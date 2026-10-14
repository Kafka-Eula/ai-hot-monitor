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
│  HN·GitHubTrending·GitHubSearch·HF·官方博客RSS·GoogleNews+Bing·       │
│  中文媒体RSS·360新闻搜索·Lobsters·twitterapi.io·Bilibili（11源）        │
│                   ↓ 质量闸门(quality.js：硬门槛+质量分+去重) ↓         │
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
│  │  ├─ db.js              # node:sqlite schema 与查询
│  │  ├─ config.js          # .env 配置
│  │  ├─ quality.js         # 质量闸门：源分级/硬门槛/质量分/域名名单/近似去重/证据封顶
│  │  ├─ scheduler.js       # node-cron 调度（默认 */30min）
│  │  ├─ collectors/        # 各信息源抓取器（统一接口）
│  │  │  ├─ index.js        # 注册表 + 并发调度 + 容错
│  │  │  ├─ hackernews.js   # Algolia API
│  │  │  ├─ githubTrending.js # 网页爬虫（cheerio，解析 stars today）
│  │  │  ├─ ghSearch.js     # GitHub Search API（近7天新建高星库）
│  │  │  ├─ hfPapers.js     # HuggingFace papers API
│  │  │  ├─ blogs.js        # 官方 RSS 白名单
│  │  │  ├─ webSearch.js    # DuckDuckGo html 爬虫（限频 + df=w）
│  │  │  ├─ newsSearch.js   # Google News(英/中) + Bing News RSS
│  │  │  ├─ cnMedia.js      # 中文 AI 媒体 RSS（按 scope 过滤）
│  │  │  ├─ lobsters.js     # Lobsters 公开 JSON
│  │  │  ├─ reddit.js       # Reddit top.rss（尽力而为）
│  │  │  ├─ twitter.js      # twitterapi.io
│  │  │  ├─ cnSearch.js     # 360 新闻搜索（免 key，中文 AI 新闻）
│  │  │  └─ bilibili.js     # B站：关键词搜索 + 综合热门（互动数据最全）
│  │  ├─ util/
│  │  │  ├─ feed.js         # RSS/Atom 三级降级解析（cheerio→rss-parser→正则）
│  │  │  └─ cnDate.js       # 中文日期解析（2026年8月13日 / N天前 / 昨天…）
│  │  ├─ scripts/
│  │  │  └─ backfill.mjs    # 历史数据回填（重算质量分+清理虚高话题）
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
  source TEXT NOT NULL,            -- hn|gh_trending|gh_search|hf_papers|blog|web_search|news_search|cn_media|cn_search|lobsters|reddit|twitter
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  author TEXT DEFAULT '',
  published_at TEXT DEFAULT '',    -- ISO8601
  metrics TEXT DEFAULT '{}',       -- JSON: 点赞/转发/热度等
  raw_hash TEXT UNIQUE NOT NULL,   -- sha1(url) 或 sha1(title+url)
  collected_at TEXT NOT NULL,
  -- v1.2 质量字段（由 quality.js 在入库前算好）
  ai_done INTEGER DEFAULT 0,       -- AI 甄别+聚类是否完成
  quality_score REAL DEFAULT 0,    -- 规则质量分 0-100
  engagement REAL DEFAULT 0,       -- 归一化互动数（取各指标最大值）
  source_tier INTEGER DEFAULT 4,   -- 源可信分级 1官方/2策展/3媒体/4泛搜索UGC
  host TEXT DEFAULT '',            -- 真实媒体域名（聚合源显式覆盖）
  quality_flags TEXT DEFAULT '[]'  -- 命中的惩罚标记（content_farm/stale/...）
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
  cluster_key TEXT UNIQUE,         -- 用于跨轮次合并同一事件
  -- v1.2 证据字段（代码统计，不依赖 AI 自报；单源非官方 → score 封顶 65）
  source_count INTEGER DEFAULT 1,  -- 跨信息源数
  host_count INTEGER DEFAULT 1,    -- 跨域名数
  has_official INTEGER DEFAULT 0,  -- 是否含官方一手来源
  viral_count INTEGER DEFAULT 0,   -- 达爆款门槛的社交条目数
  evidence_tier TEXT DEFAULT '',   -- official|media_cross|viral_social|single_viral|social_weak|weak
    sources TEXT DEFAULT '[]',       -- v1.3：构成该话题的信息源名 JSON 数组（供筛选/标签）
    -- v1.4 信息价值速判（省掉"跳去原站核对"）
    primary_host TEXT DEFAULT '',    -- 最权威来源的真实域名（排序：厂商官方>权威媒体>策展社区）
    primary_label TEXT DEFAULT '',   -- 品牌名（openai.com→OpenAI 官方 / qbitai.com→量子位）
    primary_url TEXT DEFAULT '',     -- 最权威来源原文直链（卡片可直达）
    primary_source TEXT DEFAULT '',
    primary_tier INTEGER DEFAULT 0,  -- 4官方一手/3权威媒体/2策展社区/1其他（前端徽章配色）
    authority_count INTEGER DEFAULT 0, -- 官方+权威媒体的**不同域名**数（卡片 "+N"）
    top_metrics TEXT DEFAULT '{}',   -- 话题内最热条目的**原始**互动指标（{source,url,title,author,values}）
    published_first TEXT DEFAULT '', -- 话题内最早/最晚的**原始发布时间**（发布轴，区别于 last_updated 聚类时间）
    published_last TEXT DEFAULT ''
  );
