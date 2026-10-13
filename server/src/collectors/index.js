import pLimit from 'p-limit';
import * as hackernews from './hackernews.js';
import * as githubTrending from './githubTrending.js';
import * as ghSearch from './ghSearch.js';
import * as hfPapers from './hfPapers.js';
import * as blogs from './blogs.js';
import * as newsSearch from './newsSearch.js';
import * as cnSearch from './cnSearch.js';
import * as cnMedia from './cnMedia.js';
import * as lobsters from './lobsters.js';
import * as twitter from './twitter.js';

/**
 * 启用中的信息源。
 *
 * 精简依据（近 6 轮扫描实测统计，2026-10-13）：
 *  - reddit：抓取 200 条 → 入库 **0 条**（top.rss 间歇 429，且社区帖互动门槛全拦），
 *    纯耗时无产出 → 摘除；采集器 collectors/reddit.js 保留可再启用；
 *  - web_search（DuckDuckGo 泛网页搜索）：45 条 → 入库 19 条，但**每条有效结果耗时 4.1s**
 *    （其余源均 ≤0.6s），且结果多为 SEO 站/官网首页 → 摘除；
 *    中文由 cn_search(360新闻)、英文由 news_search(Google/Bing News RSS) 覆盖，信息不丢。
 * 保留的 10 源里，hn/lobsters 虽然入库少但抓取便宜（≤6s）且常有一手深度帖，留着。
 */
export const SOURCES = [
  { name: 'hn', fn: hackernews.collect },
  { name: 'gh_trending', fn: githubTrending.collect },
  { name: 'gh_search', fn: ghSearch.collect },
  { name: 'hf_papers', fn: hfPapers.collect },
  { name: 'blog', fn: blogs.collect },
  { name: 'news_search', fn: newsSearch.collect },
  { name: 'cn_search', fn: cnSearch.collect },
  { name: 'cn_media', fn: cnMedia.collect },
  { name: 'lobsters', fn: lobsters.collect },
  { name: 'twitter', fn: twitter.collect },
];

/**
 * 并发执行全部信息源（并发≤2，单源失败不影响其他）。
 * @param ctx { allQueries, sinceIso, windowStartMs, log }
 * @returns { items, stats }
 */
export async function collectAll(ctx) {
  // 并发 4：各源打的是不同站点（HF/HN/GitHub/Google/360/lobsters…），互不共享限流域；
  // 单源内部仍有自己的 sleep 节奏（如 cn_search 每查询 ≥3s），不会触发对方风控。
  const limit = pLimit(4);
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
