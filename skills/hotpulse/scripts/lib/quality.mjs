/**
 * 质量与可信度规则层（从 server/src/quality.js 移植，零依赖、无数据库）。
 *
 * 为什么 Skill 里要有这一层：AI 的判断只有在**证据字段可靠**的前提下才有意义。
 * "这是不是内容农场""是不是厂商官方域名""互动量够不够"这些是能确定性算出来的，
 * 让 Claude 去猜媒体身份既浪费 token 又不稳定。所以：
 *   本层算出 src/tier/host/eng/official/auth/farm 等硬证据 → Claude 只负责判相关性与真伪。
 *
 * 与服务端的差异：服务端 gates() 读 settings 表，这里用 DEFAULT_GATES 常量。
 * 需要调门槛时用环境变量覆盖，例如：HP_GATE_minQuality=55 node hp.mjs collect ...
 *
 * quality_score = 源分级基础分(0-40) + 互动分(0-30) + 新鲜度(0-15) + 域名权威(0-15) − 惩罚
 */

// ---------------- 源分级 ----------------

/** 1=官方一手 2=强策展社区 3=主流媒体/策展UGC 4=搜索泛结果 */
export const SOURCE_TIER = {
  blog: 1,
  media: 3,
  cn_media: 3,
  news_search: 3,
  bilibili: 3,
  bilibili_hot: 3,
  gh_trending: 2,
  gh_search: 2,
  hf_papers: 2,
  hn: 2,
  lobsters: 2,
  reddit: 3,
  twitter: 3,
  web_search: 4,
  cn_search: 4,
};

const TIER_BASE = { 1: 40, 2: 32, 3: 26, 4: 18 };

/** 硬门槛源：社交量化门槛或泛搜索域名门槛，质量分仅作参考 */
export const GATED_SOURCES = new Set([
  'hn', 'hf_papers', 'gh_trending', 'gh_search', 'gh_search', 'reddit', 'lobsters', 'twitter',
  'bilibili', 'bilibili_hot', 'web_search', 'news_search', 'cn_search',
]);

export const isHardGated = (source) => GATED_SOURCES.has(source);

/** 快照/时效型源：抓取本身已限定时间窗，不做新鲜度加减分 */
const FRESHNESS_EXEMPT = new Set(['gh_trending', 'gh_search', 'hf_papers', 'web_search']);

/** 快照榜源：不受 maxAgeDays 硬拦截（"何时上榜"比"何时发布"更有意义） */
const SNAPSHOT_SOURCES = new Set(['gh_trending', 'hf_papers']);

/** 聚合器/策展层已筛过媒体质量的源，给策展加成 */
const CURATED_BONUS = { news_search: 8, cn_media: 8, media: 8, cn_search: 8 };

// ---------------- 域名名单 ----------------

/** 厂商/机构官方域名（一手来源，可作真伪佐证） */
export const OFFICIAL_HOSTS = [
  'openai.com', 'anthropic.com', 'claude.com', 'blog.google', 'deepmind.google',
  'googleblog.com', 'huggingface.co', 'meta.com', 'ai.meta.com', 'mistral.ai',
  'cohere.com', 'x.ai', 'microsoft.com', 'deepspeed.ai', 'ollama.com', 'langchain.com',
  'github.blog', 'aws.amazon.com', 'cloud.google.com', 'nvidia.com', 'intel.com',
  'ibm.com', 'salesforce.com', 'unity.com', 'mozilla.org', 'fs.org',
  'moonshot.cn', 'deepseek.com', 'qwenlm.github.io', 'baichuan-inc.com',
  'zhipuai.cn', 'bigmodel.cn', 'minimaxi.com', 'stepfun.com', '01.ai',
];

/**
 * 权威媒体/机构域名（可信转述，非农场）。
 * 注意：sohu.com / 163.com / 百家号等"自媒体聚合平台"故意不列（在 DENY_HOSTS），
 * 判定顺序是"先农场后放行"，转载号仍会被拦。
 */
export const AUTHORITY_HOSTS = [
  'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'nytimes.com',
  'theverge.com', 'techcrunch.com', 'arstechnica.com', 'wired.com', 'theguardian.com',
  'bbc.com', 'npr.org', 'cbsnews.com', 'nbcnews.com', 'cnbc.com', 'businessinsider.com',
  'forbes.com', 'time.com', 'nature.com', 'science.org', 'arxiv.org', 'acm.org',
  'ieee.org', 'venturebeat.com', 'infoworld.com', 'zdnet.com', 'tomshardware.com',
  'theregister.com', 'synthesis.com', 'the-decoder.com', 'superhuman.ai', 'semianalysis.com',
  'technologyreview.com', 'wired.co.uk', 'axios.com', 'politico.com',
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'chinadaily.com.cn', 'gmw.cn', 'gov.cn',
  'stcn.com', '21jingji.com', 'caixin.com', 'yicai.com', 'thepaper.cn', 'jiemian.com', 'ifeng.com',
  'chinanews.com', 'chinanews.com.cn', 'infoq.cn', 'oschina.net', 'leiphone.com',
  'qbitai.com', 'jiqizhixin.com', 'cnstock.com', 'nbd.com.cn', 'cls.cn',
  'zaobao.com', 'ftchinese.com', 'wallstreetcn.com',
  'sina.com.cn', 'eastday.com', 'iresearch.cn', 'hexun.com', 'jrj.com.cn',
  'tmtpost.com', 'iheima.com', 'iyiou.com', 'pingwest.com', 'c114.com.cn', 'ctiforum.com',
  'cs.com.cn',
  'ithome.com', 'geekpark.net', 'ifanr.com', '36kr.com', 'syncedreview.com', 'sspai.com',
  'personatechnology.com', 'mittrchina.com', 'lzwjia.com',
];

