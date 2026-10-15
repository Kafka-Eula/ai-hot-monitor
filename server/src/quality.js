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
  'bilibili', // 互动量化门槛（播放/点赞/投币/收藏/转发/弹幕加权）
  'bilibili_hot',
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

/** 用户生成内容的页面（不是厂商官宣）：HF 的模型/数据集/空间页人人可建，
 *  搜索引擎抓到的这类页会把话题误标成"官方一手"（实测：某用户上传的 llama5.2 模型页被当成官方发布）。 */
const UGC_PATH_RE = /^\/(?:datasets|spaces)\/|[^/]+\/[^/]+-(?:model|gguf|datasets?)(?:\/|$)/i;

/**
 * 是否"厂商对自己产品的一手官宣"——判定**只看域名**（不看 source 是否 RSS）。
 * 这样 MIT Technology Review（technologyreview.com）、量子位等媒体即使走"官方博客"源
 * 也不会被误当官宣，从而不再享受单源豁免与加分。
 * 例外：
 *  - hf_papers：作者自述预印本，不是厂商官宣；
 *  - HuggingFace 的用户模型/数据集页（/user/model-model）同理。
 */
export function isOfficialAnnouncement(source, host, url = '') {
  if (source === 'hf_papers') return false;
  if (!isOfficialHost(host || '')) return false;
  if (/huggingface\.co$/i.test(host || '') && UGC_PATH_RE.test(urlPath(url))) return false;
  return true;
}

