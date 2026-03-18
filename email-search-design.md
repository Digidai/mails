# 邮件搜索设计

状态：评审后已批准实现

## 范围

本文档定义了 `mails` 仓库中的第一个内建邮件搜索功能。

目标是在不改变当前发送/接收模型的前提下，为 CLI 和 SDK 增加按邮箱范围限定的搜索能力。

本文档覆盖：

- 对外 API 设计
- CLI 命令形态
- 基于 DB9 的实现策略
- SQLite 回退策略
- 测试计划与伪代码

本文档不覆盖：

- 语义搜索
- embeddings
- 向量索引
- 重排序或基于 LLM 的检索

## 为什么不是向量搜索

DB9 支持向量搜索，但这不是这个功能当前应该使用的基础能力。

邮箱搜索需要：

- 精确的邮箱范围限定
- 可预测的关键词匹配
- 支持地址、验证码和带引号短语
- 透明的排序规则

只有在我们先明确为邮件内容存储 embedding 之后，向量搜索才有意义。

对于 v1，搜索应当是：

- 针对精确字段的结构化 SQL 过滤
- DB9 上针对自由文本内容的 PostgreSQL 全文搜索
- SQLite 上大小写不敏感的回退匹配

## 使用的 DB9 能力

这个设计基于 DB9 的公开文档以及 `skill.md`。

DB9 已明确文档化、并在这里会被使用的能力包括：

- 完整 PostgreSQL
- 全文搜索
- `tsvector` / `tsquery`
- `websearch_to_tsquery`
- 使用 `ts_rank` 排序
- 高亮
- GIN 索引
- JSONB

参考资料：

- `https://db9.ai/`
- `https://db9.ai/skill.md`

## 面向用户的行为

这个功能会挂在现有的 inbox 命令下，而不是新增一个顶层命令。

示例：

```bash
mails inbox --query "reset password"
mails inbox --query "noreply@github.com"
mails inbox --query "123456"
mails inbox --mailbox agent@example.com --query "invoice" --limit 10
mails inbox --query "\"build failed\" OR deploy" --direction inbound
```

行为规则：

- 搜索始终限定在单个邮箱内
- `--query` 会把 `mails inbox` 从列表模式切换到搜索模式
- 搜索模式下 `--direction` 仍然生效
- 搜索模式下 `--limit` 仍然生效
- 如果没有传 `--query`，当前 inbox 行为保持不变

## API 设计

### 核心类型

```ts
export interface EmailQueryOptions {
  limit?: number
  offset?: number
  direction?: 'inbound' | 'outbound'
}

export interface EmailSearchOptions extends EmailQueryOptions {
  query: string
}
```

### 存储提供者契约

```ts
export interface StorageProvider {
  name: string
  init(): Promise<void>
  saveEmail(email: Email): Promise<void>
  getEmails(mailbox: string, options?: EmailQueryOptions): Promise<Email[]>
  searchEmails(mailbox: string, options: EmailSearchOptions): Promise<Email[]>
  getEmail(id: string): Promise<Email | null>
  getCode(mailbox: string, options?: { timeout?: number; since?: string }): Promise<{ code: string; from: string; subject: string } | null>
}
```

### 核心接收 API

```ts
export async function searchInbox(
  mailbox: string,
  options: EmailSearchOptions,
): Promise<Email[]>
```

### SDK 导出

```ts
export { searchInbox } from './core/receive.js'
```

## CLI 设计

CLI 仍然保持在 `mails inbox` 下。

### 语法

```bash
mails inbox --query <text> [--mailbox <address>] [--direction inbound|outbound] [--limit <n>]
```

### 解析规则

- `mails inbox <id>` 继续表示“查看单封邮件”
- `mails inbox --query ...` 表示搜索列表模式
- 不带 `--query` 的 `mails inbox` 表示当前的列表模式
- `--direction` 在列表模式和搜索模式下都可选

### 输出

搜索结果沿用当前 inbox 列表格式。

无结果时的行为：

```text
No emails found for query: <query>
```

## 搜索语义

查询字符串是用户输入的一整段搜索表达式。

v1 中参与搜索的字段：

- `subject`
- `body_text`
- `body_html`
- `from_name`
- `from_address`
- `to_address`
- `code`

v1 中的结构化过滤条件：

- `mailbox`
- `direction`
- `limit`
- `offset`

排序规则：

