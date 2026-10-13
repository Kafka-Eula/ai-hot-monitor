import * as cheerio from 'cheerio';
import { fetchText, sleep } from '../util/http.js';
import { normItem } from './normalize.js';

/**
 * DuckDuckGo HTML 端点（无 API key 的通用网页搜索）。
 * 频率红线：每次扫描 ≤ 10 查询、查询间隔 ≥ 3s。
 */
export async function collect(ctx) {
  const queries = ctx.allQueries.slice(0, 10);
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const term = /ai/i.test(q) ? q : `${q} AI`;
    try {
      // df=w：只看最近一周，配合质量层域名门槛过滤陈旧内容
      const html = await fetchText(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(term)}&df=w`,
        { timeout: 15000 }
      );
      const $ = cheerio.load(html);
      let count = 0;
      $('.result').each((_, el) => {
        if (count >= 5) return false;
        const $el = $(el);
        const a = $el.find('a.result__a').first();
        let href = a.attr('href') || '';
        const title = a.text().trim();
        if (!href || !title) return;
        // DDG 重定向链接解包
        const m = /uddg=([^&]+)/.exec(href);
        if (m) href = decodeURIComponent(m[1]);
        if (href.includes('duckduckgo.com')) return;
        const snip = $el.find('.result__snippet').first().text().trim();
        const it = normItem({
          source: 'web_search',
          url: href,
          title,
          summary: snip.slice(0, 400),
          author: 'ddg',
        });
        if (it) {
          out.push(it);
          count++;
        }
      });
      ctx.log('web_search', q, `${count} hits`);
    } catch (e) {
      ctx.log('web_search', q, e.message);
    }
    if (i < queries.length - 1) await sleep(3000 + Math.random() * 1500);
  }
  return out.slice(0, 50);
}
