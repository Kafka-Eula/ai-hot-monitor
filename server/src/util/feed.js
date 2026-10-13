/**
 * RSS/Atom 统一解析（三级降级）：
 * 1) rss-parser（标准 XML）
 * 2) cheerio xmlMode（Reddit Atom 含未引号属性导致 xml2js 报错时）
 * 3) 正则兜底（结构大幅变更时至少不崩）
 * 统一输出：{title, link, isoDate, contentSnippet, publisher, sourceUrl, author, _raw}
 */
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';

const parser = new Parser();

/** 宽松修复：未转义的 & 与未引号属性值 */
export function sanitizeXml(xml) {
  return xml
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g, '&amp;')
    .replace(/(<[\w:.-]+(?:\s+[\w:.-]+)*)\s+([\w:.-]+)=([^\s"'\u0060>]+)(?=[\s/>])/g, '$1 $2="$3"');
}

function iso(dateLike) {
  const t = Date.parse(dateLike || '');
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

function fromCheerio(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  const items = $('item').length ? $('item') : $('entry');
  items.each((_, el) => {
    const e = $(el);
    // 命名空间选择器必须转义冒号（dc:creator → dc\\:creator），否则 css-select 抛错；再兜一层 try
    const text = (...names) => {
      for (const n of names) {
        try {
          const v = e.find(n).first().text().trim();
          if (v) return v;
        } catch {
          /* 非法选择器跳过 */
        }
      }
      return '';
    };
    const linkHref = e.find('link').first().attr('href') || '';
    const linkText = e.find('link').first().text().trim();
    const content = text('content\\:encoded', 'description', 'content', 'summary');
    out.push({
      title: text('title'),
      link: linkHref || linkText || text('guid', 'id'),
      isoDate: iso(text('pubDate', 'updated', 'published', 'dc:date', 'date')),
      contentSnippet: content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      publisher: text('source'),
      sourceUrl: e.find('source').first().attr('url') || '',
      author: text('author > name', 'dc:creator', 'creator'),
      _raw: e.html() || '',
    });
  });
  return out;
}

function fromRegex(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)[\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const title = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1]?.replace(/<[^>]+>/g, '').trim();
    const link = /<link[^>]*href="([^"]+)"/.exec(block)?.[1] || /<link[^>]*>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
    const pub = /<(?:pubDate|updated|published)>?([^<]+)</.exec(block)?.[1]?.trim();
    if (!title) continue;
    out.push({
      title,
      link: link || '',
      isoDate: iso(pub),
      contentSnippet: '',
      publisher: /<source[^>]*>([^<]+)<\/source>/.exec(block)?.[1] || '',
      sourceUrl: /<source url="([^"]+)"/.exec(block)?.[1] || '',
      author: '',
      _raw: block,
    });
  }
  return out;
}

/**
 * @param {string} xml RSS/Atom 原文
 * @returns {Promise<Array>} 条目数组（解析失败返回空数组）
 */
export async function parseFeedItems(xml) {
  const cleaned = sanitizeXml(xml);
  // cheerio 优先：同时兼容 RSS(<item>) 与 Atom(<entry>)，且能拿到 <source url> 权威域名
  try {
    const items = fromCheerio(cleaned);
    if (items.length) return items;
  } catch {
    /* fallthrough */
  }
  try {
    const feed = await parser.parseString(cleaned);
    const items = (feed.items || []).map((it) => ({
      title: it.title || '',
      link: it.link || '',
      isoDate: it.isoDate || iso(it.pubDate),
      contentSnippet: (it.contentSnippet || it.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      publisher: typeof it.source === 'string' ? it.source : '',
      sourceUrl: '',
      author: it.creator || it.author || '',
      _raw: it.content || '',
    }));
    if (items.length) return items;
  } catch {
    /* fallthrough */
  }
  return fromRegex(cleaned);
}

export default parseFeedItems;
