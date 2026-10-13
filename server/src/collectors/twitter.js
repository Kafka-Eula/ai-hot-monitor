import { config } from '../config.js';
import { fetchJson } from '../util/http.js';
import { normItem, withinWindow } from './normalize.js';

/**
 * Twitter/X — twitterapi.io（第三方 API，X-API-Key 认证，按次计费）。
 * 未配置 key 自动禁用；每轮扫描调用次数受 TWITTER_MAX_CALLS_PER_SCAN 限制（控费）。
 */
export async function collect(ctx) {
  if (!config.twitter.apiKey) {
    ctx.log('twitter', '-', '未配置 TWITTERAPI_IO_KEY，跳过');
    return [];
  }
  let budget = config.twitter.maxCallsPerScan;
  const out = [];
  const since = Math.floor((ctx.windowStartMs ?? Date.now() - 3 * 3600e3) / 1000);
  for (const q of ctx.allQueries) {
    if (budget <= 0) break;
    budget--;
    try {
      const query = `"${q}" min_faves:20 lang:en since_time:${since}`;
      const j = await fetchJson(
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Top&cursor=`,
        { timeout: 20000, headers: { 'X-API-Key': config.twitter.apiKey } }
      );
      let count = 0;
      for (const t of (j.tweets || []).slice(0, 8)) {
        if (t.isReply) continue;
        const it = normItem({
          source: 'twitter',
          url: t.url,
          title: (t.text || '').replace(/\s+/g, ' ').slice(0, 280),
          summary: (t.text || '').slice(0, 800),
          author: t.user?.screenName ? `@${t.user.screenName}` : '',
          published_at: t.createdAt,
          metrics: { likes: t.likeCount, rts: t.retweetCount, views: t.viewCount, replies: t.replyCount },
        });
        if (it) {
          out.push(it);
          count++;
        }
      }
      ctx.log('twitter', q, `${count} tweets`);
    } catch (e) {
      ctx.log('twitter', q, e.message);
    }
  }
  return out.filter((it) => withinWindow(it, ctx.sinceIso)).slice(0, 60);
}
