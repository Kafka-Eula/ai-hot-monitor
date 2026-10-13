/**
 * 质量层单元测试（纯函数，无网络）：node --test test/quality.test.js
 */
import '../src/config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeQuality,
  passesGate,
  gates,
  dedupByTitle,
  titleSimilarity,
  evidenceOf,
  capScore,
  hasNotifyEvidence,
  applyQualityGate,
  normalizeHost,
  isOfficialHost,
  isAuthorityHost,
  isOfficialAnnouncement,
  dynamicTier,
  weightedEngagement,
  isViral,
  isLandingPageUrl,
} from '../src/quality.js';

const G = gates();
const now = Date.now();
const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();

const mk = (over = {}) => ({
  source: 'hn',
  url: 'https://example.com/post',
  title: 'Some reasonably long AI related title here',
  summary: 'summary text',
  published_at: iso(2),
  metrics: '{}',
  ...over,
});

test('host 归一化与名单判定', () => {
  assert.equal(normalizeHost('https://www.OpenAI.com/blog/x'), 'openai.com');
  assert.ok(isOfficialHost('developers.openai.com'));
  assert.ok(isAuthorityHost('www.reuters.com'));
  assert.ok(!isOfficialHost('openai.com.evil.io'));
});

test('HN 硬门槛：低互动拦截、高互动放行', () => {
  const low = mk({ metrics: JSON.stringify({ points: 1, comments: 0 }) });
  const r1 = passesGate(low, G);
  assert.equal(r1.pass, false);
  assert.match(r1.reason, /hn_low_engagement/);

  const hi = mk({ metrics: JSON.stringify({ points: 45, comments: 3 }) });
  assert.equal(passesGate(hi, G).pass, true);

  const manyComments = mk({ metrics: JSON.stringify({ points: 5, comments: 20 }) });
  assert.equal(passesGate(manyComments, G).pass, true);
});

test('web_search：农场/百科拦截，官方/权威域名放行', () => {
  const farm = mk({ source: 'web_search', url: 'https://felloai.com/gpt-6' });
  assert.equal(passesGate(farm, G).pass, false);

  const wiki = mk({ source: 'web_search', url: 'https://en.wikipedia.org/wiki/GPT-6' });
  assert.equal(passesGate(wiki, G).pass, false);

  const official = mk({ source: 'web_search', url: 'https://openai.com/index/gpt-6' });
  assert.equal(passesGate(official, G).pass, true);

  const media = mk({ source: 'web_search', url: 'https://www.theverge.com/news/123' });
  assert.equal(passesGate(media, G).pass, true);
});

test('cn_search：域名白名单把关 + 仍须过质量分（拦陈旧与 SEO 站）', () => {
  // 权威媒体 + 新鲜 → 放行
  const fresh = mk({
    source: 'cn_search',
    url: 'https://www2.xinhuanet.com/20261012/abc.html',
    title: 'OpenAI 正式发布 GPT-6 Astra 大模型',
    summary: 'OpenAI 表示这是其首个达到关键级能力的模型。',
    published_at: iso(6),
  });
  assert.equal(passesGate(fresh, G).pass, true);
  assert.ok(computeQuality(fresh).score >= G.minQuality, 'fresh state media should clear quality gate');

  // 2023 年老页面 → 域名门槛可过，但质量分不过（stale 惩罚）
  const stale = mk({
    source: 'cn_search',
    url: 'https://tech.ifeng.com/c/old2023',
    title: 'OpenAI 在中国申请 GPT-6 商标',
    published_at: iso(24 * 400),
  });
  assert.ok(computeQuality(stale).score < G.minQuality, 'stale article must fail quality gate');

  // SEO 站 → 域名门槛直接拦
  const seo = mk({ source: 'cn_search', url: 'https://www.gpt-chinese-guide.com/gpt-6', title: 'GPT-6 国内使用指南', published_at: iso(3) });
  const r = passesGate(seo, G);
  assert.equal(r.pass, false);
  assert.match(r.reason, /cn_search_untrusted_host/);

  // 百科/自媒体 → 农场名单拦
  assert.equal(passesGate(mk({ source: 'cn_search', url: 'https://baike.baidu.com/item/GPT-6' }), G).pass, false);
  assert.equal(passesGate(mk({ source: 'cn_search', url: 'https://mp.weixin.qq.com/s/abc' }), G).pass, false);

  // 官网首页/产品落地页：即使域名官方也拦（搜索引擎把公司主页当结果，那不是新闻）
  const homepage = mk({ source: 'cn_search', url: 'https://deepseek.com/', title: 'DeepSeek | Into the Unknown', published_at: iso(2) });
  const r2 = passesGate(homepage, G);
  assert.equal(r2.pass, false);
  assert.match(r2.reason, /cn_search_homepage/);

  // 无日期：无法判断新鲜度 → 拦
  const noDate = mk({ source: 'cn_search', url: 'https://openai.com/', title: 'OpenAI | Research & Deployment', published_at: '' });
  assert.equal(passesGate(noDate, G).pass, false);

  // 官方域名下的具体新闻页 → 放行
  const newsPage = mk({
    source: 'cn_search',
    url: 'https://www.deepseek.com/news/deepseek-v4-1-flash/',
    title: 'Introducing DeepSeek-V4.1-Flash',
    summary: 'V4.1-Flash is now live on the DeepSeek API.',
    published_at: iso(5),
  });
  assert.equal(passesGate(newsPage, G).pass, true);
});

