import { Router } from 'express';
import db from '../db.js';
import { runScan, scheduleInfo, isScanning } from '../scheduler.js';
import { scanProgress } from '../pipeline.js';
import { aiStatus, listModels } from '../ai/openrouter.js';
import { publicKey, saveSub, dropSub, pushAll, pushConfigured, subCount } from '../notify/webpush.js';
import { notify } from '../notify/index.js';
import { emailReady } from '../notify/mailer.js';
import { labelAuthor, brandOfHost, isPlatformHost, gates, engagementScore } from '../quality.js';

export const api = Router();

const now = () => new Date().toISOString();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- health ----------
api.get('/health', (req, res) => {
  res.json({ ok: true, ts: now(), name: 'hotpulse' });
});

// ---------- keywords ----------
api.get('/keywords', (req, res) => {
  const rows = db
    .prepare(
      `SELECT k.*,
        (SELECT COUNT(*) FROM hits h WHERE h.keyword_id=k.id AND h.relevant=1 AND h.genuine=1) AS hit_count
       FROM keywords k ORDER BY k.id DESC`
    )
    .all();
  res.json(rows);
});

api.post('/keywords', (req, res) => {
  const term = (req.body?.term || '').trim();
  if (!term) return bad(res, 'term 不能为空');
  try {
    const r = db
      .prepare('INSERT INTO keywords(term,created_at) VALUES(?,?)')
      .run(term, now());
    res.json({ id: r.lastInsertRowid, term });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return bad(res, '关键词已存在', 409);
    throw e;
  }
});

