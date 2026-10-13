import { sleep } from '../util/http.js';
import { normItem } from './normalize.js';

/**
 * Lobsters — 高质量技术策展（公开 JSON，免 key）。
 * 取 ai / ml / programming 标签的 hottest 榜，score 硬门槛在质量层统一判定。
 */
export async function collect(ctx) {
  const out = [];
  // /t/<tag>.json 是该标签最新条目（hottest 子路径 404），低分条目由 score 硬门槛拦截
  for (const tag of ['ai', 'ml', 'programming']) {
    try {
      const res = await fetch(`https://lobste.rs/t/${tag}.json`, {
        headers: { 'User-Agent': 'HotPulse/0.1 (personal hotspot monitor)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      let count = 0;
      for (const s of Array.isArray(j) ? j : []) {
        const url = s.url || `https://lobste.rs/s/${s.short_id}`;
        const it = normItem({
          source: 'lobsters',
          url,
          title: s.title,
          summary: (s.description || '').replace(/<[^>]+>/g, ' ').slice(0, 400),
          author: s.user,
          published_at: s.created_at,
          metrics: { score: s.score, comments: s.comment_count },
        });
        if (it) {
          out.push(it);
          count++;
        }
      }
      ctx.log('lobsters', tag, `${count} stories`);
    } catch (e) {
      ctx.log('lobsters', tag, String(e.message || e).slice(0, 80));
    }
    await sleep(1200);
  }
  return out.slice(0, 40);
}
