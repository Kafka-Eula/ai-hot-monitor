import { Router } from 'express';
import db from '../db.js';
import { runScan, scheduleInfo, isScanning } from '../scheduler.js';
import { aiStatus, listModels } from '../ai/openrouter.js';
import { publicKey, saveSub, dropSub, pushAll, pushConfigured, subCount } from '../notify/webpush.js';
import { notify } from '../notify/index.js';
import { emailReady } from '../notify/mailer.js';

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
      `SELECT h.*, i.title, i.url, i.source, i.published_at, i.summary
       FROM hits h JOIN items i ON i.id=h.item_id
       WHERE h.keyword_id=? ORDER BY h.screened_at DESC LIMIT 200`
    )
    .all(req.params.id);
  res.json(rows.map((r) => ({ ...r, passed: r.relevant === 1 && r.genuine === 1 })));
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
api.get('/topics', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db
    .prepare('SELECT * FROM topics ORDER BY score DESC, last_updated DESC LIMIT ?')
    .all(limit);
  res.json(rows.map(parseTopic));
});

api.get('/items', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 120, 300);
  const since = req.query.since; // ISO
  const rows = since
    ? db
        .prepare('SELECT id,source,url,title,author,published_at,collected_at,metrics FROM items WHERE collected_at>=? ORDER BY id DESC LIMIT ?')
        .all(since, limit)
    : db
        .prepare('SELECT id,source,url,title,author,published_at,collected_at,metrics FROM items ORDER BY id DESC LIMIT ?')
        .all(limit);
  const bySource = db.prepare('SELECT source, COUNT(*) c FROM items GROUP BY source').all();
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
  res.json({ ...topic, items });
});

function parseTopic(t) {
  return { ...t, item_ids: JSON.parse(t.item_ids || '[]') };
}

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
  res.json({ ...info, running: isScanning(), recent });
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
