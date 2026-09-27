import db from '../db.js';
import { publish } from './sse.js';
import { pushAll } from './webpush.js';
import { sendMail } from './mailer.js';

/** 同类通知 5 分钟内去重，避免轰炸 */
const THROTTLE_MS = 5 * 60000;

function throttled(title) {
  const since = new Date(Date.now() - THROTTLE_MS).toISOString();
  const row = db
    .prepare('SELECT id FROM notices WHERE title=? AND created_at>? ORDER BY id DESC LIMIT 1')
    .get(title, since);
  return Boolean(row);
}

/**
 * 创建站内通知并分发（SSE → Web Push → 邮件）。
 * @param {{kind:string,title:string,body?:string,link?:string,emailHtml?:string}} n
 */
export async function notify(n) {
  if (!n?.title) return null;
  if (throttled(n.title)) {
    console.log(`[notify] 跳过（5分钟内重复）: ${n.title}`);
    return null;
  }
  const now = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO notices(kind,title,body,link,read,created_at) VALUES(?,?,?,?,0,?)')
    .run(n.kind || 'system', n.title, n.body || '', n.link || '', now);
  const notice = { id: Number(r.lastInsertRowid), kind: n.kind, title: n.title, body: n.body, link: n.link, created_at: now, read: 0 };

  // 实时广播给打开的页面
  publish('notice', notice);

  // 浏览器系统推送
  pushAll({ title: n.title, body: n.body || '', link: n.link || '/', id: notice.id }).catch((e) =>
    console.warn('[push] all failed:', e.message)
  );

  // 邮件
  if (n.emailHtml !== false) {
    sendMail({ subject: `[HotPulse] ${n.title}`, html: emailHtml(n) }).catch(() => {});
  }
  return notice;
}

function emailHtml(n) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:auto;padding:24px;background:#0a0f1a;color:#c9d6e8;border-radius:12px">
  <div style="font-size:12px;letter-spacing:2px;color:#3ef2a5">HOTPULSE · AI 热点雷达</div>
  <h2 style="margin:10px 0;color:#fff">${escapeHtml(n.title)}</h2>
  <p style="line-height:1.7;color:#a9b8cc;white-space:pre-wrap">${escapeHtml(n.body || '')}</p>
  ${n.link ? `<p><a href="${escapeHtml(absLink(n.link))}" style="color:#3ef2a5">在控制台查看详情 →</a></p>` : ''}
  <hr style="border:none;border-top:1px solid #16233a;margin:18px 0" />
  <div style="font-size:12px;color:#5a6b85">由本机 HotPulse 自动发送 · 可在设置页关闭邮件通知</div>
</div>`;
}

function absLink(link) {
  if (/^https?:/.test(link)) return link;
  return `http://localhost:${process.env.PORT || 4117}${link.startsWith('/') ? '' : '/'}${link}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export default notify;
