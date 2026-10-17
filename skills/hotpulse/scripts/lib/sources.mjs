/**
 * 零依赖信息源采集层（从 server/src/collectors/*.js 移植）。
 *
 * 与服务端的差别只有三处，其余口径（门槛、限频、真实域名提取）完全对齐：
 * 1) 用内置 undici 代替 npm undici；
 * 2) 用 lib/feeds.mjs 的正则解析代替 cheerio + rss-parser；
 * 3) GitHub Trending 与 360 新闻的 HTML 抽取用定向正则代替 cheerio 选择器。
 *
 * 摘除的源（与需求文档 v1.x 结论一致）：
 *   - reddit：抓 200 条入库 0 条，纯耗时；
 *   - web_search(DuckDuckGo)：每条有效结果 4.1s，且多为 SEO 站/官网首页；
 *   - twitter：twitterapi.io 按次计费，与"零配置零费用"目标冲突。
 * 中文新闻由 cn_search(360) 覆盖，英文由 news_search(Google/Bing) 覆盖，信息不丢。
 */
import crypto from 'node:crypto';
import { fetchText, fetchTextRetry, fetchJson, sleep, pLimit, toIso } from './net.mjs';
import { parseFeedItems, textify } from './feeds.mjs';
import { normalizeHost } from './quality.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 HotPulse/1.0';

/**
 * 清洗隐形/零宽字符。中文媒体与 B站标题里混有 U+200B~U+200F、U+2060~U+2064、
 * U+FEFF 等不可见字符（实测条目"‌‌⁤…刚刚，Gemini 4"整段是零宽字符 + 真标题），
 * 不清掉会污染展示、干扰去重 hash 与主体匹配。
 */
const stripInvisible = (s) =>
  String(s || '')
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 统一条目格式与去重 hash（对齐 collectors/normalize.js） */
export function normItem(partial) {
  const url = (partial.url || '').trim();
  const title = stripInvisible(partial.title);
  if (!url && !title) return null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    /* 无 URL 时留空 */
  }
  // 聚合类源（Google News 只给重定向链接）显式提供真实媒体域名
  if (partial.host) host = String(partial.host).toLowerCase().replace(/^www\./, '');
  return {
    id: null, // 由 state 层落库时分配
    source: partial.source,
    url,
    host,
    title: title.slice(0, 500),
    summary: stripInvisible(partial.summary).slice(0, 2000),
    author: stripInvisible(partial.author).slice(0, 120),
    published_at: partial.published_at || '',
    metrics: partial.metrics || {},
    raw_hash: crypto.createHash('sha1').update(url || title).digest('hex'),
  };
}

const withinWindow = (item, sinceIso) => {
  if (!sinceIso) return true;
  if (!item.published_at) return true; // 无时间戳的保留（如 trending）
  return item.published_at >= sinceIso;
};

/** 标题/摘要需命中任一查询词（忽略大小写与空格变体） */
function matchesQuery(item, queries) {
  if (!queries.length) return true;
  const text = `${item.title} ${item.summary}`.toLowerCase().replace(/\s+/g, ' ');
  return queries.some((q) => {
    const s = String(q).toLowerCase().trim();
    return s && (text.includes(s) || text.includes(s.replace(/\s+/g, '-')));
  });
}

// ---------------- S1 Hacker News ----------------