/**
 * 内容农场 / SEO 站 / 教程堆砌 / 自媒体转载站（命中即重罚）。
 * 不要把已接入的源域名（reddit.com / x.com / hf）放进来，否则自我惩罚。
 */
export const DENY_HOSTS = [
  'felloai.com', 'aiwiki.ai', 'bestofai.io', 'aiomnifeed.com', 'zainode.com',
  'swfte.com', 'ai-bot.cn', 'aiagent.app', 'deepwiki.com', 'geeky-gadgets.com',
  'blink.new', 'andrew.ooo', 'aguidetocloud.com', 'producthunt.com',
  'cnblogs.com', 'geeksforgeeks.org', 'javatpoint.com', 'tutorialspoint.com',
  'w3schools.com', 'analyticsvidhya.com', 'kdnuggets.com', 'builtin.com',
  'aimultiple.com', 'simplified.com', 'venngage.com',
  'zapier.com', 'buffer.com', 'notion.so',
  'medium.com', 'quora.com', 'linkedin.com', 'pinterest.com',
  'zhuanlan.zhihu.com', 'zhihu.com', 'en.wikipedia.org', 'wikipedia.org',
  'baike.baidu.com', 'csdn.net', 'jianshu.com', 'segmentfault.com', '51cto.com',
  'sohu.com', '163.com', 'qq.com', 'toutiao.com', 'bilibili.com',
  '360kuai.com', 'huxiu.com',
];

/** 营销/软文/会议宣传/资讯汇总类标题特征 */
const PROMO_PATTERNS = [
  /\b(webinar|giveaway|sponsored|press release|announcement of the|coupon|discount|buy now)\b/i,
  /\b(top \d+|best \d+|\d+ (best|top|tools|ways|reasons)|ultimate guide|beginners guide|how to)\b/i,
  /\b(emtech|summit|conference|awards|nominees|festival)\b/i,
  /(排行|榜单|大全|导航|盘点|教程|入门|科普|优惠|抽奖|发布会直播)/,
  // "开发者大会发布 X"是真实产品发布，所以不能匹配"开发者大会"
  /(创新大会|峰会[^的]*(报名|启幕|来袭)|大会报名|参会报名|议程公布|议题征集)/,
  /^[\s【\[（(]*(早报|日报|周报|晚报|午报|快讯|早报▏|一周AI)/,
  /(早报|日报|周报|晚报)[｜|▏]/,
];

const OPINION_PATTERNS = [/\b(don'?t be fooled|won'?t change your life|we'?re putting too much|people really hate)\b/i];

/** HF 上人人可建的模型/数据集/空间页，不是厂商官宣 */
const UGC_PATH_RE = /^\/(?:datasets|spaces)\/|[^/]+\/[^/]+-(?:model|gguf|datasets?)(?:\/|$)/i;

export function normalizeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostMatch(host, list) {
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith(`.${d}`) || host === d.replace(/^www\./, ''));
}

/** 首页/落地页型 URL（搜索引擎常返回公司主页，那不是新闻事件） */
export function isLandingPageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const path = (u.pathname || '/').replace(/\/+$/, '');
  if (path === '' || path === '/') return true;
  const seg = path.split('/').filter(Boolean);
  if (seg.length === 1 && /^(download|app|apps|zh|cn|en|product|home|index|start|get|mobile)$/.test(seg[0])) return true;
  if (/play\.google\.com|apps\.apple\.com|apps\.google/i.test(u.hostname + path)) return true;
  return false;
}

export const isOfficialHost = (host) => hostMatch(host, OFFICIAL_HOSTS);
export const isAuthorityHost = (host) => hostMatch(host, AUTHORITY_HOSTS);
export const isDeniedHost = (host) => hostMatch(host, DENY_HOSTS);

function urlPath(url) {
  try {
    return new URL(url).pathname || '';
  } catch {
    return String(url || '');
  }
}

/** 是否"厂商对自己产品的一手官宣"——只看域名，hf_papers 是作者自述预印本所以排除 */
export function isOfficialAnnouncement(source, host, url = '') {
  if (source === 'hf_papers') return false;
  if (!isOfficialHost(host || '')) return false;
  if (/huggingface\.co$/i.test(host || '') && UGC_PATH_RE.test(urlPath(url))) return false;
  return true;
}

// ---------------- 互动与新鲜度 ----------------

export function parseMetricsObj(metrics) {
  let m = metrics;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m || '{}');
    } catch {
      m = {};
    }
  }
  return m && typeof m === 'object' ? m : {};
}

/**
 * 加权互动分：不同源按传播力加权，跨源可比。
 * 转发/评论比点赞更能代表"值得传"，权重更高；浏览量取 log 防刷量主导。
 */
