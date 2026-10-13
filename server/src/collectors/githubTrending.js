import * as cheerio from 'cheerio';
import { fetchText } from '../util/http.js';
import { normItem } from './normalize.js';

/**
 * GitHub Trending（daily）— 网页爬虫，全局源（不按关键词，交给 AI 聚类判断相关性）。
 * 只用 stars_today（当日新增）作为热度信号：总星数对新库毫无区分度，
 * tensorflow/vscode 这类常驻榜的老仓库会被门槛直接拦掉。
 */
export async function collect(ctx) {
  const html = await fetchText('https://github.com/trending?since=daily', { timeout: 20000 });
  const $ = cheerio.load(html);
  const out = [];
  $('article.Box-row').each((_, el) => {
    const $el = $(el);
    const href = $el.find('h2 a').attr('href') || '';
    const name = $el.find('h2 a').text().trim().replace(/\s+/g, '');
    if (!name) return;
    const desc = $el.find('p').first().text().trim();
    const stars = Number($el.find('a[href$="/stargazers"]').first().text().trim().replace(/,/g, '')) || 0;
    const lang = $el.find('[itemprop="programmingLanguage"]').first().text().trim();
    // "stars today"（增量）是 trending 真正的信号，总量 stars 对新库无区分度
    const starsTodayText = $el.find('span.d-inline-block.float-sm-right').first().text() || $el.find('[class*="float-sm-right"]').first().text();
    const stars_today = Number((starsTodayText.match(/([\d,]+)\s+stars?\s+today/i) || [])[1]?.replace(/,/g, '')) || 0;
    const forks = Number($el.find('a[href$="/forks"]').first().text().trim().replace(/,/g, '')) || 0;
    const it = normItem({
      source: 'gh_trending',
      url: `https://github.com${href}`,
      title: name,
      summary: desc,
      author: lang,
      metrics: { stars, stars_today, forks },
    });
    if (it) out.push(it);
  });
  ctx.log('gh_trending', '-', `${out.length} repos`);
  return out.slice(0, 25);
}