api.patch('/keywords/:id', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return bad(res, 'enabled 需为布尔值');
  db.prepare('UPDATE keywords SET enabled=? WHERE id=?').run(enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

api.delete('/keywords/:id', (req, res) => {
  db.prepare('DELETE FROM hits WHERE keyword_id=?').run(req.params.id);
  const r = db.prepare('DELETE FROM keywords WHERE id=?').run(req.params.id);
  if (!r.changes) return bad(res, '不存在', 404);
  res.json({ ok: true });
});

api.get('/keywords/:id/hits', (req, res) => {
  const rows = db
    .prepare(
      `SELECT h.*, i.title, i.url, i.source, i.published_at, i.collected_at, i.summary, i.host, i.metrics, i.author, i.engagement, i.source_tier, i.quality_score
       FROM hits h JOIN items i ON i.id=h.item_id
       WHERE h.keyword_id=? ORDER BY h.screened_at DESC LIMIT 200`
    )
    .all(req.params.id);
  res.json(
    rows.map((r) => ({ ...enrichItem(r), passed: r.relevant === 1 && r.genuine === 1 }))
  );
});

// ---------- scopes ----------
api.get('/scopes', (req, res) => {
  const rows = db.prepare('SELECT * FROM scopes ORDER BY id DESC').all();
  res.json(rows.map((r) => ({ ...r, queries: JSON.parse(r.queries || '[]') })));
});

api.post('/scopes', (req, res) => {
  const label = (req.body?.label || '').trim();
  let queries = req.body?.queries;
  if (!label) return bad(res, 'label 不能为空');
  if (!Array.isArray(queries) || queries.length === 0) queries = [label];
  queries = queries.map((q) => String(q).trim()).filter(Boolean);
  try {
    const r = db
      .prepare('INSERT INTO scopes(label,queries,created_at) VALUES(?,?,?)')
      .run(label, JSON.stringify(queries), now());
    res.json({ id: r.lastInsertRowid, label, queries });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return bad(res, '范围已存在', 409);
    throw e;
  }
});

api.delete('/scopes/:id', (req, res) => {
  const r = db.prepare('DELETE FROM scopes WHERE id=?').run(req.params.id);
  if (!r.changes) return bad(res, '不存在', 404);
  res.json({ ok: true });
});

// ---------- topics ----------
/**
 * 话题列表：筛选 + 排序 + 分页 + 交叉分面计数。
 *
 * 话题量级很小（几十到几百），因此在 JS 侧筛选/排序而不是拼 SQL 动态 WHERE：
 * 避免字符串拼接带来的注入面，也让"证据等级分组、来源数组匹配"这类逻辑
 * 与 quality.js 保持同一套语义（tier 的强弱归类是业务规则，不该写进 SQL）。
 *
 * 查询参数
 *   scope      关注范围 id；'none' = 未分类；缺省 = 全部
 *   tier       'strong'（官方/媒体交叉/爆款社交）| 'weak' | 具体 tier 名，逗号分隔
 *   strong     '1' 只看强佐证（前端"低佐证默认折叠"用；与 tier 同属一个维度）
 *   sources    信息源名，逗号分隔（话题构成含其中任一即命中）
 *   since      时间窗：24h / 3d / 7d / 30d
 *   min_score  最低热度分
 *   q          关键词（标题/摘要/为什么火）
 *   sort       score(默认) | updated | sources | items | engagement
 *   limit/offset 分页
 */
const TIER_STRONG = new Set(['official', 'media_cross', 'viral_social']);
const TIER_LABEL = {
  official: '官方一手',
  media_cross: '媒体交叉',
  viral_social: '多源爆款',
  single_viral: '爆款孤证',
  social_weak: '弱社交',
  weak: '单源弱佐证',
};

const SINCE_BUCKETS = [
  ['24h', 1],
  ['3d', 3],
  ['7d', 7],
  ['30d', 30],
];

/**
 * 话题的"发布轴"参考时间。
 *
 * last_updated 是聚类更新时间，只要并入一条新条目就会变——用它排序会让昨天的旧闻
 * 因为今天被讨论而排到最前。故优先用条目里**最新一条的发布时间**（published_last）。
 * 快照榜源（GitHub trending / HF daily_papers）本身没有发布时间，此时退回 last_updated。
 */
function axisTime(t) {
  return Date.parse(t.published_last || '') || Date.parse(t.last_updated) || 0;
}

/** 按除 except 外的所有维度筛选（except 传 null 表示全量应用） */
function applyDims(list, q, except) {
  const has = (k) => except !== k && q[k] && q[k] !== 'all';
  let rows = list;

  if (has('scope')) {
    rows = rows.filter((t) => (q.scope === 'none' ? t.scope_id == null : t.scope_id === Number(q.scope)));
  }
  if (except !== 'tier') {
    if (has('tier')) {
      const want = String(q.tier).split(',').map((s) => s.trim()).filter(Boolean);
      rows = rows.filter((t) =>
        want.some((w) =>
          w === 'strong' ? TIER_STRONG.has(t.evidence_tier) : w === 'weak' ? !TIER_STRONG.has(t.evidence_tier) : t.evidence_tier === w
        )
      );
    }
    if (q.strong === '1') rows = rows.filter((t) => TIER_STRONG.has(t.evidence_tier));
  }
  if (has('sources')) {
    const want = String(q.sources).split(',').filter(Boolean);
    rows = rows.filter((t) => (t.sources || []).some((s) => want.includes(s)));
  }
  if (has('since')) {
    const m = /^(\d+)([hd])$/.exec(String(q.since));
    if (m) {
      const cutoff = Date.now() - Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
        // 时间窗也走发布轴：否则"7 天内"会把两周前的旧闻按聚类时间算成新鲜
        rows = rows.filter((t) => axisTime(t) >= cutoff);
      }
    }
  if (has('min_score')) {
    const ms = Number(q.min_score);
    if (!Number.isNaN(ms)) rows = rows.filter((t) => Number(t.score) >= ms);
  }
  if (has('q')) {
    const needle = String(q.q).toLowerCase().trim();
    if (needle) rows = rows.filter((t) => `${t.title} ${t.summary_zh} ${t.why_hot}`.toLowerCase().includes(needle));
  }
  return rows;
}

api.get('/topics', (req, res) => {
  const q = req.query;
  const gatesNow = gates();
  const all = db.prepare('SELECT * FROM topics').all().map((t) => parseTopic(t, gatesNow));

  const sorters = {
    score: (a, b) => b.score - a.score || (b.engagement_total || 0) - (a.engagement_total || 0),
    updated: (a, b) => axisTime(b) - axisTime(a) || b.score - a.score,
    sources: (a, b) => (b.source_count || 1) - (a.source_count || 1) || b.score - a.score,
    items: (a, b) => (b.item_ids?.length || 0) - (a.item_ids?.length || 0) || b.score - a.score,
    // 按互动量排序：直接看"哪里有讨论"（B站/社交互动多的排最前）
    engagement: (a, b) => (b.engagement_total || 0) - (a.engagement_total || 0) || b.score - a.score,
  };

  const filtered = [...applyDims(all, q, null)].sort(sorters[q.sort] || sorters.score);
  const limit = Math.min(Number(q.limit) || 10, 200);
  const offset = Math.max(0, Number(q.offset) || 0);

  // 交叉分面：每个维度的计数在"应用其余所有维度"之后统计（标准 faceted search），
  // 这样选中一个条件后，其他维度里"点了会变空"的选项能被识别出来。
  const nowMs = Date.now();
  const tierBase = applyDims(all, q, 'tier');
  const sinceBase = applyDims(all, q, 'since');
  const facets = {
    scope: countBy(applyDims(all, q, 'scope'), (t) => (t.scope_id == null ? 'none' : String(t.scope_id))),
    tier: countBy(tierBase, (t) => t.evidence_tier || 'unknown'),
    sources: countBy(applyDims(all, q, 'sources').flatMap((t) => t.sources || []), (s) => s),
    since: Object.fromEntries(
          SINCE_BUCKETS.map(([k, days]) => [k, sinceBase.filter((t) => nowMs - axisTime(t) < days * 86400e3).length])
    ),
    // 折叠条用：当前其余筛选下"低佐证"还剩多少
    weak: tierBase.filter((t) => !TIER_STRONG.has(t.evidence_tier)).length,
    total_all: all.length,
  };

  res.json({
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    facets,
    tier_label: TIER_LABEL,
    scopes: db.prepare('SELECT id, label FROM scopes ORDER BY id').all(),
  });
});

function countBy(list, key) {
  const out = {};
  for (const x of list) {
    const k = key(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export function parseTopic(t, g) {
  let sources = [];
  try {
    sources = JSON.parse(t.sources || '[]');
  } catch {
    /* 列缺失或旧数据 */
  }
  let topMetrics = {};
  try {
    topMetrics = JSON.parse(t.top_metrics || '{}');
  } catch {
    /* 同上 */
  }
  const gatesNow = g || gates();
  const base = Number(t.base_score) > 0 ? Number(t.base_score) : Number(t.score) || 0;
  const total = Number(t.engagement_total) || 0;
  return {
    ...t,
    item_ids: JSON.parse(t.item_ids || '[]'),
    sources,
    top_metrics: topMetrics,
    base_score: base,
    engagement_total: total,
    // 展示用的分项（前端 hover 说明"为什么它排这么前"）
    engagement_score: engagementScore(total, gatesNow),
    engagement_weight: gatesNow.engagementWeight,
  };
}

/** 可信等级中文名（详情页逐条标注来源身份） */
const TIER_NAME = { 0: '未知', 1: '官方一手', 2: '强策展', 3: '主流媒体', 4: '泛搜索' };

/**
 * 条目补充展示字段（详情页用）：
 *  - 区分"发布于"（原始发布时间）与"收录于"（采集时间，榜单/快照源没有发布时间）
 *  - metrics 解析 + 标签化（前端直接渲染"👍79 💬23"）
 *  - 若指标里带 created_at（GitHub 仓库补的真实建库时间），单列 repo_created 供"建库于 X"展示
 */
function enrichItem(i) {
  let metrics = {};
  try {
    metrics = JSON.parse(i.metrics || '{}');
  } catch {
    /* 旧数据 */
  }
  const { created_at: repoCreated, ...rest } = metrics;
    return {
      ...i,
      metrics: rest,
      metric_list: metricList(rest, i.source),
      labels: labelMetrics(i.source, rest),
      published_at: i.published_at || '',
      collected_at: i.collected_at || '',
      has_published: Boolean(i.published_at),
      repo_created: repoCreated || '',
      tier_name: TIER_NAME[i.source_tier] || '',
      brand: i.host ? brandOfHost(i.host) : '',
      platform_host: Boolean(i.host) && isPlatformHost(i.host),
      author_label: labelAuthor(i.author, i.source),
    };
  }

/** 各源原始指标 → {key,label,value,text} 列表（详情页逐条展示，不做跨源加权） */
const METRIC_SPEC = {
  points: { label: '点赞', ico: '▲' },
  comments: { label: '评论', ico: '💬' },
  upvotes: { label: '赞', ico: '▲' },
  score: { label: '得分', ico: '◆' },
  likes: { label: '点赞', ico: '👍' },
  rts: { label: '转发', ico: '🔁' },
  replies: { label: '回复', ico: '↩' },
  views: { label: '浏览', ico: '👁' },
  stars: { label: 'Star', ico: '⭐' },
  stars_today: { label: '今日新增', ico: '＋' },
  forks: { label: 'Fork', ico: '⑂' },
  // B站
  like: { label: '点赞', ico: '👍' },
  coin: { label: '投币', ico: '🪙' },
  fav: { label: '收藏', ico: '⭐' },
  share: { label: '转发', ico: '🔁' },
  reply: { label: '评论', ico: '💬' },
  danmaku: { label: '弹幕', ico: '💭' },
  view: { label: '播放', ico: '▶' },
};

/** 各源指标的展示优先级（GitHub 只认当日新增；B站把播放量排在最后） */
export const METRIC_ORDER = {
  gh_trending: ['stars_today', 'stars', 'forks'],
  gh_search: ['stars', 'forks'],
  bilibili: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
  bilibili_hot: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
};
const DEFAULT_METRIC_ORDER = ['points', 'likes', 'upvotes', 'score', 'stars', 'comments', 'rts', 'replies', 'views'];

export function fmtNum(n) {
  const v = Number(n) || 0;
  // 中文语境用 万/亿（B站播放动辄百万，若按 k 会显示成难读的 "1834k"）
  if (v >= 1e8) return `${trimZero(v / 1e8)}亿`;
  if (v >= 1e4) return `${trimZero(v / 1e4)}万`;
  return String(v);
}

const trimZero = (x) => {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

export function metricList(metrics, source = '') {
  const order = METRIC_ORDER[source] || DEFAULT_METRIC_ORDER;
  return order
    .filter((k) => Number(metrics?.[k]) > 0 && METRIC_SPEC[k])
    .map((k) => ({ key: k, ...METRIC_SPEC[k], value: metrics[k], text: fmtNum(metrics[k]) }));
}

/**
 * 卡片/列表上的互动徽章：按该源的传播力排序取前几个
 * （GitHub 只认当日新增；B站点赞/投币/收藏/转发优先，播放量放最后）。
 */
export function labelMetrics(source, metrics, max = 3) {
  return metricList(metrics, source).slice(0, max);
}

api.get('/items', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 120, 300);
  const since = req.query.since; // ISO
  const cols = 'id,source,url,title,author,published_at,collected_at,metrics,quality_score,engagement,source_tier,host';
  const rows = since
    ? db
        .prepare(`SELECT ${cols} FROM items WHERE collected_at>=? ORDER BY id DESC LIMIT ?`)
        .all(since, limit)
    : db
        .prepare(`SELECT ${cols} FROM items ORDER BY id DESC LIMIT ?`)
        .all(limit);
  const bySource = db.prepare('SELECT source, COUNT(*) c, ROUND(AVG(quality_score),1) avg_quality FROM items GROUP BY source').all();
  res.json({ rows: rows.map((r) => ({ ...r, metrics: JSON.parse(r.metrics || '{}') })), bySource });
});

api.get('/topics/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM topics WHERE id=?').get(req.params.id);
  if (!t) return bad(res, '不存在', 404);
  const topic = parseTopic(t);
  const ids = topic.item_ids;
  const items = ids.length
    ? db
        .prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)
    : [];
  res.json({
    ...topic,
    // 原始条目按发布/采集时间新→旧，最上面的就是"最新动态"
    items: items.map(enrichItem).sort((a, b) => (Date.parse(b.published_at || b.collected_at) || 0) - (Date.parse(a.published_at || a.collected_at) || 0)),
      });
    });

// ---------- notices ----------
api.get('/notices', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const rows = db
    .prepare('SELECT * FROM notices ORDER BY id DESC LIMIT ?')
    .all(limit);
  const unread = db.prepare('SELECT COUNT(*) c FROM notices WHERE read=0').get().c;
  res.json({ unread, rows });
});