test('isLandingPageUrl 识别首页与产品落地页', () => {
  assert.equal(isLandingPageUrl('https://deepseek.com/'), true);
  assert.equal(isLandingPageUrl('https://openai.com'), true);
  assert.equal(isLandingPageUrl('https://play.google.com/store/apps/details?id=ai.deepseek'), true);
  assert.equal(isLandingPageUrl('https://www.deepseek.com/download'), true);
  assert.equal(isLandingPageUrl('https://www.deepseek.com/news/v4-1-flash/'), false);
  assert.equal(isLandingPageUrl('https://www.ithome.com/0/834/541.htm'), false);
});

test('gh_trending：只认 stars_today（总星数不再是信号，tensorflow/vscode 类常驻榜应被拦）', () => {
  const fresh = mk({ source: 'gh_trending', metrics: JSON.stringify({ stars: 30, stars_today: 80 }) });
  assert.equal(passesGate(fresh, G).pass, true);

  const cold = mk({ source: 'gh_trending', metrics: JSON.stringify({ stars: 30, stars_today: 5 }) });
  assert.equal(passesGate(cold, G).pass, false);

  // 关键回归：老仓库总星数极高但当日增量小 → 拦截
  const giant = mk({ source: 'gh_trending', metrics: JSON.stringify({ stars: 200543, stars_today: 12 }) });
  const r = passesGate(giant, G);
  assert.equal(r.pass, false);
  assert.match(r.reason, /gh_trending_low_engagement/);

  // 无 stars_today 字段（旧数据）→ 视为 0，拦截（不再有总星数兜底）
  assert.equal(passesGate(mk({ source: 'gh_trending', metrics: JSON.stringify({ stars: 500 }) }), G).pass, false);
});

test('blog 官方一手：新鲜高分，陈旧低分', () => {
  const fresh = mk({ source: 'blog', url: 'https://openai.com/index/x', published_at: iso(3) });
  const q1 = computeQuality(fresh);
  assert.equal(q1.tier, 1);
  assert.ok(q1.score >= 70, `fresh blog should pass, got ${q1.score}`);

  const stale = mk({ source: 'blog', url: 'https://openai.com/index/x', published_at: iso(24 * 40) });
  const q2 = computeQuality(stale);
  assert.ok(q2.score < q1.score);
  assert.ok(q2.flags.includes('stale'));
});

test('news_search 有策展加成，媒体域名放行；边缘转载站拦截', () => {
  const n = mk({ source: 'news_search', url: 'https://news.google.com/rss/articles/abc', host: 'reuters.com', published_at: iso(5) });
  const q = computeQuality(n);
  assert.ok(q.score >= G.minQuality, `news should pass, got ${q.score}`);
  assert.equal(passesGate(n, G).pass, true);
  // 2026-10 收紧：非权威名单的转载站（blocktempo 类）拦截
  const junk = mk({ source: 'news_search', url: 'https://blocktempo.com/ai', host: 'blocktempo.com', published_at: iso(5) });
  assert.equal(passesGate(junk, G).pass, false);
  assert.match(passesGate(junk, G).reason, /news_search_untrusted_host/);
});

test('营销/教程标题降分', () => {
  const promo = mk({ title: '2026年AI编程工具排行榜：10款最佳工具终极指南' });
  const q = computeQuality(promo);
  assert.ok(q.flags.includes('promo_or_guide'));
});