async function collectHn(ctx) {
  const out = [];
  for (const q of (ctx.allQueries || []).slice(0, 8)) {
    try {
      const j = await fetchJson(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=8` +
          `&numericFilters=created_at_i>${Math.floor((ctx.windowStartMs ?? 0) / 1000)}`
      );
      for (const h of j.hits || []) {
        const it = normItem({
          source: 'hn',
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title,
          summary: h.story_text ? textify(h.story_text).slice(0, 400) : '',
          author: h.author,
          // Algolia 的 created_at 是 ISO 字符串（"2026-10-15T05:31:11Z"），
          // 另有 created_at_i 是秒级时间戳——两种都兼容，别做乘法（会得到 NaN）
          published_at: toIso(h.created_at || (h.created_at_i ? h.created_at_i * 1000 : '')),
          metrics: { points: h.points || 0, comments: h.num_comments || 0 },
        });
        if (it && withinWindow(it, ctx.sinceIso)) out.push(it);
      }
      ctx.log('hn', q, `${(j.hits || []).length} 条`);
    } catch (e) {
      ctx.log('hn', q, String(e.message || e).slice(0, 70));
    }
    await sleep(300);
  }
  return out.slice(0, 60);
}

// ---------------- S2 GitHub Trending（HTML 正则抽取） ----------------

/**
 * 没有 cheerio，所以按"仓库块"切分再逐块取值。
 * 结构特征（2026-10 实测）：<article class="Box-row"> 内含
 *   h3>a[href] 仓库链接、<p> 描述、a[ href$=/stargazers ]>svg+数字、
 *   a[ href$=/forks ]>svg+数字、[itemprop=programmingLanguage] 语言、
 *   span.float-sm-right "1,552 stars today"（在块尾部，约 1 万字符处，不能截断）。
 * 星数要从"去掉标签后的锚点文本"取：锚点内含 svg <path d="坐标…">，
 * 直接 match /[\d,]+/ 会抓到路径坐标而不是星数。
 */
function parseTrendingHtml(html) {
  const articles = String(html)
    .split(/<article\b[^>]*\bclass="[^"]*Box-row[^"]*"[^>]*>/i)
    .slice(1)
    .map((a) => a.split(/<\/article>/i)[0]);

  /** 锚点内去掉标签后的第一个数字 */
  const anchorNum = (chunk, suffix) => {
    const m = new RegExp(`href="\\/[^"]+\\/${suffix}"[\\s\\S]*?<\\/a>`, 'i').exec(chunk);
    if (!m) return 0;
    const txt = textify(m[0].replace(/^[\s\S]*?>/, ''));
    return Number(txt.replace(/,/g, '').match(/\d+/)?.[0]) || 0;
  };

  const out = [];
  for (const chunk of articles) {
    const href = /<h3[\s\S]*?<a[^>]*href="(\/[^"]+)"/i.exec(chunk)?.[1] || /<h2[\s\S]*?<a[^>]*href="(\/[^"]+)"/i.exec(chunk)?.[1];
    if (!href) continue;
    const nameBlock = /<h[23][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(chunk)?.[1] || '';
    const name = textify(nameBlock).replace(/\s+/g, '');
    if (!name) continue;
    const desc = textify(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)?.[1] || '').slice(0, 500);
    const lang = textify(/itemprop="programmingLanguage"[^>]*>([^<]+)</i.exec(chunk)?.[1] || '');
    // 当日新增才是 trending 真正的信号：tensorflow/vscode 这类常驻榜老库的总星数无区分度
    const tail = /class="[^"]*float-sm-right[^"]*"[\s\S]*?<\/span>/i.exec(chunk)?.[0] || '';
    const stars_today = Number(textify(tail).replace(/,/g, '').match(/(\d+)\s*stars?\s*(today|this week|this month)/i)?.[1]) || 0;

    out.push({
      source: 'gh_trending',
      url: `https://github.com${href}`,
      title: name,
      summary: desc,
      author: lang,
      // published_at 留空：trending 是快照榜，网页无发布时间；下方补真实建库时间
      metrics: { stars: anchorNum(chunk, 'stargazers'), stars_today, forks: anchorNum(chunk, 'forks') },
    });
  }
  return out;
}

async function collectGhTrending(ctx) {
  const html = await fetchText('https://github.com/trending?since=daily', { timeout: 20000, tries: 2, headers: { 'User-Agent': UA } });
  const rows = parseTrendingHtml(html);
  ctx.log('gh_trending', '-', `${rows.length} repos`);
  return rows.slice(0, 25).map(normItem);
}

/** 调 repos API 补真实建库时间（前端按"建库于"展示，不参与互动加权） */
export async function enrichRepoCreated(items, log = () => {}) {
  const limit = pLimit(3);
  await Promise.all(
    items
      .filter((it) => /github\.com/.test(it.url) && !it.metrics?.created_at)
      .map((it) =>
        limit(async () => {
          const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(it.url);
          if (!m) return;
          try {
            const j = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2]}`, { tries: 2 });
            if (j.created_at) it.metrics.created_at = j.created_at;
          } catch (e) {
            log('gh_trending', `repo:${it.url}`, `meta 失败 ${String(e.message || e).slice(0, 40)}`);
          }
          await sleep(150);
        })
      )
  );
  return items;
}

// ---------------- S2b GitHub 新库 ----------------

async function collectGhSearch(ctx) {
  const out = [];
  const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const q of (ctx.allQueries || []).slice(0, 6)) {
    try {
      const j = await fetchJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+created:>${date}&sort=stars&order=desc&per_page=10`
      );
      for (const r of j.items || []) {
        const it = normItem({
          source: 'gh_search',
          url: r.html_url,
          title: r.full_name,
          summary: (r.description || '').slice(0, 500),
          author: r.language || '',
          published_at: r.created_at || '',
          metrics: { stars: r.stargazers_count || 0, forks: r.forks_count || 0, created_at: r.created_at },
        });
        if (it) out.push(it);
      }
      ctx.log('gh_search', q, `${(j.items || []).length} 个`);
    } catch (e) {
      ctx.log('gh_search', q, String(e.message || e).slice(0, 70));
    }
    await sleep(1000); // 未登录 API 限 10 次/分钟
  }
  return out.slice(0, 40);
}

// ---------------- S3 HuggingFace Papers ----------------

async function collectHfPapers(ctx) {
  const j = await fetchJson('https://huggingface.co/api/daily_papers?limit=50', { timeout: 20000 });
  const out = [];
  for (const p of Array.isArray(j) ? j : []) {
    const paper = p.paper || p;
    if (!paper?.id || !paper?.title) continue;
    out.push(
      normItem({
        source: 'hf_papers',
        url: `https://huggingface.co/papers/${paper.id}`,
        title: String(paper.title).replace(/\s+/g, ' ').trim(),
        summary: (paper.summary || p.title || '').replace(/\s+/g, ' ').slice(0, 500),
        author: (paper.authors || []).map((a) => a?.name).filter(Boolean).slice(0, 3).join(', '),
        published_at: paper.publishedAt || '',
        metrics: { upvotes: paper.upvotes || 0 },
      })
    );
  }
  ctx.log('hf_papers', '-', `${out.length} 篇`);
  return out;
}

// ---------------- S4 官方博客 RSS（一手官宣） ----------------

const BLOG_FEEDS = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
  { name: 'DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Mistral', url: 'https://mistral.ai/rss.xml' },
  { name: 'HF Blog', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'LangChain', url: 'https://www.langchain.com/blog/rss.xml' },
  { name: 'MIT TR AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
];

async function collectBlogs(ctx) {
  const limit = pLimit(3);
  const results = await Promise.all(
    BLOG_FEEDS.map((f) =>
      limit(async () => {
        try {
          const xml = await fetchTextRetry(f.url, {
            timeout: 20000,
            tries: 3,
            headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*', 'User-Agent': UA },
          });
          const items = [];
          for (const raw of parseFeedItems(xml).slice(0, 15)) {
            const it = normItem({
              source: 'blog',
              url: raw.link,
              title: raw.title,
              summary: raw.contentSnippet.slice(0, 500),
              author: f.name,
              published_at: raw.isoDate,
            });
            if (it && withinWindow(it, ctx.sinceIso)) items.push(it);
          }
          ctx.log('blog', f.name, `${items.length} new`);
          return items;
        } catch (e) {
          ctx.log('blog', f.name, String(e.message || e).split('\n')[0].slice(0, 70));
          return [];
        }
      })
    )
  );
  return results.flat().slice(0, 80);
}

// ---------------- S5b 新闻搜索（Google News 英/中 + Bing News RSS） ----------------

const NEWS_FEEDS = [
  { engine: 'gnews', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en` },
  { engine: 'gnews-zh', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans` },
  { engine: 'bing', url: (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss` },
];

/** Bing apiclick 链接解包出真实媒体 URL */
function unwrapBing(link) {
  try {
    const real = new URL(link).searchParams.get('url');
    if (real) return real;
  } catch {
    /* ignore */
  }
  return link;
}

/** Google News 标题尾部 " - 媒体名" 拆出来当 author */
function splitPublisher(title, publisher) {
  if (publisher) return { title, author: publisher };
  const m = /^(.*?)\s+-\s+([^-|]{2,40})$/.exec(title);
  if (m && m[2]) return { title: m[1], author: m[2] };
  return { title, author: '' };
}

async function collectNewsSearch(ctx) {
  const queries = (ctx.allQueries || []).slice(0, 8); // 频率红线：每扫描 ≤8 查询
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    for (const f of NEWS_FEEDS) {
      try {
        const xml = await fetchTextRetry(f.url(q), {
          timeout: 15000,
          tries: 2,
          headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*', 'User-Agent': UA },
        });
        let count = 0;
        for (const raw of parseFeedItems(xml).slice(0, 6)) {
          if (!raw.title || !raw.link) continue;
          const isBing = f.engine === 'bing';
          const url = isBing ? unwrapBing(raw.link) : raw.link;
          const realHost = normalizeHost(isBing ? url : raw.sourceUrl);
          // 拿不到媒体域名就无法做权威判定，丢弃（这是防假冒的关键一环）
          if (!realHost) continue;
          const { title, author } = splitPublisher(raw.title, raw.publisher || '');
          const n = normItem({
            source: 'news_search',
            url,
            host: realHost,
            title,
            summary: raw.contentSnippet.slice(0, 400),
            author: author || raw.author || f.engine,
            published_at: raw.isoDate,
          });
          if (n) {
            out.push(n);
            count++;
          }
        }
        ctx.log('news_search', `${f.engine}:${q}`, `${count} hits`);
      } catch (e) {
        ctx.log('news_search', `${f.engine}:${q}`, String(e.message || e).slice(0, 70));
      }
    }
    if (i < queries.length - 1) await sleep(2000 + Math.random() * 1000); // ≥2s 间隔
  }
  return out.slice(0, 60);
}

// ---------------- S5c 中文媒体 RSS（按查询词本地过滤） ----------------

const CN_FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: 'InfoQ中文', url: 'https://www.infoq.cn/feed' },
  { name: '极客公园', url: 'https://www.geekpark.net/rss' },
  { name: '雷锋网', url: 'https://www.leiphone.com/feed' },
  { name: 'Synced', url: 'https://www.syncedreview.com/feed/' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed' },
];

async function collectCnMedia(ctx) {
  const queries = ctx.allQueries || [];
  const out = [];
  for (const f of CN_FEEDS) {
    try {
      const xml = await fetchText(f.url, {
        timeout: 20000,
        tries: 2,
        headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', 'User-Agent': UA },
      });
      if (!/^\s*<(\?xml|rss|feed)/i.test(xml)) throw new Error('非 XML（结构变更或被拦截）');
      let count = 0;
      for (const raw of parseFeedItems(xml).slice(0, 20)) {
        if (!raw.title || !raw.link) continue;
        const n = normItem({
          source: 'cn_media',
          url: raw.link,
          title: raw.title,
          summary: raw.contentSnippet.slice(0, 500),
          author: f.name,
          published_at: raw.isoDate,
        });
        if (n && matchesQuery(n, queries)) {
          out.push(n);
          count++;
        }
      }
      ctx.log('cn_media', f.name, `${count} new`);
    } catch (e) {
      ctx.log('cn_media', f.name, String(e.message || e).split('\n')[0].slice(0, 70));
    }
    await sleep(400);
  }
  return out.slice(0, 60);
}

// ---------------- S5d Lobsters ----------------

async function collectLobsters(ctx) {
  const out = [];
  for (const tag of ['ai', 'ml', 'programming']) {
    try {
      const res = await fetch(`https://lobste.rs/t/${tag}.json`, {
        headers: { 'User-Agent': 'HotPulse/1.0 (personal hotspot monitor)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      let count = 0;
      for (const s of Array.isArray(j) ? j : []) {
        const it = normItem({
          source: 'lobsters',
          url: s.url || `https://lobste.rs/s/${s.short_id}`,
          title: s.title,
          summary: textify(s.description || '').slice(0, 400),
          author: s.user,
          published_at: s.created_at,
          metrics: { score: s.score, comments: s.comment_count },
        });
        if (it) {
          out.push(it);
          count++;
        }
      }
      ctx.log('lobsters', tag, `${count} stories`);
    } catch (e) {
      ctx.log('lobsters', tag, String(e.message || e).slice(0, 70));
    }
    await sleep(1200);
  }
  return out.slice(0, 40);
}

// ---------------- S5f 360 中文新闻搜索（HTML 正则抽取） ----------------

/** 中文相对时间："5 天之前"/"3 小时前"/"昨天" → ISO（对齐 util/cnDate.js） */
const RELATIVE = [
  { re: /(\d{1,4})\s*(秒|秒钟)/, mult: 1000 },
  { re: /(\d{1,4})\s*分(钟)?/, mult: 60000 },
  { re: /(\d{1,4})\s*(小时|个小时|h)/i, mult: 3600000 },
  { re: /(\d{1,4})\s*(天|日|天之前|天前|d)/i, mult: 86400000 },
  { re: /(\d{1,3})\s*(周|星期|weeks?)/i, mult: 7 * 86400000 },
  { re: /(\d{1,3})\s*(个?月|months?)/i, mult: 30 * 86400000 },
  { re: /(\d{1,3})\s*(年|years?)/i, mult: 365 * 86400000 },
];

export function parseCnDate(text, nowMs = Date.now()) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';

  // 绝对日期统一按 UTC 零点解析：结果只给到"日"，用 UTC 保证跨时区部署结果确定
  const abs = /(?:^|[^0-9])(20[2-4]\d)\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/.exec(s);
  if (abs) {
    const d = new Date(Date.UTC(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const ym = /(?:^|[^0-9])(20[2-4]\d)[-/.](\d{1,2})(?![-.\d])/.exec(s);
  if (ym) {
    const d = new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (/前天/.test(s)) return new Date(nowMs - 2 * 86400000).toISOString();
  if (/昨天|昨日/.test(s)) return new Date(nowMs - 86400000).toISOString();
  if (/今天|今日|刚刚/.test(s)) return new Date(nowMs).toISOString();
  for (const { re, mult } of RELATIVE) {
    const m = re.exec(s);
    if (m) return new Date(nowMs - Number(m[1]) * mult).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

const ANTI_BOT = /(安全验证|验证码|滑动验证|请完成下方验证|unusual traffic)/;

/** 从 URL 兜底提取日期（部分媒体把日期放进路径） */
function dateFromUrl(url) {
  const m = /(20\d{2})[-/](\d{2})[-/](\d{2})/.exec(String(url || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 360 新闻结果块抽取。没有 cheerio，所以按 res-list 块切分。
 * 结构特征（2026-10 实测）：<a> 在 <h3> **外层**（早期实现按 h3>a 找链接，结果恒为 0 条）：
 *   <li class="full-txt res-list pure-txt" data-url="…"><a href="…" title="…">
 *     <h3 class="g-title js-title"><div class="g-txt-inner g-ellipsis">标题<em>关键词</em></div></h3>
 *     <p class="summary g-ellipsis3">摘要</p>
 *     <cite class="sitename">媒体名</cite><span class="g-linkinfo-txt g-c-gray time">4分钟前</span>
 *   </a></li>
 */
function parse360Html(html) {
  const blocks = String(html)
    .split(/<li[^>]+class="[^"]*res-list[^"]*"[^>]*>/i)
    .slice(1)
    .map((b) => b.split(/<\/li>/i)[0]);

  const out = [];
  for (const chunk of blocks) {
    const href = /<a\b[^>]*href="(https?:[^"]+)"/i.exec(chunk)?.[1] || /data-url="(https?:[^"]+)"/i.exec(chunk)?.[1];
    if (!href) continue;
    // 标题优先取 h3 内文（带 <em> 高亮，需清洗），回退到 <a title> 属性
    const title =
      textify(/<h[3][\s\S]*?<\/h\d>/i.exec(chunk)?.[0] || '') ||
      textify(/<a\b[^>]*\btitle="([^"]*)"/i.exec(chunk)?.[1] || '');
    if (title.length < 8) continue;
    const publisher = textify(/class="sitename"[^>]*>([^<]{1,40})</i.exec(chunk)?.[1] || '');
    const timeText = textify(/class="[^"]*time[^"]*"[^>]*>([^<]{1,30})</i.exec(chunk)?.[1] || '');
    const published_at = parseCnDate(timeText) || dateFromUrl(href);
    const summary = textify(/<p[^>]*class="summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)?.[1] || '').slice(0, 400);
    const host = normalizeHost(href);
    if (!host) continue;
    out.push({ href, host, title, publisher, summary, published_at });
  }
  return out;
}

async function collectCnSearch(ctx) {
  const queries = (ctx.allQueries || []).slice(0, 8); // 每查询 ≥3s、每扫描 ≤8 查询
  const out = [];
  const seen = new Set();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const html = await fetchTextRetry(`https://news.so.com/ns?q=${encodeURIComponent(q)}&src=tab_www`, {
        timeout: 15000,
        tries: 2,
        headers: { Referer: 'https://www.so.com/', 'User-Agent': UA },
      });
      if (ANTI_BOT.test(html)) throw new Error('触发验证页，跳过');
      let count = 0;
      for (const it of parse360Html(html)) {
        if (count >= 10 || seen.has(it.href)) continue;
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
      }
      ctx.log('cn_search', `360news:${q}`, `${count} hits`);
    } catch (e) {
      ctx.log('cn_search', `360news:${q}`, String(e.message || e).slice(0, 70));
    }
    if (i < queries.length - 1) await sleep(3000 + Math.random() * 1500);
  }
  return out.slice(0, 80);
}

// ---------------- S7 Bilibili（互动数据最全的中文视频源） ----------------

/** 取首页 Cookie（buvid3）——搜索接口没有它会被 -412 拦 */
async function bootstrapCookie(log) {
  try {
    const res = await fetch('https://www.bilibili.com/', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookie = raw.map((c) => c.split(';')[0]).join('; ');
    if (cookie) log('bilibili', '-', `已获取 buvid 引导 Cookie(${raw.length} 项)`);
    return cookie;
  } catch (e) {
    log('bilibili', '-', `Cookie 引导失败：${String(e.message || e).slice(0, 60)}`);
    return '';
  }
}

/** B站搜索接口返回的标题带 <em class="keyword">…</em> 高亮标签，必须整对删掉（只删 /em> 会残留 <em） */
const cleanTitle = (t) => stripInvisible(String(t || '').replace(/<\/?em[^>]*>/gi, ''));

function biliItem(v, source) {
  if (!v) return null;
  const bvid = v.bvid || v.id || '';
  return normItem({
    source,
    url: v.arcurl || (bvid ? `https://www.bilibili.com/video/${bvid}` : ''),
    title: cleanTitle(v.title),
    summary: (v.description || v.desc || '').replace(/\s+/g, ' ').slice(0, 400),
    author: v.author || v.up_name || '',
    published_at: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : v.playback_time ? new Date(v.playback_time * 1000).toISOString() : '',
    metrics: {
      view: Number(v.play ?? v.stat?.view) || 0,
      like: Number(v.like ?? v.stat?.like) || 0,
      coin: Number(v.coin ?? v.stat?.coin) || 0,
      fav: Number(v.favnum ?? v.stat?.favorite) || 0,
      share: Number(v.sharenum ?? v.stat?.share) || 0,
      reply: Number(v.review ?? v.stat?.reply) || 0,
      danmaku: Number(v.danmaku ?? v.video_review ?? v.stat?.danmaku) || 0,
    },
  });
}

/**
 * order=totalrank（综合排序）：实测 pubdate 只返回刚上传 0 播放的新视频（会被互动门槛全拦），
 * click 只返回陈年老片；totalrank 兼顾热度与新鲜度。
 */
async function biliSearch(keyword, cookie, log) {
  const url =
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video` +
    `&keyword=${encodeURIComponent(keyword)}&page=1&order=totalrank`;
  const j = await fetchJson(url, {
    timeout: 15000,
    headers: { Cookie: cookie, Referer: 'https://search.bilibili.com/', Accept: 'application/json', 'User-Agent': UA },
  });
  if (j.code !== 0) throw new Error(`code ${j.code} ${j.message || ''}`);
  const list = j.data?.result || [];
  log('bilibili', `search:${keyword}`, `${list.length} 条`);
  return list;
}

async function biliPopular(cookie, log) {
  const out = [];
  for (let pn = 1; pn <= 2; pn++) {
    const j = await fetchJson(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${pn}`, {
      timeout: 15000,
      headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/', Accept: 'application/json', 'User-Agent': UA },
    });
    if (j.code !== 0) throw new Error(`code ${j.code} ${j.message || ''}`);
    out.push(...(j.data?.list || []));
    if (pn < 2) await sleep(800);
  }
  log('bilibili', 'popular', `${out.length} 条原始（按 AI 词表过滤）`);
  return out;
}

/** 综合热门里挑 AI 相关：标题/简介命中词表才留（热门榜 90% 是娱乐内容） */
const BILI_AI_WORDS = [
  'ai', 'aigc', 'gpt', 'claude', 'gemini', 'deepseek', 'qwen', 'kimi', 'glm', 'llm', '大模型',
  '人工智能', '智能体', 'agent', '机器学习', '深度学习', '神经网络', '开源', '多模态', '文生图',
  '文生视频', 'sora', 'midjourney', 'stable diffusion', 'hugging', 'rag', 'mcp', 'copilot', 'cursor',
  '豆包', '元宝', '纳米ai', '通义', '混元', '文心', '盘古', '星火', '具身智能', '机器人',
];

async function collectBilibili(ctx) {
  const out = [];
  const seen = new Set();
  const push = (it) => {
    if (!it || seen.has(it.raw_hash)) return;
    seen.add(it.raw_hash);
    out.push(it);
  };

  const cookie = await bootstrapCookie(ctx.log);

  for (const q of (ctx.allQueries || []).slice(0, 5)) {
    try {
      for (const v of await biliSearch(q, cookie, ctx.log)) push(biliItem(v, 'bilibili'));
    } catch (e) {
      ctx.log('bilibili', `search:${q}`, String(e.message || e).slice(0, 70));
    }
    await sleep(1200);
  }

  try {
    const popular = await biliPopular(cookie, ctx.log);
    for (const v of popular) {
      const text = `${v.title || ''} ${v.description || ''}`.toLowerCase();
      if (BILI_AI_WORDS.some((w) => text.includes(w))) push(biliItem(v, 'bilibili_hot'));
    }
  } catch (e) {
    ctx.log('bilibili', 'popular', String(e.message || e).slice(0, 70));
  }

  return out.slice(0, 60);
}

// ---------------- 汇总 ----------------

/** 启用中的源。单源失败不影响整体（核心源失败才判本轮失败） */
export const SOURCES = [
  { name: 'hn', fn: collectHn, core: true },
  { name: 'gh_trending', fn: collectGhTrending, core: false },
  { name: 'gh_search', fn: collectGhSearch, core: false },
  { name: 'hf_papers', fn: collectHfPapers, core: true },
  { name: 'blog', fn: collectBlogs, core: true },
  { name: 'news_search', fn: collectNewsSearch, core: true },
  { name: 'cn_search', fn: collectCnSearch, core: false },
  { name: 'cn_media', fn: collectCnMedia, core: false },
  { name: 'lobsters', fn: collectLobsters, core: false },
  { name: 'bilibili', fn: collectBilibili, core: false },
];

/**
 * 并发执行全部信息源（并发 4：各源打不同站点，互不共享限流域；单源内部仍有自己的 sleep 节奏）
 * @param ctx {{allQueries:string[], sinceIso:string, windowStartMs:number, log:fn, only?:string[]}}
 * @returns {{items, stats}}
 */
export async function collectAll(ctx) {
  const list = ctx.only?.length ? SOURCES.filter((s) => ctx.only.includes(s.name)) : SOURCES;
  const limit = pLimit(4);
  const stats = {};
  const jobs = list.map((s) =>
    limit(async () => {
      const t0 = Date.now();
      try {
        const items = (await s.fn(ctx)) || [];
        stats[s.name] = { ok: true, count: items.length, ms: Date.now() - t0 };
        return items;
      } catch (e) {
        stats[s.name] = { ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - t0 };
        return [];
      }
    })
  );
  const results = await Promise.all(jobs);
  let items = results.flat();

  // trending 补真实建库时间（快照榜没有发布时间）
  if (items.some((i) => i.source === 'gh_trending')) {
    try {
      items = await enrichRepoCreated(items, ctx.log);
    } catch {
      /* 补齐失败不影响主流程 */
    }
  }

  return { items, stats };
}
