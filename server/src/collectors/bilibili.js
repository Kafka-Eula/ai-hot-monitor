import { fetchJson, sleep } from '../util/http.js';
import { normItem } from './normalize.js';

/**
 * Bilibili（B站）—— 中文 AI 内容与 UP 主实时动态，互动数据最丰富的一路。
 *
 * 实测结论（2026-10，逐端点验证，修正了 REQUIREMENTS 里"B站 API 一律风控 -352"的旧结论）：
 *  - `x/web-interface/search/type`（关键词搜索）：**可用**，但必须先带首页下发的 `buvid3`
 *    Cookie，否则返回 `-412 request was banned`（这正是旧结论的来源）；
 *  - `x/web-interface/popular`（综合热门）：可用，支持 ps/pn 翻页；
 *  - `x/web-interface/newlist?rid=`（分区最新）：可用但无热度（新视频 play/like=0），不做信息源；
 *  - `x/web-interface/ranking/v2`、`popular/series/one`：`-352` 风控，放弃。
 *
 * 因此采集两路：
 *  1) **关键词搜索**（每个启用关键词/关注范围 1 次，按 pubdate 排序）→ 大 UP 主最新相关内容；
 *  2) **综合热门**（全局 2 页 × 50 条）→ 只保留标题/简介命中 AI 词表的条目，补充"破圈"信号。
 *
 * 频率红线：搜索间隔 ≥2.5s、每扫描 ≤8 次；popular 间隔 ≥2s、≤2 次（避免触发风控）。
 * 成效由 quality.js 的加权互动门槛把关（B站播放量巨大，必须给高门槛，见 weightedEngagement）。
 */

/** 标题/简介命中这些词才算 AI 相关（popular 是综合热门，必须本地过滤） */
const AI_TERMS = [
  'ai', 'a.i.', '人工智能', '大模型', '大語言模型', '语言模型', '多模态', '智能体', 'agent',
  'gpt', 'claude', 'gemini', 'deepseek', 'qwen', '千问', '文心', '豆包', 'kimi', '混元',
  'llama', 'mistral', 'grok', 'sora', 'midjourney', 'stable diffusion', 'comfyui', 'openai',
  'anthropic', 'copilot', 'cursor', 'codex', 'mcp', 'rag', 'diffusion', 'sd', 'llm',
  '神经网络', '机器学习', '深度学习', '微调', '推理', 'token', '提示词', 'prompt', '黄仁勋', '英伟达',
];

const SEARCH_LIMIT = 8;      // 每扫描最多搜索次数
const SEARCH_GAP_MS = 2500;  // 搜索间隔
const POPULAR_PAGES = 2;     // 综合热门页数（每页 50）
const POPULAR_GAP_MS = 2000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/** 命中 AI 词表才保留（综合热门用；搜索结果不必再过，因为查询词本身已限定） */
export function looksAiRelated(text) {
  const s = String(text || '').toLowerCase();
  return AI_TERMS.some((t) => s.includes(t));
}