test('资讯汇总帖（早报/多分号拼盘）被识别降分', () => {
  const zaobao = mk({
    source: 'cn_media',
    url: 'https://www.ifanr.com/1683244',
    title: '早报｜苹果定档10月13日发布新品/三星手机业务或减产30%/保时捷计划削减9000个岗位',
  });
  const q1 = computeQuality(zaobao);
  assert.ok(q1.flags.includes('promo_or_guide'), '早报 should be flagged as digest');
  assert.ok(q1.score < G.minQuality, `digest should fall below gate, got ${q1.score}`);

  const semis = mk({
    source: 'cn_media',
    url: 'http://www.geekpark.net/news/372143',
    title: '谷歌云发布 Gemini Agent；Manus 官宣五亿美元融资；小鹏上线 Robotaxi 打车小程序',
  });
  const q2 = computeQuality(semis);
  assert.ok(q2.flags.includes('news_digest'));
  assert.ok(q2.score < G.minQuality, `multi-event title should fall below gate, got ${q2.score}`);

  // 正常单一事件标题不受影响
  const single = mk({ source: 'cn_media', url: 'https://www.qbitai.com/1', title: '量子位独家｜智谱发布 GLM-5 开源权重' });
  assert.ok(!computeQuality(single).flags.includes('news_digest'));
});

test('一手官宣判定只看域名：媒体/评论站走 blog 源也不算官宣', () => {
  assert.equal(isOfficialAnnouncement('blog', 'openai.com'), true);
  assert.equal(isOfficialAnnouncement('news_search', 'anthropic.com'), true);
  // 关键回归：MIT TR 观点文、量子位报道走 RSS，但不是厂商官宣
  assert.equal(isOfficialAnnouncement('blog', 'technologyreview.com'), false);
  assert.equal(isOfficialAnnouncement('blog', 'langchain.com'), true);
  // HF 论文托管在 huggingface.co 但是作者自述，不算官宣
  assert.equal(isOfficialAnnouncement('hf_papers', 'huggingface.co'), false);

  // 分级随域名下调：媒体类 blog → T3，不再享受 T1 基础分
  assert.equal(dynamicTier('blog', 'technologyreview.com'), 3);
  assert.equal(dynamicTier('blog', 'openai.com'), 1);
  assert.equal(dynamicTier('hf_papers', 'huggingface.co'), 2);

  // 证据统计：单条 MIT TR 观点文不构成官方佐证 → 必须封顶
  const ev = evidenceOf([{ source: 'blog', url: 'https://www.technologyreview.com/2026/10/02/opinion', host: 'technologyreview.com' }]);
  assert.equal(ev.has_official, 0);
  assert.equal(ev.source_count, 1);
  const capped = capScore(88, ev);
  assert.equal(capped.score, 65);
  assert.equal(capped.capped, true);
  assert.equal(hasNotifyEvidence(ev), false);
});

test('时效硬门槛：超 maxAgeDays 拦截，快照榜源豁免', () => {
  const old = mk({ source: 'lobsters', metrics: JSON.stringify({ score: 50 }), published_at: iso(24 * 60) });
  const r = passesGate(old, G);
  assert.equal(r.pass, false);
  assert.match(r.reason, /too_old/);

  const fresh = mk({ source: 'lobsters', metrics: JSON.stringify({ score: 50 }), published_at: iso(24) });
  assert.equal(passesGate(fresh, G).pass, true);

  // 快照榜源（trending / daily_papers）发布很久但刚上榜 → 豁免
  const oldTrending = mk({ source: 'gh_trending', metrics: JSON.stringify({ stars: 900, stars_today: 300 }), published_at: iso(24 * 90) });
  assert.equal(passesGate(oldTrending, G).pass, true);
});

test('近似去重：相似标题只留质量分最高，跨源不误伤', () => {
  const a = mk({ id: 1, source: 'hn', title: 'OpenAI releases GPT-6 for everyone', quality_score: 80 });
  const b = mk({ id: 2, source: 'hn', title: 'OpenAI Releases GPT-6 For Everyone!!', quality_score: 60 });
  const c = mk({ id: 3, source: 'blog', title: 'Introducing GPT-6', quality_score: 90 });
  assert.ok(titleSimilarity(a.title, b.title) >= 0.85);
  assert.ok(titleSimilarity(a.title, c.title) < 0.85);
  const { keep, merged } = dedupByTitle([b, a, c], 0.85);
  assert.deepEqual(keep.map((x) => x.id).sort(), [1, 3]);
  assert.equal(merged.length, 1);
});

