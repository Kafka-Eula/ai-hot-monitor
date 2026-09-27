import webpush from 'web-push';
import { config } from '../config.js';
import db, { getSetting } from '../db.js';
import { toPushSubscription } from '../util/pushKey.js';

export function pushConfigured() {
  return Boolean(config.vapid.publicKey && config.vapid.privateKey);
}

let inited = false;
function init() {
  if (inited || !pushConfigured()) return;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  inited = true;
}

export function pushEnabled() {
  return pushConfigured() && getSetting('notify.webpush.enabled') !== false;
}

export function publicKey() {
  return config.vapid.publicKey || '';
}

export function saveSub(sub) {
  db.prepare(
    `INSERT INTO push_subs(endpoint,keys,created_at) VALUES(?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys`
  ).run(sub.endpoint, JSON.stringify(sub.keys || {}), new Date().toISOString());
}

export function dropSub(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint);
}

export function subCount() {
  return db.prepare('SELECT COUNT(*) c FROM push_subs').get().c;
}

/** 向所有订阅者推送；自动清理失效订阅（410/404） */
export async function pushAll(payload) {
  init();
  if (!pushEnabled()) return { skipped: true, reason: 'push_disabled' };
  const subs = db.prepare('SELECT endpoint,keys FROM push_subs').all();
  if (!subs.length) return { skipped: true, reason: 'no_subscribers' };
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) => webpush.sendNotification(toPushSubscription(s.endpoint, s.keys), body))
  );
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++;
    else {
      const code = r.reason?.statusCode;
      if (code === 410 || code === 404) {
        dropSub(subs[i].endpoint);
        console.log('[push] 清理失效订阅');
      } else {
        console.warn('[push] 发送失败:', r.reason?.message || code);
      }
    }
  });
  return { ok, total: subs.length };
}
