import { fetchTextRetry } from '../util/http.js';
import { parseFeedItems } from '../util/feed.js';
import { normItem } from './normalize.js';

/**
 * 多引擎新闻搜索：Google News RSS（英/中）+ Bing News RSS。
 * 免 key、带真实媒体域名（Google 的 <source url>、Bing 的 url= 参数）与发布时间，
 * 比 DuckDuckGo 泛搜索质量高一档。频率红线：每查询间隔 ≥2s，每扫描 ≤8 查询。
 */
const FEEDS = [
  { engine: 'gnews', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en` },
  { engine: 'gnews-zh', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans` },
  { engine: 'bing', url: (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss` },
];

/** Bing apiclick 链接解包出真实媒体 URL */
function unwrapBing(link) {
  try {
    const u = new URL(link);
    const real = u.searchParams.get('url');
    if (real) return real;
  } catch {
    /* ignore */
  }
  return link;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Google News 标题尾部 " - 媒体名" 拆出来当 author */
function splitPublisher(title, publisher) {
  if (publisher) return { title, author: publisher };
  const m = /^(.*?)\s+-\s+([^-|]{2,40})$/.exec(title);
  if (m && m[2]) return { title: m[1], author: m[2] };
  return { title, author: '' };
}

export async function collect(ctx) {
  const queries = ctx.allQueries.slice(0, 8);
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    for (const f of FEEDS) {
      try {
        const xml = await fetchTextRetry(f.url(q), {
          timeout: 15000,
          tries: 2,
          headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        });
        const items = await parseFeedItems(xml);
        let count = 0;
        for (const it of items.slice(0, 6)) {
          if (!it.title || !it.link) continue;
          const isBing = f.engine === 'bing';
          const realHost = isBing ? hostOf(unwrapBing(it.link)) : hostOf(it.sourceUrl);
          // Google News 只给重定向链接（唯一，可点开原文），媒体真实域名取自 <source url>
          const url = isBing ? unwrapBing(it.link) : it.link;
          if (!realHost) continue; // 拿不到媒体域名就无法做权威判定，丢弃
          const { title, author } = splitPublisher(it.title, it.publisher || '');
          const n = normItem({
            source: 'news_search',
            url,
            host: realHost,
            title,
            summary: (it.contentSnippet || '').slice(0, 400),
            author: author || it.author || f.engine,
            published_at: it.isoDate,
            metrics: {},
          });
          if (n) {
            out.push(n);
            count++;
          }
        }
        ctx.log('news_search', `${f.engine}:${q}`, `${count} hits`);
      } catch (e) {
        ctx.log('news_search', `${f.engine}:${q}`, String(e.message || e).slice(0, 80));
      }
    }
    if (i < queries.length - 1) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
  }
  return out.slice(0, 60);
}