export function weightedEngagement(source, metrics) {
  const m = parseMetricsObj(metrics);
  const n = (k) => Number(m[k]) || 0;
  switch (source) {
    case 'hn':
      return n('points') + n('comments') * 1.5;
    case 'reddit':
      return n('score') + n('comments') * 2;
    case 'twitter':
      return n('likes') + n('rts') * 3 + n('replies') * 2 + Math.log10(1 + n('views')) * 10;
    case 'lobsters':
      return n('score') + n('comments');
    // B站：投币/收藏/转发比点赞更能代表"值得看"；播放量动辄百万，只取 log 小头
    case 'bilibili':
    case 'bilibili_hot':
      return (
        n('like') + n('coin') * 2 + n('fav') * 3 + n('share') * 4 +
        n('danmaku') + n('reply') * 1.5 + Math.log10(1 + n('view')) * 30
      );
    case 'gh_trending':
      return n('stars_today'); // 只有当日新增是新闻信号，总星数不是
    case 'gh_search':
      return n('stars') + n('forks') * 2; // 近 7 天新建，总星数即增量
    case 'hf_papers':
      return n('upvotes');
    default:
      return 0; // 官宣/新闻/搜索类无互动接口
  }
}

export const SOCIAL_SOURCES = new Set([
  'hn', 'reddit', 'twitter', 'lobsters', 'gh_trending', 'gh_search', 'hf_papers', 'bilibili', 'bilibili_hot',
]);

export function ageHours(item, nowMs = Date.now()) {
  const iso = item.published_at || item.collected_at;
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 3600000);
}

export const tierOf = (source) => SOURCE_TIER[source] ?? 4;

/** 动态分级：以真实域名为准。blog 源里的媒体出版方（MIT TR/量子位）要降到 T3 */
export function dynamicTier(source, host) {
  if (isOfficialAnnouncement(source, host)) return 1;
  const t = tierOf(source);
  if (source === 'blog') return 3;
  if (t >= 4 && isAuthorityHost(host)) return 3;
  return t;
}

// ---------------- 门槛 ----------------

export const DEFAULT_GATES = {
  hnPoints: 30,
  hnComments: 15,
  hfUpvotes: 30,
  ghStarsToday: 50,
  ghSearchStars: 100,
  redditScore: 200,
  lobstersScore: 20,
  twitterLikes: 50,
  // 入库门槛 500 ≈ 几千播放且有点赞；爆款门槛 5000 ≈ 头部破圈
  biliScore: 500,
  authBili: 5000,
  authHn: 100,
  authReddit: 800,
  authTwitter: 500,
  authLobsters: 80,
  authGhTrending: 500,
  authGhSearch: 500,
  authHfPapers: 150,
  minQuality: 60,
  maxAgeDays: 14,
  dedupThreshold: 0.85,
  dedupEnabled: true,
  engagementWeight: 0.4,
  engagementFull: 1000,
};

/** 环境变量覆盖（HP_GATE_xxx=值），替代服务端的 settings 表 */
export function gates() {
  const g = { ...DEFAULT_GATES };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('HP_GATE_')) continue;
    const key = k.slice(8);
    if (!(key in g)) continue;
    if (typeof g[key] === 'boolean') g[key] = v !== 'false' && v !== '0';
    else g[key] = Number(v);
  }
  return g;
}

const SOCIAL_GATE_KEY = {
  hn: ['hnPoints', 'authHn'],
  reddit: ['redditScore', 'authReddit'],
  twitter: ['twitterLikes', 'authTwitter'],
  lobsters: ['lobstersScore', 'authLobsters'],
  gh_trending: ['ghStarsToday', 'authGhTrending'],
  gh_search: ['ghSearchStars', 'authGhSearch'],
  hf_papers: ['hfUpvotes', 'authHfPapers'],
  bilibili: ['biliScore', 'authBili'],
  bilibili_hot: ['biliScore', 'authBili'],
};

export function sourceThresholds(source, g = gates()) {
  const keys = SOCIAL_GATE_KEY[source];
  if (!keys) return null;
  return { entry: g[keys[0]], authority: g[keys[1]] };
}

/** 是否达到"权威门槛"（热度足以证明事件被广泛讨论） */
export function isViral(source, engagement, g = gates()) {
  const th = sourceThresholds(source, g);
  if (!th) return false;
  return (Number(engagement) || 0) >= th.authority;
}

// ---------------- 质量分 ----------------

/** @returns {{score,tier,host,engagement,flags}} */
export function computeQuality(item, nowMs = Date.now()) {
  const host = item.host || normalizeHost(item.url);
  const tier = dynamicTier(item.source, host);
  const engagement = item.engagement ?? weightedEngagement(item.source, item.metrics);
  const flags = [];
  const th = sourceThresholds(item.source);

  let score = TIER_BASE[tier] ?? 14;

  if (th) {
    // 量化互动源：以该源权威门槛为满分刻度做 log 归一（跨源可比），上限 30
    const ratio = Math.max(0, Number(engagement)) / Math.max(1, th.authority);
    score += Math.min(30, Math.max(0, Math.log10(1 + ratio) * 30));
    if (ratio >= 1) score += 10;
    else if (ratio >= 0.3) score += 4;
  } else {
    // 官宣/新闻类无互动接口：给中性分 + 策展加成，避免系统性误杀
    score += 15;
    score += CURATED_BONUS[item.source] || 0;
  }

  if (!FRESHNESS_EXEMPT.has(item.source)) {
    const hours = ageHours(item, nowMs);
    if (hours === null) {
      score -= 12;
      flags.push('no_date');
    } else if (hours <= 24) score += 15;
    else if (hours <= 72) score += 10;
    else if (hours <= 168) score += 5;
    else {
      score -= 5;
      flags.push('stale');
    }
  }

  // 农场惩罚只针对 T3/T4，且要排除平台自身域名（否则接入 B站等于自我惩罚）
  if (isOfficialHost(host)) score += 15;
  else if (isAuthorityHost(host)) score += 10;
  else if (!isPlatformHost(host) && isDeniedHost(host) && tier >= 3) {
    score -= 25;
    flags.push('content_farm');
  } else if (tier === 4) score -= 5;

  const title = item.title || '';
  if (PROMO_PATTERNS.some((re) => re.test(title))) {
    score -= 15;
    flags.push('promo_or_guide');
  }
  // 一条塞 N 个不相干事件的资讯汇总帖，无法作为单一热点证据
  if ((title.match(/[；;]/g) || []).length >= 2) {
    score -= 15;
    flags.push('news_digest');
  }
  if (OPINION_PATTERNS.some((re) => re.test(title))) {
    score -= 10;
    flags.push('opinion_piece');
  }
  if (!(item.summary || '').trim()) score -= 5;
  if (title.trim().length < 12) {
    score -= 10;
    flags.push('too_short');
  }

  return { score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)), tier, host, engagement, flags };
}