-- 通知条件：score >= 阈值 且 (source_count >= 2 或 has_official = 1)

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

| 源 | 端点/方式 | 频率与额度控制 | 硬门槛（默认） |
|---|---|---|---|
| Hacker News | `https://hn.algolia.com/api/v1/search_by_date?query=...&tags=story` | 每关键词 1 次/扫描 | points≥30 或 comments≥15 |
| GitHub Trending | `https://github.com/trending?since=hourly` cheerio 解析（含 stars today）；入库前对**本轮新仓库**调 `api.github.com/repos/:o/:r` 补 `created_at`（限量 20 次/轮，已入库的跳过） | 每扫描 1 次 | stars_today≥50 |
| GitHub 新库 | `https://api.github.com/search/repositories?q=...+created:>7d&sort=stars` | 每扫描 ≤6 查询，间隔 6.5s（未登录 10 次/分） | stars≥100 |
| HF Papers | `https://huggingface.co/api/daily_papers` | 每扫描 1 次 | upvotes≥30 |
| 官方博客 RSS | openai.com/blog、anthropic.com/news、deepmind… `rss-parser` | 每源 1 次/扫描 | —（走质量分） |
| ~~DuckDuckGo~~ | ~~`https://html.duckduckgo.com/html/?q=...&df=w`~~ | **已摘除（2026-10）**：45 条拦 41 条、每条有效结果耗时 4.1s，性价比最低；采集器保留可恢复 | — |
| 新闻搜索 | Google News RSS（en+zh）`news.google.com/rss/search` + Bing News RSS `bing.com/news/search?format=rss` | 每查询 ≤3 引擎，间隔 ≥2s，每扫描 ≤8 查询 | **域名须在官方/权威名单**（2026-10 收紧，拦边缘转载站）+ 质量分≥60；媒体域名取自 feed `<source url>` / `url=` 参数 |
| 中文媒体 | IT之家/量子位/InfoQ中文/极客公园/雷锋网/Synced/爱范儿 RSS | 每源 1 次/扫描，按 queries 本地过滤 | 质量分≥60 |
| 360 新闻搜索 | `https://news.so.com/ns?q=...&src=tab_www`（免 key 爬虫，中文 AI 新闻；结果含原文直链+媒体名+相对时间） | **每查询间隔 ≥ 3s，每扫描 ≤ 8 查询**，UA 伪装 + 验证页检测 | 域名须在官方/权威名单 + 有日期 + 非落地页，且质量分≥60 |
| Lobsters | `https://lobste.rs/t/{ai,ml,programming}.json` | 每扫描 3 请求，间隔 1.2s | score≥20 |
| ~~Reddit~~ | ~~`https://www.reddit.com/r/{sub}/top.rss?t=day`~~ | **已摘除（2026-10）**：抓取 200 条 → 入库 0 条（429 限流 + 互动门槛全拦）；采集器保留可恢复 | — |
| Twitter/X | `GET https://api.twitterapi.io/twitter/tweet/advanced_search?query=...&queryType=Latest`，头 `X-API-Key` | 每关键词/scope ≤ 1 次/扫描；未配 key 时自动禁用 | likes≥50 |
| Bilibili | ① `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=...&order=totalrank`（**需首页 `buvid3` Cookie**）② `https://api.bilibili.com/x/web-interface/popular?ps=50&pn=N` | 搜索 ≤8 次/扫描、间隔 ≥2.5s；热门 ≤2 页、间隔 ≥2s | 加权互动 ≥ biliScore(500)；爆款 ≥ authBili(5000) |