/** 时长 "MM:SS" / "HH:MM:SS" → 秒；异常返回 0 */
export function durationSeconds(d) {
  const parts = String(d || '').split(':').map((x) => Number(x));
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** B站搜索结果里标题带 <em class="keyword"> 高亮标签，需要剥离 */
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function normBili(v, source, extra = {}) {
  const bvid = v.bvid || '';
  const url = bvid ? `https://www.bilibili.com/video/${bvid}` : stripTags(v.arcurl);
  if (!url) return null;
  return normItem({
    source,
    url,
    host: 'bilibili.com',
    title: stripTags(v.title),
    summary: (v.description || v.desc || '').slice(0, 400),
    author: v.author || v.owner?.name || '',
    published_at: v.pubdate ? new Date(Number(v.pubdate) * 1000).toISOString() : v.create || '',
    metrics: {
      view: Number(v.play ?? v.stat?.view) || 0,
      like: Number(v.like ?? v.stat?.like) || 0,
      coin: Number(v.coin ?? v.stat?.coin) || 0,
      fav: Number(v.favorites ?? v.stat?.favorite) || 0,
      share: Number(v.share ?? v.stat?.share) || 0,
      reply: Number(v.review ?? v.stat?.reply) || 0,
      danmaku: Number(v.danmaku ?? v.video_review ?? v.stat?.danmaku) || 0,
      ...extra,
    },
  });
}

/** 取首页 Cookie（buvid3）——搜索接口没有它会被 -412 拦 */
async function bootstrapCookie(log) {
  try {
    const res = await fetch('https://www.bilibili.com/', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookie = raw.map((c) => c.split(';')[0]).join('; ');
    if (cookie) log?.('bilibili', '-', `已获取 buvid 引导 Cookie(${raw.length} 项)`);
    return cookie;
  } catch (e) {
    log?.('bilibili', '-', `Cookie 引导失败：${String(e.message || e).slice(0, 60)}`);
    return '';
  }
}

async function searchVideos(keyword, cookie, log) {
  // order=totalrank（综合排序）：实测 pubdate 只返回刚上传、0 播放的视频（会被互动门槛全拦），
  // click 只返回陈年高播放老视频（3 天内 0 条）；totalrank 兼顾热度与新鲜度。
  const url =
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video` +
    `&keyword=${encodeURIComponent(keyword)}&page=1&order=totalrank`;
  const j = await fetchJson(url, {
    timeout: 15000,
    headers: { Cookie: cookie, Referer: 'https://search.bilibili.com/', Accept: 'application/json' },
  });
  if (j.code !== 0) throw new Error(`code ${j.code} ${j.message || ''}`);
  const list = j.data?.result || [];
  log?.('bilibili', `search:${keyword}`, `${list.length} 条`);
  return list;
}

async function fetchPopular(cookie, log) {
  const out = [];
  for (let pn = 1; pn <= POPULAR_PAGES; pn++) {
    const j = await fetchJson(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${pn}`, {
      timeout: 15000,
      headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
    });
    if (j.code !== 0) throw new Error(`code ${j.code} ${j.message || ''}`);
    out.push(...(j.data?.list || []));
    if (pn < POPULAR_PAGES) await sleep(POPULAR_GAP_MS);
  }
  log?.('bilibili', 'popular', `${out.length} 条原始（将按 AI 词表过滤）`);
  return out;
}

export async function collect(ctx) {
  const out = [];
  const seen = new Set();
  const push = (norm) => {
    if (!norm || seen.has(norm.raw_hash)) return;
    seen.add(norm.raw_hash);
    out.push(norm);
  };

  const cookie = await bootstrapCookie(ctx.log);
  const headers = { Cookie: cookie };

  // ---- 1) 关键词/关注范围搜索（大 UP 主实时内容）----
  const queries = (ctx.allQueries || []).slice(0, SEARCH_LIMIT);
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const list = await searchVideos(q, cookie, ctx.log);
      for (const v of list) push(normBili(v, 'bilibili'));
    } catch (e) {
      ctx.log('bilibili', `search:${q}`, `失败 ${String(e.message || e).slice(0, 60)}`);
    }
    if (i < queries.length - 1) await sleep(SEARCH_GAP_MS + Math.random() * 800);
  }

  // ---- 2) 综合热门（全局，按 AI 词表过滤，捕捉破圈内容）----
  try {
    const hot = await fetchPopular(cookie, ctx.log);
    let kept = 0;
    for (const v of hot) {
      // 热门榜标题/简介里出现 AI 相关词才收（避免把全站热门都塞进 AI 热点）
      if (!looksAiRelated(`${v.title} ${v.desc || ''} ${v.tname || ''}`)) continue;
      push(normBili(v, 'bilibili_hot'));
      kept++;
    }
    ctx.log('bilibili', 'popular:filtered', `${kept}/${hot.length} 条与 AI 相关`);
  } catch (e) {
    ctx.log('bilibili', 'popular', `失败 ${String(e.message || e).slice(0, 60)}`);
  }

  return out.slice(0, 60);
}

export default { collect, looksAiRelated, durationSeconds };