function urlPath(url) {
  try {
    return new URL(url).pathname || '';
  } catch {
    return String(url || '');
  }
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
    // B站：投币(2)+收藏(3)+转发(4)比点赞更能代表"值得看/值得传"，弹幕与评论同权重（讨论度）；
    // 播放量取 log 且只占小头——B站播放动辄百万，线性计入会淹没其他平台信号。
    case 'bilibili':
    case 'bilibili_hot':
      return (
        n('like') + n('coin') * 2 + n('fav') * 3 + n('share') * 4 +
        n('danmaku') + n('reply') * 1.5 + Math.log10(1 + n('view')) * 30
      );
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
export const SOCIAL_SOURCES = new Set([
  'hn', 'reddit', 'twitter', 'lobsters', 'gh_trending', 'gh_search', 'hf_papers', 'bilibili', 'bilibili_hot',
]);

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
    // 平台自身域名（bilibili.com / github.com…）是"内容托管在哪"，不是内容农场，
    // 绝不能走农场惩罚——否则接入平台型信息源会自我惩罚（实测：B站条目被扣 25 分）
    else if (!isPlatformHost(host) && isDeniedHost(host) && tier >= 3) {
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
  // B站：播放量以 log×30 计入（200 万播放才贡献 ~190 分），真正拉开差距的是点赞/投币/收藏/转发。
  // 入库门槛 500 ≈ "几千播放且有点赞"的中等 UP 作品；爆款门槛 5000 ≈ 头部破圈内容。
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
    // 话题热度分里的互动权重与互动满刻度（用户要求：互动越多排名越靠前）
    engagementWeight: 0.4,
    engagementFull: 1000,
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
  bilibili: ['biliScore', 'authBili'],
  bilibili_hot: ['biliScore', 'authBili'],
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
        biliScore: num('biliScore', DEFAULT_GATES.biliScore),
        authHn: num('authHn', DEFAULT_GATES.authHn),
    authReddit: num('authReddit', DEFAULT_GATES.authReddit),
    authTwitter: num('authTwitter', DEFAULT_GATES.authTwitter),
    authLobsters: num('authLobsters', DEFAULT_GATES.authLobsters),
    authGhTrending: num('authGhTrending', DEFAULT_GATES.authGhTrending),
    authGhSearch: num('authGhSearch', DEFAULT_GATES.authGhSearch),
    authHfPapers: num('authHfPapers', DEFAULT_GATES.authHfPapers),
        authBili: num('authBili', DEFAULT_GATES.authBili),
    minQuality: num('minQuality', DEFAULT_GATES.minQuality),
    maxAgeDays: num('maxAgeDays', DEFAULT_GATES.maxAgeDays),
    dedupThreshold: num('dedupThreshold', DEFAULT_GATES.dedupThreshold),
    dedupEnabled: bool('dedupEnabled', DEFAULT_GATES.dedupEnabled),
        engagementWeight: num('engagementWeight', DEFAULT_GATES.engagementWeight),
        engagementFull: num('engagementFull', DEFAULT_GATES.engagementFull),
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
    let engTotal = 0;
    let socialOnly = items.length > 0;

    for (const it of items) {
      sources.add(it.source);
      const h = it.host || normalizeHost(it.url);
      if (h) hosts.add(h);
      if (isOfficialAnnouncement(it.source, h, it.url)) hasOfficial = 1;

      // 互动总量：话题内**全部**条目累加（官方/新闻类无互动接口，天然贡献 0），
      // 供话题热度分合成使用——高互动话题（B站/社交）因此能排到前面
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

/** 话题互动量基准尺度：与 log 曲线配合，决定"多少互动算中等热度" */
export const ENGAGEMENT_FULL = 1000;
/** 互动分量在话题热度分中的权重（与 AI 基线分并列的主成分） */
export const ENGAGEMENT_WEIGHT = 0.4;
/**
 * 互动分量的曲线系数：每 10 倍互动 ≈ +40 分（封顶 100）。
 * 即 互动分量 = min(100, 40 × log₁₀(1 + 总量/基准))。
 */
const ENGAGEMENT_K = 40;

/**
 * 话题互动分量（0~100）：对全话题加权互动总量做**对数**归一。
 *
 * 为何用对数而非线性/指数：互动是长尾分布——B站头部几万到几十万互动，
 * 普通话题几百互动。线性归一会让头部顶死、其余全挤在 0 附近；
 * 指数曲线又衰减太快（实测 10 万互动即满分，30 万与 100 万无区分度）。
 * 对数曲线在整个现实区间都有区分度（基准 1000）：
 *   500 → 7 分·2千 → 19 分·1万 → 42 分·2万 → 53 分·10万 → 80 分·30万 → 100 分
 */
export function engagementScore(engagementTotal, g = gates()) {
  const total = Math.max(0, Number(engagementTotal) || 0);
  if (!total) return 0;
  const full = Math.max(1, Number(g.engagementFull) || ENGAGEMENT_FULL);
  const score = ENGAGEMENT_K * Math.log10(1 + total / full);
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}

/**
 * 合成话题热度分：互动分量与 AI 基线分**并列**，最后按证据等级封顶。
 *
 * score = (1−w) × AI基线 + w × 互动分量
 *   · 高互动话题（B站/社交爆款）直接压过 0 互动的官方发布（用户明确要求）；
 *   · w 由 gates.engagementWeight 控制（默认 0.4），设 0 即退回"纯 AI 评分"；
 *   · 封顶仍以证据等级为准（official/media_cross 100、viral_social 80…），
 *     保证"单源孤证"不会因为互动高就绕过封顶。
 *
 * @param {number} baseScore AI 给的基线分
 * @param {number} engagementTotal 话题加权互动总量（evidenceOf().engagement_total）
 * @param {object} ev evidenceOf 结果（决定封顶）
 * @param {object} g gates
 */
export function combineScore(baseScore, engagementTotal, ev, g = gates()) {
  const base = Math.max(0, Math.min(100, Number(baseScore) || 0));
  const w = Math.max(0, Math.min(1, Number(g.engagementWeight ?? ENGAGEMENT_WEIGHT)));
  const eng = w > 0 ? engagementScore(engagementTotal, g) : 0;
  const blended = (1 - w) * base + w * eng;
  const capped = capScore(blended, ev);
  return {
    ...capped,
    base: Math.round(base * 10) / 10,
    engagement: eng,
    weight: w,
    blended: Math.round(blended * 10) / 10,
  };
}

/**
 * 通知证据规则：等级本身即代表证据充分性
 * （official=厂商官宣 / media_cross=≥2 家权威媒体交叉 / viral_social=≥2 条社交爆款）。
 */
export function hasNotifyEvidence(ev) {
  return EVIDENCE_TIERS[evidenceTier(ev)].notify;
}

// ---------------- v1.4 来源摘要与原始数据 ----------------

/**
 * 域名的展示品牌名（把 openai.com / techcrunch.com 变成人一眼认得的"谁在说"）。
 * 名单不全没关系：未命中的域名回退为域名本身（去掉 .com/.cn 等后缀）。
 */
export const BRAND_HOSTS = {
  // 厂商官方
  'openai.com': 'OpenAI 官方',
  'anthropic.com': 'Anthropic 官方',
  'claude.com': 'Claude 官方',
  'deepmind.google': 'DeepMind 官方',
  'blog.google': 'Google 官方',
  'googleblog.com': 'Google 官方',
  'ai.meta.com': 'Meta AI 官方',
  'meta.com': 'Meta 官方',
  'mistral.ai': 'Mistral 官方',
  'cohere.com': 'Cohere 官方',
  'x.ai': 'xAI 官方',
  'microsoft.com': 'Microsoft 官方',
  'nvidia.com': 'NVIDIA 官方',
  'huggingface.co': 'HuggingFace',
  'deepseek.com': 'DeepSeek 官方',
  'moonshot.cn': '月之暗面官方',
  'bigmodel.cn': '智谱官方',
  'zhipuai.cn': '智谱官方',
  'ollama.com': 'Ollama 官方',
  'langchain.com': 'LangChain 官方',
  // 权威媒体（英文）
  'reuters.com': '路透社',
  'apnews.com': '美联社',
  'bloomberg.com': '彭博社',
  'ft.com': '金融时报',
  'wsj.com': '华尔街日报',
  'nytimes.com': '纽约时报',
  'theverge.com': 'The Verge',
  'techcrunch.com': 'TechCrunch',
  'arstechnica.com': 'Ars Technica',
  'wired.com': 'WIRED',
  'theguardian.com': '卫报',
  'bbc.com': 'BBC',
  'cnbc.com': 'CNBC',
  'businessinsider.com': 'Business Insider',
  'forbes.com': '福布斯',
  'venturebeat.com': 'VentureBeat',
  'zdnet.com': 'ZDNet',
  'tomshardware.com': "Tom's Hardware",
  'theregister.com': 'The Register',
  'the-decoder.com': 'The Decoder',
  'semianalysis.com': 'SemiAnalysis',
  'technologyreview.com': 'MIT 科技评论',
  'mittrchina.com': 'MIT 科技评论中文',
  'axios.com': 'Axios',
  'nature.com': 'Nature',
  'arxiv.org': 'arXiv',
  'syncedreview.com': 'Synced',
  // 中文媒体
  'xinhuanet.com': '新华社',
  'news.cn': '新华网',
  'people.com.cn': '人民网',
  'cctv.com': '央视网',
  'chinadaily.com.cn': '中国日报',
  'thepaper.cn': '澎湃新闻',
  'jiemian.com': '界面新闻',
  'yicai.com': '第一财经',
  'caixin.com': '财新',
  '21jingji.com': '21世纪经济报道',
  'stcn.com': '证券时报',
  'cls.cn': '财联社',
  'wallstreetcn.com': '华尔街见闻',
  'nbd.com.cn': '每日经济新闻',
  'ifeng.com': '凤凰网',
  'sina.com.cn': '新浪',
  'chinanews.com': '中新网',
  'chinanews.com.cn': '中新网',
  'zaobao.com': '联合早报',
  'ftchinese.com': 'FT中文网',
  'qbitai.com': '量子位',
  'jiqizhixin.com': '机器之心',
  'infoq.cn': 'InfoQ 中文',
  'geekpark.net': '极客公园',
  'leiphone.com': '雷锋网',
  'ifanr.com': '爱范儿',
  '36kr.com': '36氪',
  'ithome.com': 'IT之家',
  'tmtpost.com': '钛媒体',
  'sspai.com': '少数派',
  'oschina.net': '开源中国',
  'iresearch.cn': '艾瑞网',
  'hexun.com': '和讯网',
  'c114.com.cn': 'C114 通信网',
  'eastday.com': '东方网',
  'cs.com.cn': '中国证券报',
  'gmw.cn': '光明网',
  'gov.cn': '中国政府网',
  'pingwest.com': '品玩',
  'iheima.com': 'i黑马',
  'iyiou.com': '亿欧',
  'ctiforum.com': '通信世界',
  'jrj.com.cn': '金融界',
  'cnstock.com': '上海证券报',
  'lzwjia.com': '量子位',
    // 平台自身域名（社交/榜单/论文库条目 URL 的 host）
    'github.com': 'GitHub',
    'news.ycombinator.com': 'Hacker News',
    'ycombinator.com': 'Hacker News',
    'lobste.rs': 'Lobsters',
    'reddit.com': 'Reddit',
    'x.com': 'X / Twitter',
    'twitter.com': 'X / Twitter',
    'aws.amazon.com': 'AWS 官方',
    'ibm.com': 'IBM',
    'npr.org': 'NPR',
    'youtube.com': 'YouTube',
    'bleepingcomputer.com': 'BleepingComputer',
    'bilibili.com': 'B站',
  };

  /** 公共二级后缀（回退取域名时需多带一级，避免把 aws.amazon.com 截成 aws.amazon） */
  const PUBLIC_SLD = /^(co|com|net|org|gov|edu)\.(uk|cn|au|jp|hk|tw|br|in|de|fr|ru|kr|sg|nz|za|mx|ar|tr|it|es|nl|se|no|pl)$/;

/** 无自有域名的渠道型源（社交/榜单/论文库）的展示名 */
export const BRAND_SOURCES = {
  hn: 'Hacker News',
  gh_trending: 'GitHub Trending',
  gh_search: 'GitHub 新库',
  hf_papers: 'HF Papers',
  lobsters: 'Lobsters',
  reddit: 'Reddit',
  twitter: 'X / Twitter',
  bilibili: 'B站',
  bilibili_hot: 'B站热门',
};

/** 域名品牌名（未命中名单则回退取域名主干，如 aws.amazon.com → amazon） */
export function brandOfHost(host) {
  if (!host) return '';
  if (BRAND_HOSTS[host]) return BRAND_HOSTS[host];
  const hit = Object.keys(BRAND_HOSTS).find((d) => host === d || host.endsWith('.' + d));
  if (hit) return BRAND_HOSTS[hit];
  const parts = host.split('.');
  // 双段后缀（co.uk/com.cn）多带一级：aws.amazon.co.uk → amazon
  const take = parts.length >= 3 && PUBLIC_SLD.test(parts.slice(-2).join('.')) ? 3 : 2;
  const main = parts.length > take && parts[parts.length - take] !== 'www' ? parts[parts.length - take] : parts[0];
  return main || host;
}

/**
 * 来源权威度分级（决定"最权威来源"取谁）：
 * 4=厂商/机构官方一手，3=权威媒体，2=策展社区/论文库，1=其他。
 * hf_papers 不走官方豁免（作者自述预印本），按论文库算。
 */
export function authorityRank(source, host, url = '') {
  // hf_papers 虽托管在 huggingface.co（官方域名名单内），但它是作者自述预印本而非厂商官宣，
  // 与证据分级口径保持一致：按"论文库"算，不计入权威来源数。
  if (source === 'hf_papers') return 2;
  if (source === 'blog' && !isOfficialHost(host)) return 3; // 官方博客源里的媒体出版方
  // 官宣判定要排除社交/榜单渠道：X 帖若链接自家站点（x.ai）也只是"在 X 上发帖"，
  // 不是一手官宣页；这类条目应作为社交信号（rank 2）参与，而不是压过新闻报道。
  if (!CHANNEL_SOURCES.has(source) && isOfficialAnnouncement(source, host, url)) return 4;
  // HuggingFace：官方组织空间才是官方发布，用户模型/数据集页按论文库档位（不为"单源"脱罪）
  if (/huggingface\.co$/i.test(host || '')) return 2;
  if (isAuthorityHost(host) || isOfficialHost(host)) return 3;
  if (BRAND_SOURCES[source]) return 2;
  return 1;
}

/**
 * 渠道型源：条目自带的域名只是平台自身（github.com / news.ycombinator.com / x.com…），
 * 不代表"谁在说这件事"。它们按渠道（BRAND_SOURCES）参与排序，不享受厂商官宣豁免。
 */
export const CHANNEL_SOURCES = new Set([
  'hn', 'gh_trending', 'gh_search', 'hf_papers', 'lobsters', 'reddit', 'twitter', 'bilibili', 'bilibili_hot',
]);

/** 平台自身域名（社交/榜单/论文库）：没有"平台"这个来源方，展示与计数都应排除 */
export const PLATFORM_HOSTS = [
  'huggingface.co', 'github.com', 'x.com', 'twitter.com', 'news.ycombinator.com', 'lobste.rs', 'reddit.com',
  'bilibili.com', 'b23.tv',
];

/** 是否"平台自身"域名（前端用于过滤"来源域名"列表与计数） */
export function isPlatformHost(host) {
return hostMatch(host, PLATFORM_HOSTS);
}

/** 该条目的原始指标是否有意义（新闻/官宣源没有互动接口，恒为 0） */
export function metricCount(source, metrics) {
  const m = parseMetricsObj(metrics);
  return Object.values(m).filter((v) => Number(v) > 0).length;
}

/**
 * 发布者署名：X 的 @handle 规范化，GitHub 条目的 author 其实是语言（不是发布者）故置空。
 * 与 routes/api.js 的展示口径保持一致（前端列表与卡片署名不打架）。
 */
export function labelAuthor(author, source) {
  const a = String(author || '').trim();
  if (!a) return '';
  if (source === 'gh_trending' || source === 'gh_search') return '';
  if (source === 'twitter') return a.startsWith('@') ? a : `@${a}`;
  return a;
}

/**
 * 来源摘要：算出"卡片该显示的 1~2 个最权威来源"与话题的原始发布/互动轴。
 *
 * 排序优先级：厂商官方 > 权威媒体 > 策展社区；同档按发布时间新→旧，再按域名稳定排序，
 * 保证同一话题跨轮次展示一致（不会每轮扫描换个来源）。
 * 注意话题的 last_updated 是聚类时间、会随并入新条目而变，不能用来判断新旧，
 * 故这里单列 publishedFirst / publishedLast 作为原始发布轴。
 *
 * @param {Array<{source,url,host,metrics,published_at,author,title}>} items 话题全部条目
  * @param {object} opts { max: 卡片显示几个来源 }
 */
export function summarizeSources(items, opts = {}) {
  const max = opts.max || 2;
  const list = items || [];
  if (!list.length) {
    return {
      primarySource: '', primaryHost: '', primaryLabel: '', primaryUrl: '', primaryTier: 0,
      primaryAuthor: '', authorityCount: 0, shown: [], metrics: null,
      publishedFirst: '', publishedLast: '',
    };
  }

  const ranked = list
    .map((it) => {
      const h = it.host || normalizeHost(it.url || '');
        return {
          it,
          host: h,
          rank: authorityRank(it.source, h, it.url),
          // "权威媒体/官方也报道了"的有效证据：必须是有编辑责任的外部**媒体/官方域名**。
          // 平台自身域名（huggingface.co / github.com / x.com…）不算报道——否则用户上传的
          // 模型页会被算成"媒体交叉"（实测：某用户 llama5.2 模型页曾把话题抬成官方一手）。
          isAuthMedia: !isPlatformHost(h) && (isAuthorityHost(h) || isOfficialHost(h)),
          ts: Date.parse(it.published_at || '') || 0,
          eng: weightedEngagement(it.source, it.metrics),
        };
      })
      .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.ts - a.ts ||
        (a.host || '').localeCompare(b.host || '') ||
        String(a.it.url || '').localeCompare(String(b.it.url || ''))
    );

  const top = ranked[0];
    // 权威来源数 = 官方/权威媒体的**不同域名**数（不含平台自身域名），
    // 与 evidenceOf().authority_media_count 同口径：同一家媒体发 8 篇只算 1 个来源，
    // 卡片上的 "+N" 就是"另外还有 N 家权威媒体/官方也在说"。
    const authorityCount = new Set(ranked.filter((r) => r.isAuthMedia).map((r) => r.host)).size;

  // 最热条目：只在有原始互动指标的类型里选（官宣/新闻类参与只会全是 0）
  const best = ranked.filter((r) => metricCount(r.it.source, r.it.metrics) > 0).sort((a, b) => b.eng - a.eng)[0];
  const metrics = best
      ? {
          source: best.it.source,
          url: best.it.url,
          title: best.it.title,
          author: labelAuthor(best.it.author, best.it.source),
          // metrics 列是 TEXT：这里必须解析成对象再落库，否则消费方拿到的是 JSON 字符串
          values: parseMetricsObj(best.it.metrics),
        }
      : null;

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
    metrics,
    publishedFirst: dates[0] || '',
    publishedLast: dates[dates.length - 1] || '',
  };
}

export default {
  computeQuality,
  gates,
  dedupByTitle,
  evidenceOf,
  capScore,
  combineScore,
  engagementScore,
  hasNotifyEvidence,
  weightedEngagement,
  isViral,
  summarizeSources,
  brandOfHost,
  authorityRank,
  labelAuthor,
};
