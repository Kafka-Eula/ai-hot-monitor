import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

/**
 * Node 24 内置 node:sqlite（零原生依赖）。
 * 迁移原因：better-sqlite3 v11/v12 在 Node 24 下随机触发原生 GC 析构断言崩溃
 * （RemoveEnvironmentCleanupHook / Statement destructor）。
 */
export const db = new DatabaseSync(config.dbFile);

// ---- better-sqlite3 风格兼容层 ----
db.pragma = (sql) => {
  try {
    const r = db.prepare(`PRAGMA ${sql}`).get();
    return r ? Object.values(r)[0] : undefined;
  } catch {
    db.exec(`PRAGMA ${sql}`);
    return undefined;
  }
};
db.transaction = (fn) => {
  const wrapped = (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  };
  wrapped.deferred = wrapped;
  return wrapped;
};

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  author TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  metrics TEXT DEFAULT '{}',
  raw_hash TEXT UNIQUE NOT NULL,
  collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_collected ON items(collected_at);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT UNIQUE NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_hit_at TEXT
);

CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  relevant INTEGER NOT NULL,
  genuine INTEGER NOT NULL,
  confidence REAL DEFAULT 0,
  reason TEXT DEFAULT '',
  screened_at TEXT NOT NULL,
  UNIQUE(keyword_id, item_id)
);

CREATE TABLE IF NOT EXISTS scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE NOT NULL,
  queries TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER,
  title TEXT NOT NULL,
  summary_zh TEXT DEFAULT '',
  why_hot TEXT DEFAULT '',
  score REAL DEFAULT 0,
  item_ids TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  cluster_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_topics_updated ON topics(last_updated DESC);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  stats TEXT,
  ok INTEGER
);
`);

// 迁移：旧库补列
const cols = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!cols.includes('ai_done')) db.exec('ALTER TABLE items ADD COLUMN ai_done INTEGER DEFAULT 0');

// ---------- settings helpers ----------
const getStmt = db.prepare('SELECT value FROM settings WHERE key=?');
const setStmt = db.prepare(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
);

export function getSetting(key, def = undefined) {
  const row = getStmt.get(key);
  if (!row) return def;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  setStmt.run(key, JSON.stringify(value));
}

export function allSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

/** 读取数值型设置（settings 优先，回退 .env config） */
export function settingNum(key, fallback) {
  const v = getSetting(key);
  return v === undefined || v === null || v === '' ? fallback : Number(v);
}

export default db;