test('applyQualityGate 端到端：拦截+去重', () => {
  const items = [
    mk({ id: 1, source: 'hn', metrics: JSON.stringify({ points: 100, comments: 40 }), url: 'https://a.com/1' }),
    mk({ id: 2, source: 'hn', metrics: JSON.stringify({ points: 1 }), url: 'https://b.com/2' }),
  ];
  const { passed, blocked } = applyQualityGate(items, { g: G, nowMs: now });
  assert.equal(passed.length, 1);
  assert.equal(passed[0].id, 1);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /hn_low_engagement/);
});

test('加权互动分：跨源可比，转发/评论权重高于点赞', () => {
  assert.equal(weightedEngagement('hn', { points: 100, comments: 20 }), 130);
  // 100 + 50*3 + 10*2 + log10(100001)*10 ≈ 320
  assert.ok(Math.abs(weightedEngagement('twitter', { likes: 100, rts: 50, replies: 10, views: 100000 }) - 320) < 0.01);
  assert.equal(weightedEngagement('gh_trending', { stars: 200000, stars_today: 800 }), 800);
  // 权威门槛判定
  assert.equal(isViral('hn', 130, G), true); // >= authHn 100
  assert.equal(isViral('hn', 40, G), false);
  assert.equal(isViral('gh_trending', 600, G), true); // >= 500
  assert.equal(isViral('gh_trending', 60, G), false); // 过入库门槛但不够爆款
});

test('分级封顶：官方/权威媒体交叉不封顶；纯社交按爆款数封顶', () => {
  // 单条普通社交帖（未达爆款门槛）→ 封顶 60，不通知
  const weak = evidenceOf([{ source: 'hn', url: 'https://x.com/1', host: 'x.com', metrics: JSON.stringify({ points: 40, comments: 2 }) }], G);
  assert.equal(weak.viral_count, 0);
  assert.equal(capScore(95, weak).score, 60);
  assert.equal(hasNotifyEvidence(weak), false);

  // 单条社交爆款 → 封顶 65，不通知（孤证）
  const one = evidenceOf([{ source: 'hn', url: 'https://x.com/1', host: 'x.com', metrics: JSON.stringify({ points: 900, comments: 200 }) }], G);
  assert.equal(one.viral_count, 1);
  assert.equal(capScore(95, one).score, 65);
  assert.equal(hasNotifyEvidence(one), false);

  // 跨平台多爆款 → 封顶 80，可通知
  const viral = evidenceOf([
    { source: 'hn', url: 'https://news.ycombinator.com/item?id=1', host: 'news.ycombinator.com', metrics: JSON.stringify({ points: 900, comments: 200 }) },
    { source: 'reddit', url: 'https://reddit.com/r/x/1', host: 'reddit.com', metrics: JSON.stringify({ score: 5000, comments: 300 }) },
  ], G);
  assert.equal(viral.viral_count, 2);
  assert.equal(capScore(95, viral).score, 80);
  assert.ok(hasNotifyEvidence(viral));

  // 官方一手 → 不封顶、可通知
  const off = evidenceOf([{ source: 'blog', url: 'https://openai.com/x', host: 'openai.com' }], G);
  assert.equal(off.has_official, 1);
  assert.equal(capScore(95, off).score, 95);
  assert.ok(hasNotifyEvidence(off));

  // ≥2 家不同权威媒体报道 → 不封顶、可通知
  const media = evidenceOf([
    { source: 'news_search', url: 'https://news.google.com/rss/articles/1', host: 'reuters.com' },
    { source: 'news_search', url: 'https://news.google.com/rss/articles/2', host: 'theverge.com' },
  ], G);
  assert.equal(media.authority_media_count, 2);
  assert.equal(capScore(95, media).score, 95);
  assert.ok(hasNotifyEvidence(media));

  // 单家媒体 + 普通社交帖 → weak 档封顶 65，不通知
  const mixed = evidenceOf([
    { source: 'news_search', url: 'https://news.google.com/rss/articles/3', host: 'reuters.com' },
    { source: 'hn', url: 'https://x.com/2', host: 'x.com', metrics: JSON.stringify({ points: 35 }) },
  ], G);
  assert.equal(capScore(95, mixed).score, 65);
  assert.equal(hasNotifyEvidence(mixed), false);
});
