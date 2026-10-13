import pLimit from 'p-limit';
import { fetchTextRetry } from '../util/http.js';
import { parseFeedItems } from '../util/feed.js';
import { normItem, withinWindow } from './normalize.js';

/** 用代理感知的 fetchText 拉取，再交给统一解析器（rss-parser 自身 http 不走 undici 代理） */
async function parseFeed(url) {
  const xml = await fetchTextRetry(url, {
    timeout: 20000,
    tries: 3,
    headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
  });
  return parseFeedItems(xml);
}

/** 官方博客白名单（一手官宣，可信度最高；2026-09 实测可用） */
const FEEDS = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
  { name: 'DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Mistral', url: 'https://mistral.ai/rss.xml' },
  { name: 'HF Blog', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'LangChain', url: 'https://www.langchain.com/blog/rss.xml' },
  { name: 'MIT TR AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
];

export async function collect(ctx) {
  const limit = pLimit(3); // 并发拉取，单源失败不影响其他
  const results = await Promise.all(
    FEEDS.map((f) =>
      limit(async () => {
        try {
          const itemsRaw = await parseFeed(f.url);
          const items = [];
          for (const item of itemsRaw.slice(0, 15)) {
            const it = normItem({
              source: 'blog',
              url: item.link,
              title: item.title,
              summary: (item.contentSnippet || '').slice(0, 500),
              author: f.name,
              published_at: item.isoDate,
            });
            if (it && withinWindow(it, ctx.sinceIso)) items.push(it);
          }
          ctx.log('blog', f.name, `${items.length} new`);
          return items;
        } catch (e) {
          ctx.log('blog', f.name, String(e.message || e).split('\n')[0]);
          return [];
        }
      })
    )
  );
  return results.flat().slice(0, 80);
}
