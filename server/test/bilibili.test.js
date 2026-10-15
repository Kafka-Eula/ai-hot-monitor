import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSources, weightedEngagement, authorityRank, gates, sourceThresholds, isHardGated, SOCIAL_SOURCES, isPlatformHost, CHANNEL_SOURCES, evidenceOf, combineScore, engagementScore, subjectTokens, itemMatchesSubject } from '../src/quality.js';
// 前端与后端共用同一套展示口径（指标顺序/徽章），但仓库没有前端测试运行器，
// 这里直接 import web 侧模块做断言，保证"卡片怎么显示"也被测到。
import { metricsList, SOURCE_LABEL, METRIC_LABEL } from '../../web/src/lib/api.js';

/** 真实抓取样本（B站搜索/热门接口返回，已裁剪） */
const biliItem = {
  source: 'bilibili',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  host: 'bilibili.com',
  title: '从零用上 GPT6+Codex！保姆级教程',
  author: '柚子站长',
  published_at: '2026-10-13T16:07:16.000Z',
  metrics: JSON.stringify({ view: 70470, like: 1295, coin: 0, fav: 3025, share: 0, reply: 249, danmaku: 101 }),
};

test('B站接入：加权互动按传播力计算，播放量取 log 不当主导', () => {
  const m = biliItem.metrics;
  // 1295 + 0 + 3025×3 + 0 + 101 + 249×1.5 + log10(70471)×30 ≈ 10990
  const eng = weightedEngagement('bilibili', m);
  assert.ok(eng > 10900 && eng < 11100, `实际 ${eng}`);
  // 播放量单指标（无互动）不应把内容推过入库门槛——这才是防刷量的关键
  assert.ok(weightedEngagement('bilibili', { view: 10_000_000 }) < 500);
  // 与 bilibili_hot 同口径
  assert.equal(weightedEngagement('bilibili_hot', m), eng);
});

test('B站接入：互动量化门槛 + 社交证据资格', () => {
  const g = gates();
  assert.ok(isHardGated('bilibili'));
  assert.deepEqual(sourceThresholds('bilibili'), { entry: g.biliScore, authority: g.authBili });
  assert.ok(SOCIAL_SOURCES.has('bilibili'));
  assert.ok(SOCIAL_SOURCES.has('bilibili_hot'));
});

test('B站接入：平台域名不算内容农场、不算媒体报道', () => {
  assert.ok(isPlatformHost('bilibili.com'));
  assert.ok(isPlatformHost('b23.tv'));
  assert.ok(CHANNEL_SOURCES.has('bilibili'));
  // 平台渠道按策展社区档位参与排序，不冒充官方一手
  assert.equal(authorityRank('bilibili', 'bilibili.com'), 2);
});

test('B站接入：话题最热条目为B站视频时，top_metrics 带全量原始互动', () => {
  const s = summarizeSources([
    biliItem,
    {
      source: 'news_search', url: 'https://techcrunch.com/a', host: 'techcrunch.com',
      title: '报道', published_at: '2026-10-13T18:00:00.000Z', metrics: '{}',
    },
  ]);
  // 权威报道优先当"来源"，但互动取最热的B站视频
  assert.equal(s.primaryLabel, 'TechCrunch');
  assert.equal(s.metrics.source, 'bilibili');
  assert.equal(s.metrics.values.like, 1295);
  assert.equal(s.metrics.author, '柚子站长');
  assert.equal(s.authorityCount, 1);
});

