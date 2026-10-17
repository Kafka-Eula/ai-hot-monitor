---
name: hotpulse
description: 监控 AI 领域热点——零依赖自包含，无需启动服务、无需 API key、不产生调用费用。本 Skill 的 CLI 抓取 10 个免 key 信息源（Hacker News、GitHub Trending/新库、HuggingFace 论文与博客、OpenAI/Anthropic/DeepMind/Mistral 等官方 RSS、Google/Bing/360 新闻搜索、中文科技媒体、Lobsters、B站），经规则质量闸门滤掉内容农场/蹭词软文/过期旧闻后，由你（执行本 Skill 的 AI）亲自甄别真伪、聚类热点、评分并写中文摘要，结果增量存入本地 SQLite。当用户要求"盯梢/监控某个 AI 产品或关键词（如 GPT-6、Claude、DeepSeek、Kimi）""看看最近 AI 圈/大模型/AI 编程有什么热点或最新动态""检查有没有新热点/新消息""这个爆料是不是假的/为什么没抓到"，或提到 HotPulse、热点雷达、热点订阅、防假冒甄别时使用本技能。也适合定时任务（cron / agent 心跳）周期调用实现全自动热点发现。第一次使用先跑 doctor 自检。   
---

# HotPulse · AI 热点雷达（自包含 Agent Skill）

发现 AI 领域热点：**CLI 负责确定性抓取与过滤，你（AI）负责判断**。不需要后端服务、不需要 OpenRouter key、不产生任何 API 费用——分析质量取决于你当前用的模型。

## 为什么这样分工

判断"这条内容是不是真的、和关键词有没有实质关系、哪些条目讲的是同一件事"正是 LLM 的强项，交给外部小模型反而更贵更差。但"从 10 个站点抓数据、算互动加权、认域名是不是官方/权威/农场、按证据等级给分数封顶"是确定性计算，交给代码更快更稳、还能防你被长上下文拖垮。所以：

- **CLI** 把每条内容的**证据字段预先算好**（`official/auth/farm/eng/tier/q/m/age`）直接给你——你**不必也不该**自己推测媒体身份。
- **你** 只做三个判断：`relevant`（实质相关吗）、`genuine`（可信吗）、聚类 + 基线分 + 中文摘要。
- **分数不由你定死**：你给的是"事件量级"基线分，CLI 会按互动数据合成、再按**证据等级封顶**（单源孤证最高 65 分）。这是为了治"1 条孤证也给 100 分""随手发帖成热点"——你无法、也不应自我抬分。

## 前置

- **Node ≥ 22.5**（用到内置 `node:sqlite` 与内置 `undici`）。**无需 `npm install`**。
- **境外源需要代理**：Node 原生 fetch 不读 `HTTPS_PROXY`，CLI 用内置 undici 走代理。国内直连时 HuggingFace/GitHub/Google News/OpenAI 博客等会超时并被静默跳过（国内源仍可用）。Clash/Verge 用户：
  ```powershell
  $env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"; $env:NO_PROXY="localhost,127.0.0.1"
  ```
- 所有命令：`node scripts/hp.mjs <命令>`（相对本 Skill 目录）。加 `--json` 得机器可读输出。数据落在本 Skill 的 `data/agent.db`（与 `server/` 完全隔离）。

**第一次用先跑一次自检**（只读，不写库、不烧额度）：
```bash
node scripts/hp.mjs doctor
```
逐源打印连通性。境外源标 `✗` → 按上面设代理再跑；全 `✓` 即可开始。

## 核心闭环（盯梢某关键词）

用户说"帮我盯 GPT-6，出新消息告诉我"：

1. `node scripts/hp.mjs watch GPT-6` —— 加入盯梢列表（`--now` 顺带采集一轮）
2. `node scripts/hp.mjs collect` —— 抓 10 源 → 质量闸门 → 增量入库（约 30~60s，报告"新增 N 条"）
3. `node scripts/hp.mjs pending` —— 取**待你判断**的工作清单：每条带证据字段，分"待甄别"（×关键词）与"待聚类"两堆，并列出既有话题的 `cluster_key`
4. **你读 [reference/rubric.md](reference/rubric.md)**，对每个【关键词×条目】判 `relevant/genuine/confidence/reason`，把相关条目聚成话题（`cluster_key`+中文标题+摘要+`why_hot`+基线分+`item_ids`），写成一个 JSON 文件（用**绝对路径**）：
   ```json
   {"verdicts":[{"k":"GPT-6","i":64,"relevant":true,"genuine":false,"confidence":0.4,"reason":"聚合页转述无官方佐证，疑似蹭词"}],
    "topics":[{"cluster_key":"gpt6-release","title":"OpenAI 发布 GPT-6","summary_zh":"…","why_hot":"…","score":90,"item_ids":[54,63],"scope":""}]}
   ```
