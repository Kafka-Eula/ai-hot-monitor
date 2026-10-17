/**
 * 零依赖状态层：Node 内置 node:sqlite（Node ≥ 22.5 可用，无需安装 better-sqlite3）。
 *
 * 为什么自包含 Skill 也要有库：没有跨次记忆就做不到"增量发现"——
 * 每次全量分析会把上周的旧闻当新消息重复播报，"第一时间知道"就落空了。
 * 单文件、零配置、零安装，仍在"自包含"范围内。
 *
 * 表设计（与服务端 schema 同构但更简，只保留 Skill 需要的部分）：
 *   items    入库条目（raw_hash 唯一 = 跨轮次去重锚点）
 *   topics   话题（cluster_key 唯一 = 跨轮次合并锚点）
 *   topic_items  话题↔条目
 *   watches  盯梢关键词
 *   verdicts 关键词×条目 的 AI 判定（含被过滤项，可追溯误杀）
 *   scans    轮次记录（可观测：抓了多少、拦了多少、新增几个热点）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  combineScore,
  evidenceOf,
  subjectTokens,
  itemMatchesSubject,
  summarizeSources,
} from './quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 默认库文件在 skill 自己的 data/ 下，可用 HP_DB 覆盖（便于多项目隔离） */
const DEFAULT_DB = path.resolve(__dirname, '..', '..', 'data', 'agent.db');

let dbInstance = null;

