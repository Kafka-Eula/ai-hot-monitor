# HotPulse · AI 热点雷达

HotPulse 是一个本地优先的 AI 行业热点监控工具。它会从多个公开信息源收集新内容，经过规则质量筛选与去重，再按需使用 AI 甄别关键词命中、聚类热点并生成中文摘要。你可以在 Web 界面查看热点、管理监控项，并接收站内通知；邮件和浏览器推送为可选功能。

## 功能一览

- **关键词盯梢**：跟踪 GPT、Claude、DeepSeek 等关键词，查看 AI 甄别结果及原因。
- **热点雷达**：管理关注范围，浏览聚类后的热点、中文摘要、来源与佐证信息。
- **多源采集**：支持 Hacker News、GitHub Trending / 新建仓库、Hugging Face Papers、官方博客 RSS、Google/Bing 新闻 RSS、中文媒体与新闻搜索、Lobsters、Bilibili；X/Twitter 需要单独配置 API key。
- **质量筛选**：按来源、时效、互动数据、域名与近似内容去重等规则过滤低价值内容；热点分数会受佐证强度约束。
- **通知**：页面内实时通知默认可用；浏览器推送和邮件需要额外配置。
- **独立 Agent Skill**：`skills/hotpulse/` 中还包含一个可单独使用的 CLI Skill，不依赖 Web 服务或 OpenRouter；它与 Web 版使用各自独立的 SQLite 数据库。

## 技术栈

- **服务端**：Node.js、原生 JavaScript ES Modules、Express、内置 `node:sqlite`、node-cron
- **前端**：React、Vite、JavaScript
- **数据存储**：本地 SQLite
- **AI 接口**：OpenRouter（可选；AI 甄别与聚类需要配置）

## 项目结构

```text
.
├── server/                 # Express 后端与数据处理
│   ├── src/
│   │   ├── ai/             # AI 甄别、热点聚类与 OpenRouter 接口
│   │   ├── collectors/     # 各信息源采集器
│   │   ├── notify/         # SSE、Web Push、邮件通知
│   │   ├── routes/         # REST API
│   │   ├── util/           # HTTP、Feed、日期等工具
│   │   ├── db.js           # SQLite 数据库与表结构
│   │   ├── pipeline.js     # 采集、过滤、入库与 AI 处理流程
│   │   ├── quality.js      # 质量门槛、来源分级与去重
│   │   └── scheduler.js    # 定时与手动扫描
│   └── test/               # 服务端测试
├── web/                    # React 前端
│   └── src/
│       ├── pages/          # Radar、Watch、Settings 页面
│       ├── components/     # 页面组件
│       └── lib/            # API 与通用工具
├── skills/hotpulse/        # 独立 Agent Skill 与 CLI
├── docs/                   # 需求与设计文档
├── .env.example            # 环境变量模板
└── package.json            # npm workspaces 与常用命令
```

## 快速开始

### 环境要求

- Node.js **24 或更高版本**
- npm
- OpenRouter API Key（可选；没有 Key 时仍可采集和保存内容，但不会执行 AI 甄别与热点聚类）

### 本地开发

在项目根目录执行：

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，至少在需要 AI 功能时设置：

```dotenv
OPENROUTER_API_KEY=你的_OpenRouter_API_Key
```

然后启动开发环境：

```powershell
npm run dev
```

- Web 界面：<http://localhost:5173>
- 后端 API：<http://localhost:4117/api>
- 健康检查：<http://localhost:4117/api/health>

开发模式下，Vite 会将 `/api` 请求代理到本地后端。服务端默认每 30 分钟扫描一次；也可以在 Radar 页面手动启动扫描。

### 生产运行

先构建前端，再启动服务端：

```powershell
npm install
Copy-Item .env.example .env
npm --workspace web run build
npm start
```

打开 <http://localhost:4117>。SQLite 数据库默认保存在 `data/hotpulse.db`，可用 `DB_FILE` 修改路径。数据库和 `.env` 都是本地数据，不应提交到仓库。

## 使用流程

1. 在 **Settings** 中配置 OpenRouter Key 和模型；需要时再设置扫描频率及通知渠道。
2. 在 **Watch** 中添加要盯梢的关键词。
3. 在 **Radar** 中添加关注范围，例如“AI 编程”或“开源大模型”。
4. 点击“立即扫描”，或等待定时任务运行。
5. 在 **Watch** 查看命中与甄别原因，在 **Radar** 搜索、筛选和查看热点及其来源。

质量门槛与通知阈值可在设置页调整。没有配置 OpenRouter 时，采集和质量筛选仍会工作，但 AI 相关结果会暂时缺失。

## 配置说明

完整模板见 [.env.example](.env.example)。常用配置：

| 变量 | 用途 | 默认值/说明 |
| --- | --- | --- |
| `PORT` | 后端监听端口 | `4117` |
| `SCAN_CRON` | 定时扫描 Cron 表达式 | 每 30 分钟 |
| `DB_FILE` | SQLite 数据库文件路径 | `data/hotpulse.db` |
| `OPENROUTER_API_KEY` | AI 甄别和聚类 | 可选；不配置则跳过 AI 阶段 |
| `OPENROUTER_MODEL` | OpenRouter 模型 ID | 可在 `.env` 或设置页配置 |
| `TWITTERAPI_IO_KEY` | X/Twitter 信息源 | 可选；该服务可能产生费用 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出站 HTTP 代理 | 可选 |
| `SMTP_*` / `MAIL_*` | 邮件通知 | 可选 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 浏览器 Web Push | 可选 |

OpenRouter 与 X/Twitter 第三方服务的可用性、配额或费用由各自服务商决定。请勿将真实密钥提交到 GitHub；`.env` 已被 `.gitignore` 排除。

## Agent Skill（可选）

`skills/hotpulse/` 下的 CLI 版 Skill 与 Web 服务相互独立，不需要启动 Express 服务，也不需要 OpenRouter API Key。需要 Node.js 24 或更高版本。在项目根目录执行：

```powershell
node skills/hotpulse/scripts/hp.mjs doctor
node skills/hotpulse/scripts/hp.mjs watch "GPT-6" --now
node skills/hotpulse/scripts/hp.mjs collect
node skills/hotpulse/scripts/hp.mjs pending
node skills/hotpulse/scripts/hp.mjs digest --hours 72
```

首次使用建议运行 `doctor` 检查信息源连通性。该 Skill 的数据保存在 `skills/hotpulse/data/agent.db`，与 Web 版数据库隔离。更多命令与 AI 甄别流程见 [skills/hotpulse/SKILL.md](skills/hotpulse/SKILL.md)。

## 测试

运行服务端默认测试：

```powershell
npm test
```

## 文档

- [需求文档](docs/REQUIREMENTS.md)
- [技术设计](docs/DESIGN.md)
- [Agent Skill 使用说明](skills/hotpulse/SKILL.md)

## 许可证

当前仓库尚未声明开源许可证。若计划公开分发或允许他人复用，请先添加适合项目的 LICENSE 文件。
