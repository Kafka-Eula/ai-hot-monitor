import db, { getSetting } from '../db.js';
import { config } from '../config.js';
import { chatJSON } from './openrouter.js';
import { evidenceOf, capScore, hasNotifyEvidence, weightedEngagement, isViral } from '../quality.js';

const SYSTEM = `你是 AI 领域热点分析师。用户给出监控范围（scope）与一批来自多个信息源的内容条目（含既有热点话题列表）。
任务：
1. 把讨论**同一事件/产品/话题**的条目聚类（跨信息源合并，例如 HN+Twitter+官方博客都在说同一个模型发布 → 一个话题）。
2. 为每个话题输出：
   - cluster_key：简短稳定的英文标识（如 "gpt6-release"），同一事件跨轮次必须使用相同的 key；
   - title：话题中文标题（≤40字）；
   - summary_zh：60~120字中文摘要，说明发生了什么；
   - why_hot：一句话说明为什么值得关注；
   - score：0~100 热度评分。**评分必须与证据相称**（系统还会按证据硬性封顶，虚高会被拉回）：
     · tier=1 官方一手发布 → 可给 85~100；
     · ≥2 家权威媒体（host 不同）交叉报道 → 可给 80~100；
     · 社交平台条目：viral=1（点赞/转发/评论加权后达到该源爆款门槛）才算"被广泛讨论"，
       多条 viral 跨源可给 70~80；viral=0 的普通社交帖（如 HN 几十个赞、GitHub 几百星）
       只是零散讨论，**不得高于 60**；
     · eng=0 且仅单一来源 → 不得高于 60；只有 1 条非官方来源、无互动佐证 → 不得高于 55；
     · 信息增量（新发布/新数据）> 旧闻转述 > 观点评论；
     · 注意：GitHub 老仓库（tensorflow/vscode 级别）常驻 trending 榜，"总星数高"不等于热点，
       只有 stars_today（当日新增）才是信号；
   - item_ids：属于该话题的条目 id 数组；
   - scope_id：最相关的监控范围 id（无则 null）。
3. 与既有话题重复的事件，请**沿用既有的 cluster_key**并把新条目并入 item_ids。
4. 无信息量、纯广告、与所有 scope 无关的条目可以不归入任何话题。
只输出 JSON：{"topics":[{"cluster_key":"...","title":"...","summary_zh":"...","why_hot":"...","score":85,"item_ids":[1,2],"scope_id":1}]}
最多输出 12 个话题，按 score 降序。`;