- DB9 搜索模式：先按相关性，再按 `received_at DESC`
- SQLite 回退模式：按 `received_at DESC`

## DB9 实现

### 高层策略

DB9 搜索应当使用混合查询：

1. 对邮箱和方向做硬过滤
2. 对自然语言文本做全文搜索
3. 对地址和类似验证码的 token 做子串回退匹配
4. 对全文命中的结果做相关性排序

这样既避免引入向量搜索，也能利用 DB9 的全文搜索支持。

### 索引方案

保留现有索引：

```sql
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
```

新增一个 GIN 全文索引：

```sql
CREATE INDEX IF NOT EXISTS idx_emails_search_fts
ON emails
USING GIN (
  setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(body_html, '')), 'D')
);
```

原因：

- `subject` 的权重应该最高
- `from_name` 有价值，但优先级应低于 subject
- `body_text` 和 `body_html` 有用，但不应压过 subject 命中
- 邮件地址和验证码更适合用显式的子串谓词处理

### 查询形态

搜索查询应当使用 `websearch_to_tsquery('simple', ...)` 构建。

这样可以获得：

- 带引号短语支持
- `or`
- `-term` 排除
- 更自然的 CLI 搜索语法

计划中的 SQL 形态：

```sql
WITH ranked AS (
  SELECT
    *,
    ts_rank(
      setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(body_html, '')), 'D'),
      websearch_to_tsquery('simple', $query)
    ) AS rank
  FROM emails
  WHERE mailbox = $mailbox
    AND ($direction IS NULL OR direction = $direction)
    AND (
      (
        setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(from_name, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(body_text, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(body_html, '')), 'D')
      ) @@ websearch_to_tsquery('simple', $query)
      OR from_address ILIKE $pattern
      OR to_address ILIKE $pattern
      OR code ILIKE $pattern
    )
)
SELECT *
FROM ranked
ORDER BY rank DESC, received_at DESC
LIMIT $limit OFFSET $offset;
```

### 为什么是混合方案，而不是纯 FTS

纯 FTS 并不适合处理：

- 邮件地址
- 较短的数字验证码
- 含大量标点的 token

所以 v1 会有意组合：

- 用 FTS 处理自然语言文本
- 用 `ILIKE` 回退处理地址/验证码查找

## SQLite 实现

SQLite 是本地开发和测试时的回退实现。

SQLite v1 暂时不引入 FTS5。

相反，它应当在同一批字段上使用确定性的、大小写不敏感的 `LIKE` 搜索：

```sql
WHERE mailbox = ?
  AND (?direction IS NULL OR direction = ?)
  AND (
    subject LIKE ? COLLATE NOCASE
    OR body_text LIKE ? COLLATE NOCASE
    OR body_html LIKE ? COLLATE NOCASE
    OR from_address LIKE ? COLLATE NOCASE
    OR from_name LIKE ? COLLATE NOCASE
    OR to_address LIKE ? COLLATE NOCASE
    OR code LIKE ? COLLATE NOCASE
  )
ORDER BY received_at DESC
LIMIT ? OFFSET ?
```

原因：

- 迁移路径更简单
- 便于本地测试
- 行为更容易理解
- 暂时避免维护两套不同的本地 schema

## 迁移影响

DB9 schema 需要新增一个搜索索引。

SQLite schema 在 v1 不需要迁移。

现有的用户命令不会被移除或重命名。

## 测试计划

### 1. SQLite Provider 单元测试

目标：

- 验证大小写不敏感搜索
- 验证 subject/body/from/code 匹配
- 验证邮箱范围限定
- 验证 direction 过滤
- 验证排序和 limit 行为

伪代码：

```ts
test('searchEmails matches subject/body/from/code in sqlite', async () => {
  const provider = createSqliteProvider(TEST_DB)
  await provider.init()

  await provider.saveEmail(email({ id: 'a', subject: 'Reset password', from_name: 'Security Team', body_text: 'Use code 654321' }))
  await provider.saveEmail(email({ id: 'b', subject: 'Weekly digest', from_address: 'digest@example.com' }))

  expect(await provider.searchEmails('agent@test.com', { query: 'security' })).toEqual([emailA])
  expect(await provider.searchEmails('agent@test.com', { query: '654321' })).toEqual([emailA])
  expect(await provider.searchEmails('agent@test.com', { query: 'digest@example.com' })).toEqual([emailB])
})
```

