import { fetchText, sleep } from '../util/http.js';
import { parseFeedItems } from '../util/feed.js';
import { normItem } from './normalize.js';

/**
 * Reddit — AI 相关 subreddit 的当日热榜（公开 .rss，免 key）。
 * 注意：.json 端点被 Reddit 封锁（403/429），.rss 间歇可用，故设计为"尽力而为"：
 * 单版块失败不影响其他；score 取 Atom 扩展 <news:population>，门槛在质量层统一判定。
 */
const SUBREDDITS = ['singularity', 'LocalLLaMA', 'MachineLearning', 'OpenAI'];

function extractScore(raw) {
  const m = /<(?:news:)?population>(\d+)</.exec(raw || '');
  return m ? Number(m[1]) : 0;
}

export async function collect(ctx) {
  const out = [];
  for (const sub of SUBREDDITS) {
    try {
      const xml = await fetchText(`https://www.reddit.com/r/${sub}/top.rss?t=day&limit=25`, {
        timeout: 15000,
        headers: { Accept: 'application/atom+xml,application/xml,text/xml,*/*' },
      });
      if (!/^\s*<(\?xml|feed)/i.test(xml)) throw new Error('非 XML（可能被限流）');
      const items = await parseFeedItems(xml);
      let count = 0;
      for (const it of items) {
        if (!it.title || !it.link) continue;
        const n = normItem({
          source: 'reddit',
          url: it.link.startsWith('https://www.reddit.com') ? it.link : `https://www.reddit.com${it.link}`,
          title: it.title,
          summary: (it.contentSnippet || '').slice(0, 400),
          author: it.author || `r/${sub}`,
          published_at: it.isoDate,
          metrics: { score: extractScore(it._raw) },
        });
        if (n) {
          out.push(n);
          count++;
        }
      }
      ctx.log('reddit', sub, `${count} posts`);
    } catch (e) {
      ctx.log('reddit', sub, String(e.message || e).slice(0, 80));
    }
    await sleep(1500 + Math.random() * 1000);
  }
  return out.slice(0, 50);
}
