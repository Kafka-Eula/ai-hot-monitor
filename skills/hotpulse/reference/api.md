# HotPulse REST API

Base：`http://localhost:4117`（环境变量 `HOTPULSE_URL` 覆盖）。全部 JSON。

## 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok, ts, name}` |
| GET | `/api/ai/status` | `{has_key, model, chain[], available[], circuit_open}` |
| GET | `/api/notify/status` | `{sse, push:{configured,subscribers}, email:{ready}}` |
| GET | `/api/scan/status` | `{running, cron, lastScan, nextRunAt, recent[]}` |
| POST | `/api/scan/run` | 触发扫描（异步；409=进行中） |

## 关键词 / 范围

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/keywords` | 列表（含 hit_count, last_hit_at） |
| POST | `/api/keywords` | `{term}` → `{id, term}` |
| PATCH | `/api/keywords/:id` | `{enabled: bool}` 启停 |
| DELETE | `/api/keywords/:id` | 删除（连带 hits） |
| GET | `/api/keywords/:id/hits` | 甄别记录 `[{passed, relevant, genuine, confidence, reason, title, url, source}]` |
| GET | `/api/scopes` | 关注范围（queries 为检索词数组） |
| POST | `/api/scopes` | `{label, queries?}` |
| DELETE | `/api/scopes/:id` | |

## 热点 / 条目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/topics?limit=` | 热点榜（score 降序）`[{id, title, summary_zh, why_hot, score, item_ids[], cluster_key}]` |
| GET | `/api/topics/:id` | 详情 + `items[]` 原始条目 |
| GET | `/api/items?limit=&since=` | 原始条目 + `bySource[]` 统计 |

## 通知

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notices?limit=` | `{unread, rows:[{id, kind, title, body, link, read, created_at}]}` |
| POST | `/api/notices/read` | `{id}` 或 `{all:true}` |
| POST | `/api/notify/test` | `{title?, body?}` 三渠道测试通知 |

## 推送订阅

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/push/public-key` | VAPID 公钥 |
| POST | `/api/push/subscribe` | PushSubscription JSON |
| POST | `/api/push/unsubscribe` | `{endpoint}` |
| POST | `/api/push/test` | 向全部订阅者发测试 |

## 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings` | 全部运行时设置 |
| PUT | `/api/settings` | 任意键值覆盖。常用键：`scanCron`、`openrouter.model`、`thresholds.minConfidence`、`thresholds.minTopicScore`、`notify.email.enabled`、`notify.webpush.enabled` |

## SSE

`GET /api/events`（text/event-stream）：事件 `notice`（新通知）、`scan`（`{state:'start'|'end', stats}`）、`hello`。

## kind 取值

`keyword_hit` 关键词命中 · `hot_topic` 高热话题 · `system` 系统 · `daily_digest` 摘要（预留）。
