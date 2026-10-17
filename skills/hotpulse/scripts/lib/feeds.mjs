/**
 * 零依赖 RSS/Atom 解析器。
 *
 * 服务端用 cheerio + rss-parser；这里必须只用 Node 内置能力，所以直接做块级正则解析。
 * 够用即可：热点条目只需要 title / link / 时间 / 摘要 / 媒体名，
 * 而 RSS 的 <item> 与 Atom 的 <entry> 结构非常稳定。
 *
 * 与 feed.js 的关键对齐点：<source url="..."> 要能取到——Google News 只给重定向链接，
 * 真实媒体域名全靠这个属性，丢了它就没法做权威域名判定。
 */

/** 修复未转义的 & 与未加引号的属性值（部分中文站/Reddit 常见） */
export function sanitizeXml(xml) {
  return String(xml)
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g, '&amp;')
    .replace(/(<[\w:.-]+(?:\s+[\w:.-]+)*)\s+([\w:.-]+)=([^\s"'`>]+)(?=[\s/>])/g, '$1 $2="$3"');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * 清洗顺序很关键（实测踩过两个坑）：
 * 1) 先解包 CDATA——否则 `<![CDATA[标题]]>` 整段会被"去标签"正则当成一个标签吞掉
 *    （OpenAI RSS 就是这样 1296 条标题全空）；
 * 2) 再解实体——中文站把正文 HTML 二次编码成 `&lt;p&gt;`，先去标签就永远去不掉
 *    （IT之家就是这样摘要里全是标签）；
 * 3) 去标签；4) 再解一次实体，兜住双重编码残留。
 */
export function textify(raw) {
  let s = String(raw ?? '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

const stripTags = textify;

/** 取块内第一个指定标签的原始内容（支持带命名空间的标签名） */
function pick(block, ...names) {
  for (const n of names) {
    if (!/^[\w:.-]+$/.test(n)) continue; // 跳过 'author > name' 这类非法标签名
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (m && m[1].trim()) return m[1];
  }
  return '';
}

/** Atom 的 <author><name>X</name></author> 嵌套形式 */
function pickNested(block, outer, inner) {
  const o = new RegExp(`<${outer}(?:\\s[^>]*)?>([\\s\\S]*?)</${outer}>`, 'i').exec(block);
  return o ? pick(o[1], inner) : '';
}

/** 取属性，例如 <link href="..."> / <source url="..."> */
function attr(block, tag, name) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, 'i').exec(block);
  return m ? m[1] : '';
}

function iso(dateLike) {
  const t = Date.parse(stripTags(dateLike));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

/**
 * @param {string} xml 原文
 * @returns {Array<{title,link,isoDate,contentSnippet,publisher,sourceUrl,author}>}
 */
export function parseFeedItems(xml) {
  const cleaned = sanitizeXml(xml);
  const blocks = [...cleaned.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);

  const out = [];
  for (const b of blocks) {
    // Atom 用 <link rel="alternate" href>，RSS 用 <link>文本</link>；两种都要能吃下
    const linkHref = (() => {
      for (const l of b.matchAll(/<link\b([^>]*)>/gi)) {
        const a = l[1];
        if (/rel="alternate"/i.test(a) || !/rel=/.test(a)) {
          const href = /\bhref="([^"]*)"/i.exec(a)?.[1];
          if (href) return href;
        }
      }
      return '';
    })();

    const titleRaw = pick(b, 'title');
    const link = linkHref || stripTags(pick(b, 'link', 'guid', 'id'));
    const content = pick(b, 'content:encoded', 'description', 'summary', 'content');
    // Google News 的 <source url="https://..."> 给出真实媒体域名
    const sourceBlock = /<source\b[^>]*>[\s\S]*?<\/source>/i.exec(b)?.[0] || '';

    if (!titleRaw && !link) continue;
    out.push({
      title: stripTags(titleRaw),
      link,
      isoDate: iso(pick(b, 'pubDate', 'updated', 'published', 'dc:date', 'date')),
      contentSnippet: stripTags(content),
      publisher: stripTags(sourceBlock),
      sourceUrl: attr(sourceBlock, 'source', 'url'),
      author: pick(b, 'dc:creator', 'creator') || pickNested(b, 'author', 'name'),
    });
  }
  return out;
}
