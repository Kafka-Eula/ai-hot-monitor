# AI 热点雷达（HotPulse）— 技术方案

> 版本：v1.0 ｜ 日期：2026-09-27 ｜ 关联文档：`docs/REQUIREMENTS.md`

## 1. 总览

```
┌─────────────────────────────  HotPulse  ─────────────────────────────┐
│                                                                      │
│  React/Vite 前端 ──HTTP/SSE──► Express 后端 ──► SQLite (better-sqlite3)│
│                                   │                                  │
│                     ┌─────────────┼──────────────┐                   │
│                  调度器(node-cron)  AI层(OpenRouter)  通知层           │
│                     │                             │                  │
│              抓取层 collectors               SSE / Web Push / 邮件     │
│   HN·GitHubTrending·HF·RSS·DDG搜索·twitterapi.io                      │
└──────────────────────────────────────────────────────────────────────┘
```

- 单进程后端：Express 同时提供 REST API、SSE、静态前端构建产物。
- 目录结构（monorepo，npm workspaces）：

```
ai_hot_monitor/
├─ docs/                    # 需求/方案/接口笔记（本目录）
├─ server/                  # Express 后端
│  ├─ src/
│  │  ├─ index.js           # 入口：API + SSE + 静态托管
│  │  ├─ db.js              # better-sqlite3 schema 与查询
│  │  ├─ config.js          # .env 配置
│  │  ├─ scheduler.js       # node-cron 调度（默认 */30min）
│  │  ├─ collectors/        # 各信息源抓取器（统一接口）
│  │  │  ├─ index.js        # 注册表 + 并发调度 + 容错
│  │  │  ├─ hackernews.js   # Algolia API
│  │  │  ├─ githubTrending.js # 网页爬虫（cheerio）
│  │  │  ├─ hfPapers.js     # HuggingFace papers API
│  │  │  ├─ blogs.js        # 官方 RSS 白名单
│  │  │  ├─ webSearch.js    # DuckDuckGo html 爬虫（限频）
│  │  │  └─ twitter.js      # twitterapi.io
│  │  ├─ ai/
│  │  │  ├─ openrouter.js   # chat/completions + structured outputs
│  │  │  ├─ screen.js       # 关键词甄别（相关性+真伪）
│  │  │  └─ cluster.js      # 热点聚类评分
│  │  ├─ notify/
│  │  │  ├─ index.js        # 通知编排（写 notices + 分发）
│  │  │  ├─ sse.js          # 实时推送到页面
│  │  │  ├─ webpush.js      # VAPID
│  │  │  └─ mailer.js       # nodemailer SMTP
│  │  └─ routes/            # REST API 路由
│  └─ package.json
├─ web/                     # React + Vite 前端
│  ├─ src/
│  │  ├─ main.jsx  App.jsx
│  │  ├─ pages/  Radar.jsx  Watch.jsx  Settings.jsx
│  │  ├─ components/  NoticeBell.jsx  TopicCard.jsx  ...
│  │  └─ styles/          # 手写"雷达控制台"主题
│  └─ package.json
├─ skills/hotpulse/         # 第二阶段：Agent Skill
├─ .env / .env.example
└─ package.json             # workspaces 根
```

## 2. 数据模型（SQLite）

```sql
-- 原始条目（所有来源统一落这张表，hash 唯一去重）
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,            -- hn|gh_trending|hf_papers|blog|web_search|twitter
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  author TEXT DEFAULT '',
  published_at TEXT DEFAULT '',    -- ISO8601
  metrics TEXT DEFAULT '{}',       -- JSON: 点赞/转发/热度等
  raw_hash TEXT UNIQUE NOT NULL,   -- sha1(url) 或 sha1(title+url)
  collected_at TEXT NOT NULL
);

-- 盯梢关键词
CREATE TABLE keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT UNIQUE NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_hit_at TEXT
);

-- 关键词命中（含 AI 甄别结果，可解释）
CREATE TABLE hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  relevant INTEGER NOT NULL,       -- AI: 是否实质相关
  genuine INTEGER NOT NULL,        -- AI: 是否真实发布/更新
  confidence REAL DEFAULT 0,
  reason TEXT DEFAULT '',          -- AI 甄别理由（中文）
  screened_at TEXT NOT NULL,
  UNIQUE(keyword_id, item_id)
);

-- 关注范围（Radar 话题域）
CREATE TABLE scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE NOT NULL,      -- 如 "AI 编程"
  queries TEXT NOT NULL,           -- JSON: 各源检索词
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- AI 聚类后的热点话题
CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER,
  title TEXT NOT NULL,
  summary_zh TEXT DEFAULT '',      -- 中文摘要点评
  why_hot TEXT DEFAULT '',
  score REAL DEFAULT 0,            -- 0-100 热度
  item_ids TEXT NOT NULL,          -- JSON 数组：合并的原始条目
  first_seen TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  cluster_key TEXT UNIQUE          -- 用于跨轮次合并同一事件
);

-- 站内通知
CREATE TABLE notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- keyword_hit|hot_topic|daily_digest|system
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, stats TEXT, ok INTEGER);
```

