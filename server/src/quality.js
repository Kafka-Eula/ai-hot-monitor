/**
 * 质量与可信度评估（规则层，在 AI 之前）。
 *
 * 目标：把"随便发一条就被抓进来"的噪音在入库前拦掉，并把判定依据做成可解释的分数。
 *
 * quality_score = 源分级基础分(0-40) + 互动分(0-30) + 新鲜度(0-15) + 域名权威(0-15) − 惩罚
 */
import { getSetting } from './db.js';

/** 源可信分级：1=官方一手 2=强策展社区 3=主流媒体/策展UGC 4=搜索泛结果 */
export const SOURCE_TIER = {
  blog: 1,
  media: 3,
  cn_media: 3,
  news_search: 3,
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

/**
 * 判定方式二选一，避免双重惩罚：
 * - 硬门槛源：社交量化门槛（HN/HF/Reddit/…按加权互动分）或域名门槛（web_search），质量分仅作参考；
 * - 其余（官宣/新闻/媒体类）：由 quality_score >= minQuality 判定。
 */
export const GATED_SOURCES = new Set([
  'hn',
  'hf_papers',
  'gh_trending',
  'gh_search',
  'reddit',
  'lobsters',
  'twitter',
  'web_search', // 域名硬门槛（官方/权威名单内才放行）
  'news_search', // 同上：拦边缘转载站（2026-10 收紧）
]);

/** 该源是否走硬门槛判定（社交量化门槛或泛搜索域名门槛） */
export function isHardGated(source) {
  return GATED_SOURCES.has(source);
}

/**
 * 快照/时效型源：抓取动作本身已限定时间窗（trending=今日、daily_papers=今日精选、
 * 搜索带 df=w），published_at 缺失或过旧不代表低质量，不做新鲜度加减分。
 */
const FRESHNESS_EXEMPT = new Set(['gh_trending', 'gh_search', 'hf_papers', 'web_search']);

/**
 * 快照榜源：条目"何时被推上榜"比"何时发布"更有意义，不受 maxAgeDays 硬拦截。
 * 其余源（含 gated）超过 maxAgeDays 一律拦截——修复"7 月旧帖今天又被抓进来"。
 */
const SNAPSHOT_SOURCES = new Set(['gh_trending', 'hf_papers']);

/** 聚合器/策展层已筛过媒体质量的源，给策展加成 */
const CURATED_BONUS = { news_search: 8, cn_media: 8, media: 8, cn_search: 8 };

/** 厂商/机构官方域名（一手来源，可作真伪佐证） */
export const OFFICIAL_HOSTS = [
  'openai.com', 'anthropic.com', 'claude.com', 'blog.google', 'deepmind.google',
  'googleblog.com', 'huggingface.co', 'meta.com', 'ai.meta.com', 'mistral.ai',
  'cohere.com', 'x.ai',   'microsoft.com', 'deepspeed.ai', 'ollama.com', 'langchain.com',
  'github.blog', 'aws.amazon.com', 'cloud.google.com', 'nvidia.com', 'intel.com',
  'ibm.com', 'salesforce.com', 'unity.com', 'mozilla.org', 'fs.org',
  'moonshot.cn', 'deepseek.com', 'qwenlm.github.io', 'baichuan-inc.com',
  'zhipuai.cn', 'bigmodel.cn', 'minimaxi.com', 'stepfun.com', '01.ai',
];

/** 权威媒体/机构域名（可信转述，非农场） */
export const AUTHORITY_HOSTS = [
  'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'nytimes.com',
  'theverge.com', 'techcrunch.com', 'arstechnica.com', 'wired.com', 'theguardian.com',
  'bbc.com', 'npr.org', 'cbsnews.com', 'nbcnews.com', 'cnbc.com', 'businessinsider.com',
  'forbes.com', 'time.com', 'nature.com', 'science.org', 'arxiv.org', 'acm.org',
  'ieee.org', 'venturebeat.com', 'infoworld.com', 'zdnet.com', 'tomshardware.com',
  'theregister.com', 'synthesis.com', 'the-decoder.com', 'superhuman.ai', 'semianalysis.com',
  'technologyreview.com', 'wired.co.uk', 'axios.com', 'politico.com',
  // 中国官方与主流财经/科技媒体（中文搜索源主要靠这份名单把关）。
  // 注意：sohu.com / 163.com / 网易号 / 百家号等"自媒体聚合平台"故意不列（已在 DENY_HOSTS），
  // 它们转载内容质量不稳定，放行会重新引入噪音。
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'chinadaily.com.cn', 'gmw.cn', 'gov.cn',
  'stcn.com', '21jingji.com', 'caixin.com', 'yicai.com', 'thepaper.cn', 'jiemian.com', 'ifeng.com',
  'chinanews.com', 'chinanews.com.cn', 'infoq.cn', 'oschina.net', 'leiphone.com',
  'qbitai.com', 'jiqizhixin.com', 'cnstock.com', 'nbd.com.cn', 'cls.cn',
  'zaobao.com', 'ftchinese.com', 'wallstreetcn.com',
  // 门户/科技媒体的编辑部频道（承载大量 AI 报道）。
  // 其自媒体聚合子域（sohu.com / 163.com / qq.com / baijiahao 等）已在 DENY_HOSTS，
  // 判定顺序为"先农场后放行"，因此转载号仍会被拦。
  'sina.com.cn', 'ifeng.com', 'eastday.com', 'iresearch.cn', 'hexun.com', 'jrj.com.cn',
  'tmtpost.com', 'iheima.com', 'iyiou.com', 'pingwest.com', 'c114.com.cn', 'ctiforum.com',
  'cs.com.cn',
  'ithome.com', 'qbitai.com', 'infoq.cn', 'geekpark.net', 'leiphone.com', 'ifanr.com',
  '36kr.com', 'syncedreview.com', 'jiqizhixin.com', 'sspai.com', 'sina.com.cn',
  'personatechnology.com', 'mittrchina.com', 'lzwjia.com',
];

/**
 * 内容农场 / SEO 站 / 教程堆砌 / 自媒体转载站（命中即重罚）。
 * 前 14 个来自本项目历史数据实测（web_search 源噪音），其余为公认的低信息增量站点。
 * 注意：不要把已接入的源域名（reddit.com / x.com / hn / hf）放进来，否则自我惩罚。
 */
export const DENY_HOSTS = [
  // 历史数据实测噪音域名
  'felloai.com', 'aiwiki.ai', 'bestofai.io', 'aiomnifeed.com', 'zainode.com',
  'swfte.com', 'ai-bot.cn', 'aiagent.app', 'deepwiki.com', 'geeky-gadgets.com',
  'blink.new', 'andrew.ooo', 'aguidetocloud.com', 'producthunt.com',
  // 教程/文档堆砌站
  'cnblogs.com', 'geeksforgeeks.org', 'javatpoint.com', 'tutorialspoint.com',
  'w3schools.com', 'analyticsvidhya.com', 'kdnuggets.com', 'builtin.com',
  'aimultiple.com', 'simplified.com', 'venngage.com',
  // 营销/工具目录类
  'zapier.com', 'buffer.com', 'notion.so',
  // 自媒体/问答/百科（非新闻一手，信息增量低）
  'medium.com', 'quora.com', 'linkedin.com', 'pinterest.com',
  'zhuanlan.zhihu.com', 'zhihu.com', 'en.wikipedia.org', 'wikipedia.org',
  'baike.baidu.com', 'csdn.net', 'jianshu.com', 'segmentfault.com', '51cto.com',
  'sohu.com', '163.com', 'qq.com', 'toutiao.com', 'bilibili.com',
  // 360kuai=快资讯机器聚合号；huxiu 的入库内容多为"虎嗅号"自媒体转载（标题带" - 虎嗅网"后缀）
  '360kuai.com', 'huxiu.com',
];

/** 营销/软文/会议宣传标题特征 */
const PROMO_PATTERNS = [
  /\b(webinar|giveaway|sponsored|press release|announcement of the|coupon|discount|buy now)\b/i,
  /\b(top \d+|best \d+|\d+ (best|top|tools|ways|reasons)|ultimate guide|beginners guide|how to)\b/i,
  /\b(emtech|summit|conference|awards|nominees|festival)\b/i,
  /(排行|榜单|大全|导航|盘点|教程|入门|科普|优惠|抽奖|发布会直播)/,
  // 会议宣传/报名帖不是热点事件（"创新大会"是极客公园年会自促栏目名）；
  // 注意不能写"开发者大会"——"开发者大会发布 X"是真实产品发布
  /(创新大会|峰会[^的]*(报名|启幕|来袭)|大会报名|参会报名|议程公布|议题征集)/,
  // 资讯汇总类（早报/日报/周报）：一条塞 N 个不相干事件，无法作为单一热点证据
  /^[\s【\[（(]*(早报|日报|周报|晚报|午报|快讯|早报▏|一周AI)/,
  /(早报|日报|周报|晚报)[｜|▏]/,
];

/** 与 AI 热点无关的纯观点/生活类标题特征（博客观点文） */
const OPINION_PATTERNS = [
  /\b(don'?t be fooled|won'?t change your life|we'?re putting too much|people really hate)\b/i,
];

export function normalizeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostMatch(host, list) {
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith('.' + d) || host === d.replace(/^www\./, ''));
}

/**
 * 是否为"首页/落地页"型 URL（无具体文章路径）。
 * 搜索引擎常把公司主页、App 下载页、产品页当结果返回，它们不是新闻事件。
 */
export function isLandingPageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const path = (u.pathname || '/').replace(/\/+$/, '');
  if (path === '' || path === '/') return true;
  // 只有一层且是通用产品/落地词（/deepseek、/download、/app、/zh 等）
  const seg = path.split('/').filter(Boolean);
  if (seg.length === 1 && /^(download|app|apps|zh|cn|en|product|home|index|start|get|mobile)$/.test(seg[0])) return true;
  // 应用商店页
  if (/play\.google\.com|apps\.apple\.com|apps\.google/i.test(u.hostname + path)) return true;
  return false;
}

export function isOfficialHost(host) {
  return hostMatch(host, OFFICIAL_HOSTS);
}

/**
 * 是否"厂商对自己产品的一手官宣"——判定**只看域名**（不看 source 是否 RSS）。
 * 这样 MIT Technology Review（technologyreview.com）、量子位等媒体即使走"官方博客"源
 * 也不会被误当官宣，从而不再享受单源豁免与加分。
 * 例外：hf_papers 虽托管在 huggingface.co，但它是作者自述预印本，不是厂商官宣。
 */
export function isOfficialAnnouncement(source, host) {
  if (source === 'hf_papers') return false;
  return isOfficialHost(host || '');
}
export function isAuthorityHost(host) {
  return hostMatch(host, AUTHORITY_HOSTS);
}
export function isDeniedHost(host) {
  return hostMatch(host, DENY_HOSTS);
}

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
 * 加权互动分（engagement）：不同源的指标按传播力加权，跨源可比。
 * 转发/评论比点赞更能代表传播，故权重更高；浏览量取 log 防刷量主导。
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
    case 'gh_trending':
      return n('stars_today'); // 只有"当日新增"才是新闻信号，总星数不是
    case 'gh_search':
      return n('stars') + n('forks') * 2; // 近 7 天新建，总星数即增量
    case 'hf_papers':
      return n('upvotes');
    default:
      return 0; // 官宣/新闻/搜索类无互动指标
  }
}