const schema = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cluster_key: { type: 'string' },
          title: { type: 'string' },
          summary_zh: { type: 'string' },
          why_hot: { type: 'string' },
          score: { type: 'number' },
          item_ids: { type: 'array', items: { type: 'number' } },
          scope_id: { type: ['number', 'null'] },
        },
        required: ['cluster_key', 'title', 'summary_zh', 'why_hot', 'score', 'item_ids', 'scope_id'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

/**
 * 热点聚类评分（分批处理，避免大批量超时）。
 * @param {number[]} newItemIds 本轮待处理 item id
 * @returns { topics:number, newHot:[], updated:[], failedIds:number[] }
 */
const CLUSTER_BATCH = 20; // 免费模型处理大 prompt 易超时，20 条/批成功率更高

export async function clusterTopics(newItemIds, onProgress) {
  const scopes = db.prepare('SELECT id, label FROM scopes WHERE enabled=1').all();
  if (!newItemIds.length) return { topics: 0, newHot: [], updated: [], failedIds: [] };

  const allItems = db
    .prepare(
      `SELECT id, source, title, summary, url, author, published_at, metrics, host, engagement, source_tier, quality_score FROM items WHERE id IN (${newItemIds.map(() => '?').join(',')})`
    )
    .all(...newItemIds);
  if (!allItems.length) return { topics: 0, newHot: [], updated: [], failedIds: [] };

  const today = new Date().toISOString().slice(0, 10);
  const dateNote = `【当前日期：${today}】你的训练数据有截止时间，许多新模型/新产品是在那之后发布的，**不得以"知识中不存在"判定为虚构**，以给定来源与佐证为准。\n\n`;

  const now = new Date().toISOString();
  const minScore = Number(getSetting('thresholds.minTopicScore', config.thresholds.minTopicScore));
  const newHot = [];
  const updated = [];
  const failedIds = [];
  let topics = 0;

  /**
   * 写入/合并话题：证据（跨源数、域名数、是否官方）由代码统计，
   * 并对"单源且非官方"的话题硬性封顶，防止 1 条噪音拿到满分。
   */
  const upsert = (t, validIds) => {
    const prev = db.prepare('SELECT * FROM topics WHERE cluster_key=?').get(t.cluster_key);
    const prevIds = prev ? JSON.parse(prev.item_ids || '[]') : [];
    const allIds = [...new Set([...prevIds, ...validIds])];
    // 证据基于该话题**全部**条目（含历史轮次入库的），而非仅本批。
    // 不取 items.engagement 列：历史行是旧"取最大值"口径，统一按加权口径从 metrics 重算
    const rows = db
      .prepare(`SELECT source,url,host,metrics FROM items WHERE id IN (${allIds.map(() => '?').join(',')})`)
      .all(...allIds);
    const ev = evidenceOf(rows);
    const capped = capScore(Number(t.score) || 0, ev);
    const merged = JSON.stringify(allIds);

    if (prev) {
      // 证据累积后重新封顶：历史虚高分会被拉回证据允许的上限
      const recheck = capScore(Math.max(prev.score, capped.score), ev);
      db.prepare(
        `UPDATE topics SET title=?, summary_zh=?, why_hot=?, score=?, item_ids=?, last_updated=?, scope_id=COALESCE(?, scope_id),
         source_count=?, host_count=?, has_official=?, viral_count=?, evidence_tier=? WHERE id=?`
      ).run(
        t.title, t.summary_zh, t.why_hot, recheck.score, merged, now, t.scope_id ?? null,
        ev.source_count, ev.host_count, ev.has_official, ev.viral_count, recheck.tier, prev.id
      );
      // 此前未达通知条件、现在满足 → 补发一次（按 prev 条目精确重算，避免重复轰炸）
      let prevOk = false;
      if (prevIds.length) {
        const prevRows = db
          .prepare(`SELECT source,url,host,metrics FROM items WHERE id IN (${prevIds.map(() => '?').join(',')})`)
          .all(...prevIds);
        prevOk = prev.score >= minScore && hasNotifyEvidence(evidenceOf(prevRows));
      }
      if (recheck.score >= minScore && !prevOk && hasNotifyEvidence(ev)) {
        updated.push({ topicId: prev.id, title: t.title, score: recheck.score, summary_zh: t.summary_zh, why_hot: t.why_hot });
      }
    } else {
      const r = db
        .prepare(
          `INSERT INTO topics(scope_id,title,summary_zh,why_hot,score,item_ids,first_seen,last_updated,cluster_key,source_count,host_count,has_official,viral_count,evidence_tier)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          t.scope_id ?? null,
          t.title,
          t.summary_zh,
          t.why_hot,
          capped.score,
          merged,
          now,
          now,
          t.cluster_key,
          ev.source_count,
          ev.host_count,
          ev.has_official,
          ev.viral_count,
          capped.tier
        );
      topics++;
      if (capped.score >= minScore && hasNotifyEvidence(ev)) {
        newHot.push({
          topicId: Number(r.lastInsertRowid),
          title: t.title,
          score: capped.score,
          summary_zh: t.summary_zh,
          why_hot: t.why_hot,
        });
      }
    }
  };

  // 分批：每批取当前最新既有话题，保证跨批能沿用 cluster_key
  for (let i = 0; i < allItems.length; i += CLUSTER_BATCH) {
    const batch = allItems.slice(i, i + CLUSTER_BATCH);
    const batchIds = new Set(batch.map((b) => b.id));
    const existing = db
      .prepare('SELECT cluster_key, title, score FROM topics ORDER BY last_updated DESC LIMIT 30')
      .all();
    const user =
      dateNote +
      JSON.stringify({
        scopes,
        existing_topics: existing,
        items: batch.map((it) => {
          const eng = it.engagement ?? weightedEngagement(it.source, it.metrics);
          return {
            i: it.id,
            src: it.source,
            tier: it.source_tier,
            q: it.quality_score,
            eng,
            viral: isViral(it.source, eng) ? 1 : 0,
            host: it.host,
            title: it.title.slice(0, 180),
            sum: (it.summary || '').slice(0, 240),
            author: it.author,
            at: it.published_at,
            m: it.metrics,
          };
        }),
      });

    try {
      const { data } = await chatJSON({ system: SYSTEM, user, schema, name: 'topics' });
      const tx = db.transaction(() => {
        for (const t of data?.topics || []) {
          const valid = (t.item_ids || []).filter((id) => batchIds.has(id));
          if (!valid.length) continue;
          upsert(t, valid);
        }
      });
      tx();
      console.log(`[ai] 聚类批次 ${Math.floor(i / CLUSTER_BATCH) + 1}: ${batch.length} 条 → ${(data?.topics || []).length} 话题`);
    } catch (e) {
      console.warn(`[ai] 聚类批次 ${Math.floor(i / CLUSTER_BATCH) + 1} 失败: ${e.code || ''} ${e.message}`);
      failedIds.push(...batch.map((b) => b.id));
    }
    onProgress?.({ phase: 'cluster', done: Math.min(i + CLUSTER_BATCH, allItems.length), total: allItems.length });
  }

  return { topics, newHot, updated, failedIds };
}
