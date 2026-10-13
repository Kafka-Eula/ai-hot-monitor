/**
 * 中文日期解析单测：node --test test/cnDate.test.js
 */
import '../src/config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCnDate } from '../src/util/cnDate.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const day = 86400000;

test('绝对日期（年月日 / 连字符 / 斜杠）统一按 UTC 零点解析', () => {
  assert.equal(parseCnDate('2026年8月13日', NOW), '2026-08-13T00:00:00.000Z');
  assert.equal(parseCnDate('2026-08-13', NOW), '2026-08-13T00:00:00.000Z');
  assert.equal(parseCnDate('2026/3/1', NOW), '2026-03-01T00:00:00.000Z');
  assert.equal(parseCnDate('发布于 2025年10月31日 的文章', NOW), '2025-10-31T00:00:00.000Z');
});

test('仅年月也接受（取月初）', () => {
  assert.equal(parseCnDate('2026-08', NOW), '2026-08-01T00:00:00.000Z');
});

test('相对时间：N 天/小时/周/月前', () => {
  assert.equal(parseCnDate('5 天之前', NOW), new Date(NOW - 5 * day).toISOString());
  assert.equal(parseCnDate('3小时前', NOW), new Date(NOW - 3 * 3600000).toISOString());
  assert.equal(parseCnDate('2 周前', NOW), new Date(NOW - 14 * day).toISOString());
  assert.equal(parseCnDate('昨天', NOW), new Date(NOW - day).toISOString());
  assert.equal(parseCnDate('前天', NOW), new Date(NOW - 2 * day).toISOString());
  assert.equal(parseCnDate('刚刚', NOW), new Date(NOW).toISOString());
});

test('360 新闻搜索的相对时间格式', () => {
  assert.equal(parseCnDate('9小时前', NOW), new Date(NOW - 9 * 3600000).toISOString());
  assert.equal(parseCnDate('1天前', NOW), new Date(NOW - day).toISOString());
  assert.equal(parseCnDate('4天前', NOW), new Date(NOW - 4 * day).toISOString());
});

test('无法解析时返回空串（调用方按无日期处理）', () => {
  assert.equal(parseCnDate('随便一句话没有日期', NOW), '');
  assert.equal(parseCnDate(null, NOW), '');
});