## 3. 抓取层设计

统一接口：每个 collector 导出 `async collect(ctx) => RawItem[]`，`ctx` 含
关键词列表、关注范围 queries、上次扫描时间、限流器。

| 源 | 端点/方式 | 频率与额度控制 |
|---|---|---|
| Hacker News | `https://hn.algolia.com/api/v1/search_by_date?query=...&tags=story` | 每关键词 1 次/扫描 |
| GitHub Trending | `https://github.com/trending?since=hourly` cheerio 解析 | 每扫描 1 次 |
| HF Papers | `https://huggingface.co/api/daily_papers` | 每扫描 1 次，本地按 queries 过滤 |
| 官方博客 RSS | openai.com/blog、anthropic.com/news、deepmind… `rss-parser` | 每源 1 次/扫描 |
| DuckDuckGo | `https://html.duckduckgo.com/html/?q=...`（无 API，纯爬虫） | **每查询间隔 ≥ 3s，每扫描 ≤ 10 查询**，UA 伪装 + 失败静默 |
| Twitter/X | `GET https://api.twitterapi.io/twitter/tweet/advanced_search?query=...&queryType=Latest`，头 `X-API-Key` | 每关键词/scope ≤ 1 次/扫描；未配 key 时自动禁用 |

- 全局限流：`p-limit` 并发 ≤ 2；单源失败仅记录日志。
- 新条目判定：`published_at > 上次扫描时间 - 重叠窗口(10min)` 且 hash 未入库。

### twitterapi.io 对接要点（MCP 已核实，2026-09）
- Base：`https://api.twitterapi.io`，认证：请求头 `X-API-Key: <key>`（无 OAuth）。
- 搜索：`GET /twitter/tweet/advanced_search?query=<q>&queryType=Latest&cursor=`
  → `{ tweets[], has_next_page, next_cursor }`；支持 `since_time:`/`min_faves:` 等高级语法。
- 计费：~$0.15/1k 次，注册送 $0.1。映射：`text/url/createdAt/likeCount/retweetCount/viewCount/user.screenName`。

### OpenRouter 对接要点（MCP 已核实，2026-09）
- `POST https://openrouter.ai/api/v1/chat/completions`，头 `Authorization: Bearer <key>`。
- 用 **Structured Outputs**：`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`
  保证甄别/聚类返回合法 JSON（解析失败时降级重试一次纯 JSON 提示词）。
- 模型：`OPENROUTER_MODEL` 可配，默认 `google/gemini-2.5-flash`（快且便宜）。

## 4. AI 流程设计

### 4.1 关键词甄别（screen.js）
1. 新条目先做**廉价预筛**（标题/摘要包含关键词或其变体，全小写匹配）→ 候选集。
2. 候选条目**批量**送 AI（每次 ≤ 20 条，省 token）：
   - 输入：关键词 + 条目(title/summary/source/author) + 来源可信等级。
   - 输出 schema：`{results:[{item_id, relevant, genuine, confidence, reason(中文)}]}`。
3. `relevant && genuine && confidence>=0.6` → 写入 `hits` 且发通知；否则仅存档（页面可查"被过滤项"）。
4. 同一 keyword+item 不重复甄别（UNIQUE 约束）。

### 4.2 热点聚类（cluster.js）
1. 取上次聚类后新增条目（≤ 120 条），连同 scope queries 送 AI。
2. 输出 schema：`{topics:[{cluster_key, title, summary_zh, why_hot, score, item_ids, scope_id}]}`。
3. `cluster_key` 已存在 → 合并更新（追加 items、分数取 max、刷新 last_updated）；
   新话题且 `score >= 通知阈值(默认70)` → 发通知。

## 5. 通知层设计

