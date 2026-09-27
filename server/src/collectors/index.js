import pLimit from 'p-limit';
import * as hackernews from './hackernews.js';
import * as githubTrending from './githubTrending.js';
import * as hfPapers from './hfPapers.js';
import * as blogs from './blogs.js';
import * as webSearch from './webSearch.js';
import * as twitter from './twitter.js';

export const SOURCES = [
  { name: 'hn', fn: hackernews.collect },
  { name: 'gh_trending', fn: githubTrending.collect },
  { name: 'hf_papers', fn: hfPapers.collect },
  { name: 'blog', fn: blogs.collect },
  { name: 'web_search', fn: webSearch.collect },
  { name: 'twitter', fn: twitter.collect },
];

/**
 * 并发执行全部信息源（并发≤2，单源失败不影响其他）。
 * @param ctx { allQueries, sinceIso, windowStartMs, log }
 * @returns { items, stats }
 */
export async function collectAll(ctx) {
  const limit = pLimit(2);
  const stats = {};
  const jobs = SOURCES.map((s) =>
    limit(async () => {
      const t0 = Date.now();
      try {
        const items = (await s.fn(ctx)) || [];
        stats[s.name] = { ok: true, count: items.length, ms: Date.now() - t0 };
        return items;
      } catch (e) {
        stats[s.name] = { ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 };
        return [];
      }
    })
  );
  const results = await Promise.all(jobs);
  return { items: results.flat(), stats };
}