**Bilibili 接入要点（2026-10 实测，修正"B站一律 -352 风控"的旧结论）**
- 只有**分区排行 `ranking/v2`、`popular/series/one`** 是 `-352`；`search/type` 与 `popular` 可用。
- `search/type` 缺 Cookie 时返回 `-412 request was banned` → 先抓首页取 `buvid3` 即可正常返回。
- `order` 实测：`pubdate` 只给刚上传、0 播放的视频（会被互动门槛全拦）；`click` 只给陈年高播放老视频（3 天内 0 条）；
  **`totalrank`（综合排序）**兼顾热度与新鲜度，采用它。
- `newlist`（分区最新）可用但新视频 play/like=0，无热度信号，不采用。
- 搜索结果**不返回 `coin`（投币）**，前端按"有值才显示"处理，不会出现误导性的 0。
- 综合热门是**全站**榜，按 AI 词表（`AI_TERMS`）本地过滤后才收（实测 100 条 → 12 条 AI 相关）。

- 全局限流：`p-limit` 并发 ≤ 4（各源打不同站点互不限流；单源内部另有自己的节奏）；单源失败仅记录日志；核心源（hn/hf_papers/blog/news_search）失败才判本轮失败。
- AI 积压控制：待甄别集合按**质量分降序、新优先**取前 40 条（2026-10 改），保证新热点最先出通知，低质量旧积压不堵队。
- 新条目判定：`published_at > 上次扫描时间 - 重叠窗口(10min)` 且 hash 未入库。

### 3.5 质量闸门（quality.js，v1.2）

抓取后、入库前统一执行（顺序）：
1. **时效硬门槛**：发布超 `maxAgeDays`（默认 14 天）拦截；trending/daily_papers 快照榜源豁免；
2. **各源互动硬门槛**（见上表）；`web_search` 走域名白/黑名单；
   互动数按**传播力加权**为单一 `engagement`（跨源可比）：
   `HN = points + comments×1.5`；`Reddit = score + comments×2`；
   `X = likes + rts×3 + replies×2 + log₁₀(views)×10`；`Lobsters = score + comments`；
   `GitHub Trending = stars_today`（**只认当日新增**，总星数不是新闻信号）；
      `GitHub 新库 = stars + forks×2`；`HF Papers = upvotes`；
      **`Bilibili = like + coin×2 + fav×3 + share×4 + danmaku + reply×1.5 + log₁₀(view)×30`**
      （投币/收藏/转发比点赞更能代表"值得看/值得传"；播放量取 log 且只占小头，
      否则百万播放的刷量视频会淹没其他平台信号）。
   每源两级门槛：**入库门槛**（低于则拦截）与**爆款门槛**（达到才算"事件被广泛讨论"，可解锁更高话题分）。
3. **综合质量分**（非门槛型源）：`tier基础分(0-40) + 互动/策展分(0-30) + 新鲜度(0-15) + 域名权威(0-15) − 惩罚`，低于 `minQuality`（默认 60）拦截。
   惩罚项：内容农场域名、营销/排行/教程标题、**资讯汇总帖**（"早报｜…"、标题内 ≥2 个分号拼多个不相干事件）、无日期、过旧、摘要缺失、标题过短；
4. **同源近似去重**：标题 shingle Jaccard ≥0.85 视为同一事件，只保留质量分最高一条（**跨源重复保留**，作为多源佐证证据）。

