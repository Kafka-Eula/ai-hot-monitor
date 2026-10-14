import db from './db.js';
import { collectAll } from './collectors/index.js';
import { enrichTrendingRepos } from './collectors/githubTrending.js';
import { applyQualityGate, gates } from './quality.js';
import { screenKeywords } from './ai/screen.js';
import { clusterTopics } from './ai/cluster.js';
import { aiReady, aiStatus } from './ai/openrouter.js';
import { notify } from './notify/index.js';
import { publish } from './notify/sse.js';

/** 核心源：失败即整轮判失败；其余源尽力而为（偶发限流不致命） */
const CORE_SOURCES = ['hn', 'hf_papers', 'blog', 'news_search'];

let currentProgress = null; // {phase,done,total} 供轮询兜底
export function scanProgress() {
  return currentProgress;
}

const insertItem = db.prepare(
  `INSERT OR IGNORE INTO items(source,url,title,summary,author,published_at,metrics,raw_hash,collected_at,quality_score,engagement,source_tier,host,quality_flags)
   VALUES(@source,@url,@title,@summary,@author,@published_at,@metrics,@raw_hash,@collected_at,@quality_score,@engagement,@source_tier,@host,@quality_flags)`
);

/** 汇总本轮检索词：启用的关键词 + 各 scope 的 queries */
export function buildQueries() {
  const kws = db.prepare('SELECT term FROM keywords WHERE enabled=1').all().map((r) => r.term);
  const scopes = db
    .prepare('SELECT queries FROM scopes WHERE enabled=1')
    .all()
    .flatMap((r) => JSON.parse(r.queries || '[]'));
  const all = [...new Set([...kws, ...scopes].filter(Boolean))];
  return { kws, scopes, allQueries: all };
}

/**
 * 一轮完整扫描：抓取 → hash 去重入库 → 记录 scans。
 * （Step3 会在此后追加 AI 甄别与聚类阶段。）
 */
