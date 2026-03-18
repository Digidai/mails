# mails - Implementation Plan

## 产品概览

**mails** (mails.dev) — Agent 邮件基础设施。开源 CLI + 多租户云服务。

```
┌──────────────────────────────────────────────────────────┐
│                     mails CLI (开源)                      │
│  mails send / mails inbox / mails setup / mails config   │
└───────────────────────┬──────────────────────────────────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
    ┌────────────┐ ┌─────────┐ ┌──────────┐
    │ Send       │ │ Receive │ │ Storage  │
    │ Providers  │ │ Worker  │ │ Providers│
    ├────────────┤ ├─────────┤ ├──────────┤
    │ • Resend   │ │ CF Email│ │ • db9.ai │
    │ • (SES)    │ │ Routing │ │ • SQLite │
    │ • (SMTP)   │ │ Worker  │ │ • (PG)   │
    └────────────┘ └─────────┘ └──────────┘

┌──────────────────────────────────────────────────────────┐
│               ~/Codes/mails (npm: mails)                  │
│  开源 CLI + SDK + Worker + skill.md                       │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│               ~/Codes/mails.dev (闭源)                    │
│  多租户云服务 (xxx@mails.dev) + Landing Page               │
│  Setup 页面 + Cloud API (x402)                            │
└──────────────────────────────────────────────────────────┘
```

## 双仓库结构

### ~/Codes/mails（开源，npm: mails）

```
mails/
├── src/
│   ├── cli/                  # CLI 入口 + 命令
│   │   ├── index.ts          # CLI main（Bun）
│   │   ├── commands/
│   │   │   ├── send.ts       # mails send
│   │   │   ├── inbox.ts      # mails inbox
│   │   │   ├── code.ts       # mails code（等待验证码）
│   │   │   ├── config.ts     # mails config（get/set）
│   │   │   └── setup.ts      # mails setup（启动本地 API → 打开 mails.dev/setup）
│   │   └── setup-server.ts   # setup 本地 API 服务器（Bun.serve）
│   ├── core/                 # 核心逻辑（CLI + SDK 共用）
│   │   ├── send.ts           # 发邮件统一接口
│   │   ├── receive.ts        # 收邮件查询接口
│   │   ├── config.ts         # 配置文件读写 (~/.mails/config.json)
│   │   └── types.ts          # 类型定义
│   ├── providers/
│   │   ├── send/
│   │   │   ├── interface.ts  # SendProvider interface
│   │   │   └── resend.ts     # Resend 实现
│   │   └── storage/
│   │       ├── interface.ts  # StorageProvider interface
│   │       ├── db9.ts        # db9.ai 实现
│   │       └── sqlite.ts     # 本地 SQLite 实现（默认）
│   └── index.ts              # SDK 导出（programmatic use）
├── worker/                   # Cloudflare Email Worker（用户自部署）
│   ├── src/
│   │   └── index.ts          # email() handler + HTTP API
│   ├── wrangler.toml
│   └── package.json
├── skill.md                  # Agent 接入指南（给 AI agent 阅读）
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### ~/Codes/mails.dev（闭源）

```
mails.dev/
├── src/
│   ├── api/                  # Cloud API 服务器
│   │   ├── server.ts         # Hono + x402 中间件
│   │   ├── routes/
│   │   │   ├── send.ts       # POST /v1/send（x402 付费）
│   │   │   ├── inbox.ts      # GET /v1/inbox（免费）
│   │   │   └── code.ts       # GET /v1/code（免费）
│   │   └── middleware/
│   │       └── auth.ts       # API Key + x402 双轨认证
│   └── worker/               # mails.dev 自有 Email Worker（多租户）
│       ├── src/index.ts      # 接收 xxx@mails.dev 邮件
│       └── wrangler.toml
├── web/                      # Landing Page + Setup 页面
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.tsx      # mails.dev 首页
│   │   │   └── Setup.tsx     # 交互式配置页面（shipkey 模式）
│   │   └── ...
│   ├── package.json
│   └── vite.config.ts
├── package.json
└── tsconfig.json
```

## Setup 交互流程（shipkey 模式）

```
用户执行 `mails setup`
    ↓
CLI 启动本地 API 服务器 (Bun.serve, 随机端口)
    ↓
打开浏览器: https://mails.dev/setup?port=<PORT>
    ↓
Web 页面通过 fetch() 与 localhost:<PORT> 通信 (CORS)
    ↓
