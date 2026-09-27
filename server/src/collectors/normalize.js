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
  return {
    source: partial.source,
    url,
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