api.post('/notices/read', (req, res) => {
  const { id, all } = req.body || {};
  if (all) db.prepare('UPDATE notices SET read=1 WHERE read=0').run();
  else if (id) db.prepare('UPDATE notices SET read=1 WHERE id=?').run(id);
  else return bad(res, '需要 id 或 all');
  res.json({ ok: true });
});

// ---------- scan ----------
api.post('/scan/run', (req, res) => {
  if (isScanning()) return res.status(409).json({ error: '扫描进行中，请稍候' });
  runScan('manual').catch((e) => console.error('[scan] manual failed', e));
  res.json({ started: true });
});

api.get('/scan/status', (req, res) => {
  const info = scheduleInfo();
  const recent = db
    .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 10')
    .all()
    .map((r) => ({ ...r, stats: JSON.parse(r.stats || '{}') }));
  res.json({ ...info, running: isScanning(), progress: scanProgress(), recent });
});

api.get('/ai/status', (req, res) => {
  res.json(aiStatus());
});

api.get('/ai/models', async (req, res) => {
  try {
    res.json(await listModels());
  } catch (e) {
    bad(res, `拉取模型列表失败：${e.message}`, 502);
  }
});

// ---------- notifications / push ----------
api.get('/notify/status', (req, res) => {
  res.json({
    sse: true,
    push: { configured: pushConfigured(), subscribers: subCount() },
    email: { ready: emailReady() },
  });
});