**一手官宣判定 `isOfficialAnnouncement(source, host)` 只看域名，不看 source**：
- `blog` 源里的评论/报道型出版方（如 technologyreview.com）→ **不算**厂商官宣（降 T3，不给单源封顶豁免）；
- `hf_papers`（作者自述预印本，虽托管在 huggingface.co）→ **不算**官宣，热度需靠 upvotes 与多源佐证；
- 仅域名命中 OFFICIAL_HOSTS（openai.com / anthropic.com / deepseek.com / …）才是一手来源。

### 3.6 证据分级封顶（v1.3，替代"单源≤65"单一规则）

话题入库时由代码统计证据（不信 AI 自报），按等级硬性封顶：

| 证据档 | 判定条件 | 分数上限 | 可否通知 |
|---|---|---|---|
| `official` | 含厂商一手官宣（域名判定） | 100 | ✅ |
| `media_cross` | ≥2 家**不同权威媒体**域名报道 | 100 | ✅ |
| `viral_social` | ≥2 条社交条目达**爆款门槛** | 80 | ✅ |
| `single_viral` | 仅 1 条爆款（孤证） | 65 | ❌ |
| `social_weak` | 纯社交但都不够热 | 60 | ❌ |
| `weak` | 其余（单条非官方/单家媒体+弱社交） | 65 | ❌ |

要点：**社交平台热度真正参与评分**（多平台刷屏可解锁 80 分通知），但"随手发帖"（未达爆款门槛）最高 60 分，永远进不了通知；`evidence_tier` / `viral_count` 落库，前端以徽章展示（🔥N源爆款 / 爆款·孤证 / 📰媒体交叉）。

被拦截条目不入库，`scans.stats.blockedStats` 记录各源拦截数与原因分布（可解释、可回溯）。
阈值全部走 `settings` 表 `gates.*` 键，设置页可调，下轮扫描生效。

历史数据一次性回填：`npm --workspace server run backfill`（先 `backfill:dry` 预览），自动备份 db。
v1.4 起该脚本同时重算 `primary_*` / `authority_count` / `top_metrics` / `published_first|last`。

### 3.7 信息价值速判（v1.4：来源精简 + 原始数据露出）

目标：**省掉"跳去原站核对"的时间**。四条展示口径（均已落库、前后端同源）：

1. **来源只显示 1~2 个最权威的**（`summarizeSources()`）：排序为 厂商官方(4) > 权威媒体(3) >
   策展社区/论文库(2) > 其他(1)；同档按发布时间新→旧、再按域名稳定排序（跨轮次不跳变）。
   展示**品牌名**（`BRAND_HOSTS`：openai.com→OpenAI 官方、techcrunch.com→TechCrunch、qbitai.com→量子位，
   未命中回退域名主干），其余折叠为 `+N`（N = `authority_count - 1`，`authority_count` 是
   官方/权威媒体的**不同域名**数，同一家媒体多篇不虚高）。
2. **原始发布时间上卡片**：`published_first/last` 来自条目 `published_at`；
   `last_updated` 是聚类时间（并入新条目就变），**不能**用来判断新旧——"最新"排序与时间窗筛选
   均已改按发布轴（`axisTime()`）。快照榜源（gh_trending / hf_papers）本身无发布时间 → 如实标注
   "该源不提供发布时间"；gh_trending 由 `enrichTrendingRepos()` 调 repos API 补 `metrics.created_at`
   （仅补本轮**首次入库**的仓库，限量 20 次），前端显示"建库于 X"。
3. **原始互动指标露出**：`top_metrics` 存话题内最热条目的原始指标（不是加权的 engagement 分），
   **在卡片标签行放首位**——这是"值不值得点开"最快的判据；详情页逐条列出全部指标 + 传播力；
   新闻/官宣/媒体类**本就没有互动接口**，如实显示"无互动数据"而非 0。
   指标顺序按源定制（B站：点赞/投币/收藏/转发/评论/弹幕/播放；GitHub 只认当日新增），
   大数字按中文习惯显示为 万/亿（避免 "1834k" 这种难读形式）。