export async function runPipeline() {
  const startedAt = new Date().toISOString();
  currentProgress = { phase: 'collect' };
  const { allQueries } = buildQueries();
  const lastDone = db.prepare("SELECT started_at FROM scans WHERE ok=1 ORDER BY id DESC LIMIT 1").get();
  // 重叠窗口 10 分钟，防止边界漏抓；首轮回溯 6 小时
  const sinceMs = lastDone
    ? Date.parse(lastDone.started_at) - 10 * 60000
    : Date.now() - 6 * 3600000;
  const ctx = {
    allQueries,
    sinceIso: new Date(sinceMs).toISOString(),
    windowStartMs: sinceMs,
    log: (src, q, msg) => console.log(`  [collect:${src}] ${q}: ${msg}`),
  };

  const { items, stats } = await collectAll(ctx);

    // ---- 补数据（走质量分之前）：trending 仓库补真实"建库时间" ----
    // 只对本轮首次出现的仓库请求 GitHub API（已入库的 hash 直接跳过），限量调用避免触发限流。
    try {
      const hashRows = items.length
        ? db
            .prepare(`SELECT raw_hash FROM items WHERE raw_hash IN (${items.map(() => '?').join(',')})`)
            .all(...items.map((i) => i.raw_hash))
        : [];
      const knownHashes = new Set(hashRows.map((r) => r.raw_hash));
      const n = await enrichTrendingRepos(items, { knownHashes, log: ctx.log });
      if (n) console.log(`[collect:gh_trending] 补建库时间 ${n} 个仓库`);
    } catch (e) {
      console.warn('[collect:gh_trending] 补建库时间失败（忽略）:', e.message);
    }

    // ---- 质量闸门（AI 之前）：硬门槛 + 质量分 + 同源近似去重，不达标不入库 ----
  const g = gates();
  const { passed, blocked } = applyQualityGate(items, { g });
  const blockedStats = {};
  for (const b of blocked) {
    const src = b.item.source;
    blockedStats[src] ||= { total: 0, reasons: {} };
    blockedStats[src].total++;
    const key = b.reason.replace(/\(.*/, '');
    blockedStats[src].reasons[key] = (blockedStats[src].reasons[key] || 0) + 1;
  }

  // 入库并收集"本轮新条目" id
  let inserted = 0;
  const collectedAt = new Date().toISOString();
  const tx = db.transaction((list) => {
    for (const it of list) {
      const r = insertItem.run({
        source: it.source,
        url: it.url,
        title: it.title,
        summary: it.summary,
        author: it.author,
        published_at: it.published_at,
        metrics: it.metrics,
        raw_hash: it.raw_hash,
        collected_at: collectedAt,
        quality_score: it.quality_score ?? 0,
        engagement: it.engagement ?? 0,
        source_tier: it.source_tier ?? 4,
        host: it.host ?? '',
        quality_flags: JSON.stringify(it.quality_flags ?? []),
      });
      if (r.changes) inserted++;
    }
  });
  tx(passed);

  // 待 AI 处理集合：本轮新增 + 历史未处理（ai_done=0）。
  // 排序按「质量分降序、新优先」——低质量旧积压不再堵住新热点的通知路径；
  // 上限 40 控制单轮 AI 时长（免费模型每批 25 对约 1~2 分钟，剩余积压下轮继续）。
  const pendingIds = db
    .prepare('SELECT id FROM items WHERE ai_done=0 ORDER BY COALESCE(quality_score,0) DESC, id DESC LIMIT 40')
    .all()
    .map((r) => r.id);

  // ---- AI 阶段（零成本：无待处理 / 未配 key / 熔断中 → 跳过；失败保留 ai_done=0 下轮重试）----
  const ai = { skipped: true, reason: '', pending: pendingIds.length, screened: 0, hits: 0, topics: 0, newHot: [], hitList: [] };
  if (!pendingIds.length) {
    ai.reason = 'no_new_items';
  } else if (!aiReady()) {
    ai.reason = aiStatus().has_key ? 'circuit_open' : 'no_api_key';
  } else {
    ai.skipped = false;
    const failedSet = new Set();
    const onProgress = (p) => {
      currentProgress = p;
      publish('scan_progress', p);
    };
    try {
      const s = await screenKeywords(pendingIds, onProgress);
      ai.screened = s.screened || 0;
      ai.hits = s.hits || 0;
      ai.hitList = s.hitList || [];
      for (const id of s.failedIds || []) failedSet.add(id);
    } catch (e) {
      ai.screenError = `${e.code || ''} ${e.message}`.trim().slice(0, 300);
      console.warn('[ai] 甄别失败（下轮重试）:', ai.screenError);
      for (const id of pendingIds) failedSet.add(id); // 整体失败全部重试
    }
    try {
      const c = await clusterTopics(pendingIds, onProgress);
      ai.topics = c.topics || 0;
      ai.newHot = c.newHot || [];
      ai.upgraded = c.updated || [];
      for (const id of c.failedIds || []) failedSet.add(id);
    } catch (e) {
      ai.clusterError = `${e.code || ''} ${e.message}`.trim().slice(0, 300);
      console.warn('[ai] 聚类失败（下轮重试）:', ai.clusterError);
    }
    // 两阶段都成功的条目标记完成；失败保留 ai_done=0 下轮重试
    const doneIds = pendingIds.filter((id) => !failedSet.has(id));
    if (doneIds.length) {
      const ph = doneIds.map(() => '?').join(',');
      db.prepare(`UPDATE items SET ai_done=1 WHERE id IN (${ph})`).run(...doneIds);
    }
    ai.retrying = failedSet.size;

    // ---- 通知分发（失败不影响扫描结果）----
    try {
      for (const h of ai.hitList.slice(0, 5)) {
        await notify({
          kind: 'keyword_hit',
          title: `关键词命中：${h.keyword.term}`,
          body: `${h.item.title}\n\nAI 甄别：${h.reason || '通过'}（置信度 ${h.confidence}）\n来源：${h.item.source}`,
          link: h.item.url || `/watch`,
        });
      }
      for (const t of ai.newHot.slice(0, 5)) {
        await notify({
          kind: 'hot_topic',
          title: `🔥 新热点（${t.score}分）：${t.title}`,
          body: t.summary_zh || t.why_hot || '',
          link: `/topic/${t.topicId}`,
        });
      }
      // 证据累积后跨阈值升级的旧话题（此前单源、现在跨源/官方佐证）
      for (const t of (ai.upgraded || []).slice(0, 3)) {
        await notify({
          kind: 'hot_topic',
          title: `🔥 热点佐证升级（${t.score}分）：${t.title}`,
          body: (t.summary_zh || t.why_hot || '') + '\n（多源交叉证实后重新达到通知阈值）',
          link: `/topic/${t.topicId}`,
        });
      }
    } catch (e) {
      console.warn('[notify] 分发异常（忽略）:', e.message);
    }
  }

  const finishedAt = new Date().toISOString();
  currentProgress = null;
  // ok 只看核心源（其余为尽力而为源，偶发限流/结构变更不应让整轮判失败）
  const coreFailed = CORE_SOURCES.filter((s) => !stats[s]?.ok);
  const ok = allQueries.length > 0 && coreFailed.length === 0;
  const summary = {
    queries: allQueries.length,
    fetched: items.length,
    blocked: blocked.length,
    blockedStats,
    passed: passed.length,
    inserted,
    duplicates: passed.length - inserted,
    gates: { minQuality: g.minQuality, hnPoints: g.hnPoints, hfUpvotes: g.hfUpvotes, dedup: g.dedupEnabled },
    sources: stats,
    coreFailed,
    ai: {
      skipped: ai.skipped,
      reason: ai.reason,
      pending: ai.pending,
      screened: ai.screened,
      hits: ai.hits,
      topics: ai.topics,
      newHot: ai.newHot.length,
      screenError: ai.screenError,
      clusterError: ai.clusterError,
    },
  };
  db.prepare('INSERT INTO scans(started_at,finished_at,stats,ok) VALUES(?,?,?,?)').run(
    startedAt,
    finishedAt,
    JSON.stringify(summary),
    ok ? 1 : 0
  );
  console.log(
    `[scan] 完成: 抓取 ${items.length} / 新增 ${inserted} / AI ${ai.skipped ? '跳过(' + ai.reason + ')' : `甄别${ai.screened} 命中${ai.hits} 话题${ai.topics}`}`
  );
  return { startedAt, finishedAt, stats: summary, ok, ai };
}
