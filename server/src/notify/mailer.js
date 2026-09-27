import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { getSetting } from '../db.js';

let transporter = null;

function enabled() {
  // 设置页可关闭；默认配了 SMTP 就开
  const flag = getSetting('notify.email.enabled');
  if (flag === false) return false;
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.smtp.to);
}

function getTransport() {
  if (!enabled()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

export function emailReady() {
  return enabled();
}

/** 发送 HTML 邮件；失败仅记录，不抛（通知不应阻塞主流程） */
export async function sendMail({ subject, html }) {
  const t = getTransport();
  if (!t) return { skipped: true, reason: 'email_disabled' };
  try {
    const info = await t.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: config.smtp.to,
      subject,
      html,
    });
    console.log('[mail] sent:', info.messageId);
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.warn('[mail] 发送失败:', e.message);
    return { ok: false, error: e.message };
  }
}
