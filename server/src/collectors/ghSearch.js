import { fetchJson, sleep } from '../util/http.js';
import { normItem } from './normalize.js';

/**
 * GitHub Search API — 近 7 天新建仓库按 star 排序（免 key，未登录限 10 次/分钟）。
 * 替代脆弱的 trending 页面爬虫：trending 保留作交叉源，这里提供"新仓库爆发"的可靠信号。
 * stars 硬门槛默认 100，在质量层统一判定。
 */
export async function collect(ctx) {
  const queries = ctx.allQueries.slice(0, 6);
  const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const j = await fetchJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+created:>${date}&sort=stars&order=desc&per_page=10`,
        { timeout: 20000, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
      );
      let count = 0;
      for (const r of j.items || []) {
        const it = normItem({
          source: 'gh_search',
          url: r.html_url,
          title: `${r.full_name}: ${r.description || ''}`.trim(),
          summary: (r.description || '').slice(0, 400),
          author: r.language || '',
          published_at: r.created_at,
          metrics: { stars: r.stargazers_count, forks: r.forks_count },
        });
        if (it) {
          out.push(it);
          count++;
        }
      }
      ctx.log('gh_search', q, `${count} repos`);
    } catch (e) {
      ctx.log('gh_search', q, String(e.message || e).slice(0, 80));
    }
    // 未登录搜索限 10 次/分钟
    if (i < queries.length - 1) await sleep(6500);
  }
  return out.slice(0, 40);
}
