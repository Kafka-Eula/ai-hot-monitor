# 信息源手册（采集失败/要调门槛时读这份）

本 Skill 自带 10 个**免 API key** 的信息源，全部在 `scripts/lib/sources.mjs`。
`node scripts/hotpulse/scripts/hp.mjs doctor` 会逐个探测连通性。

## 源清单与门槛

| 源 (`--only` 名) | 接口 | 免key | 入库硬门槛 | 说明 |
|---|---|---|---|---|
| `hn` Hacker News | Algolia `search_by_date` | ✓ | points+1.5×comments ≥30，或 comments≥15 | 时间窗用 `created_at_i`（秒）；`created_at` 是 ISO 串别乘 1000 |
| `gh_trending` GitHub | `github.com/trending` 网页 | ✓ | stars_today ≥50 | 爬虫，取**当日新增**；老库总星数无意义。需代理 |
| `gh_search` GitHub 新库 | `api.github.com/search/repositories` | ✓ | stars ≥100 | 近 7 天新建高星库；未登录限 10 次/分，内部 sleep 1s |
| `hf_papers` HF 论文 | `huggingface.co/api/daily_papers` | ✓ | upvotes ≥30 | 作者自述预印本，**不算官方一手** |
| `blog` 官方博客 | 7 家 RSS | ✓ | 质量分 ≥60 | OpenAI/Google/DeepMind/Mistral/HF/LangChain/MIT-TR。一手官宣，需代理 |
| `news_search` 新闻搜索 | Google News(英/中)+Bing News RSS | ✓ | 域名须在官方/权威名单 | 真实媒体域名取自 `<source url>`；每查询≥2s、每扫描≤8 查询。需代理 |
| `cn_search` 360 中文新闻 | `news.so.com/ns` 网页 | ✓ | 域名在名单内 + 必须有日期 + 非落地页 | 中文报道主力；每查询≥3s、≤8 查询；触发验证页会跳过 |
| `cn_media` 中文媒体 | 7 家 RSS(IT之家/量子位/InfoQ中文/极客公园/雷锋网/Synced/爱范儿) | ✓ | 质量分 ≥60 | 按检索词本地过滤，域名均在权威名单 |
| `lobsters` Lobsters | `lobste.rs/t/<tag>.json` | ✓ | score+comments ≥20 | ai/ml/programming 三标签 |
| `bilibili` B站 | `search/type`+`popular` API | ✓ | 加权互动 ≥500（爆款 ≥5000） | **互动最全**（播放/点赞/投币/收藏/转发/弹幕/评论）；搜索需首页 `buvid3` Cookie，否则 `-412` |

**摘除的源**（与需求文档 v1.x 一致，代码里不启用）：
- `reddit`：抓 200 条入库 0 条，纯耗时；
- `web_search`(DuckDuckGo)：每条有效结果 4.1s，多为 SEO 站；
- `twitter`：twitterapi.io 按次计费，与"零配置零费用"冲突。
中英文新闻由 `news_search`/`cn_search` 覆盖，信息不丢。

## 代理（境外源的关键）

Node 原生 `fetch` **不读** `HTTPS_PROXY`。本 Skill 用 **Node 内置 `undici`** 的 `EnvHttpProxyAgent` 解决（无需 `npm install`）。
境外源（`hf_papers`/`gh_trending`/`gh_search`/`blog`/`news_search`）在国内直连会超时失败并被静默跳过——国内源仍可用。

**启用境外源**（Clash/Verge 用户）：
```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"; $env:NO_PROXY="localhost,127.0.0.1"
```
`doctor` 里 `境外` 标记的源若 `✗`，就是没走代理。代理不可达时不会报错，只会让那些源失败。

## 调质量门槛（环境变量 `HP_GATE_*`，无需改代码）

默认见 `scripts/lib/quality.mjs` 的 `DEFAULT_GATES`。常用：
```powershell
$env:HP_GATE_minQuality=55      # 综合质量分门槛（默认 60，越低越宽松）
$env:HP_GATE_maxAgeDays=21      # 时效硬门槛（默认 14 天，trending/daily_papers 豁免）
$env:HP_GATE_hnPoints=20        # HN 入库门槛
$env:HP_GATE_biliScore=300      # B站加权互动门槛
$env:HP_GATE_dedupEnabled=false # 关闭近似去重
```
命中阈值：`$env:HP_MIN_CONFIDENCE=0.7`（relevant+genuine 且 confidence≥此值才算命中，默认 0.6）。

## 采集节奏与容错

- 并发 4（各源打不同站点，互不共享限流域）；单源内部仍按各自红线 sleep。
- **单源失败不影响整体**；只有核心源（`hn`/`hf_papers`/`blog`/`news_search`）失败才判本轮不完整（`collect` 会提示 `core_failed`）。
- 一轮 `collect` 实测约 30~60s（境外源走代理时）。
- `--hours` 控制时间窗（默认 72h）；`--global` 只用全局源（trending/hf/lobsters/blog，不检索关键词）；`--only hn,blog` 指定源。

## 增量去重

数据在 `scripts/../data/agent.db`（`node:sqlite`，零安装，可用 `HP_DB` 换路径）。
- 条目按 `raw_hash`(=sha1(url|title)) 去重——跨轮次同一 URL 只入库一次，`collect` 报"新增 N 条"。
- 话题按 `cluster_key` 合并——同一事件跨轮次不重复开话题（这是"第一时间发现新变化"的基础）。
- 想重新全量分析：`node scripts/hp.mjs reset --yes` 清空库。

## 与 Web 版 HotPulse 的关系

本 Skill 与 `server/` 是**两套独立实现**，共用同一套质量/证据判据（从 `server/src/quality.js` 移植），但各自有独立数据库。
- Web 版：常驻服务 + OpenRouter 做 AI + 站内/推送/邮件通知，适合"挂机自动监控"。
- 本 Skill：零服务、零 key、零费用，**Claude 即 AI 引擎**，适合"在对话里按需发现热点"。
两者互不影响，本 Skill 不读写 `server/` 的任何文件或数据库。