### 2. DB9 Provider 单元测试

目标：

- 验证生成的 SQL 使用了 DB9 全文搜索原语
- 验证生成的 SQL 仍然包含子串回退逻辑
- 验证单引号已被转义
- 验证包含 direction 过滤

伪代码：

```ts
test('searchEmails builds DB9 FTS query', async () => {
  mockFetchCaptureQuery()

  await provider.searchEmails('agent@test.com', {
    query: '"reset password" OR 654321',
    direction: 'inbound',
    limit: 5,
  })

  expect(sql).toContain("websearch_to_tsquery('simple'")
  expect(sql).toContain("to_tsvector('simple'")
  expect(sql).toContain("from_address ILIKE")
  expect(sql).toContain("code ILIKE")
  expect(sql).toContain("direction = 'inbound'")
})
```

### 3. Core Receive 测试

目标：

- 验证 `searchInbox()` 会委托给 `getStorage().searchEmails()`

伪代码：

```ts
test('searchInbox delegates to storage.searchEmails', async () => {
  mock.module('../../src/core/storage.js', () => ({
    getStorage: async () => ({ searchEmails: async () => [emailA] }),
  }))

  const { searchInbox } = await importFresh('../../src/core/receive.ts')
  expect(await searchInbox('agent@test.com', { query: 'reset' })).toEqual([emailA])
})
```

### 4. CLI Inbox Command 测试

目标：

- 验证存在 `--query` 时会走搜索模式
- 验证无 `--query` 时仍走列表模式
- 验证搜索模式下的无结果提示会变化
- 验证 `--direction` 会被透传

伪代码：

```ts
test('inboxCommand uses searchInbox when --query is present', async () => {
  mock.module('../../src/core/receive.js', () => ({
    getInbox: async () => [],
    searchInbox: async () => [emailA],
    getEmail: async () => null,
  }))

  await inboxCommand(['--mailbox', 'agent@test.com', '--query', 'reset', '--direction', 'inbound'])

  expect(searchInboxSpy).toHaveBeenCalledWith('agent@test.com', {
    query: 'reset',
    direction: 'inbound',
    limit: 20,
  })
})
```

### 5. SDK 导出测试

目标：

- 验证顶层 `src/index.ts` 导出了 `searchInbox`

伪代码：

```ts
test('index exports searchInbox', async () => {
  const mod = await import('../../src/index.ts')
  expect(typeof mod.searchInbox).toBe('function')
})
```

### 6. 与搜索功能一起补的覆盖率工作

当前仓库报告的 `100%`，只覆盖了现有 coverage 命令实际加载到的那部分文件。

搜索功能应当配套补上测试，把这些文件真正拉进 coverage：

- `src/cli/index.ts`
- `src/cli/commands/send.ts`
- `src/cli/commands/config.ts`
- `src/cli/commands/code.ts`
- `src/cli/commands/inbox.ts`
- `src/cli/commands/claim.ts`
- `src/core/receive.ts`
- `src/core/storage.ts`
- `src/index.ts`

现有说明：

- `test/e2e/claim-flow.test.ts` 已存在，后续覆盖率策略应考虑进去
- 它目前没有被 `package.json` 的 `test` 或 `test:coverage` 包含

## 实现顺序

1. 在 `src/core/types.ts` 中定稿 provider contract
2. 在 `src/core/receive.ts` 中增加 `searchInbox()`
3. 从 `src/index.ts` 导出 `searchInbox()`
4. 实现 SQLite 回退搜索
5. 实现 DB9 混合全文搜索
6. 更新 `mails inbox` 的 CLI 解析和帮助文本
7. 补上 provider/core/CLI/export 路径的单元测试
8. 在命令级测试就位后，再决定是否扩展 coverage 脚本

## v1 明确不做的事情

- embeddings
- pgvector 使用
- 语义相似度搜索
- 基于 LLM 的模糊排序
- 跨邮箱的全局搜索
- 服务端保存的搜索预设

## 未来扩展路径

如果未来真的需要语义化的邮件检索，应当单独做成一个功能，并有自己独立的设计：

1. 定义 embedding 模型和维度
2. 为每封邮件或每个 chunk 存储 embedding
3. 回填历史邮件
4. 增加向量索引
5. 增加独立的语义搜索 API，而不是把它和关键词搜索混在一起
