import db from './db.js';
import { collectAll } from './collectors/index.js';
import { screenKeywords } from './ai/screen.js';
import { clusterTopics } from './ai/cluster.js';
import { aiReady, aiStatus } from './ai/openrouter.js';
import { notify } from './notify/index.js';
import { publish } from './notify/sse.js';

let currentProgress = null; // {phase,done,total} 供轮询兜底
export function scanProgress() {
  return currentProgress;
}

const insertItem = db.prepare(
  `INSERT OR IGNORE INTO items(source,url,title,summary,author,published_at,metrics,raw_hash,collected_at)
   VALUES(@source,@url,@title,@summary,@author,@published_at,@metrics,@raw_hash,@collected_at)`
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

  // 入库并收集"本轮新条目" id
  let inserted = 0;
  const collectedAt = new Date().toISOString();
  const tx = db.transaction((list) => {
    for (const it of list) {
      const r = insertItem.run({ ...it, collected_at: collectedAt });
      if (r.changes) inserted++;
    }
  });
  tx(items);

  // 待 AI 处理集合 = 本轮新增 + 历史未处理成功（ai_done=0），上限 150 防积压过大
  const pendingIds = db
    .prepare('SELECT id FROM items WHERE ai_done=0 ORDER BY id ASC LIMIT 150')
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
    } catch (e) {
      console.warn('[notify] 分发异常（忽略）:', e.message);
    }
  }

  const finishedAt = new Date().toISOString();
  currentProgress = null;
  const ok = Object.values(stats).every((s) => s.ok) && allQueries.length > 0;
  const summary = {
    queries: allQueries.length,
    fetched: items.length,
    inserted,
    duplicates: items.length - inserted,
    sources: stats,
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