/** 硬门槛判定（在质量分之前拦截） @returns {{pass,reason}} */
export function passesGate(item, g = gates(), nowMs = Date.now()) {
  const m = parseMetricsObj(item.metrics);
  const hasDate = Boolean(item.published_at);
  const host = item.host || normalizeHost(item.url);

  if (!SNAPSHOT_SOURCES.has(item.source) && hasDate) {
    const hours = ageHours(item, nowMs);
    if (hours !== null && hours > g.maxAgeDays * 24) {
      return { pass: false, reason: `too_old(${Math.round(hours / 24)}d>${g.maxAgeDays}d)` };
    }
  }

  const th = sourceThresholds(item.source, g);
  if (th) {
    const e = weightedEngagement(item.source, m);
    if (e >= th.entry) return { pass: true, reason: '' };
    // HN 高讨论量兜底：评论多但点数低的深度帖
    if (item.source === 'hn' && (Number(m.comments) || 0) >= g.hnComments) return { pass: true, reason: '' };
    return { pass: false, reason: `${item.source}_low_engagement(${Math.round(e)}<${th.entry})` };
  }

  if (item.source === 'web_search' || item.source === 'cn_search' || item.source === 'news_search') {
    // 泛搜索噪音最大：域名必须在官方/权威名单内（宁缺毋滥）
    if (isDeniedHost(host)) return { pass: false, reason: `${item.source}_content_farm(${host})` };
    if (!isOfficialHost(host) && !isAuthorityHost(host)) {
      return { pass: false, reason: `${item.source}_untrusted_host(${host})` };
    }
    if (item.source === 'cn_search') {
      if (!item.published_at) return { pass: false, reason: 'cn_search_no_date' };
      if (isLandingPageUrl(item.url)) return { pass: false, reason: 'cn_search_homepage' };
    }
    return { pass: true, reason: '' };
  }

  return { pass: true, reason: '' };
}

// ---------------- 近似去重 ----------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are',
  'was', 'be', 'been', 'it', 'its', 'this', 'that', 'as', 'by', 'from', 'new', 'news',
  'how', 'what', 'why', 'when', 'where', 'who', 's', 't', 'll', 've', 're',
]);

export function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .join(' ');
}

function shingles(key, n = 3) {
  const words = key.split(' ').filter(Boolean);
  if (!words.length) return new Set();
  if (words.length < n) return new Set([words.join(' ')]);
  const out = new Set();
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function titleSimilarity(a, b) {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const sa = shingles(ka);
  const sb = shingles(kb);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 组内近似去重：质量分高的先占位，相似标题并入 */
export function dedupByTitle(enriched, threshold = 0.85) {
  const keep = [];
  const merged = [];
  const sorted = [...enriched].sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0));
  for (const it of sorted) {
    const hit = keep.find((k) => titleSimilarity(k.title, it.title) >= threshold);
    if (hit) merged.push({ ...it, dup_of: hit.url, dup_title: hit.title });
    else keep.push(it);
  }
  return { keep, merged };
}

/**
 * 质量闸门：硬门槛 → 质量分 → 同源近似去重。
 * 跨源重复**保留**，因为多源报道本身就是佐证证据。
 * @returns {{passed,blocked}}
 */
export function applyQualityGate(items, opts = {}) {
  const g = opts.g || gates();
  const nowMs = opts.nowMs || Date.now();
  const blocked = [];
  const scored = [];

  for (const it of items) {
    const q = computeQuality(it, nowMs);
    const gate = passesGate(it, g, nowMs);
    if (!gate.pass) {
      blocked.push({ item: it, reason: gate.reason });
      continue;
    }
    if (!isHardGated(it.source) && q.score < g.minQuality) {
      blocked.push({ item: it, reason: `low_quality(${q.score}<${g.minQuality}${q.flags.length ? ',' + q.flags[0] : ''})` });
      continue;
    }
    scored.push({ ...it, quality_score: q.score, engagement: q.engagement, source_tier: q.tier, host: q.host, quality_flags: q.flags });
  }

  let passed = scored;
  if (g.dedupEnabled) {
    const bySource = new Map();
    for (const it of scored) {
      if (!bySource.has(it.source)) bySource.set(it.source, []);
      bySource.get(it.source).push(it);
    }
    passed = [];
    for (const [src, list] of bySource) {
      list.sort((a, b) => b.quality_score - a.quality_score);
      const { keep, merged } = dedupByTitle(list, g.dedupThreshold);
      passed.push(...keep);
      for (const m of merged) blocked.push({ item: m, reason: `near_duplicate(${src})` });
    }
  }
  return { passed, blocked };
}

