# mails

面向 AI Agent 的邮件基础设施。通过编程方式收发邮件。

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[English](https://github.com/chekusu/mails/blob/main/README.md) | [日本語](https://github.com/chekusu/mails/blob/main/README.ja.md)

## 工作原理

```
                           发送                                       接收

  Agent                                              外部发件人
    |                                                  |
    |  mails send --to user@example.com                |  发送邮件到 agent@mails.dev
    |                                                  |
    v                                                  v
+--------+         +----------+              +-------------------+
|  CLI   |-------->|  Resend  |---> SMTP --->| Cloudflare Email  |
|  /SDK  |         |   API    |              |     Routing       |
+--------+         +----------+              +-------------------+
    |                                                  |
    |  或 POST /v1/send（托管模式）                      |  email() handler
    |                                                  v
    v                                          +-------------+
+-------------------+                          |   Worker    |
| mails.dev 云服务   |                          | (自部署)     |
| (每月 100 封免费)  |                          +-------------+
+-------------------+                                  |
                                                       |  存储
                                                       v
                                  +--------------------------------------+
                                  |           存储 Provider               |
                                  |                                      |
                                  |  D1 (Worker)  /  SQLite  /  db9.ai  |
                                  +--------------------------------------+
                                                       |
                                              通过 CLI/SDK 查询
                                                       |
                                                       v
                                                    Agent
                                              mails inbox
                                              mails inbox --query "验证码"
                                              mails code --to agent@mails.dev
```

## 特性

- **发送邮件** — 通过 Resend，支持附件
- **接收邮件** — 通过 Cloudflare Email Routing Worker
- **搜索收件箱** — 按关键词搜索主题、正文、发件人、验证码
- **验证码自动提取** — 自动从邮件中提取验证码（支持中/英/日/韩）
- **附件** — CLI `--attach` 或 SDK 发送，Worker 自动解析 MIME 附件
- **存储 Provider** — 本地 SQLite、[db9.ai](https://db9.ai) 云端 PostgreSQL、或远程 Worker API
- **托管服务** — 通过 `mails claim` 免费获取 `@mails.dev` 邮箱
- **自部署** — 部署自己的 Worker，支持可选的 AUTH_TOKEN 鉴权

## 安装

```bash
npm install -g mails
```

## 快速开始

### 托管模式 (mails.dev)

```bash
mails claim myagent                  # 免费认领 myagent@mails.dev
mails send --to user@example.com --subject "Hello" --body "World"  # 每月 100 封免费
mails inbox                          # 查看收件箱
mails inbox --query "密码"            # 搜索邮件
mails code --to myagent@mails.dev    # 等待验证码
```

无需 Resend key — 托管用户每月 100 封免费发件。无限发送请配置自己的 key：`mails config set resend_api_key re_YOUR_KEY`

### 自部署模式

```bash
cd worker && wrangler deploy         # 部署你自己的 Worker
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_TOKEN
mails config set mailbox agent@yourdomain.com
mails inbox                          # 查询你的 Worker API
```

## CLI 参考

```bash
mails claim <name>                           # 认领 @mails.dev 邮箱
mails send --to <email> --subject <s> --body <text>
mails send --to <email> --subject <s> --body <text> --attach file.pdf
mails inbox                                  # 最近邮件列表
mails inbox --query "关键词"                   # 全文搜索（按相关性排序）
mails inbox <id>                             # 查看邮件详情（含附件）
mails code --to <addr> --timeout 30          # 等待验证码
mails config                                 # 查看配置

# 高级过滤（mails.dev 托管 / db9）
mails inbox --has-attachments                # 只看带附件的邮件
mails inbox --attachment-type pdf            # 按附件类型过滤
mails inbox --from github.com               # 按发件人过滤
mails inbox --since 2026-03-01 --until 2026-03-20  # 时间范围
mails inbox --header "X-Mailer:sendgrid"    # 按邮件头过滤

# 任意组合
mails inbox --from github.com --has-attachments --since 2026-03-13
mails inbox --query "部署" --attachment-type log --direction inbound

# 发件人统计
mails stats senders                          # 按发件人频率排行
```

## SDK

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// 发送（支持附件）
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// 搜索收件箱（全文搜索，按相关性排序）
const results = await searchInbox('agent@mails.dev', { query: '密码重置' })

// 高级过滤（mails.dev 托管 / db9）
const pdfs = await getInbox('agent@mails.dev', {
  has_attachments: true,
  attachment_type: 'pdf',
  since: '2026-03-01',
})

// 等待验证码
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
```

## Worker 自部署

部署后可选设置鉴权：`wrangler secret put AUTH_TOKEN`

| 端点 | 说明 |
|------|------|
| `GET /api/inbox?to=<addr>&query=<text>` | 搜索邮件 |
| `GET /api/code?to=<addr>&timeout=30` | 等待验证码 |
| `GET /api/email?id=<id>` | 邮件详情（含附件） |

## 配置项

| 键 | 说明 |
|---|------|
| `mailbox` | 接收邮箱地址 |
| `api_key` | mails.dev 托管服务 API key |
| `worker_url` | 自部署 Worker URL |
| `worker_token` | 自部署 Worker 鉴权 token |
| `resend_api_key` | Resend API 密钥 |
| `default_from` | 默认发件人地址 |
| `storage_provider` | `sqlite`、`db9` 或 `remote`（自动检测） |

## 测试

```bash
bun test              # 单元 + E2E 测试（无需外部依赖）
bun test:coverage     # 附带覆盖率报告
bun test:live         # 实时 E2E 测试（需要 .env 配置）
bun test:all          # 全部测试（包括实时 E2E）
```

168 个单元测试 + 71 个 E2E 测试 = **239 个测试**，覆盖全部 Provider。

### 各 Provider E2E 覆盖情况

|                           | SQLite | db9   | Remote (OSS) | Remote (托管) |
|---------------------------|--------|-------|--------------|---------------|
| 存储 inbound 邮件         | ✅     | ✅    | N/A          | N/A           |
| 存储邮件 + 附件           | ✅     | ✅    | N/A          | N/A           |
| 发送 → 接收（真实链路）    | ✅     | —     | ✅           | ✅            |
| 收件箱列表                | ✅     | ✅    | ✅           | ✅            |
| has_attachments 标记      | ✅     | ✅    | ✅           | ✅            |
| 方向过滤                  | ✅     | ✅    | ✅           | ✅            |
| 分页                      | ✅     | ✅    | ✅           | ✅            |
| 邮件详情                  | ✅     | ✅    | ✅           | ✅            |
| 附件元数据                | ✅     | ✅    | ✅           | ✅            |
| 搜索                      | ✅     | ✅    | ✅           | ✅            |
| 附件内容搜索              | ✅     | ✅    | —            | —             |
| 验证码                    | ✅     | ✅    | ✅           | ✅            |
| 附件下载                  | ✅     | ✅    | —            | ✅            |
| 保存到磁盘 (--save)       | ✅     | —     | —            | ✅            |
| 邮箱隔离                  | ✅     | ✅    | —            | —             |
| Outbound 记录             | ✅     | —     | N/A          | N/A           |

## 许可证

MIT