┌─────────────────────────────────────────────┐
│  Setup 页面步骤：                             │
│                                              │
│  1. 选择模式：                                │
│     • 托管模式 (xxx@mails.dev) — 零配置       │
│     • 自建模式 (自定义域名) — 需配置 CF        │
│                                              │
│  2. [自建] 配置 Cloudflare：                  │
│     • 输入 CF API Token                      │
│     • 选择/输入域名                           │
│     • 一键配置 DNS (MX, SPF, DKIM, DMARC)    │
│     • 部署 Email Worker                      │
│                                              │
│  3. 配置发件 Provider：                       │
│     • 输入 Resend API Key                    │
│     • 验证连通性                              │
│                                              │
│  4. 配置存储 Provider：                       │
│     • 本地 SQLite（默认，无需配置）             │
│     • db9.ai（输入 Token）                    │
│                                              │
│  5. 测试：发送测试邮件 + 确认收件              │
└─────────────────────────────────────────────┘
    ↓
配置写入 ~/.mails/config.json
    ↓
CLI 退出，提示 "Setup complete!"
```

### Setup 本地 API 端点

```
GET  /api/config          — 读取当前配置
POST /api/config          — 保存配置字段
POST /api/test-send       — 发送测试邮件
POST /api/test-receive    — 测试收件
POST /api/dns/check       — 检查 DNS 记录
POST /api/dns/configure   — 通过 CF API 配置 DNS
POST /api/verify-key      — 验证 API Key 有效性
GET  /api/status          — 各项配置状态检查
```

## 阶段划分

### Phase 1：核心 CLI + 发邮件 + skill.md（MVP）

目标：Agent 通过 skill.md 学会用 `mails` 发邮件

- [ ] 1.1 项目初始化
  - package.json（name: mails, bin: mails）
  - tsconfig.json, bunfig.toml, .gitignore

- [ ] 1.2 类型定义
  - `src/core/types.ts` — Email, SendOptions, Config 等

- [ ] 1.3 配置系统
  - `src/core/config.ts` — 读写 `~/.mails/config.json`

- [ ] 1.4 发邮件 Provider
  - `src/providers/send/interface.ts` — SendProvider interface
  - `src/providers/send/resend.ts` — Resend 实现
  - `src/core/send.ts` — 统一发送入口

- [ ] 1.5 CLI
  - `src/cli/index.ts` — 命令路由
  - `mails send` — 发邮件
  - `mails config` — get/set 配置
  - `mails help`

- [ ] 1.6 SDK 导出
  - `src/index.ts` — programmatic API（`import { send } from 'mails'`）

- [ ] 1.7 skill.md
  - Agent 接入指南：安装、配置、发邮件、收邮件 API

- [ ] 1.8 Bun 打包 + npm 发布
  - `bun build --compile`
  - 发布 mails@1.0.0 到 npm

### Phase 2：收邮件 Worker + 存储

目标：部署 Worker 后，`mails inbox` / `mails code` 可用

- [ ] 2.1 Cloudflare Email Worker
  - 基于 sandbank mailbox 代码
  - email() handler → MIME 解析 → 验证码提取 → 存储
  - HTTP API：`/api/inbox`, `/api/code`, `/api/email/:id`

- [ ] 2.2 Storage Provider
  - `src/providers/storage/interface.ts`
  - `src/providers/storage/sqlite.ts` — 本地默认
  - `src/providers/storage/db9.ts` — db9.ai（兼容 PG schema）

- [ ] 2.3 CLI 收件箱
  - `mails inbox` / `mails code`

- [ ] 2.4 本地优先入站模式
  - Worker 可选把入站邮件直接转发到本地常驻进程
  - 本地 `sqlite` / `db9` 都能持久化附件元数据和附件内容
  - 不强制 R2，不强制 Cloudflare blob 存储
  - keep-alive agent 可用 `mails serve` 或自定义 webhook 持续接收入站邮件

### Phase 3：Setup + mails.dev

目标：`mails setup` 打开配置向导；mails.dev 上线

- [ ] 3.1 CLI setup 本地 API 服务器
  - `src/cli/setup-server.ts` — Bun.serve + CORS
  - `src/cli/commands/setup.ts` — 启动服务器 + 打开浏览器

- [ ] 3.2 mails.dev 仓库初始化
  - ~/Codes/mails.dev 项目结构
  - Landing page
  - Setup 页面（React + Tailwind，参考 shipkey）

- [ ] 3.3 DNS 配置集成
  - Cloudflare API 读写 DNS 记录
  - MX, SPF, DKIM, DMARC 一键配置

### Phase 4：多租户云服务 (xxx@mails.dev)

目标：Agent 用 x402 付费使用 mails.dev 邮箱

- [ ] 4.1 mails.dev Email Worker（多租户）
  - 接收 *@mails.dev 邮件
  - 按 to 地址分发到对应租户存储

- [ ] 4.2 Cloud API
  - Hono + x402 中间件
  - `POST /v1/send` — 付费发邮件
  - `GET /v1/inbox` — 查询收件箱
  - `GET /v1/code` — 等待验证码

- [ ] 4.3 部署
  - api.mails.dev — Cloud API
  - mails.dev — Landing + Setup

## 接口设计

### SendProvider Interface

```typescript
interface SendProvider {
  name: string
  send(options: {
    from: string        // "Name <user@domain.com>"
    to: string[]
    subject: string
    text?: string
    html?: string
    replyTo?: string
  }): Promise<{ id: string; provider: string }>
}
```

### StorageProvider Interface

```typescript
interface StorageProvider {
  name: string
  init(): Promise<void>
  saveEmail(email: Email): Promise<void>
  getEmails(mailbox: string, options?: {
    limit?: number
    offset?: number
    direction?: 'inbound' | 'outbound'
  }): Promise<Email[]>
  getEmail(id: string): Promise<Email | null>
  getCode(mailbox: string, options?: {
    timeout?: number
    since?: string
  }): Promise<{ code: string; from: string; subject: string } | null>
}
```

### Email Type

```typescript
interface Email {
  id: string
  mailbox: string
  from_address: string
  from_name: string
  to_address: string
  subject: string
  body_text: string
  body_html: string
  code: string | null
  headers: Record<string, string>
  metadata: Record<string, unknown>
  direction: 'inbound' | 'outbound'
  status: 'received' | 'sent' | 'failed' | 'queued'
  received_at: string
  created_at: string
}
```

### CLI 命令

```bash
# 配置向导
mails setup                     # 启动本地 API → 打开 mails.dev/setup