5. `node scripts/hp.mjs commit --file <绝对路径>` —— 写回；命中项会即时打印
6. `node scripts/hp.mjs digest --hours 72` —— 生成可直接播报的中文简报，转述给用户

之后告诉用户：再跑 `collect → pending → commit → digest` 就是增量发现（已判过的条目不会重复出现在 `pending`）。

## 按用户意图速查

| 用户说 | 怎么做 |
|---|---|
| "最近 AI 圈有什么热点" | `collect --global`（只用全局源，不检索词）→ `pending`（此时无盯梢词，只聚类）→ 判话题 → `commit` → `topics 10` 或 `digest` |
| "AI 编程/大模型最新动态" | 先 `scope add "AI 编程" "AI 编程,coding agent,vibe coding"` → `collect` → 聚类 → `commit` → `topics --scope "AI 编程"` |
| "盯 X 并出结果告诉我" | 上面【核心闭环】6 步 |
| "这爆料是真的吗/为什么没通知" | `hits <关键词> --all` 看被过滤项与你的 `reason`；误杀可 `HP_MIN_CONFIDENCE`/`HP_GATE_minQuality` 调低后重判 |
| "定时自动发现"（cron/心跳） | 每轮：`collect` → `pending --json` → 判 → `commit --file` → `digest --hours <间隔> --json` 取新热点播报。频率建议 ≥30 分钟，太密只是重复抓同一批 |
| "换个模型/调门槛" | 见 [reference/sources.md](reference/sources.md) 的 `HP_GATE_*` 环境变量 |

## 查询命令

- `topics [n]` —— 热点榜。筛选：`--q 词`、`--scope 名称`、`--tier strong|weak|official|media_cross`、`--sources hn,blog`、`--hours 24`、`--min-score 70`；排序：`--sort score|updated|sources|engagement`；`--strong` 只看有佐证的。分页 `--limit/--offset`。
- `topic <id|cluster_key>` —— 详情：逐条原始来源+品牌名、原始互动、**发布 vs 收录**区分、分数构成（基线×0.6+互动×0.4→封顶）。
- `digest [n] --hours 24` —— 今日简报（命中 + 热点 TOP + 速判字段），最适合直接转述。
- `hits <关键词> [--all]` —— 该词甄别记录；`--all` 含被过滤项（排查误杀）。
- `watches` / `unwatch <词>`；`scope list|add|remove`；`stats` / `history [n]` / `reset --yes`。

## 理解甄别结果（防假冒）

`hits`/`digest` 里每条：
- `✅HIT [置信%]`：实质相关 + 真实可信 + 达阈值；`⚪低置信`：判真但置信不足阈值；`❌过滤`：蹭词/软文/无佐证爆料。
- `AI:` 后是**你自己写的**中文理由，依据来源可信度与交叉佐证——**不是模型自身知识**。监控的产品可能比你训练数据更新，**严禁以"我没听说过该产品"判假**（rubric.md 第 0 条，最关键）。
- 被过滤内容同样存档可追溯。commit 有一道代码兜底：你判 `genuine=true` 但 `reason` 自曝"无官方佐证/传闻"且来源**既非官方也非权威**时，会被自动降级（对齐后端，防言行不一）。

## 注意

- `collect`/`commit` 有真实副作用（写库），但**不消耗任何 AI 额度、不花钱**（判断在你这边完成）。
- 单源失败不影响整体；只有核心源（hn/hf_papers/blog/news_search）失败才提示本轮不完整，可稍后重试。
- 数据在本 Skill 的 `data/agent.db` 持久化，重启不丢；`reset --yes` 清空。
- 与 `server/` 里的 Web 版 HotPulse 是两套独立实现，共用同一套判据但各存各的库，互不读写对方文件。

判据细则见 [reference/rubric.md](reference/rubric.md)；信息源、门槛、代理、去重见 [reference/sources.md](reference/sources.md)。