/** 兼容旧调用：等价于 weightedEngagement */
export function extractEngagement(metrics, source = '') {
  return weightedEngagement(source, metrics);
}

/** 社交平台（其热度以加权互动分衡量，需达"权威门槛"才算被广泛讨论） */
export const SOCIAL_SOURCES = new Set(['hn', 'reddit', 'twitter', 'lobsters', 'gh_trending', 'gh_search', 'hf_papers']);

/** 新鲜度：以发布时间（缺失则抓取时间）距今小时数 */
export function ageHours(item, nowMs = Date.now()) {
  const iso = item.published_at || item.collected_at;
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 3600000);
}

export function tierOf(source) {
  return SOURCE_TIER[source] ?? 4;
}

/**
 * 动态分级：以**真实域名**为准，而非仅看 source。
 * - 官方域名 → T1；
 * - blog 源但域名非官方（MIT TR、量子位等评论/媒体出版方）→ 降到 T3（它是媒体不是厂商）；
 * - 权威媒体域名 → 至少 T3。
 */
export function dynamicTier(source, host) {
  if (isOfficialAnnouncement(source, host)) return 1;
  const t = tierOf(source);
  if (source === 'blog') return 3;
  if (t >= 4 && isAuthorityHost(host)) return 3;
  return t;
}

