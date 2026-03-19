# 高级查询 API（mails.dev 托管服务）

状态：已实现

## 概述

mails.dev 托管服务基于 DB9（PostgreSQL）提供高级邮件查询能力，超越基础的关键词搜索。

这些能力通过 `GET /v1/inbox` 的查询参数暴露，CLI 端通过 `mails inbox` 命令的 flags 使用。所有参数可自由组合。

## API 参数

### GET /v1/inbox

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `query` | string | FTS 全文搜索（权重：subject > from > body > 附件文本） | `query=password reset` |
| `direction` | string | 方向过滤 | `direction=inbound` |
| `has_attachments` | bool | 只返回有附件的邮件 | `has_attachments=true` |
| `attachment_type` | string | 按附件文件类型过滤（匹配文件名） | `attachment_type=pdf` |
| `from` | string | 按发件人地址模糊匹配 | `from=github.com` |
| `since` | string | 起始时间（ISO 8601） | `since=2026-03-01` |
| `until` | string | 截止时间（ISO 8601） | `until=2026-03-20` |
| `header` | string | 按邮件头 JSONB 字段匹配（`Key:value` 格式） | `header=X-Mailer:sendgrid` |
| `limit` | number | 返回数量上限（默认 20，最大 100） | `limit=50` |
| `offset` | number | 分页偏移 | `offset=20` |

### GET /v1/stats/senders

按发件人聚合统计，返回频率最高的前 50 个发件人。

```json
{
  "senders": [
    { "from_address": "noreply@github.com", "count": 42 },
    { "from_address": "notifications@slack.com", "count": 17 }
  ]
}
```

## CLI 用法

### 基础搜索

```bash
# FTS 全文搜索（按相关性排序）
mails inbox --query "password reset"

# 搜索附件内容（PDF 提取的文字等）
mails inbox --query "quarterly report"
```

### 附件过滤

```bash
# 只看有附件的邮件
mails inbox --has-attachments

# 按附件类型过滤
mails inbox --attachment-type pdf
mails inbox --attachment-type csv

# 组合：搜索带 PDF 附件且包含 "invoice" 的邮件
mails inbox --query "invoice" --attachment-type pdf
```

### 发件人过滤

```bash
# 按发件人过滤
mails inbox --from github.com
mails inbox --from "noreply@stripe.com"
```

### 时间范围

```bash
# 最近 7 天
mails inbox --since 2026-03-13

# 指定区间
mails inbox --since 2026-03-01 --until 2026-03-20

# 组合：上周来自 GitHub 的带附件邮件
mails inbox --from github.com --has-attachments --since 2026-03-13
```

### 邮件头查询

```bash
# 按自定义邮件头过滤（JSONB 查询）
mails inbox --header "X-Mailer:sendgrid"
mails inbox --header "List-Unsubscribe:example.com"
```

### 发件人统计

```bash
# 查看发件人频率排行
mails stats senders
```

### 组合查询示例

```bash
# 来自 GitHub、带附件、最近 7 天、搜索 "deploy"
mails inbox --from github.com --has-attachments --since 2026-03-13 --query "deploy"

# 所有 inbound 的 PDF 附件邮件
mails inbox --direction inbound --attachment-type pdf

# 搜索验证码邮件
mails inbox --query "verification code" --since 2026-03-19
```

## FTS 搜索权重

全文搜索使用 PostgreSQL `websearch_to_tsquery` + 四级权重：

| 权重 | 字段 | 说明 |
|------|------|------|
| A（最高） | `subject` | 邮件主题 |
| B | `from_name` | 发件人名称 |
| C | `body_text` | 邮件正文 |
| D（最低） | `attachment_search_text` | 附件提取的文本内容 |

搜索结果按 `ts_rank` 相关性排序，同分按 `received_at DESC`。

支持 PostgreSQL websearch 语法：
- `"exact phrase"` — 精确短语
- `word1 word2` — AND（同时包含）
- `word1 OR word2` — OR
- `-word` — 排除

## 回退行为

当 DB9 不可用时，查询自动回退到 D1（Cloudflare SQLite）：
- FTS 降级为 `LIKE` 模糊匹配
- 高级过滤参数不可用
- 排序固定为 `received_at DESC`

## 对 StorageProvider 接口的影响

Remote provider（`src/providers/storage/remote.ts`）已支持将这些参数透传给 Worker API。CLI 使用 `storage_provider = 'remote'`（hosted 模式默认值）时自动生效。

DB9 provider（`src/providers/storage/db9.ts`）的 `searchEmails` 和 `getEmails` 已实现等价的本地 SQL 查询。

SQLite provider 不受影响——高级过滤参数仅在 remote/db9 模式下生效。

## 实现位置

| 组件 | 文件 |
|------|------|
| Worker API 路由 | `worker/src/index.ts`, `worker/src/routes.ts` |
| DB9 查询引擎 | `worker/src/db9.ts` |
| DB9 Schema | `worker/db9-schema.sql` |
| E2E 测试 | `worker/test-db9.ts`（65 assertions） |