4. **平台渠道不冒充一手**：`PLATFORM_HOSTS`（huggingface.co / github.com / bilibili.com / x.com…）不算
   "谁在说这件事"，**同时豁免内容农场惩罚**（否则接入平台型信息源会自我惩罚——实测 B站条目被扣 25 分）。
   修复：用户上传的 HF 模型页（`/user/model-model`）曾被当成厂商官宣把话题
   抬到 90 分「官方一手」（`isOfficialAnnouncement` 增加 UGC 路径判定，`authorityRank` 增至 rank 2，
   该话题已回落 65 分 weak）；社交条目链接自家站点（X 帖 → x.ai）也只算社交信号。

阈值/口径全部集中在 `quality.js`，无新增配置项。

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
2. 候选条目**批量**送 AI（每次 ≤ 25 对，省 token）：
   - 输入：关键词 + 条目(title/summary/source/author) + 证据(tier/host/eng)。
   - 输出 schema：`{results:[{item_id, relevant, genuine, confidence, reason(中文)}]}`。
3. `relevant && genuine && confidence>=0.6` → 写入 `hits` 且发通知；否则仅存档（页面可查"被过滤项"）。
4. 同一 keyword+item 不重复甄别（UNIQUE 约束）。

### 4.2 热点聚类（cluster.js）
1. 取上次聚类后新增条目（≤ 150 条，20 条/批），连同 scope queries 与既有话题送 AI。
2. 每条注入证据字段：`tier`(来源分级)、`eng`(互动数)、`host`(域名)、`q`(质量分)；
   prompt 明确约束"评分必须与证据相称"（单源非官方 ≤55、eng=0 单源 ≤60）。
3. 输出 schema：`{topics:[{cluster_key, title, summary_zh, why_hot, score, item_ids, scope_id}]}`。
4. **代码侧证据封顶（不信 AI 自报）**：入库时按话题全部条目统计 `source_count / host_count / has_official`；
   仅单一来源且非官方 → `score` 硬性封顶 65（合并轮次会重新封顶，虚高分被拉回）。
5. `cluster_key` 已存在 → 合并更新（追加 items、分数取 max 后再封顶、刷新 last_updated）；
   **通知条件**：`score >= 通知阈值(默认70)` 且 `跨源≥2 或 含官方一手`；
   此前不满足、证据累积后满足 → 补发"佐证升级"通知。

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
GET  /api/topics?[筛选参数]           # 热点榜：筛选 + 排序 + 分页 + 交叉分面计数
     #   scope=2|none  tier=strong|weak|official|media_cross|...  sources=blog,hn
     #   since=24h|3d|7d|30d  min_score=80  sort=score|updated|sources|items  q=关键词
     #   strong=1（只看强佐证，配合前端"低佐证默认折叠"）  limit(默认10)|offset（分页）
     #   → { rows, total, offset, limit, facets:{scope,tier,sources,since,weak,total_all}, tier_label, scopes }
     #   facets 为**交叉分面**：每个维度的计数在"应用其余所有维度"之后统计（标准 faceted search），
     #   因此选中某条件后，其他维度里"点了会变空"的选项能被识别出来。
     #   sort=updated 与 since 时间窗均按**原始发布轴**（published_last → 回退 last_updated），
     #   不再用聚类时间，避免旧闻因今天被讨论而排到最前。
     #   rows 内每行含 v1.4 速判字段：primary_label/primary_host/primary_tier/authority_count/
     #   top_metrics{source,url,title,author,values}/published_first/published_last
