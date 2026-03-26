# mails-agent

面向 AI Agent 的邮件基础设施。发送、接收、搜索邮件，自动提取验证码。

[![npm](https://img.shields.io/npm/v/mails-agent)](https://www.npmjs.com/package/mails-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Digidai/mails/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/mails-agent)](https://www.npmjs.com/package/mails-agent)

[English](README.md) | [日本語](README.ja.md)

> **Agent 集成：** 使用 [mails-skills](https://github.com/Digidai/mails-skills) 一行命令为你的 Claude Code、OpenClaw 或任何 AI agent 添加邮件能力。

## 为什么选择 mails？

与只能发送的原始邮件 API 不同，mails 为你的 Agent 提供完整的邮件身份 — 发送、接收、搜索、提取验证码，一个包搞定。在你自己的域名上通过 Cloudflare 部署（免费额度足够），完全掌控，不依赖任何第三方服务。

## 特性

- **发送邮件** — 通过 Resend，支持附件
- **接收邮件** — 通过 Cloudflare Email Routing → Worker → D1
- **搜索收件箱** — FTS5 全文搜索，涵盖主题、正文、发件人、验证码
- **验证码自动提取** — 自动从邮件中提取 4-8 位验证码（支持中/英/日/韩）
- **附件** — CLI `--attach` 或 SDK 发送；接收时大附件自动存入 R2
- **Webhook 通知** — 收件时 POST 到你的 URL，带 HMAC-SHA256 签名
- **邮箱隔离** — 通过 `auth_tokens` D1 表实现按 token 绑定邮箱
- **删除 API** — 删除已处理邮件，级联清理附件和 R2 对象
- **存储 Provider** — 本地 SQLite（开发用）或远程 Worker API（生产环境）
- **零运行时依赖** — 所有 Provider 使用原生 `fetch()`
- **自部署** — 在 Cloudflare 部署你自己的 Worker（免费额度足够），完全掌控数据

## 安装

```bash
npm install -g mails-agent
# 或
bun install -g mails-agent
# 或直接使用
npx mails-agent
```

## 快速开始

```bash
# 1. 部署你的 Worker（参见下方完整自部署指南）
cd worker && wrangler deploy

# 2. 配置 CLI
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_TOKEN
mails config set mailbox agent@yourdomain.com
mails config set default_from agent@yourdomain.com

# 3. 开始使用
mails send --to user@example.com --subject "Hello" --body "World"
mails inbox                          # 查看收件箱
mails inbox --query "密码"            # 搜索邮件
mails code --to agent@yourdomain.com # 等待验证码
```

## 工作原理

```
                           发送                                       接收

  Agent                                              外部发件人
    |                                                  |
    |  mails send --to user@example.com                |  发送邮件到 agent@yourdomain.com
    |                                                  |
    v                                                  v
+--------+                                   +-------------------+
|  CLI   |------ /api/send ----------------->| Cloudflare Email  |
|  /SDK  |<----- /api/inbox -----------------|     Routing       |
+--------+                                   +-------------------+
    |                                                  |
    v                                                  v
+--------------------------------------------------+
|              你的 Cloudflare Worker               |
|  /api/send → Resend API → SMTP 投递              |
|  /api/inbox, /api/code → D1 查询 (FTS5 全文搜索)  |
|  email() handler → 解析 MIME → 存储到 D1          |
+--------------------------------------------------+
    |               |
    v               v
+--------+    +------------+
|   D1   |    |     R2     |
| 邮件    |    |   大附件    |
+--------+    +------------+
    |
    |  通过 CLI/SDK 查询
    v
  Agent
    mails inbox
    mails inbox --query "验证码"
    mails code --to agent@yourdomain.com
```

## CLI 参考

### send

```bash
mails send --to <email> --subject <subject> --body <text>
mails send --to <email> --subject <subject> --html "<h1>Hello</h1>"
mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
mails send --to <email> --subject "Report" --body "See attached" --attach report.pdf
```

### inbox

```bash
mails inbox                                  # 最近邮件列表
mails inbox --mailbox agent@test.com         # 指定邮箱
mails inbox --query "password reset"         # 搜索邮件
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # 查看邮件详情（含附件）
```

### code

```bash
mails code --to agent@test.com              # 等待验证码（默认 30 秒）
mails code --to agent@test.com --timeout 60 # 自定义超时
```

验证码输出到 stdout，方便管道：`CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # 查看所有配置
mails config set <key> <value>  # 设置
mails config get <key>          # 获取
```

## SDK

```typescript
import { send, getInbox, searchInbox, getEmail, deleteEmail, waitForCode } from 'mails-agent'

// 发送
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// 发送（支持附件）
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 收件箱列表
const emails = await getInbox('agent@yourdomain.com', { limit: 10 })

// 搜索收件箱
const results = await searchInbox('agent@yourdomain.com', {
  query: '密码重置',
  direction: 'inbound',
})

// 获取邮件详情（含附件）
const email = await getEmail('email-id')

// 删除邮件（级联删除附件和 R2 对象）
await deleteEmail('email-id')

// 等待验证码
const code = await waitForCode('agent@yourdomain.com', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## 存储 Provider

CLI 自动检测存储 Provider：
- 配置中有 `worker_url` → 远程（查询 Worker API）
- 否则 → 本地 SQLite（`~/.mails/mails.db`）

<details>
<summary><strong>配置项</strong></summary>

| 键 | 设置方式 | 说明 |
|---|---------|------|
| `mailbox` | 手动 | 接收邮箱地址 |
| `worker_url` | 手动 | Worker URL（启用远程 Provider） |
| `worker_token` | 手动 | Worker 鉴权 token |
| `resend_api_key` | 手动 | Resend API key（设置 worker_url 后不需要） |
| `default_from` | 手动 | 默认发件人地址 |
| `storage_provider` | 自动 | `sqlite` 或 `remote`（自动检测） |

</details>

<details>
<summary><strong>完整自部署指南</strong></summary>

用你自己的域名 + Cloudflare + Resend 运行全套邮件系统，完全掌控，不依赖任何第三方服务。

### 前置条件

| 需要什么 | 为什么 | 费用 |
|---------|--------|------|
| 一个域名（如 `example.com`） | 邮箱地址 `agent@example.com` | 已有 |
| Cloudflare 账号 | DNS、Email Routing、Worker、D1 | 免费额度足够 |
| Resend 账号 | SMTP 投递 | 免费 100 封/天 |

### 第 1 步：域名接入 Cloudflare

如果你的域名 DNS 还没托管在 Cloudflare，在 [dash.cloudflare.com](https://dash.cloudflare.com) 添加域名，然后到域名注册商修改 nameserver。

### 第 2 步：配置 Resend 发件域名

1. 注册 [Resend](https://resend.com) 账号
2. 进入 **Domains** → **Add Domain** → 输入你的域名
3. Resend 会给出需要添加的 DNS 记录，到 Cloudflare DNS 添加：
   - **SPF** — `@` 上添加 `TXT` 记录：`v=spf1 include:amazonses.com ~all`
   - **DKIM** — 按 Resend 给出的 3 条 `CNAME` 记录添加
   - **DMARC** — `_dmarc` 上添加 `TXT` 记录：`v=DMARC1; p=none;`
4. 等待 Resend 验证域名（通常几分钟，最长 48 小时）
5. 复制 Resend API key（`re_...`）

### 第 3 步：部署 Worker

```bash
cd worker
bun install

# 创建 D1 数据库
wrangler d1 create mails
# → 复制输出中的 database_id

# 编辑 wrangler.toml — 粘贴你的 database_id
# 把 REPLACE_WITH_YOUR_DATABASE_ID 替换为实际 ID

# 初始化数据库表结构
wrangler d1 execute mails --file=schema.sql

# 设置密钥
wrangler secret put AUTH_TOKEN         # 设置一个强随机 token
wrangler secret put RESEND_API_KEY     # 粘贴 Resend 的 re_... key

# 部署
wrangler deploy
# → 记下 Worker URL: https://mails-worker.<你的子域名>.workers.dev
```

### 第 4 步：配置 Cloudflare Email Routing（收件）

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com) → 你的域名 → **Email** → **Email Routing**
2. 点击 **Enable Email Routing**（Cloudflare 会自动添加 MX 记录）
3. 进入 **Routing rules** → **Catch-all address** → 选择 **Send to a Worker** → 选择你部署的 Worker
4. 现在所有发送到 `*@example.com` 的邮件都会路由到你的 Worker

### 第 5 步：（可选）创建 R2 存储桶用于大附件

```bash
wrangler r2 create mails-attachments
```

R2 绑定已在 `wrangler.toml` 中配置好，创建后重新部署即可：

```bash
wrangler deploy
```

### 第 6 步：配置 CLI 客户端

```bash
mails config set worker_url https://mails-worker.<你的子域名>.workers.dev
mails config set worker_token YOUR_AUTH_TOKEN       # 第 3 步设置的同一个 token
mails config set mailbox agent@example.com          # 你的邮箱地址
mails config set default_from agent@example.com     # 默认发件人
```

### 第 7 步：验证

```bash
# 检查 Worker 是否可达
curl https://mails-worker.<你的子域名>.workers.dev/health

# 查看收件箱（应该为空）
mails inbox

# 发送测试邮件
mails send --to 你的个人邮箱@gmail.com --subject "Test" --body "Hello from self-hosted mails"

# 从任意邮箱发一封邮件到你的 agent@example.com，然后：
mails inbox
```

### 部署后架构

```
你的 Agent                              外部发件人
    |                                        |
    |  mails send / mails inbox              |  发邮件到 agent@example.com
    v                                        v
+--------+                         +-------------------+
|  CLI   |------ /api/send ------->|  Cloudflare Email |
|  /SDK  |<----- /api/inbox -------|     Routing       |
+--------+                         +-------------------+
    |                                        |
    v                                        v
+--------------------------------------------------+
|              你的 Cloudflare Worker               |
|  /api/send → Resend API → SMTP 投递              |
|  /api/inbox, /api/code → D1 查询 (FTS5 全文搜索)  |
|  email() handler → 解析 MIME → 存储到 D1          |
+--------------------------------------------------+
    |               |
    v               v
+--------+    +------------+
|   D1   |    |     R2     |
| 邮件    |    |   大附件    |
+--------+    +------------+
```

### Worker 密钥参考

| 密钥 | 是否必须 | 说明 |
|------|---------|------|
| `AUTH_TOKEN` | 推荐 | API 鉴权 token。设置后所有 `/api/*` 端点需要 `Authorization: Bearer <token>` |
| `RESEND_API_KEY` | 发送必须 | Resend API key（`re_...`）。Worker 通过它调用 Resend 发送邮件 |
| `WEBHOOK_SECRET` | 可选 | HMAC-SHA256 签名密钥，用于 webhook 载荷签名（`X-Webhook-Signature` 头） |

### Worker API 端点

| 端点 | 说明 |
|------|------|
| `POST /api/send` | 发送邮件（需要 `RESEND_API_KEY` 密钥） |
| `GET /api/inbox?to=<addr>&limit=20` | 邮件列表 |
| `GET /api/inbox?to=<addr>&query=<text>` | 搜索邮件（FTS5 全文检索） |
| `GET /api/code?to=<addr>&timeout=30` | 长轮询等待验证码 |
| `GET /api/email?id=<id>` | 邮件详情（含附件） |
| `DELETE /api/email?id=<id>` | 删除邮件（含附件及 R2 对象） |
| `GET /api/attachment?id=<id>` | 下载附件 |
| `GET /api/me` | Worker 信息和能力 |
| `GET /health` | 健康检查（无需鉴权） |

### 发送优先级

CLI/SDK 发送邮件时，按以下顺序检查配置：

1. `worker_url` → 通过你的 Worker `/api/send` 发送（推荐）
2. `resend_api_key` → 直连 Resend API

设置了 `worker_url` 后，客户端不需要 `resend_api_key` — Resend key 作为密钥存储在 Worker 侧。

</details>

<details>
<summary><strong>测试</strong></summary>

```bash
bun test              # 单元测试 + mock E2E
bun test:coverage     # 含覆盖率报告
bun test:live         # 真实 E2E（需要 .env 配置 Resend key）
```

187 个测试，分布在 20 个测试文件中。

</details>

## 生态

```
┌─────────────────────────────────────────────────────────────┐
│                        mails 生态                            │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐  │
│  │  mails CLI   │    │  mails Worker    │    │   mails   │  │
│  │  & SDK       │───▶│  (Cloudflare)    │◀───│  -skills  │  │
│  │              │    │                  │    │           │  │
│  │ npm i mails- │    │  收件 + 发件     │    │  Agent    │  │
│  │    agent     │    │  + 搜索 + 验证码  │    │  Skills   │  │
│  └──────────────┘    └──────────────────┘    └───────────┘  │
│    开发者 / 脚本         基础设施              AI Agents    │
└─────────────────────────────────────────────────────────────┘
```

| 项目 | 是什么 | 谁使用 |
|---|---|---|
| **[mails](https://github.com/Digidai/mails)**（本仓库） | 邮件服务（Worker）+ CLI + SDK | 部署邮件基础设施的开发者 |
| **[mails-skills](https://github.com/Digidai/mails-skills)** | AI Agent 技能文件 | AI Agents（Claude Code、OpenClaw、Cursor） |

**快速集成 Agent：**
```bash
git clone https://github.com/Digidai/mails-skills && cd mails-skills && ./install.sh
```

## 贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建、项目结构和 PR 规范。

## 致谢

本项目基于 [mails](https://github.com/chekusu/mails)（作者 [turing](https://github.com/guo-yu)）开发。我们在此基础上新增了 mailbox 隔离、webhook 通知、删除 API、R2 附件存储、Worker 文件重构和全面的测试覆盖（187 个测试）。感谢原作者奠定的优秀基础。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。已按 MIT 条款保留原始版权声明。
