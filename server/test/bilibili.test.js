import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSources, weightedEngagement, authorityRank, gates, sourceThresholds, isHardGated, SOCIAL_SOURCES, isPlatformHost, CHANNEL_SOURCES } from '../src/quality.js';
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