/**
 * 计算规则质量分。
 * @returns {{score:number, tier:number, host:string, engagement:number, flags:string[]}}
 */
export function computeQuality(item, nowMs = Date.now()) {
  const host = item.host || normalizeHost(item.url);
  const tier = dynamicTier(item.source, host);
  const engagement = item.engagement ?? weightedEngagement(item.source, item.metrics);
  const flags = [];
  const th = sourceThresholds(item.source);

  let score = TIER_BASE[tier] ?? 14;

  if (th) {
    // 量化互动源：以该源"权威门槛"为满分刻度做 log 归一化（跨源可比），上限 30
    const ratio = Math.max(0, Number(engagement)) / Math.max(1, th.authority);
    score += Math.min(30, Math.max(0, Math.log10(1 + ratio) * 30));
    if (ratio >= 1) score += 10; // 达到权威门槛：被广泛讨论的强信号
    else if (ratio >= 0.3) score += 4;
  } else {
    // 官宣/新闻/搜索类：本身无互动指标，给中性分 + 聚合器策展加成（避免系统性误杀）
    score += 15;
    score += CURATED_BONUS[item.source] || 0;
  }

  // 新鲜度（快照型源豁免）
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

  // 域名权威（农场黑名单惩罚仅针对 T3/T4 源，避免误伤官方与策展源）
  if (isOfficialHost(host)) score += 15;
  else if (isAuthorityHost(host)) score += 10;
  else if (isDeniedHost(host) && tier >= 3) {
    score -= 25;
    flags.push('content_farm');
  } else if (tier === 4) score -= 5; // 泛搜索结果的未知域名

  // 标题特征
  const title = item.title || '';
  if (PROMO_PATTERNS.some((re) => re.test(title))) {
    score -= 15;
    flags.push('promo_or_guide');
  }
  // 资讯汇总帖：标题里塞 ≥2 个分号分隔的独立事件，无法作为单一热点的证据
  const semiCount = (title.match(/[；;]/g) || []).length;
  if (semiCount >= 2) {
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

  return {
    score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
    tier,
    host,
    engagement,
    flags,
  };
}

/**
 * 各源硬门槛默认值（可被 settings 覆盖）。
 * xxxScore/xxxPoints 等作用于**加权互动分**（见 weightedEngagement），
 * authXxx 是"权威门槛"：达到才算"该事件被广泛讨论"，可参与话题分数解锁。
 */
export const DEFAULT_GATES = {
  hnPoints: 30,
  hnComments: 15,
  hfUpvotes: 30,
  ghStarsToday: 50,
  ghSearchStars: 100,
  redditScore: 200,
  lobstersScore: 20,
  twitterLikes: 50,
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
};

/** 各源加权互动分的入库门槛 / 权威门槛 */
const SOCIAL_GATE_KEY = {
  hn: ['hnPoints', 'authHn'],
  reddit: ['redditScore', 'authReddit'],
  twitter: ['twitterLikes', 'authTwitter'],
  lobsters: ['lobstersScore', 'authLobsters'],
  gh_trending: ['ghStarsToday', 'authGhTrending'],
  gh_search: ['ghSearchStars', 'authGhSearch'],
  hf_papers: ['hfUpvotes', 'authHfPapers'],
};

export function gates() {
  const num = (key, def) => {
    const v = getSetting(`gates.${key}`);
    return v === undefined || v === null || v === '' ? def : Number(v);
  };
  const bool = (key, def) => {
    const v = getSetting(`gates.${key}`);
    return v === undefined ? def : Boolean(v);
  };
  return {
    hnPoints: num('hnPoints', DEFAULT_GATES.hnPoints),
    hnComments: num('hnComments', DEFAULT_GATES.hnComments),
    hfUpvotes: num('hfUpvotes', DEFAULT_GATES.hfUpvotes),
    ghStarsToday: num('ghStarsToday', DEFAULT_GATES.ghStarsToday),
    ghSearchStars: num('ghSearchStars', DEFAULT_GATES.ghSearchStars),
    redditScore: num('redditScore', DEFAULT_GATES.redditScore),
    lobstersScore: num('lobstersScore', DEFAULT_GATES.lobstersScore),
    twitterLikes: num('twitterLikes', DEFAULT_GATES.twitterLikes),
    authHn: num('authHn', DEFAULT_GATES.authHn),
    authReddit: num('authReddit', DEFAULT_GATES.authReddit),
    authTwitter: num('authTwitter', DEFAULT_GATES.authTwitter),
    authLobsters: num('authLobsters', DEFAULT_GATES.authLobsters),
    authGhTrending: num('authGhTrending', DEFAULT_GATES.authGhTrending),
    authGhSearch: num('authGhSearch', DEFAULT_GATES.authGhSearch),
    authHfPapers: num('authHfPapers', DEFAULT_GATES.authHfPapers),
    minQuality: num('minQuality', DEFAULT_GATES.minQuality),
    maxAgeDays: num('maxAgeDays', DEFAULT_GATES.maxAgeDays),
    dedupThreshold: num('dedupThreshold', DEFAULT_GATES.dedupThreshold),
    dedupEnabled: bool('dedupEnabled', DEFAULT_GATES.dedupEnabled),
  };
}

/** 该源的加权互动分入库门槛 / 权威门槛 */
export function sourceThresholds(source, g = gates()) {
  const keys = SOCIAL_GATE_KEY[source];
  if (!keys) return null;
  return { entry: g[keys[0]], authority: g[keys[1]] };
}

/** 该条目是否达到"权威门槛"（社交热度足以作为事件被广泛讨论的证据） */
export function isViral(source, engagement, g = gates()) {
  const th = sourceThresholds(source, g);
  if (!th) return false;
  return (Number(engagement) || 0) >= th.authority;
}

/**
 * 各源硬门槛（在质量分之前拦截，集中在此便于测试与调参）。
 * @returns {{pass:boolean, reason:string}}
 */
export function passesGate(item, g = gates(), nowMs = Date.now()) {
  const m = parseMetricsObj(item.metrics);
  const hasDate = Boolean(item.published_at);
  const host = item.host || normalizeHost(item.url);

  // 时效硬门槛：快照榜源（trending/daily_papers）豁免，其余发布超过 maxAgeDays 一律拦截
  if (!SNAPSHOT_SOURCES.has(item.source) && hasDate) {
    const hours = ageHours(item, nowMs);
    if (hours !== null && hours > g.maxAgeDays * 24) {
      return { pass: false, reason: `too_old(${Math.round(hours / 24)}d>${g.maxAgeDays}d)` };
    }
  }

  // 社交平台：按加权互动分（点赞+转发×N+评论×N…）判定入库门槛
  const th = sourceThresholds(item.source, g);
  if (th) {
    const e = weightedEngagement(item.source, m);
    if (e >= th.entry) return { pass: true, reason: '' };
    // HN 高讨论量兜底（评论多但点数低的深度帖）
    if (item.source === 'hn' && (Number(m.comments) || 0) >= g.hnComments) return { pass: true, reason: '' };
    return { pass: false, reason: `${item.source}_low_engagement(${Math.round(e)}<${th.entry})` };
  }

  if (item.source === 'web_search' || item.source === 'cn_search' || item.source === 'news_search') {
    // 泛搜索结果噪音最大：域名必须在官方/权威名单内（时间新鲜度由质量分保障）。
    // news_search 同样过这道关：Google/Bing 新闻会带出 blocktempo/howtogeek/moomoo
    // 这类边缘转载站，宁缺毋滥（2026-10 用户明确要求增强权威性）。
    if (isDeniedHost(host)) return { pass: false, reason: `${item.source}_content_farm(${host})` };
    if (!isOfficialHost(host) && !isAuthorityHost(host)) {
      return { pass: false, reason: `${item.source}_untrusted_host(${host})` };
    }
    // 中文新闻搜索额外两关：无时间戳无法判断新鲜度，一律拦掉；
    // 落地页/首页型 URL 不是新闻事件（防御性保留，360 正常结果均为文章页）。
    if (item.source === 'cn_search') {
      if (!item.published_at) return { pass: false, reason: 'cn_search_no_date' };
      if (isLandingPageUrl(item.url)) return { pass: false, reason: 'cn_search_homepage' };
    }
    return { pass: true, reason: '' };
  }

  return { pass: true, reason: '' };
}

// ---------------- 近似去重 ----------------

/** 标题归一化：小写、去标点、去常见停用词 */
export function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .join(' ');
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are',
  'was', 'be', 'been', 'it', 'its', 'this', 'that', 'as', 'by', 'from', 'new', 'news',
  'how', 'what', 'why', 'when', 'where', 'who', 's', 't', 'll', 've', 're',
]);

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

