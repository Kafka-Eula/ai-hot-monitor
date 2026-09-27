import { fetchJson } from '../util/http.js';
import { normItem, withinWindow } from './normalize.js';

/** Hacker News — Algolia 公开 API，免 key */
export async function collect(ctx) {
  const queries = ctx.allQueries.slice(0, 8);
  const out = [];
  for (const q of queries) {
    try {
      const j = await fetchJson(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=8&numericFilters=created_at_i>${Math.floor((ctx.windowStartMs ?? 0) / 1000)}`
      );
      for (const h of j.hits || []) {
        const it = normItem({
          source: 'hn',
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title,
          summary: (h.story_text || '').slice(0, 300),
          author: h.author,
          published_at: h.created_at,
          metrics: { points: h.points, comments: h.num_comments },
        });
        if (it) out.push(it);
      }
    } catch (e) {
      ctx.log('hn', q, e.message);
    }
  }
  return out.filter((it) => withinWindow(it, ctx.sinceIso)).slice(0, 60);
}
