import * as cheerio from 'cheerio';
import { fetchText, fetchJson, sleep } from '../util/http.js';
import { normItem } from './normalize.js';

const REPO_RE = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i;
/** 单轮最多补几次 repos API（未登录 60 次/小时，需留余量） */
export const MAX_REPO_META = 20;

/** 取仓库的创建/最后推送时间（唯一可靠的真实时间；trending 网页不提供） */
export async function fetchRepoMeta(url) {
  const m = REPO_RE.exec(url || '');
  if (!m) return null;
  const repo = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
    timeout: 10000,
    headers: { Accept: 'application/vnd.github+json' },
  });
  return { created_at: repo.created_at || '', pushed_at: repo.pushed_at || '' };
}

/**
 * 给 trending 仓库补"建库时间"。
 *
 * trending 网页只有"stars today"，没有发布时间；前端若拿采集时间冒充，
 * 会把去年建的仓库显示成"刚刚发布"。repos API 的 created_at 是唯一可靠的真实时间。
 * 已有条目不再请求（trending 榜跨轮次高度重叠），仅补本轮**首次入库**的仓库。
 *
 * @param {Array} items 已过质量闸门的条目
 * @param {{knownHashes?:Set<string>, log?:Function}} opts
 */
export async function enrichTrendingRepos(items, opts = {}) {
  const known = opts.knownHashes || new Set();
  const targets = (items || [])
    .filter((it) => it.source === 'gh_trending' && REPO_RE.test(it.url || '') && !known.has(it.raw_hash))
    .slice(0, MAX_REPO_META);

  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    try {
      const meta = await fetchRepoMeta(it.url);
      if (!meta) continue;
      const metrics = JSON.parse(it.metrics || '{}');
      // created_at 是字符串（非互动指标）：前端按"建库于"单独展示，不参与加权互动
      it.metrics = JSON.stringify({ ...metrics, ...meta });
    } catch (e) {
      opts.log?.('gh_trending', `repo:${it.url}`, `meta 失败 ${String(e.message || e).slice(0, 50)}`);
    }
    if (i < targets.length - 1) await sleep(150);
  }
  return targets.length;
}

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
    // stars today（增量）是 trending 真正的信号，总量 stars 对新库无区分度
    const starsTodayText = $el.find('span.d-inline-block.float-sm-right').first().text() || $el.find('[class*="float-sm-right"]').first().text();
    const stars_today = Number((starsTodayText.match(/([\d,]+)\s+stars?\s+today/i) || [])[1]?.replace(/,/g, '')) || 0;
    const forks = Number($el.find('a[href$="/forks"]').first().text().trim().replace(/,/g, '')) || 0;
    const it = normItem({
      source: 'gh_trending',
      url: `https://github.com${href}`,
      title: name,
      summary: desc,
      author: lang,
          // published_at 留空：trending 是快照榜，网页无发布时间；
          // 真实的"建库于"由 pipeline 调 repos API 补进 metrics.created_at
          metrics: { stars, stars_today, forks },
        });
    if (it) out.push(it);
  });
  ctx.log('gh_trending', '-', `${out.length} repos`);
  return out.slice(0, 25);
}