/**
 * 组内近似去重：按质量分降序保留最优一条，其余标记 dup_of。
 * @param {Array} enriched 已带 quality 的条目
 * @param {number} threshold
 * @returns {{keep: Array, merged: Array}}
 */
export function dedupByTitle(enriched, threshold = 0.85) {
  const keep = [];
  const merged = [];
  // 质量分高的先占位，相似标题的后来者被合并
  const sorted = [...enriched].sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0));
  for (const it of sorted) {
    const hit = keep.find((k) => titleSimilarity(k.title, it.title) >= threshold);
    if (hit) {
      merged.push({ ...it, dup_of: hit.url, dup_title: hit.title });
    } else {
      keep.push(it);
    }
  }
  return { keep, merged };
}

/**
 * 质量闸门：硬门槛 → 质量分 → 同源近似去重（跨源重复保留，作为多源佐证证据）。
 * @param {Array} items normItem 输出
 * @param {object} opts { g: gates, nowMs }
 * @returns {{passed:Array, blocked:Array<{item:object, reason:string}>}}
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
    // 硬门槛源（社交量化 + 泛搜索域名）由门槛判定，质量分仅作参考；
    // 其余（官宣/新闻/中文媒体）必须过质量分门槛
    if (!isHardGated(it.source) && q.score < g.minQuality) {
      blocked.push({ item: it, reason: `low_quality(${q.score}<${g.minQuality}${q.flags.length ? ',' + q.flags[0] : ''})` });
      continue;
    }
    scored.push({ ...it, quality_score: q.score, engagement: q.engagement, source_tier: q.tier, host: q.host, quality_flags: q.flags });
  }

  // 同源内近似去重（保留质量分最高者）
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

/**
 * 证据统计（代码算，不依赖 AI 自报）。
 * 除跨源/跨域/官方一手外，额外统计：
 *  - authority_media_count：报道该事件的**不同权威媒体域名**数（≥2 即交叉报道）
 *  - viral_count：达到"权威门槛"的社交平台条目数（点赞/转发/评论加权后够热）
 *  - social_only：该话题是否完全由社交平台条目构成
 */
