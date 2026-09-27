import db, { getSetting } from '../db.js';
import { config } from '../config.js';
import { chatJSON } from './openrouter.js';

const SYSTEM = `你是 AI 领域热点分析师。用户给出监控范围（scope）与一批来自多个信息源的内容条目（含既有热点话题列表）。
任务：
1. 把讨论**同一事件/产品/话题**的条目聚类（跨信息源合并，例如 HN+Twitter+官方博客都在说同一个模型发布 → 一个话题）。
2. 为每个话题输出：
   - cluster_key：简短稳定的英文标识（如 "gpt6-release"），同一事件跨轮次必须使用相同的 key；
   - title：话题中文标题（≤40字）；
   - summary_zh：60~120字中文摘要，说明发生了什么；
   - why_hot：一句话说明为什么值得关注；
   - score：0~100 热度评分，考虑：官方一手发布>媒体报道>社区讨论；多源交叉证实加分；互动数据（点赞/评论/星数）加分；信息增量加分；
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
 * 热点聚类评分。
 * @param {number[]} newItemIds 本轮新入库条目
 * @returns { topics:number, newHot:[], updated:[] }
 */
export async function clusterTopics(newItemIds) {
  const scopes = db.prepare('SELECT id, label FROM scopes WHERE enabled=1').all();
  if (!newItemIds.length) return { topics: 0, newHot: [], updated: [] };

  const placeholders = newItemIds.map(() => '?').join(',');
  const items = db
    .prepare(
      `SELECT id, source, title, summary, url, author, published_at, metrics FROM items WHERE id IN (${placeholders})`
    )
    .all(...newItemIds);
  if (!items.length) return { topics: 0, newHot: [], updated: [] };

  // 近期既有话题（供 AI 沿用 cluster_key）
  const existing = db
    .prepare('SELECT cluster_key, title, score FROM topics ORDER BY last_updated DESC LIMIT 30')
    .all();

  const today = new Date().toISOString().slice(0, 10);
  const dateNote = `【当前日期：${today}】你的训练数据有截止时间，许多新模型/新产品是在那之后发布的，**不得以"知识中不存在"判定为虚构**，以给定来源与佐证为准。\n\n`;
  const user =
    dateNote +
    JSON.stringify({
      scopes,
      existing_topics: existing,
      items: items.map((it) => ({
        i: it.id,
        src: it.source,
        title: it.title.slice(0, 180),
        sum: (it.summary || '').slice(0, 240),
        author: it.author,
        at: it.published_at,
        m: it.metrics,
      })),
    });

  const { data } = await chatJSON({ system: SYSTEM, user, schema, name: 'topics' });

  const now = new Date().toISOString();
  const minScore = Number(getSetting('thresholds.minTopicScore', config.thresholds.minTopicScore));
  const newHot = [];
  const updated = [];
  const tx = db.transaction(() => {
    for (const t of data?.topics || []) {
      const ids = JSON.stringify((t.item_ids || []).filter((id) => items.some((x) => x.id === id)));
      const prev = db.prepare('SELECT * FROM topics WHERE cluster_key=?').get(t.cluster_key);
      if (prev) {
        const merged = JSON.stringify(
          [...new Set([...JSON.parse(prev.item_ids || '[]'), ...JSON.parse(ids)])]
        );
        const newScore = Math.max(prev.score, Number(t.score) || 0);
        db.prepare(
          `UPDATE topics SET title=?, summary_zh=?, why_hot=?, score=?, item_ids=?, last_updated=?, scope_id=COALESCE(?, scope_id) WHERE id=?`
        ).run(t.title, t.summary_zh, t.why_hot, newScore, merged, now, t.scope_id ?? null, prev.id);
        if (newScore >= minScore && prev.score < minScore) {
          updated.push({ topicId: prev.id, title: t.title, score: newScore });
        }
      } else {
        const r = db
          .prepare(
            `INSERT INTO topics(scope_id,title,summary_zh,why_hot,score,item_ids,first_seen,last_updated,cluster_key)
             VALUES(?,?,?,?,?,?,?,?,?)`
          )
          .run(
            t.scope_id ?? null,
            t.title,
            t.summary_zh,
            t.why_hot,
            Number(t.score) || 0,
            ids,
            now,
            now,
            t.cluster_key
          );
        if ((Number(t.score) || 0) >= minScore) {
          newHot.push({
            topicId: Number(r.lastInsertRowid),
            title: t.title,
            score: Number(t.score) || 0,
            summary_zh: t.summary_zh,
            why_hot: t.why_hot,
          });
        }
      }
    }
  });
  tx();
  return { topics: (data?.topics || []).length, newHot, updated };
}
