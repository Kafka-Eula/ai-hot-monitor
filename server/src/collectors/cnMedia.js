import { fetchText } from '../util/http.js';
import { parseFeedItems } from '../util/feed.js';
import { normItem } from './normalize.js';

/**
 * 中文/亚洲视角 AI 媒体 RSS（免 key，2026-10 实测返回合法 XML）。
 * 机器之心（jiqizhixin.com/rss）与 36氪 已改为 SPA 不再输出 RSS，故不接入。
 * 全局源（抓最新条目后按 scope queries 本地过滤），媒体域名在 AUTHORITY_HOSTS 白名单内，
 * 由质量层评分判定。
 */
const FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed' },
  { name: '极客公园', url: 'https://www.geekpark.net/rss' },
  { name: '雷锋网', url: 'https://www.leiphone.com/feed' },
  { name: 'Synced', url: 'https://www.syncedreview.com/feed/' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed' },
];

/** 标题/摘要需命中任一查询词（忽略大小写与空格变体）才保留 */
function matchesQuery(item, queries) {
  if (!queries.length) return true;
  const text = `${item.title} ${item.summary}`.toLowerCase().replace(/\s+/g, ' ');
  return queries.some((q) => {
    const s = q.toLowerCase().trim();
    return s && (text.includes(s) || text.includes(s.replace(/\s+/g, '-')));
  });
}

export async function collect(ctx) {
  const queries = ctx.allQueries;
  const out = [];
  for (const f of FEEDS) {
    try {
      const xml = await fetchText(f.url, {
        timeout: 20000,
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      });
      if (!/^\s*<(\?xml|rss|feed)/i.test(xml)) throw new Error('非 XML（结构变更或被拦截）');
      const items = await parseFeedItems(xml);
      let count = 0;
      for (const it of items.slice(0, 20)) {
        if (!it.title || !it.link) continue;
        const n = normItem({
          source: 'cn_media',
          url: it.link,
          title: it.title,
          summary: (it.contentSnippet || '').slice(0, 500),
          author: f.name,
          published_at: it.isoDate,
          metrics: {},
        });
        if (n && matchesQuery(n, queries)) {
          out.push(n);
          count++;
        }
      }
      ctx.log('cn_media', f.name, `${count} new`);
    } catch (e) {
      ctx.log('cn_media', f.name, String(e.message || e).split('\n')[0].slice(0, 80));
    }
  }
  return out.slice(0, 60);
}
