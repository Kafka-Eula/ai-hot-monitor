import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSources, brandOfHost, authorityRank, metricCount } from '../src/quality.js';

const it = (o) => ({ host: '', metrics: '{}', published_at: '', author: '', ...o });

test('brandOfHost: 命中名单用品牌名，未命中回退域名主干', () => {
  assert.equal(brandOfHost('openai.com'), 'OpenAI 官方');
  assert.equal(brandOfHost('blog.openai.com'), 'OpenAI 官方');
  assert.equal(brandOfHost('qbitai.com'), '量子位');
  assert.equal(brandOfHost('someunknown.io'), 'someunknown');
  // 多级子域要回退到主干而不是第一段，否则 aws.amazon.com 会显示成 "aws.amazon"
    assert.equal(brandOfHost('docs.aws.somecloud.com'), 'somecloud');
    assert.equal(brandOfHost('aws.amazon.com'), 'AWS 官方');
  assert.equal(brandOfHost('news.ycombinator.com'), 'Hacker News');
  assert.equal(brandOfHost('github.com'), 'GitHub');
  assert.equal(brandOfHost(''), '');
});

test('authorityRank: 官方 > 权威媒体 > 策展社区 > 其他', () => {
  assert.equal(authorityRank('blog', 'openai.com'), 4);
  assert.equal(authorityRank('news_search', 'techcrunch.com'), 3);
  // hn 条目的 host 是 news.ycombinator.com（不是权威媒体域名），应按策展社区算
  assert.equal(authorityRank('hn', 'news.ycombinator.com'), 2);
  assert.equal(authorityRank('cn_search', 'unknown-blog.top'), 1);
  // 官方博客源里的媒体出版方不算厂商官宣
  assert.equal(authorityRank('blog', 'technologyreview.com'), 3);
  // hf_papers 托管在 huggingface.co 但不是厂商官宣
  assert.equal(authorityRank('hf_papers', 'huggingface.co'), 2);
  // 用户上传的 HF 模型页同样不算官方
  assert.equal(authorityRank('web_search', 'huggingface.co', '/someone/llama5.2-model'), 2);
});

test('summarizeSources: 平台渠道不冒充官方一手（X 帖链接 x.ai 仍算社交）', () => {
  const s = summarizeSources([
    it({ source: 'twitter', url: 'https://x.com/karpathy/status/1', host: 'x.ai', metrics: '{"likes":900,"rts":120,"views":500000}', published_at: '2026-10-13T09:00:00Z' }),
    it({ source: 'news_search', url: 'https://techcrunch.com/a', host: 'techcrunch.com', published_at: '2026-10-13T11:00:00Z' }),
  ]);
  assert.equal(s.primaryLabel, 'TechCrunch'); // 报道优先于社交帖
  assert.equal(s.primaryTier, 3);
});

test('summarizeSources: 用户上传的 HF 模型页不算官方一手（实测误判来源）', () => {
  const s = summarizeSources([
    it({ source: 'web_search', url: 'https://huggingface.co/VoidZeroe/llama5.2-model', host: 'huggingface.co' }),
  ]);
  assert.equal(s.primaryTier, 2); // 按论文库档位，不给官方豁免
  assert.equal(s.primaryLabel, 'HuggingFace');
  // 官方组织空间仍是官方（路径不含 user/model-model 形态）
  const org = summarizeSources([it({ source: 'blog', url: 'https://huggingface.co/blog/xyz', host: 'huggingface.co' })]);
  assert.equal(org.primaryTier, 4);
});

test('summarizeSources: "+N 权威来源"按不同媒体域名计（同一家多篇不虚高）', () => {
  const s = summarizeSources([
    it({ source: 'news_search', url: 'https://reuters.com/a', host: 'reuters.com' }),
    it({ source: 'news_search', url: 'https://reuters.com/b', host: 'reuters.com' }),
    it({ source: 'news_search', url: 'https://nytimes.com/c', host: 'nytimes.com' }),
  ]);
  assert.equal(s.authorityCount, 2); // 路透 ×2 + 纽约时报 = 2 家媒体
});

test('summarizeSources: 平台自家域名显示为渠道名（github.com → GitHub）', () => {
  const s = summarizeSources([
    it({ source: 'gh_search', url: 'https://github.com/org/repo', host: 'github.com', metrics: '{"stars":233,"forks":39}' }),
  ]);
  assert.equal(s.primaryLabel, 'GitHub');
  assert.equal(s.metrics.values.stars, 233);
});

test('summarizeSources: 取最权威来源，官方压过媒体与社交', () => {
  const s = summarizeSources([
    it({ source: 'hn', url: 'https://news.ycombinator.com/item?id=1', host: 'news.ycombinator.com', metrics: '{"points":79,"comments":23}', published_at: '2026-10-13T10:00:00Z' }),
    it({ source: 'news_search', url: 'https://techcrunch.com/a', host: 'techcrunch.com', published_at: '2026-10-13T12:00:00Z' }),
    it({ source: 'blog', url: 'https://openai.com/blog/x', host: 'openai.com', published_at: '2026-10-13T08:00:00Z' }),
  ]);
  assert.equal(s.primaryLabel, 'OpenAI 官方');
  assert.equal(s.primaryTier, 4);
  assert.equal(s.authorityCount, 2); // openai.com + techcrunch.com
  assert.equal(s.shown[0].label, 'OpenAI 官方');
  assert.equal(s.shown.length, 2);
});

test('summarizeSources: 同档按发布时间新→旧，跨轮次结果稳定', () => {
  const rows = [
    it({ source: 'news_search', url: 'https://reuters.com/o', host: 'reuters.com', published_at: '2026-10-11T00:00:00Z' }),
    it({ source: 'cn_search', url: 'https://qbitai.com/n', host: 'qbitai.com', published_at: '2026-10-13T00:00:00Z' }),
  ];
  assert.equal(summarizeSources(rows).primaryLabel, '量子位');
  assert.equal(summarizeSources([...rows].reverse()).primaryLabel, '量子位');
});

test('summarizeSources: 最热条目取原始互动，官宣/新闻不入围', () => {
  const s = summarizeSources([
    it({ source: 'blog', url: 'https://openai.com/blog/x', host: 'openai.com', metrics: '{}' }),
    it({ source: 'hn', url: 'u1', metrics: '{"points":79,"comments":23}' }),
    it({ source: 'hf_papers', url: 'u2', metrics: '{"upvotes":72}' }),
  ]);
  assert.equal(s.metrics.source, 'hn');
  assert.equal(s.metrics.values.points, 79);
});

test('summarizeSources: 发布轴取全话题最早/最晚发布时间', () => {
  const s = summarizeSources([
    it({ source: 'hn', url: 'a', published_at: '2026-10-13T10:00:00Z' }),
    it({ source: 'hn', url: 'b', published_at: '2026-10-11T09:00:00Z' }),
    it({ source: 'gh_trending', url: 'c', published_at: '' }),
  ]);
  assert.equal(s.publishedFirst, '2026-10-11T09:00:00Z');
  assert.equal(s.publishedLast, '2026-10-13T10:00:00Z');
});

test('metricCount: 无互动接口的源恒为 0', () => {
  assert.equal(metricCount('news_search', '{}'), 0);
  assert.equal(metricCount('hn', '{"points":0,"comments":0}'), 0);
  assert.equal(metricCount('hn', '{"points":79,"comments":0}'), 1);
});