// ---------------- 证据统计与封顶 ----------------

/** 证据统计由代码算，不依赖 AI 自报，防止模型给自己加分 */
export function evidenceOf(items, g = gates()) {
  const sources = new Set();
  const hosts = new Set();
  const authorityHosts = new Set();
  let hasOfficial = 0;
  let viralCount = 0;
  let engTotal = 0;
  let socialOnly = items.length > 0;

  for (const it of items) {
    sources.add(it.source);
    const h = it.host || normalizeHost(it.url);
    if (h) hosts.add(h);
    if (isOfficialAnnouncement(it.source, h, it.url)) hasOfficial = 1;

    // 全条目累加互动：官方/新闻类无接口，天然贡献 0
    const eng = Number(it.engagement ?? weightedEngagement(it.source, it.metrics)) || 0;
    engTotal += eng;

    if (SOCIAL_SOURCES.has(it.source)) {
      if (isViral(it.source, eng, g)) viralCount++;
    } else {
      socialOnly = false;
      if (h && (isAuthorityHost(h) || isOfficialHost(h))) authorityHosts.add(h);
    }
  }

  return {
    source_count: sources.size,
    host_count: hosts.size,
    has_official: hasOfficial,
    authority_media_count: authorityHosts.size,
    viral_count: viralCount,
    engagement_total: Math.round(engTotal),
    social_only: socialOnly ? 1 : 0,
    sources: [...sources].sort(),
  };
}

/**
 * 证据等级 → 分数上限 / 是否值得通知。
 * 治的是"1 条孤证也给 100 分"和"随手发帖成热点"。
 */
const EVIDENCE_TIERS = {
  official: { cap: 100, notify: true },
  media_cross: { cap: 100, notify: true },
  viral_social: { cap: 80, notify: true },
  single_viral: { cap: 65, notify: false },
  social_weak: { cap: 60, notify: false },
  weak: { cap: 65, notify: false },
};

export const TIER_LABEL = {
  official: '官方一手',
  media_cross: '媒体交叉',
  viral_social: '社交爆款',
  single_viral: '单条爆款',
  social_weak: '社交弱信号',
  weak: '单源孤证',
};

export function evidenceTier(ev) {
  if (ev.has_official) return 'official';
  if ((ev.authority_media_count || 0) >= 2) return 'media_cross';
  const viral = ev.viral_count || 0;
  if (viral >= 2) return 'viral_social';
  if (ev.social_only) return viral === 1 ? 'single_viral' : 'social_weak';
  return 'weak';
}

export function capScore(rawScore, ev) {
  const s = Number(rawScore) || 0;
  const tier = evidenceTier(ev);
  const cap = EVIDENCE_TIERS[tier].cap;
  return { score: Math.min(s, cap), capped: s > cap, tier, cap };
}

const ENGAGEMENT_K = 40; // 每 10 倍互动 ≈ +40 分（封顶 100）

/**
 * 话题互动分量（0~100）：对加权互动总量做对数归一。
 * 用对数是因为互动是长尾分布——线性会让头部顶死、其余挤在 0 附近。
 * 500→7分 · 2千→19 · 1万→42 · 2万→53 · 10万→80 · 30万→100
 */
export function engagementScore(engagementTotal, g = gates()) {
  const total = Math.max(0, Number(engagementTotal) || 0);
  if (!total) return 0;
  const full = Math.max(1, Number(g.engagementFull) || 1000);
  return Math.round(Math.min(100, Math.max(0, ENGAGEMENT_K * Math.log10(1 + total / full))) * 10) / 10;
}

/**
 * 合成热度分：score = (1−w)×AI基线 + w×互动分量，最后按证据等级封顶。
 * 高互动话题因此能压过 0 互动的官方发布，但单源孤证仍绕不过封顶。
 */
export function combineScore(baseScore, engagementTotal, ev, g = gates()) {
  const base = Math.max(0, Math.min(100, Number(baseScore) || 0));
  const w = Math.max(0, Math.min(1, Number(g.engagementWeight ?? 0.4)));
  const eng = w > 0 ? engagementScore(engagementTotal, g) : 0;
  const blended = (1 - w) * base + w * eng;
  return { ...capScore(blended, ev), base: Math.round(base * 10) / 10, engagement: eng, weight: w, blended: Math.round(blended * 10) / 10 };
}

export const hasNotifyEvidence = (ev) => EVIDENCE_TIERS[evidenceTier(ev)].notify;

// ---------------- 展示：品牌名 / 权威排序 / 主体校验 ----------------

