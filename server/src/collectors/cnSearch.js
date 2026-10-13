import * as cheerio from 'cheerio';
import { fetchTextRetry, sleep } from '../util/http.js';
import { normItem } from './normalize.js';
import { parseCnDate } from '../util/cnDate.js';

/**
 * 中文新闻搜索 —— 360 新闻搜索（news.so.com），免 API Key。
 *
 * 为什么只用这一个引擎（2026-10 逐个实测）：
 *  - 百度：返回「百度安全验证」拦截页，0 结果；
 *  - Bing 中文 / Sogou 通用**网页**搜索：搜产品名返回字典释义页、公司官网首页、
 *    百度百科、App 下载页（如"智的拼音部首"），不是新闻，实测 48 条 0 通过；
 *  - Bing News RSS：中文市场参数失效，返回英文旅游新闻；
 *  - 搜狗微信文章搜索：/link 跳转包装且结果多为 2023 年旧文；
 *  - 360 新闻搜索：直接给出**原文真实 URL**（无跳转包装）+ 结构化媒体名 + 相对时间，
 *    且是新鲜 AI 报道（新浪财经/每经网/界面新闻…）。
 * 结论：垂直「新闻」搜索才是对的入口，通用网页搜索不适合做热点源。
 *
 * 权威性由质量层域名白名单二次把关：网易号/搜狐号等自媒体转载仍会被拦。
 * 频率红线：每扫描 ≤ 8 查询，间隔 ≥ 3s。
 */
const ANTI_BOT = /安全验证|请输入验证码|访问过于频繁|unusual traffic/;
const TRACKING_HOST = /so\.com$|360tres|q\.so\.com/i;

/** 从 URL 路径提取日期（媒体站 URL 常含 /2026-10-13/ 或 /articles/2026-10-08/） */
function dateFromUrl(url) {
  const m =
    /\/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(url) ||
    /\/(20\d{2})(\d{2})(\d{2})\//.exec(url);
  if (!m) return '';
  const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 解析一条 li.res-list；失败返回 null */
function parseItem($, el) {
  const e = $(el);
  // 站外原文链接（360 不做 /link 包装）
  let href = '';
  e.find('a').each((_, a) => {
    if (href) return;
    const h = $(a).attr('href') || '';
    if (/^https?:/i.test(h) && !TRACKING_HOST.test(h)) href = h;
  });
  if (!href) return null;

  // 标题优先取 .g-txt-inner（锚文本可能被高亮标签截断）
  const title = (e.find('.g-txt-inner').first().text() || e.find('a').first().text())
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 8) return null;

  const publisher = e.find('cite.sitename').first().text().trim();
  const timeText = e.find('span.time').first().text().trim();
  const published_at = parseCnDate(timeText) || dateFromUrl(href);

  // 摘要：条目全文去掉标题/媒体/时间后剩余的正文段
  let summary = e.text().replace(/\s+/g, ' ').trim();
  for (const junk of [title, publisher, timeText]) {
    if (junk) summary = summary.replace(junk, ' ');
  }
  summary = summary.replace(/\s+/g, ' ').trim();

  const host = hostOf(href);
  if (!host) return null;
  return { href, host, title, publisher, summary, published_at };
}

export async function collect(ctx) {
  const queries = ctx.allQueries.slice(0, 8);
  const out = [];
  const seen = new Set();

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const url = `https://news.so.com/ns?q=${encodeURIComponent(q)}&src=tab_www`;
      const html = await fetchTextRetry(url, {
        timeout: 15000,
        tries: 2,
        headers: { Referer: 'https://www.so.com/' },
      });
      if (ANTI_BOT.test(html)) throw new Error('触发验证页，跳过');
      const $ = cheerio.load(html);
      let count = 0;

      $('li.res-list').each((_, el) => {
        if (count >= 10) return false;
        const it = parseItem($, el);
        if (!it || seen.has(it.href)) return;
        seen.add(it.href);
        const norm = normItem({
          source: 'cn_search',
          url: it.href,
          host: it.host,
          title: it.title,
          summary: it.summary.slice(0, 400),
          author: it.publisher || it.host,
          published_at: it.published_at,
        });
        if (norm) {
          out.push(norm);
          count++;
        }
      });
      ctx.log('cn_search', `360news:${q}`, `${count} hits`);
    } catch (err) {
      ctx.log('cn_search', `360news:${q}`, String(err.message || err).slice(0, 70));
    }
    if (i < queries.length - 1) await sleep(3000 + Math.random() * 1500);
  }
  return out.slice(0, 50);
}