# 配置
mails config                    # 显示当前配置
mails config set resend_api_key sk-xxx
mails config get domain

# 发邮件
mails send --to user@example.com --subject "Hello" --body "World"
mails send --to user@example.com --subject "Hello" --html "<h1>World</h1>"
mails send --from "Bot <bot@mydomain.com>" --to user@example.com ...

# 收邮件
mails inbox                     # 列出最近邮件
mails inbox --mailbox bot@mydomain.com
mails inbox <id>                # 查看详情
mails code --to bot@mydomain.com --timeout 30   # 等待验证码

# Worker（自建用户）
mails worker deploy             # 部署 Cloudflare Worker
mails worker dev                # 本地开发 Worker
```

### 配置文件 (~/.mails/config.json)

```json
{
  "mode": "hosted",
  "domain": "mails.dev",
  "mailbox": "myagent@mails.dev",
  "send_provider": "resend",
  "storage_provider": "sqlite",
  "resend_api_key": "re_xxx",
  "db9_token": "xxx",
  "db9_database_id": "t-xxx",
  "cloudflare_api_token": "xxx",
  "cloudflare_zone_id": "xxx",
  "default_from": "Agent <myagent@mails.dev>"
}
```

自建模式：
```json
{
  "mode": "selfhosted",
  "domain": "mydomain.com",
  "mailbox": "agent@mydomain.com",
  "worker_url": "https://mail-worker.mydomain.com",
  "send_provider": "resend",
  "storage_provider": "db9",
  ...
}
```

## 技术栈

| 组件 | 技术 |
|------|------|
| CLI 运行时 | Bun |
| CLI 打包 | `bun build --compile` |
| HTTP 框架 | Hono |
| 本地数据库 | better-sqlite3 |
| Email Worker | Cloudflare Workers + D1 |
| 云服务支付 | x402 (USDC on Base) |
| Setup 页面 | React + Tailwind（mails.dev 仓库） |
| Landing Page | React + Tailwind（mails.dev 仓库） |
| 类型检查 | TypeScript |

## 硬约束

1. **包名 `mails`** — 不加 scope
2. **CLI 用 Bun 打包** — 单二进制文件
3. **双仓库** — mails（开源）+ mails.dev（闭源）
4. **skill.md 代替 dashboard** — Agent 通过 skill.md 自接入
5. **多租户** — mails.dev 云服务支持多用户 (xxx@mails.dev)
6. **db9 schema 兼容** — SQLite 和 db9 用兼容的表结构
7. **x402 仅云服务** — CLI 本身不需要支付
8. **Setup 走 shipkey 模式** — CLI 本地 API + mails.dev/setup 页面

## 执行顺序

Phase 1 先行，发布 npm，让 agent 能用。Phase 2-4 迭代推进。

---

**请审阅此计划，在需要修改的地方加批注。**