test('展示口径：B站徽章顺序为 点赞/投币/收藏/转发/评论/弹幕/播放', () => {
  const full = metricsList('bilibili', { view: 70470, like: 1295, coin: 12, fav: 3025, share: 7, reply: 249, danmaku: 101 });
  assert.deepEqual(full.map((x) => x.key), ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view']);
  assert.equal(full[0].label, '点赞');
  assert.equal(full.find((x) => x.key === 'danmaku').label, '弹幕');
  // 卡片只取前 4 个（点赞/投币/收藏/转发），播放量不占主位
  const card = metricsList('bilibili', { view: 70470, like: 1295, coin: 12, fav: 3025, share: 7, reply: 249, danmaku: 101 }, 4);
  assert.deepEqual(card.map((x) => x.key), ['like', 'coin', 'fav', 'share']);
  // 大数字按中文习惯可读化（万/亿，而不是难读的 "1834k"）
    assert.equal(metricsList('bilibili', { view: 1834000 })[0].text, '183.4万');
    assert.equal(metricsList('bilibili', { view: 70470 })[0].text, '7万');
    assert.equal(metricsList('bilibili', { view: 9999 })[0].text, '9999');
});

test('展示口径：B站源名与指标标签齐备（前端不会显示成原始 key）', () => {
  assert.equal(SOURCE_LABEL.bilibili, 'B站');
  assert.equal(SOURCE_LABEL.bilibili_hot, 'B站热门');
  for (const k of ['like', 'coin', 'fav', 'share', 'reply', 'danmaku', 'view']) {
    assert.ok(METRIC_LABEL[k]?.label, `缺少指标标签: ${k}`);
  }
});

// ---------------- v1.5 热度分：互动作为并列主成分 ----------------

test('互动分量：对数归一，互动越多分越高', () => {
    assert.equal(engagementScore(0), 0);
    assert.ok(engagementScore(2000) < engagementScore(20000)); // 2千 < 2万
    assert.ok(engagementScore(20000) < engagementScore(100000)); // 2万 < 10万
    assert.ok(engagementScore(100000) <= 100);
});

test('热度合成：高互动话题压过 0 互动的官方发布（用户核心诉求）', () => {
  const official = { has_official: 1, authority_media_count: 1, viral_count: 0, social_only: 0 };
  const social = { has_official: 0, authority_media_count: 1, viral_count: 2, social_only: 0 };
  // 官方发布：AI 基线 94、互动 0
  const a = combineScore(94, 0, official);
  // B站爆款话题：AI 基线 82、互动 7.8 万
  const b = combineScore(82, 78402, social);
  assert.ok(b.score > a.score, `高互动(${b.score}) 应高于 0 互动官方(${a.score})`);
  // 0 互动的官方发布会被拉低（互动分量 0 参与加权）
  assert.ok(a.score < 94, `0 互动话题应从 94 下降，实际 ${a.score}`);
  assert.equal(a.engagement, 0);
});

test('热度合成：w=0 时退回纯 AI 基线分', () => {
  const ev = { has_official: 1, authority_media_count: 1, viral_count: 0, social_only: 0 };
  const r = combineScore(88, 999999, ev, { ...gates(), engagementWeight: 0 });
  assert.equal(r.score, 88);
});

test('热度合成：证据封顶仍然生效（互动高不能绕过孤证封顶）', () => {
  const singleViral = { has_official: 0, authority_media_count: 0, viral_count: 1, social_only: 1 };
  const r = combineScore(100, 1e6, singleViral);
  assert.equal(r.score, 65); // single_viral 上限
  assert.equal(r.tier, 'single_viral');
});

test('evidenceOf：累计全话题加权互动总量（含B站多指标）', () => {
  const items = [
    { source: 'bilibili', host: 'bilibili.com', url: 'https://www.bilibili.com/video/BV1', metrics: JSON.stringify({ view: 100000, like: 1000, fav: 500, reply: 100, danmaku: 50 }) },
    { source: 'news_search', host: 'techcrunch.com', url: 'https://techcrunch.com/a', metrics: '{}' },
  ];
  const ev = evidenceOf(items);
  // B站：1000 + 500×3 + 100×1.5 + 50 + log10(100001)×30 ≈ 2855；新闻类贡献 0
  assert.ok(ev.engagement_total > 2800 && ev.engagement_total < 2900, `实际 ${ev.engagement_total}`);
});

// ---------------- v1.6 话题-条目主体相关性 ----------------

test('subjectTokens：从话题标题提取拉丁主体，泛词与纯中文不算', () => {
  assert.deepEqual(subjectTokens('GPT-6 系列发布及性能下降调查'), ['gpt6']);
  // 花式连字符 U+2011 折叠："GPT‑6 Sol" 应能提出 gpt6/sol
  assert.ok(subjectTokens('Introducing GPT\u20116 Sol and Luna').includes('gpt6'));
  // 纯中文标题提不出 → 空（跳过校验）
  assert.deepEqual(subjectTokens('阿里千问发布个人硬件新品'), []);
  // 泛词不算主体
  assert.deepEqual(subjectTokens('New AI Model Release'), []);
});

test('itemMatchesSubject：DeepSeek宕机赔偿 不应并入 GPT-6 话题', () => {
  const tokens = subjectTokens('GPT-6 系列发布及性能下降调查'); // ['gpt6']
  assert.equal(itemMatchesSubject({ title: 'OpenAI称GPT-6.1 Sol Codex性能下降', summary: '' }, tokens), true);
  assert.equal(itemMatchesSubject({ title: 'Introducing GPT‑6 Sol and Luna', summary: '' }, tokens), true); // 花式连字符
  assert.equal(itemMatchesSubject({ title: 'DeepSeek 服务异常 5 小时，7 天内金额全部返还', summary: 'OpenCode 可免费使用 DeepSeek V4.1 Flash' }, tokens), false);
  assert.equal(itemMatchesSubject({ title: '【星际争霸2】Deepseek V4.1 大战专家难度人族', summary: '' }, tokens), false);
  // 无 token（纯中文话题）→ 恒过，不误杀
  assert.equal(itemMatchesSubject({ title: '任何条目' }, []), true);
});