- **notices 表**是唯一事实源；写入后通过 `notify/index.js` 分发：
  - SSE：`GET /api/events`（`text/event-stream`），前端 EventSource 订阅 → 红点实时跳动。
  - Web Push：`web-push` 库，VAPID 密钥 `npx web-push generate-vapid-keys` 生成；
    前端注册 Service Worker（`/sw.js`），订阅存 `push_subs` 表；设置页一键"开启浏览器推送"。
  - 邮件：`nodemailer`，SMTP_* 配置存在则启用；发送失败不重试超过 1 次。
- 频控：同类通知 5 分钟内合并，避免轰炸。

## 6. REST API（供前端与 Agent Skill 共用）

```
GET  /api/health
# 关键词
GET/POST/DELETE/PATCH /api/keywords[/:id]
GET  /api/keywords/:id/hits          # 命中历史（含 AI 理由、被过滤项）
# 关注范围
GET/POST/DELETE /api/scopes[/:id]
# 热点
GET  /api/topics?scope=&limit=       # 热点榜（按 score/时间）
GET  /api/topics/:id                 # 详情：合并的原始条目、来源分布
# 扫描
POST /api/scan/run                   # 立即扫描（异步，返回 scanId）
GET  /api/scan/status                # 上次/下次扫描、各源统计
# 通知
GET  /api/notices?unread=1 | POST /api/notices/read
# 推送订阅
POST /api/push/subscribe | GET /api/push/public-key
# 设置
GET/PUT /api/settings                # 频率、通知阈值、SMTP 开关等
```

## 7. 前端设计（独特性）

风格：**"深空雷达控制台"** —— 暗底、扫描线动画、荧光绿/琥珀信号色、等宽字体点缀。
- 首页 Radar：左侧话题时间线流（热度=卡片辉光强度），右侧可选"雷达盘"可视化（Canvas 扫描动画，光点=近期条目）。
- Watch 页：关键词芯片 + 每个关键词的命中流水，AI 理由以"甄别报告"形式展开。
- 通知：右上铃铛抽屉，SSE 实时。
- Settings：范围管理、扫描频率、通知三渠道配置表单。
- 响应式：≤768px 单列，雷达盘降级为状态条。
- 不引入重型 UI 库；`recharts` 仅用于热度趋势小图（可选）。

## 8. Agent Skill（第二阶段）

```
skills/hotpulse/
├─ SKILL.md            # 描述何时/如何用（面向其他 AI）
├─ scripts/hotpulse.mjs  # CLI：add-keyword / scan / topics / hits / notices / subscribe-scope
└─ reference/api.md    # API 速查
```
CLI 直连本机 `http://localhost:4117/api`，输出对 AI 友好的 JSON/文本。

## 9. 配置（.env）

```
PORT=4117
SCAN_CRON=*/30 * * * *
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-2.5-flash
TWITTERAPI_IO_KEY=            # 可选，空则禁用 X 源
SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASS= MAIL_TO=   # 可选
VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY=                    # 可选
AI_NOTIFY_MIN_CONFIDENCE=0.6
TOPIC_NOTIFY_MIN_SCORE=70
```

## 10. 开发步骤与测试计划

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 1 | 骨架：workspaces、db schema、config、health | `npm run dev` 起服务，`/api/health` 200 |
| 2 | 抓取层 6 源 | 单测脚本逐源跑，items 落库、去重生效 |
| 3 | AI 层（OpenRouter） | 用真实 key 跑甄别/聚类，检查 JSON 合法与理由质量 |
| 4 | 调度+通知（SSE/Push/邮件） | 手动触发扫描，观察 notices/SSE；push 与邮件按 key 可用性验证 |
| 5 | 前端 5 页面 | 浏览器人工+自动化检查响应式 |
| 6 | 端到端联调 → **用户验收 Web** | 按需求 §6 验收标准逐条过 |
| 7 | Agent Skill → **用户验收** | 在其他 AI 会话中调用 skill 完成一次监控闭环 |

依赖（server）：`express better-sqlite3 node-cron rss-parser cheerio undici p-limit nodemailer web-push dotenv`
依赖（web）：`react react-dom vite`（+可选 `recharts`）

## 11. 风险与对策

- **DDG 爬虫被限**：静默降级，不影响其他源；频率红线（≥3s 间隔、≤10 查询/扫描）。
- **twitterapi.io 费用**：每扫描调用数硬上限（默认 ≤ 12 次），设置页可调；未配 key 自动禁用。
- **AI 误判**：理由全量落库可回溯；被过滤项单独可查，用户可一键"误杀恢复"。
- **RSS/页面结构变更**：collector 层各自 try/catch，监控 scans.stats 里各源失败计数。