GET  /api/topics/:id                 # 详情：合并的原始条目、来源分布
     #   条目已补充展示字段：metrics(解析后)/labels(徽章)/metric_list/has_published/
     #   published_at+collected_at(区分发布与收录)/repo_created(GitHub 建库时间)/brand/
     #   platform_host/author_label/tier_name；条目按发布/采集时间新→旧排列
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
- 首页 Radar：话题流（热度=卡片辉光强度）+ 雷达盘可视化（Canvas 扫描动画，光点=近期条目）。
  **v1.3 检索、排序与分页**（`components/TopicFilters.jsx`）：
  - 五类条件全部走服务端（`GET /api/topics?...`）：关键词搜索、关注范围、佐证强度、时间窗、信息源，
    外加热度滑块与四种排序（热度/最新/跨源数/来源条数）；筛选状态存 localStorage。
  - 排序做成段控按钮（不用原生 select）；五类筛选收进「⚑ 筛选」按钮，展开为**内嵌区域**
    （撑开检索条而非浮层覆盖卡片），按钮上带已生效条件数徽章。
  - chip 计数来自后端交叉分面 `facets`（每个维度在应用其余维度后统计），
    可识别"点了会变空"的选项。
  - 列表统一**长条形、一行一条**（放弃 Bento 错落，减少视觉跳动）；描述与"为什么火"
    用低对比中性色并限两行，突出标题与热度分。
  - 两种视图：平铺 / **按关注范围分组**（列由 scopes 表动态生成，用户增删范围即增减列）。
  - 低佐证话题（单源/孤证，热度封顶）**默认由服务端过滤掉**（`strong=1`），折叠成一条
    "还有 N 个低佐证话题"，符合"宁缺毋滥"；用户显式按佐证筛选时不再二次折叠。
  - **分页每页 10 条**（服务端 limit/offset）：页码首尾常驻 + 邻近页 + 省略号，显示"X–Y / 共 N 条"；
    筛选变化回到第 1 页，结果集变小时自动回退到末页。
  - 搜索输入 260ms 防抖；防抖回调用 ref 读最新状态，避免与其他条件互相覆盖。
  - **v1.4 信息价值速判**（省跳站核对，见 §3.7）：
    - 卡片只挂 **1 个最权威来源**（品牌名，配色区分官方绿/媒体蓝）+ `+N` 折叠其余权威来源；
      显示话题内最热条目的原始互动（`▲139 💬92`）与 **首发时间** + 新鲜度标签
      （新 <6h / 发酵中 / 冷却），hover 看最新动态与收录时间；最热原文 `↗ 原文` 可直接跳走。
    - 详情页：来源域名带品牌名与真实域名、逐条列出原始指标徽章（无互动接口的源标"无互动数据"）、
      区分"发布于 X"与"收录 Y"、GitHub 条目显示"建库于 Z"、发布者署名（`每经网`/`nirajrajgor`）。
  - Watch 页：关键词芯片 + 每个关键词的命中流水，AI 理由以"甄别报告"形式展开；
    命中条目同样区分"发布于/无发布时间"并显示原始互动徽章。
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

质量门槛（v1.2）存 `settings` 表 `gates.*` 键，Web 设置页可调，`.env` 无需配置：
`gates.hnPoints=30 gates.hnComments=15 gates.hfUpvotes=30 gates.ghStarsToday=50
gates.ghSearchStars=100 gates.redditScore=200 gates.lobstersScore=20 gates.twitterLikes=50
gates.biliScore=500 gates.authBili=5000
gates.minQuality=60 gates.maxAgeDays=14 gates.dedupThreshold=0.85 gates.dedupEnabled=true`

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
- **Google/Bing News 被限**：多引擎互为备份，单引擎失败静默跳过；间隔 ≥2s、每扫描 ≤8 查询。
- **Reddit 间歇 403/429**：尽力而为源（非核心），失败不影响整轮；UA 与间隔控制。
- **twitterapi.io 费用**：每扫描调用数硬上限（默认 ≤ 12 次），设置页可调；未配 key 自动禁用。
- **AI 误判**：理由全量落库可回溯；被过滤项单独可查，用户可一键"误杀恢复"。
- **RSS/页面结构变更**：collector 层各自 try/catch，监控 scans.stats 里各源失败计数；
  `util/feed.js` 三级降级解析（cheerio→rss-parser→正则）兜底结构差异。
- **质量门槛误杀（漏报）**：所有阈值设置页可调（gates.*）；域名名单集中在 quality.js 便于扩充；
  历史回填前自动备份 db，可回滚。
- **噪音入库（现状问题）**：质量闸门拦截率实测 ~74%（190 抓 → 138 拦），
  拦截原因分布落 scans.stats.blockedStats，可审计。