export function openDb(file = process.env.HP_DB || DEFAULT_DB) {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_hash TEXT UNIQUE,
      source TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL DEFAULT '',
      collected_at TEXT NOT NULL,
      metrics TEXT NOT NULL DEFAULT '{}',
      quality_score REAL NOT NULL DEFAULT 0,
      engagement REAL NOT NULL DEFAULT 0,
      source_tier INTEGER NOT NULL DEFAULT 4,
      flags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_items_collected ON items(collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);

    CREATE TABLE IF NOT EXISTS topics(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      summary_zh TEXT NOT NULL DEFAULT '',
      why_hot TEXT NOT NULL DEFAULT '',
      base_score REAL NOT NULL DEFAULT 0,
      engagement_total INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      evidence_tier TEXT NOT NULL DEFAULT 'weak',
      source_count INTEGER NOT NULL DEFAULT 1,
      authority_count INTEGER NOT NULL DEFAULT 0,
      has_official INTEGER NOT NULL DEFAULT 0,
      primary_label TEXT NOT NULL DEFAULT '',
      primary_host TEXT NOT NULL DEFAULT '',
      primary_url TEXT NOT NULL DEFAULT '',
      top_metrics TEXT NOT NULL DEFAULT '{}',
      published_first TEXT NOT NULL DEFAULT '',
      published_last TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic_items(
      topic_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      PRIMARY KEY(topic_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS watches(
      term TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_hit_at TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS scopes(
      label TEXT PRIMARY KEY,
      queries TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verdicts(
      term TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      relevant INTEGER NOT NULL DEFAULT 0,
      genuine INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      screened_at TEXT NOT NULL,
      PRIMARY KEY(term, item_id)
    );
    CREATE TABLE IF NOT EXISTS scans(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      queries TEXT NOT NULL DEFAULT '[]',
      stats TEXT NOT NULL DEFAULT '{}'
    );
  `);
  dbInstance = db;
  return db;
}

export const closeDb = () => {
  dbInstance?.close();
  dbInstance = null;
};

export function dbPath() {
  return process.env.HP_DB || DEFAULT_DB;
}

const now = () => new Date().toISOString();

/**
 * 条目落库（raw_hash 冲突即视为"已见过"）。
 * @returns {{id:number, isNew:boolean}}
 */
export function upsertItem(item) {
  const db = openDb();
  const existed = db.prepare('SELECT id FROM items WHERE raw_hash=?').get(item.raw_hash);
  if (existed) return { id: Number(existed.id), isNew: false };
  const r = db
    .prepare(
      `INSERT INTO items(raw_hash,source,url,host,title,summary,author,published_at,collected_at,metrics,quality_score,engagement,source_tier,flags)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      item.raw_hash,
      item.source,
      item.url,
      item.host || '',
      item.title,
      item.summary || '',
      item.author || '',
      item.published_at || '',
      item.collected_at || now(),
      JSON.stringify(item.metrics || {}),
      item.quality_score ?? 0,
      Math.round(item.engagement ?? 0),
      item.source_tier ?? 4,
      JSON.stringify(item.quality_flags || [])
    );
  return { id: Number(r.lastInsertRowid), isNew: true };
}

export function getItem(id) {
  const r = openDb().prepare('SELECT * FROM items WHERE id=?').get(id);
  return r ? hydrateItem(r) : null;
}

const hydrateItem = (r) => ({
  ...r,
  metrics: safeJson(r.metrics, {}),
  flags: safeJson(r.flags, []),
  quality_flags: safeJson(r.flags, []),
});

function safeJson(s, def) {
  try {
    return JSON.parse(s || '') ?? def;
  } catch {
    return def;
  }
}

/** 本轮新入库的条目 id（供 Claude 判定与聚类，旧条目不重复消耗注意力） */
export function recentNewIds(sinceIso) {
  const rows = openDb()
    .prepare('SELECT id FROM items WHERE collected_at>=? ORDER BY id')
    .all(sinceIso);
  return rows.map((r) => Number(r.id));
}

export function watchExists(term) {
  return Boolean(openDb().prepare('SELECT term FROM watches WHERE term=?').get(term));
}

export function addWatch(term) {
  const db = openDb();
  const existed = db.prepare('SELECT term FROM watches WHERE term=?').get(term);
  if (existed) return { term, isNew: false };
  db.prepare('INSERT INTO watches(term,created_at) VALUES(?,?)').run(term, now());
  return { term, isNew: true };
}

export const removeWatch = (term) => {
  const db = openDb();
  db.prepare('DELETE FROM verdicts WHERE term=?').run(term);
  return db.prepare('DELETE FROM watches WHERE term=?').run(term).changes > 0;
};

export function listWatches() {
  return openDb()
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM verdicts v WHERE v.term=w.term AND v.relevant=1 AND v.genuine=1) AS hit_count
       FROM watches w ORDER BY w.created_at DESC`
    )
    .all();
}

/** AI 判定结果落库（含被过滤项，便于事后追溯误杀） */
export function saveVerdict({ term, item_id, relevant, genuine, confidence, reason }) {
  const db = openDb();
  const passed = Boolean(relevant && genuine);
  db.prepare(
    `INSERT INTO verdicts(term,item_id,relevant,genuine,confidence,reason,screened_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(term,item_id) DO UPDATE SET relevant=excluded.relevant, genuine=excluded.genuine,
       confidence=excluded.confidence, reason=excluded.reason, screened_at=excluded.screened_at`
  ).run(term, item_id, relevant ? 1 : 0, genuine ? 1 : 0, confidence ?? 0, reason || '', now());
  // 命中要回写盯梢时间，否则"上次命中"永远是空
  if (passed) db.prepare('UPDATE watches SET last_hit_at=? WHERE term=?').run(now(), term);
}

export function listVerdicts(term, { onlyPassed = true, limit = 100 } = {}) {
  const db = openDb();
  const rows = onlyPassed
    ? db
        .prepare(
          `SELECT v.*, i.title,i.url,i.source,i.host,i.published_at,i.collected_at,i.metrics,i.engagement,i.quality_score,i.author,i.summary
           FROM verdicts v JOIN items i ON i.id=v.item_id
           WHERE v.term=? AND v.relevant=1 AND v.genuine=1 ORDER BY v.screened_at DESC LIMIT ?`
        )
        .all(term, limit)
    : db
        .prepare(
          `SELECT v.*, i.title,i.url,i.source,i.host,i.published_at,i.collected_at,i.metrics,i.engagement,i.quality_score,i.author,i.summary
           FROM verdicts v JOIN items i ON i.id=v.item_id
           WHERE v.term=? ORDER BY v.screened_at DESC LIMIT ?`
        )
        .all(term, limit);
  return rows.map((r) => ({ ...r, metrics: safeJson(r.metrics, {}), passed: r.relevant === 1 && r.genuine === 1 }));
}

/**
 * 话题落库：cluster_key 命中即并入（跨轮次同一事件不重复开话题）。
 * 分数由代码合成（AI 只给基线分），并按证据等级封顶——AI 无法自我抬分。
 * 主体硬校验：条目必须提及话题主体，否则拒绝并入（防"话题黑洞"）。
 */
export function upsertTopic(topic, g = undefined) {
  const db = openDb();
  const itemIds = (topic.item_ids || []).filter((id) => getItem(id));
  if (!itemIds.length) return { skipped: '无有效条目' };

  const items = itemIds.map(getItem);
  const tokens = subjectTokens(topic.title);
  const matched = items.filter((it) => itemMatchesSubject(it, tokens));
  if (!matched.length) return { skipped: `主体不匹配（${tokens.join('/')}）` };

  const ev = evidenceOf(matched, g);
  const final = combineScore(topic.score, ev.engagement_total, ev, g);
  const stamp = now();

  const existing = db.prepare('SELECT * FROM topics WHERE cluster_key=?').get(topic.cluster_key);
  const summary = summarizeTopic(matched.map((it) => ({ ...it, metrics: it.metrics })));

  if (existing) {
    // 并入既有话题：只增不减，避免同一事件被拆成两个话题
    const prevIds = new Set(db.prepare('SELECT item_id FROM topic_items WHERE topic_id=?').all(existing.id).map((r) => Number(r.item_id)));
    const prevItems = prevIds.size
      ? db.prepare(`SELECT * FROM items WHERE id IN (${[...prevIds].map(() => '?').join(',')})`).all(...prevIds).map(hydrateItem)
      : [];
    const allItems = [...prevItems, ...matched.filter((m) => !prevIds.has(m.id))];
    const evAll = evidenceOf(allItems, g);
    const finalAll = combineScore(Math.max(Number(existing.base_score) || 0, Number(topic.score) || 0), evAll.engagement_total, evAll, g);
    const sumAll = summarizeTopic(allItems);
    const dates = allItems.map((it) => it.published_at).filter(Boolean).sort();

    db.prepare(
      `UPDATE topics SET title=?, summary_zh=?, why_hot=?, base_score=?, engagement_total=?, score=?,
        evidence_tier=?, source_count=?, authority_count=?, has_official=?, primary_label=?, primary_host=?,
        primary_url=?, top_metrics=?, published_first=?, published_last=?, scope=?, updated_at=? WHERE id=?`
    ).run(
      topic.title || existing.title,
      topic.summary_zh || existing.summary_zh,
      topic.why_hot || existing.why_hot,
      finalAll.base,
      evAll.engagement_total,
      finalAll.score,
      finalAll.tier,
      evAll.source_count,
      sumAll.authorityCount,
      evAll.has_official,
      sumAll.primaryLabel,
      sumAll.primaryHost,
      sumAll.primaryUrl,
      JSON.stringify(sumAll.metrics || {}),
      dates[0] || '',
      dates[dates.length - 1] || '',
      topic.scope || existing.scope,
      stamp,
      existing.id
    );
    const ins = db.prepare('INSERT OR IGNORE INTO topic_items(topic_id,item_id) VALUES(?,?)');
    for (const m of matched) if (!prevIds.has(m.id)) ins.run(existing.id, m.id);
    return { id: Number(existing.id), updated: true, score: finalAll.score, tier: finalAll.tier, capped: finalAll.capped };
  }

  const dates = matched.map((it) => it.published_at).filter(Boolean).sort();
  const r = db
    .prepare(
      `INSERT INTO topics(cluster_key,title,summary_zh,why_hot,base_score,engagement_total,score,evidence_tier,
        source_count,authority_count,has_official,primary_label,primary_host,primary_url,top_metrics,
        published_first,published_last,scope,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      topic.cluster_key,
      topic.title,
      topic.summary_zh || '',
      topic.why_hot || '',
      final.base,
      ev.engagement_total,
      final.score,
      final.tier,
      ev.source_count,
      summary.authorityCount,
      ev.has_official,
      summary.primaryLabel,
      summary.primaryHost,
      summary.primaryUrl,
      JSON.stringify(summary.metrics || {}),
      dates[0] || '',
      dates[dates.length - 1] || '',
      topic.scope || '',
      stamp,
      stamp
    );
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT OR IGNORE INTO topic_items(topic_id,item_id) VALUES(?,?)');
  for (const m of matched) ins.run(id, m.id);
  return { id, created: true, score: final.score, tier: final.tier, capped: final.capped };
}

/** 话题的来源/互动/发布轴摘要（复用 quality.summarizeSources） */
const summarizeTopic = (items) => summarizeSources(items, { max: 2 });

const SORTERS = {
  score: (a, b) => b.score - a.score || (b.engagement_total || 0) - (a.engagement_total || 0),
  updated: (a, b) => Date.parse(b.published_last || b.updated_at) - Date.parse(a.published_last || a.updated_at) || b.score - a.score,
  sources: (a, b) => (b.source_count || 1) - (a.source_count || 1) || b.score - a.score,
  engagement: (a, b) => (b.engagement_total || 0) - (a.engagement_total || 0) || b.score - a.score,
};

const STRONG = new Set(['official', 'media_cross', 'viral_social']);

/** 话题查询：筛选 + 排序（口径对齐服务端 /api/topics） */
export function listTopics(opts = {}) {
  const db = openDb();
  let rows = db.prepare('SELECT * FROM topics').all().map((t) => ({
    ...t,
    top_metrics: safeJson(t.top_metrics, {}),
    item_ids: db.prepare('SELECT item_id FROM topic_items WHERE topic_id=?').all(t.id).map((r) => r.item_id),
  }));

  if (opts.q) {
    const needle = String(opts.q).toLowerCase().trim();
    rows = rows.filter((t) => `${t.title} ${t.summary_zh} ${t.why_hot}`.toLowerCase().includes(needle));
  }
  if (opts.scope) rows = rows.filter((t) => t.scope === opts.scope);
  if (opts.tier === 'strong') rows = rows.filter((t) => STRONG.has(t.evidence_tier));
  else if (opts.tier === 'weak') rows = rows.filter((t) => !STRONG.has(t.evidence_tier));
  else if (opts.tier) rows = rows.filter((t) => t.evidence_tier === opts.tier);
  if (opts.sources) {
    const want = String(opts.sources).split(',').map((s) => s.trim()).filter(Boolean);
    rows = rows.filter((t) =>
      db.prepare('SELECT i.source FROM topic_items ti JOIN items i ON i.id=ti.item_id WHERE ti.topic_id=?').all(t.id).some((r) => want.includes(r.source))
    );
  }
  if (opts.hours) {
    const cutoff = Date.now() - opts.hours * 3600000;
    rows = rows.filter((t) => {
      const axis = Date.parse(t.published_last || '') || Date.parse(t.updated_at) || 0;
      return axis >= cutoff;
    });
  }
  if (opts.min_score) rows = rows.filter((t) => Number(t.score) >= Number(opts.min_score));

  rows.sort(SORTERS[opts.sort] || SORTERS.score);
  const total = rows.length;
  const limit = Math.min(Number(opts.limit) || 10, 200);
  const offset = Math.max(0, Number(opts.offset) || 0);
  return { rows: rows.slice(offset, offset + limit), total, offset, limit, weak_count: rows.filter((t) => !STRONG.has(t.evidence_tier)).length };
}

export function getTopic(idOrKey) {
  const db = openDb();
  const t = /^\d+$/.test(String(idOrKey))
    ? db.prepare('SELECT * FROM topics WHERE id=?').get(Number(idOrKey))
    : db.prepare('SELECT * FROM topics WHERE cluster_key=?').get(String(idOrKey));
  if (!t) return null;
  const items = db
    .prepare('SELECT i.* FROM topic_items ti JOIN items i ON i.id=ti.item_id WHERE ti.topic_id=? ORDER BY i.id DESC')
    .all(t.id)
    .map(hydrateItem)
    .sort((a, b) => (Date.parse(b.published_at || b.collected_at) || 0) - (Date.parse(a.published_at || a.collected_at) || 0));
  return { ...t, top_metrics: safeJson(t.top_metrics, {}), items };
}

/** 关注范围（F2 范围热点）：label 主键，queries 为检索词数组 */
export function addScope(label, queries) {
  const db = openDb();
  const qs = (Array.isArray(queries) && queries.length ? queries : [label]).map((q) => String(q).trim()).filter(Boolean);
  const existed = db.prepare('SELECT label FROM scopes WHERE label=?').get(label);
  if (existed) {
    db.prepare('UPDATE scopes SET queries=? WHERE label=?').run(JSON.stringify(qs), label);
    return { label, queries: qs, updated: true };
  }
  db.prepare('INSERT INTO scopes(label,queries,created_at) VALUES(?,?,?)').run(label, JSON.stringify(qs), now());
  return { label, queries: qs, created: true };
}

export const removeScope = (label) => openDb().prepare('DELETE FROM scopes WHERE label=?').run(label).changes > 0;

export function listScopes() {
  return openDb()
    .prepare('SELECT * FROM scopes ORDER BY created_at DESC')
    .all()
    .map((r) => ({ ...r, queries: safeJson(r.queries, []) }));
}

/** 全部检索词 = 盯梢关键词 + 各范围 queries（采集层的 allQueries） */
export function allQueries() {
  const db = openDb();
  const terms = db.prepare('SELECT term FROM watches').all().map((r) => r.term);
  const scopeQ = db
    .prepare('SELECT queries FROM scopes')
    .all()
    .flatMap((r) => safeJson(r.queries, []));
  return [...new Set([...terms, ...scopeQ])];
}

export function recordScan({ queries, stats }) {  openDb().prepare('INSERT INTO scans(started_at,queries,stats) VALUES(?,?,?)').run(now(), JSON.stringify(queries || []), JSON.stringify(stats || {}));
}

export function listScans(limit = 10) {
  return openDb()
    .prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, queries: safeJson(r.queries, []), stats: safeJson(r.stats, {}) }));
}

/** 给 Claude 的工作集：按 id 取条目（判定与聚类都要引用 id，所以必须显式给） */
export function getItemsByIds(ids) {
  const list = (ids || []).filter((id) => Number.isFinite(Number(id)));
  if (!list.length) return [];
  return openDb()
    .prepare(`SELECT * FROM items WHERE id IN (${list.map(() => '?').join(',')})`)
    .all(...list.map(Number))
    .map(hydrateItem);
}

/** 既有话题的 cluster_key 清单：让 Claude 复用 key，而不是每轮重新发明 */
export function existingClusterKeys(limit = 60) {
  return openDb()
    .prepare('SELECT cluster_key, title, score, evidence_tier, updated_at FROM topics ORDER BY updated_at DESC LIMIT ?')
    .all(limit);
}

export function stats() {
  const db = openDb();
  const one = (sql) => Number(db.prepare(sql).get()?.c || 0);
  return {
    items: one('SELECT COUNT(*) c FROM items'),
    topics: one('SELECT COUNT(*) c FROM topics'),
    verdicts: one('SELECT COUNT(*) c FROM verdicts'),
    watches: one('SELECT COUNT(*) c FROM watches'),
    scans: one('SELECT COUNT(*) c FROM scans'),
    by_source: db.prepare('SELECT source, COUNT(*) c FROM items GROUP BY source ORDER BY c DESC').all(),
  };
}

export function resetAll() {
  const db = openDb();
  for (const t of ['topic_items', 'topics', 'verdicts', 'items', 'watches', 'scans']) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('items','topics','scans')");
}