export const BRAND_HOSTS = {
  'openai.com': 'OpenAI 官方', 'anthropic.com': 'Anthropic 官方', 'claude.com': 'Claude 官方',
  'deepmind.google': 'DeepMind 官方', 'blog.google': 'Google 官方', 'googleblog.com': 'Google 官方',
  'ai.meta.com': 'Meta AI 官方', 'meta.com': 'Meta 官方', 'mistral.ai': 'Mistral 官方',
  'cohere.com': 'Cohere 官方', 'x.ai': 'xAI 官方', 'microsoft.com': 'Microsoft 官方',
  'nvidia.com': 'NVIDIA 官方', 'huggingface.co': 'HuggingFace', 'deepseek.com': 'DeepSeek 官方',
  'moonshot.cn': '月之暗面官方', 'bigmodel.cn': '智谱官方', 'zhipuai.cn': '智谱官方',
  'ollama.com': 'Ollama 官方', 'langchain.com': 'LangChain 官方',
  'reuters.com': '路透社', 'apnews.com': '美联社', 'bloomberg.com': '彭博社', 'ft.com': '金融时报',
  'wsj.com': '华尔街日报', 'nytimes.com': '纽约时报', 'theverge.com': 'The Verge',
  'techcrunch.com': 'TechCrunch', 'arstechnica.com': 'Ars Technica', 'wired.com': 'WIRED',
  'theguardian.com': '卫报', 'bbc.com': 'BBC', 'cnbc.com': 'CNBC',
  'businessinsider.com': 'Business Insider', 'forbes.com': '福布斯', 'venturebeat.com': 'VentureBeat',
  'zdnet.com': 'ZDNet', 'tomshardware.com': "Tom's Hardware", 'theregister.com': 'The Register',
  'the-decoder.com': 'The Decoder', 'semianalysis.com': 'SemiAnalysis',
  'technologyreview.com': 'MIT 科技评论', 'mittrchina.com': 'MIT 科技评论中文', 'axios.com': 'Axios',
  'nature.com': 'Nature', 'arxiv.org': 'arXiv', 'syncedreview.com': 'Synced',
  'xinhuanet.com': '新华社', 'news.cn': '新华网', 'people.com.cn': '人民网', 'cctv.com': '央视网',
  'chinadaily.com.cn': '中国日报', 'thepaper.cn': '澎湃新闻', 'jiemian.com': '界面新闻',
  'yicai.com': '第一财经', 'caixin.com': '财新', '21jingji.com': '21世纪经济报道',
  'stcn.com': '证券时报', 'cls.cn': '财联社', 'wallstreetcn.com': '华尔街见闻',
  'nbd.com.cn': '每日经济新闻', 'ifeng.com': '凤凰网', 'sina.com.cn': '新浪',
  'chinanews.com': '中新网', 'chinanews.com.cn': '中新网', 'zaobao.com': '联合早报',
  'ftchinese.com': 'FT中文网', 'qbitai.com': '量子位', 'jiqizhixin.com': '机器之心',
  'infoq.cn': 'InfoQ 中文', 'geekpark.net': '极客公园', 'leiphone.com': '雷锋网',
  'ifanr.com': '爱范儿', '36kr.com': '36氪', 'ithome.com': 'IT之家', 'tmtpost.com': '钛媒体',
  'sspai.com': '少数派', 'oschina.net': '开源中国', 'iresearch.cn': '艾瑞网', 'hexun.com': '和讯网',
  'c114.com.cn': 'C114 通信网', 'eastday.com': '东方网', 'cs.com.cn': '中国证券报',
  'gmw.cn': '光明网', 'gov.cn': '中国政府网', 'pingwest.com': '品玩', 'iheima.com': 'i黑马',
  'iyiou.com': '亿欧', 'ctiforum.com': '通信世界', 'jrj.com.cn': '金融界',
  'cnstock.com': '上海证券报', 'lzwjia.com': '量子位',
  'github.com': 'GitHub', 'news.ycombinator.com': 'Hacker News', 'ycombinator.com': 'Hacker News',
  'lobste.rs': 'Lobsters', 'reddit.com': 'Reddit', 'x.com': 'X / Twitter', 'twitter.com': 'X / Twitter',
  'aws.amazon.com': 'AWS 官方', 'ibm.com': 'IBM', 'npr.org': 'NPR', 'youtube.com': 'YouTube',
  'bleepingcomputer.com': 'BleepingComputer', 'bilibili.com': 'B站',
};

/** 无自有域名的渠道型源的展示名 */
export const BRAND_SOURCES = {
  hn: 'Hacker News', gh_trending: 'GitHub Trending', gh_search: 'GitHub 新库',
  hf_papers: 'HF Papers', lobsters: 'Lobsters', reddit: 'Reddit', twitter: 'X / Twitter',
  bilibili: 'B站', bilibili_hot: 'B站热门',
};

/** 中文信息源标签（与前端 SOURCE_LABEL 口径一致） */
export const SOURCE_LABEL = {
  hn: 'Hacker News', gh_trending: 'GitHub', gh_search: 'GitHub 新库', hf_papers: 'HF Papers',
  blog: '官方博客', news_search: '新闻搜索', cn_search: '360新闻搜索', cn_media: '中文媒体',
  lobsters: 'Lobsters', reddit: 'Reddit', twitter: 'X', bilibili: 'B站', bilibili_hot: 'B站热门',
  web_search: '网页搜索', media: '媒体',
};

const PUBLIC_SLD = /^(co|com|net|org|gov|edu)\.(uk|cn|au|jp|hk|tw|br|in|de|fr|ru|kr|sg|nz|za|mx|ar|tr|it|es|nl|se|no|pl)$/;

/** 域名品牌名；未命中名单则回退取域名主干（aws.amazon.co.uk → amazon） */
export function brandOfHost(host) {
  if (!host) return '';
  if (BRAND_HOSTS[host]) return BRAND_HOSTS[host];
  const hit = Object.keys(BRAND_HOSTS).find((d) => host === d || host.endsWith(`.${d}`));
  if (hit) return BRAND_HOSTS[hit];
  const parts = host.split('.');
  const take = parts.length >= 3 && PUBLIC_SLD.test(parts.slice(-2).join('.')) ? 3 : 2;
  const main = parts.length > take && parts[parts.length - take] !== 'www' ? parts[parts.length - take] : parts[0];
  return main || host;
}