api.get('/push/public-key', (req, res) => {
  if (!pushConfigured()) return bad(res, '未配置 VAPID 密钥', 503);
  res.json({ publicKey: publicKey() });
});

api.post('/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys) return bad(res, '需要 PushSubscription JSON');
  saveSub(sub);
  res.json({ ok: true, subscribers: subCount() });
});

api.post('/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return bad(res, '需要 endpoint');
  dropSub(endpoint);
  res.json({ ok: true });
});

api.post('/push/test', async (req, res) => {
  const r = await pushAll({ title: 'HotPulse 测试', body: '浏览器推送配置成功 ✅', link: '/' });
  res.json(r);
});

api.post('/notify/test', async (req, res) => {
  const n = await notify({
    kind: 'system',
    title: req.body?.title || 'HotPulse 测试通知',
    body: req.body?.body || '这是一条测试通知（站内 + 推送 + 邮件）。',
    link: '/settings',
  });
  res.json(n ? { ok: true, notice: n } : { ok: false, reason: '已存在同类测试通知（5分钟频控）' });
});

// ---------- settings ----------
api.get('/settings', (req, res) => {
  const { allSettings } = req.app.locals;
  res.json(allSettings());
});

api.put('/settings', (req, res) => {
  const { setSetting } = req.app.locals;
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) setSetting(k, v);
  res.json({ ok: true });
});

export default api;
