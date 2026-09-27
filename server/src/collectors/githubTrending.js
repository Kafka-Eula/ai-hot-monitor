import * as cheerio from 'cheerio';
import { fetchText } from '../util/http.js';
import { normItem } from './normalize.js';

/** GitHub Trending（hourly）— 网页爬虫，全局源（不按关键词，交给 AI 聚类判断相关性） */
export async function collect(ctx) {
  const html = await fetchText('https://github.com/trending?since=hourly', { timeout: 20000 });
  const $ = cheerio.load(html);
  const out = [];
  $('article.Box-row').each((_, el) => {
    const $el = $(el);
    const href = $el.find('h2 a').attr('href') || '';
    const name = $el.find('h2 a').text().trim().replace(/\s+/g, '');
    if (!name) return;
    const desc = $el.find('p').first().text().trim();
    const stars = $el.find('a[href$="/stargazers"]').first().text().trim().replace(/,/g, '');
    const lang = $el.find('[itemprop="programmingLanguage"]').first().text().trim();
    const it = normItem({
      source: 'gh_trending',
      url: `https://github.com${href}`,
      title: name,
      summary: desc,
      author: lang,
      metrics: { stars },
    });
    if (it) out.push(it);
  });
  ctx.log('gh_trending', '-', `${out.length} repos`);
  return out.slice(0, 25);
}