/** 渠道型源：条目自带域名只是平台，不代表"谁在说这件事" */
export const CHANNEL_SOURCES = new Set([
  'hn', 'gh_trending', 'gh_search', 'hf_papers', 'lobsters', 'reddit', 'twitter', 'bilibili', 'bilibili_hot',
]);

/** 平台自身域名：展示与计数都要排除（没有"平台"这个来源方） */
export const PLATFORM_HOSTS = [
  'huggingface.co', 'github.com', 'x.com', 'twitter.com', 'news.ycombinator.com', 'lobste.rs',
  'reddit.com', 'bilibili.com', 'b23.tv',
];

export const isPlatformHost = (host) => hostMatch(host, PLATFORM_HOSTS);

/** 来源权威度：4=厂商官方一手 3=权威媒体 2=策展社区/论文库 1=其他 */
export function authorityRank(source, host, url = '') {
  if (source === 'hf_papers') return 2; // 作者自述预印本，不算官方
  if (source === 'blog' && !isOfficialHost(host)) return 3; // 官方博客源里的媒体出版方
  // X 帖即使链接自家站点也只是"在 X 上发帖"，不是一手官宣页
  if (!CHANNEL_SOURCES.has(source) && isOfficialAnnouncement(source, host, url)) return 4;
  if (/huggingface\.co$/i.test(host || '')) return 2;
  if (isAuthorityHost(host) || isOfficialHost(host)) return 3;
  if (BRAND_SOURCES[source]) return 2;
  return 1;
}

const SUBJECT_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'new', 'release', 'releases', 'update', 'updates',
  'model', 'models', 'ai', 'api', 'vs', 'via', 'its', 'how', 'what', 'why', 'top', 'best',
  'series', 'pro', 'flash', 'version', 'launch', 'says', 'just', 'now', 'official',
]);

/**
 * 从话题标题提取"主体 token"（gpt6、deepseek…）。
 * 只用标题不用 cluster_key：英文 key 去匹配中文标题会大面积误杀。
 * 纯中文话题提不出拉丁词 → 返回空数组，调用方跳过校验（宁放过不误杀）。
 */
export function subjectTokens(title) {
  const norm = String(title || '').replace(/[\u2010-\u2015\u2212]/g, '-');
  const out = new Set();
  for (const w of norm.toLowerCase().match(/[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*/g) || []) {
    const compact = w.replace(/[.\-_]/g, '');
    if (compact.length >= 3 && !SUBJECT_STOP.has(compact)) out.add(compact);
  }
  return [...out];
}

/** 话题-条目主体硬校验：防"话题黑洞"（什么条目都往大话题里塞） */
export function itemMatchesSubject(item, tokens) {
  if (!tokens.length) return true;
  const text = String(`${item.title || ''} ${item.summary || ''}`).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return tokens.some((tk) => text.includes(tk));
}

/** 该条目的原始指标是否有意义（新闻/官宣源恒为 0） */
export function metricCount(source, metrics) {
  return Object.values(parseMetricsObj(metrics)).filter((v) => Number(v) > 0).length;
}

/** 发布者署名规范化：X 补 @，GitHub 的 author 其实是语言所以置空 */
export function labelAuthor(author, source) {
  const a = String(author || '').trim();
  if (!a) return '';
  if (source === 'gh_trending' || source === 'gh_search') return '';
  if (source === 'twitter') return a.startsWith('@') ? a : `@${a}`;
  return a;
}

const METRIC_LABEL = {
  points: { label: '分', ico: '▲' },
  comments: { label: '评论', ico: '💬' },
  stars: { label: '星标', ico: '⭐' },
  stars_today: { label: '今日新增', ico: '📈' },
  forks: { label: '复刻', ico: '🍴' },
  upvotes: { label: '推荐', ico: '▲' },
  score: { label: '分', ico: '▲' },
  likes: { label: '赞', ico: '👍' },
  rts: { label: '转发', ico: '🔁' },
  replies: { label: '回复', ico: '💬' },
  views: { label: '浏览', ico: '👁' },
  like: { label: '点赞', ico: '👍' },
  coin: { label: '投币', ico: '🪙' },
  fav: { label: '收藏', ico: '⭐' },
  share: { label: '转发', ico: '🔁' },
  reply: { label: '评论', ico: '💬' },
  danmaku: { label: '弹幕', ico: '💭' },
  view: { label: '播放', ico: '▶' },
};

const METRIC_ORDER = {
  gh_trending: ['stars_today', 'stars', 'forks'],
  gh_search: ['stars', 'forks'],
  bilibili: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
  bilibili_hot: ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view'],
};
const DEFAULT_METRIC_ORDER = ['points', 'likes', 'upvotes', 'score', 'stars', 'comments', 'rts', 'replies', 'views'];

/** 原始互动指标 → 紧凑徽章串（放首位展示，判断"值不值得点开"最快的依据） */
export function metricsList(source, metrics, max = 0) {
  const m = parseMetricsObj(metrics);
  const order = METRIC_ORDER[source] || DEFAULT_METRIC_ORDER;
  const list = order
    .filter((k) => Number(m[k]) > 0)
    .map((k) => ({ key: k, ico: METRIC_LABEL[k]?.ico || '', label: METRIC_LABEL[k]?.label || k, value: Number(m[k]) }));
  return max > 0 ? list.slice(0, max) : list;
}

const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 100000) return `${Math.round(v / 1000)}k`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};

