import crypto from 'node:crypto';
import { toIso } from '../util/http.js';

/** 统一条目格式与去重 hash */
export function normItem(partial) {
  const url = (partial.url || '').trim();
  const title = (partial.title || '').trim().replace(/\s+/g, ' ');
  if (!url && !title) return null;
  const hash = crypto
    .createHash('sha1')
    .update(url || title)
    .digest('hex');
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    /* 无 URL 时留空 */
  }
  // 聚合类源（如 Google News 只给重定向链接）可显式提供真实媒体域名
  if (partial.host) host = String(partial.host).toLowerCase().replace(/^www\./, '');
  return {
    source: partial.source,
    url,
    host,
    title: title.slice(0, 500),
    summary: (partial.summary || '').trim().slice(0, 2000),
    author: (partial.author || '').slice(0, 120),
    published_at: toIso(partial.published_at),
    metrics: JSON.stringify(partial.metrics || {}),
    raw_hash: hash,
  };
}

/** 只保留 since 之后发布的条目（since 为空则全保留，由调用方限量） */
export function withinWindow(item, sinceIso) {
  if (!sinceIso) return true;
  if (!item.published_at) return true; // 无时间戳的保留（如 trending）
  return item.published_at >= sinceIso;
}
