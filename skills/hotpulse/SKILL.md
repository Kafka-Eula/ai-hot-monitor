---
name: hotpulse
description: 监控 AI 领域热点——用本机 HotPulse 服务自动抓取多信息源（Hacker News、GitHub Trending、HuggingFace 论文、官方博客 RSS、网页搜索、X/Twitter），经 AI 甄别假冒/蹭词内容后聚类评分，发现关键词命中与热点话题并发送通知。当用户要求"盯梢/监控某个 AI 产品或关键词（如 GPT-6、Claude）"、"看看最近 AI 圈有什么热点"、"AI 编程/大模型最新动态"、"检查热点通知"，或提到 HotPulse、热点雷达、热点订阅、扫描、防假冒甄别时使用本技能。也适合定时任务（cron / agent 心跳）周期调用，实现全自动热点发现。
---

# HotPulse · AI 热点雷达

通过 CLI 操作本机 HotPulse 服务，完成「添加监控 → 扫描 → AI 甄别 → 热点聚类 → 通知」全流程。

## 前置条件

服务需在本机运行（默认 `http://localhost:4117`）。先执行：

```bash
node scripts/hotpulse.mjs status
```

- 输出 `服务: OK` → 继续
- 连接失败 → 提示用户：在 HotPulse 项目目录（`d:\develop\project\ai_hot_monitor`）运行 `npm run dev:server`，或后台运行 `node server/src/index.js`。服务启动后会自动按 cron（默认每 30 分钟）扫描。
- 若服务在其他地址：设置环境变量 `HOTPULSE_URL`。

## 核心命令

所有命令：`node scripts/hotpulse.mjs <命令>`。加 `--json` 获得机器可读输出。

| 场景 | 命令 |
|---|---|
| 一键盯梢某关键词（添加+扫描+报告命中） | `watch <关键词>` |
| 查看最新热点榜 | `topics`（详情 `topic <id>`） |
| 手动触发一轮扫描并等待 | `scan`（免费模型一轮约 2~7 分钟） |
| 查某关键词的命中/被过滤记录 | `hits <关键词或id> [--all]` |
| 管理关注范围（热点聚合域） | `scopes` / `add-scope <名称>` / `remove-scope <id>` |
| 查通知 / 标记已读 | `notices [--unread]` / `read <id\|all>` |
| 关键词增删 | `add-keyword <词>` / `remove-keyword <id>` |

## 工作流速查

**用户说"帮我盯 GPT-6，出了新消息告诉我"**：
1. `watch GPT-6` —— 一键完成添加+扫描+输出命中（含 AI 甄别理由）
2. 告知用户：之后每 30 分钟自动扫描，命中会通过通知中心/浏览器推送/邮件提醒；打开 `http://localhost:4117/#watch` 可看命中流水

**用户说"最近 AI 圈有什么热点"**：
1. `topics 10` —— 按热度列出话题（分数=AI 综合评分，基于官方源权重+多源交叉+互动数据）
2. 对高分话题用 `topic <id>` 展开原始来源，再向用户转述

**定时自动发现（cron / agent 心跳）**：
1. `scan --wait 600` 触发并等待一轮扫描
2. `notices --unread --json` 拉取新通知，向用户播报后 `read all` 清零
3. 建议频率 ≥ 30 分钟（与内置 cron 对齐，更高频会浪费 AI 额度）

## 理解 AI 甄别（防假冒）

`hits` 输出中每条都有判定：
- `✅HIT [置信%]`：实质相关 + 真实可信，达到通知阈值
- `❌过滤`：蹭词/营销软文/无官方佐证的爆料，或置信度不足
- `AI:` 后是中文理由（依据来源可信度与交叉佐证，**不是**模型自身知识——监控的产品可能比模型训练数据更新）

被过滤的内容同样存档可追溯；用户认为误杀时，可引导其到 Web 页查看或调低阈值（`http://localhost:4117/#settings`，或 PUT `/api/settings` 修改 `thresholds.minConfidence`）。

## 注意事项

- 扫描/通知等写操作有真实副作用（消耗 AI 调用额度、发浏览器推送），批量操作前先向用户确认。
- `ai.skipped=circuit_open` 表示免费模型限流熔断，10 分钟内自动恢复，无需干预。
- 未配置 `TWITTERAPI_IO_KEY` 时 X/Twitter 源自动跳过，不影响其他源。
- 数据在服务端 SQLite 持久化（项目 `data/hotpulse.db`），重启不丢。

完整 REST API 见 [reference/api.md](reference/api.md)。