export function badgeText(source, metrics, max = 4) {
  const list = metricsList(source, metrics, max);
  if (!list.length) return '';
  return list.map((x) => `${x.ico}${fmtNum(x.value)}`).join(' ');
}

/** 新鲜度分档（与前端一致）：新 <6h / 发酵中 <48h / 冷却 */
export function freshness(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return null;
  const h = (nowMs - t) / 3600000;
  if (h < 6) return { key: 'new', label: '新' };
  if (h < 48) return { key: 'warm', label: '发酵中' };
  return { key: 'cold', label: '冷却' };
}

export const NO_DATE_NOTE = '该源不提供发布时间';

/**
 * 来源摘要：算出卡片该显示的 1~2 个最权威来源 + 原始发布/互动轴。
 * 排序：厂商官方 > 权威媒体 > 策展社区；同档按发布时间新→旧，再按域名稳定排序，
 * 保证同一话题跨轮次展示一致。
 */
export function summarizeSources(items, opts = {}) {
  const max = opts.max || 2;
  const list = items || [];
  const empty = {
    primarySource: '', primaryHost: '', primaryLabel: '', primaryUrl: '', primaryTier: 0,
    primaryAuthor: '', authorityCount: 0, shown: [], metrics: null, publishedFirst: '', publishedLast: '',
  };
  if (!list.length) return empty;

  const ranked = list
    .map((it) => {
      const h = it.host || normalizeHost(it.url || '');
      return {
        it,
        host: h,
        rank: authorityRank(it.source, h, it.url),
        // 有效佐证必须是有编辑责任的外部媒体/官方域名；平台自身域名不算"报道"，
        // 否则用户上传的 HF 模型页会被算成媒体交叉（实测踩过）
        isAuthMedia: !isPlatformHost(h) && (isAuthorityHost(h) || isOfficialHost(h)),
        ts: Date.parse(it.published_at || '') || 0,
        eng: weightedEngagement(it.source, it.metrics),
      };
    })
    .sort(
      (a, b) =>
        b.rank - a.rank || b.ts - a.ts ||
        (a.host || '').localeCompare(b.host || '') ||
        String(a.it.url || '').localeCompare(String(b.it.url || ''))
    );

  const top = ranked[0];
  const authorityCount = new Set(ranked.filter((r) => r.isAuthMedia).map((r) => r.host)).size;

  // 最热条目只在有原始互动指标的条目里选（官宣/新闻类参与只会全是 0）
  const best = ranked.filter((r) => metricCount(r.it.source, r.it.metrics) > 0).sort((a, b) => b.eng - a.eng)[0];

  const dates = list.map((it) => it.published_at).filter(Boolean).sort();

  return {
    primarySource: top.it.source,
    primaryHost: top.host,
    primaryLabel: top.host ? brandOfHost(top.host) : BRAND_SOURCES[top.it.source] || top.it.source,
    primaryUrl: top.it.url,
    primaryTier: top.rank,
    primaryAuthor: labelAuthor(top.it.author, top.it.source),
    authorityCount,
    shown: ranked
      .filter((r, i) => r.rank >= 2 || i === 0)
      .slice(0, max)
      .map((r) => ({
        host: r.host,
        label: r.host ? brandOfHost(r.host) : BRAND_SOURCES[r.it.source] || r.it.source,
        url: r.it.url,
        source: r.it.source,
        rank: r.rank,
      })),
    metrics: best
      ? {
          source: best.it.source,
          url: best.it.url,
          title: best.it.title,
          author: labelAuthor(best.it.author, best.it.source),
          values: parseMetricsObj(best.it.metrics),
        }
      : null,
    publishedFirst: dates[0] || '',
    publishedLast: dates[dates.length - 1] || '',
  };
}

/** 给 Claude 看的单条证据行：确定性字段全部预先算好，模型不必推测媒体身份 */
export function evidenceLine(item, nowMs = Date.now()) {
  const host = item.host || normalizeHost(item.url);
  const th = sourceThresholds(item.source);
  const eng = Number(item.engagement ?? weightedEngagement(item.source, item.metrics)) || 0;
  const parts = [
    `src=${item.source}`,
    `tier=${dynamicTier(item.source, host)}`,
    `host=${host || '-'}`,
    `eng=${Math.round(eng)}${th ? `/${th.entry}~${th.authority}` : ''}`,
  ];
  if (isOfficialAnnouncement(item.source, host, item.url)) parts.push('official=1');
  if (!isPlatformHost(host) && (isAuthorityHost(host) || isOfficialHost(host))) parts.push('auth=1');
  if (!isPlatformHost(host) && isDeniedHost(host)) parts.push('farm=1');
  if (item.quality_score != null) parts.push(`q=${item.quality_score}`);
  if (item.quality_flags?.length) parts.push(`flags=${item.quality_flags.join('|')}`);
  const badge = badgeText(item.source, item.metrics, 3);
  if (badge) parts.push(`m=${badge}`);
  const pub = item.published_at ? new Date(item.published_at) : null;
  parts.push(pub ? `age=${Math.round(ageHours(item, nowMs))}h` : 'age=?');
  return parts.join(' ');
}