export function evidenceOf(items, g = gates()) {
  const sources = new Set();
  const hosts = new Set();
  const authorityHosts = new Set();
  let hasOfficial = 0;
  let viralCount = 0;
  let socialOnly = items.length > 0;

  for (const it of items) {
    sources.add(it.source);
    const h = it.host || normalizeHost(it.url);
    if (h) hosts.add(h);
    if (isOfficialAnnouncement(it.source, h)) hasOfficial = 1;

    if (SOCIAL_SOURCES.has(it.source)) {
      const eng = it.engagement ?? weightedEngagement(it.source, it.metrics);
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
    social_only: socialOnly ? 1 : 0,
    sources: [...sources].sort(),
  };
}

/**
 * 证据等级 → 分数上限 / 可否通知。
 * 官方一手、≥2 家权威媒体交叉 → 不封顶；
 * 纯社交但 ≥2 条够热 → 80 封顶（社交热度可解锁通知）；
 * 纯社交但不够热 → 60 封顶且不通知（治"随手发帖成热点"）。
 */
const EVIDENCE_TIERS = {
  official: { cap: 100, notify: true },
  media_cross: { cap: 100, notify: true },
  viral_social: { cap: 80, notify: true },
  single_viral: { cap: 65, notify: false },
  social_weak: { cap: 60, notify: false },
  weak: { cap: 65, notify: false },
};

export function evidenceTier(ev) {
  if (ev.has_official) return 'official';
  if ((ev.authority_media_count || 0) >= 2) return 'media_cross';
  const viral = ev.viral_count || 0;
  // 两条以上社交爆款 = 事件确实被广泛讨论（即使混有媒体报道，也按社交档处理）
  if (viral >= 2) return 'viral_social';
  if (ev.social_only) return viral === 1 ? 'single_viral' : 'social_weak';
  return 'weak';
}

/** 按证据等级封顶（治"1 条也给 100 分"） */
export function capScore(rawScore, ev) {
  const s = Number(rawScore) || 0;
  const tier = evidenceTier(ev);
  const cap = EVIDENCE_TIERS[tier].cap;
  return { score: Math.min(s, cap), capped: s > cap, tier, cap };
}

/**
 * 通知证据规则：等级本身即代表证据充分性
 * （official=厂商官宣 / media_cross=≥2 家权威媒体交叉 / viral_social=≥2 条社交爆款）。
 */
export function hasNotifyEvidence(ev) {
  return EVIDENCE_TIERS[evidenceTier(ev)].notify;
}

export default {
  computeQuality,
  gates,
  dedupByTitle,
  evidenceOf,
  capScore,
  hasNotifyEvidence,
  weightedEngagement,
  isViral,
};
