import db, { getSetting } from '../db.js';
import { config } from '../config.js';
import { chatJSON } from './openrouter.js';
import { evidenceOf, capScore, hasNotifyEvidence, weightedEngagement, isViral, isOfficialHost, isAuthorityHost, isDeniedHost, isPlatformHost, normalizeHost, summarizeSources } from '../quality.js';

const SYSTEM = `你是 AI 领域热点分析师。给定监控范围（scope）与一批来自多个信息源的内容条目（含既有热点话题列表），完成聚类与评分。

1. 聚类：把讨论**同一事件/产品**的条目合并为一个话题（跨信息源合并：HN + 官方博客 + 媒体都在说同一个模型发布 → 一个话题）。
   与既有话题重复时**沿用既有 cluster_key**并把新条目并入 item_ids；同一产品的不同事件（如"发布"与"故障调查"）可合并为同一话题，但要在摘要里说清是几件事。

2. 每个话题输出：
   - cluster_key：简短稳定的英文标识（如 "gpt6-release"），同一事件跨轮次必须一致；
   - title：中文标题 ≤28字，写"主体 + 动作 + 关键对象"，不要堆形容词、不要带标点结尾；
   - summary_zh：40~90字，只陈述事实（谁、做了什么、关键数字/规格/时间）。禁止复述标题、禁止"引发关注"这类评价；
   - why_hot：≤28字，说明**新增信息量**（改变了什么、对谁有实际影响）。禁止空泛套话（"行业关注度极高""备受瞩目"一律不许用）；
   - item_ids：属于该话题的条目 id 数组（只能引用给定条目）；
   - scope_id：最相关的监控范围 id，无则 null。

3. score（0~100）**必须与证据相称**，系统还会按证据硬性封顶，虚高会被拉回。判定顺序：先看量级，再看佐证强度。
   条目证据字段（代码算好，直接采用）：src=信息源、tier=来源分级(1官方/2强策展/3媒体/4泛搜索UGC)、q=质量分、eng=加权互动数、viral=1 表示该条达到所属平台的爆款门槛、host=域名、official=1 厂商官方一手、auth=1 权威媒体名单内、m=原始互动数据。
   - 量级（决定基础分）：
     · 全新模型/重大能力/开源权重/行业级合作落地 → 85~100；
     · 现有产品的常规版本迭代、小功能更新、客户案例软文、活动预告、综述/榜单类内容 → 60~75，即使 official=1 也不给 85 以上；
     · 旧闻转述、纯观点评论 → ≤60。
   - 佐证修正：≥2 个不同信息源或 official=1 且量级达标 → 可给到 90+；仅 1 条来源且非官方 → ≤65；eng=0 且单一来源 → ≤60；
     多条 viral=1 跨平台讨论 → 可按热度给 70~85；viral=0 的普通社交帖（HN 几十赞、GitHub 几百星）只是零散讨论，不得高于 60。
   - 注意：GitHub 老仓库（tensorflow/vscode 级别）常驻 trending 榜，"总星数高"不是热点，只有 stars_today（当日新增）才是信号。
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
        .prepare(`SELECT source,url,host,metrics,published_at,author,title FROM items WHERE id IN (${allIds.map(() => '?').join(',')})`)
      .all(...allIds);
    const ev = evidenceOf(rows);
      // 卡片展示用：最权威 1~2 个来源 + 原始发布轴 + 最热条目的原始互动指标
      const src = summarizeSources(rows);
      const capped = capScore(Number(t.score) || 0, ev);
      const merged = JSON.stringify(allIds);

      if (prev) {
        // 证据累积后重新封顶：历史虚高分会被拉回证据允许的上限
        const recheck = capScore(Math.max(prev.score, capped.score), ev);
        db.prepare(
          `UPDATE topics SET title=?, summary_zh=?, why_hot=?, score=?, item_ids=?, last_updated=?, scope_id=COALESCE(?, scope_id),
           source_count=?, host_count=?, has_official=?, viral_count=?, evidence_tier=?, sources=?,
           primary_host=?, primary_label=?, primary_url=?, primary_source=?, primary_tier=?, authority_count=?, top_metrics=?,
           published_first=?, published_last=? WHERE id=?`
        ).run(
          t.title, t.summary_zh, t.why_hot, recheck.score, merged, now, t.scope_id ?? null,
          ev.source_count, ev.host_count, ev.has_official, ev.viral_count, recheck.tier, JSON.stringify(ev.sources),
          src.primaryHost, src.primaryLabel, src.primaryUrl, src.primarySource, src.primaryTier, src.authorityCount,
          JSON.stringify(src.metrics || {}), src.publishedFirst, src.publishedLast, prev.id
        );
      // 此前未达通知条件、现在满足 → 补发一次（按 prev 条目精确重算，避免重复轰炸）
      let prevOk = false;
      if (prevIds.length) {
        const prevRows = db
                .prepare(`SELECT source,url,host,metrics,published_at,author,title FROM items WHERE id IN (${prevIds.map(() => '?').join(',')})`)
          .all(...prevIds);
        prevOk = prev.score >= minScore && hasNotifyEvidence(evidenceOf(prevRows));
      }
      if (recheck.score >= minScore && !prevOk && hasNotifyEvidence(ev)) {
        updated.push({ topicId: prev.id, title: t.title, score: recheck.score, summary_zh: t.summary_zh, why_hot: t.why_hot });
      }
    } else {
      const r = db
        .prepare(
                `INSERT INTO topics(scope_id,title,summary_zh,why_hot,score,item_ids,first_seen,last_updated,cluster_key,source_count,host_count,has_official,viral_count,evidence_tier,sources,
                   primary_host,primary_label,primary_url,primary_source,primary_tier,authority_count,top_metrics,published_first,published_last)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
                capped.tier,
                JSON.stringify(ev.sources),
                src.primaryHost,
                src.primaryLabel,
                src.primaryUrl,
                src.primarySource,
                src.primaryTier,
                src.authorityCount,
                JSON.stringify(src.metrics || {}),
                src.publishedFirst,
                src.publishedLast
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
          const h = it.host || normalizeHost(it.url || '');
          return {
            i: it.id,
            src: it.source,
            tier: it.source_tier,
            q: it.quality_score,
            eng,
            viral: isViral(it.source, eng) ? 1 : 0,
            host: h,
            // 名单判定由代码算好（模型对媒体身份判断不稳，直接给结论）
            // 字段语义与提示词一致：official=域名是厂商官方（纯域名判定）
            official: isOfficialHost(h) ? 1 : 0,
            auth: isAuthorityHost(h) ? 1 : 0,
                        // 平台自身域名（bilibili.com / github.com…）不是"内容农场"，别让模型据此降分
                        farm: !isPlatformHost(h) && isDeniedHost(h) ? 1 : 0,
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
