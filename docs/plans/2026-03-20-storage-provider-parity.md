# Storage Provider Parity Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring sqlite and db9 storage providers to feature parity with the Worker schema, including attachment support, outbound recording, and search safety.

**Architecture:** Upgrade sqlite/db9 schemas to match worker/schema.sql (add attachment columns + attachments table). Update saveEmail() to persist attachments. Add getAttachment() stubs that return from local storage. Fix sqlite search escaping. Record outbound emails after send.

**Tech Stack:** Bun, SQLite (bun:sqlite), PostgreSQL via db9.ai REST API, bun:test

---

## Task 1: sqlite schema upgrade + attachment columns

**Files:**
- Modify: `src/providers/storage/sqlite.ts`
- Test: `test/unit/sqlite.test.ts`

**Step 1: Write failing test — saveEmail with attachments persists attachment metadata**

Add to `test/unit/sqlite.test.ts`:

```typescript
test('saveEmail persists attachment metadata', async () => {
  await provider.saveEmail({
    id: 'att-email-1',
    mailbox: 'test@test.com',
    from_address: 'a@b.com',
    from_name: '',
    to_address: 'test@test.com',
    subject: 'With attachment',
    body_text: 'see attached',
    body_html: '',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    has_attachments: true,
    attachment_count: 1,
    attachment_names: 'report.pdf',
    attachments: [{
      id: 'a1',
      email_id: 'att-email-1',
      filename: 'report.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
      content_disposition: 'attachment',
      content_id: null,
      mime_part_index: 0,
      text_content: '',
      text_extraction_status: 'unsupported',
      storage_key: null,
      created_at: new Date().toISOString(),
    }],
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  })

  const email = await provider.getEmail('att-email-1')
  expect(email!.has_attachments).toBe(true)
  expect(email!.attachment_count).toBe(1)
  expect(email!.attachments).toHaveLength(1)
  expect(email!.attachments![0]!.filename).toBe('report.pdf')
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/unit/sqlite.test.ts`
Expected: FAIL — `has_attachments` undefined, `attachments` undefined

**Step 3: Upgrade sqlite schema and implementation**

In `sqlite.ts`, update `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  to_address TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  body_html TEXT DEFAULT '',
  code TEXT,
  headers TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  message_id TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  content_disposition TEXT,
  content_id TEXT,
  mime_part_index INTEGER NOT NULL,
  text_content TEXT DEFAULT '',
  text_extraction_status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
```

Update `saveEmail()` to:
- INSERT the 20 columns (including message_id, has_attachments, attachment_count, attachment_names, attachment_search_text)
- After inserting the email, INSERT each attachment in `email.attachments` into the `attachments` table

Update `getEmail()` to:
- After fetching the email row, query `SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC`
- Map attachment rows and attach to the returned Email object

Update `getEmails()` to:
- SELECT should include `has_attachments, attachment_count` columns

Update `rowToEmail()` to:
- Map `message_id`, `has_attachments` (as Boolean), `attachment_count`, `attachment_names`, `attachment_search_text`

**Step 4: Run test to verify it passes**

Run: `bun test test/unit/sqlite.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(sqlite): upgrade schema with attachments table and metadata columns
```

---

## Task 2: db9 schema upgrade + attachment columns

**Files:**
- Modify: `src/providers/storage/db9.ts`
- Test: `test/unit/db9.test.ts`

**Step 1: Write failing test — saveEmail with attachments**

Add to `test/unit/db9.test.ts` (same shape as sqlite test, but verifying the SQL sent to db9 API contains INSERT INTO attachments).

**Step 2: Run test to verify it fails**

**Step 3: Upgrade db9 schema and implementation**

Identical structural changes to Task 1 but in PostgreSQL syntax:
- `SCHEMA`: add same columns to emails table, add attachments table with PostgreSQL types (TEXT, INTEGER, TIMESTAMPTZ)
- `EMAIL_COLUMNS`: add `message_id, has_attachments, attachment_count, attachment_names, attachment_search_text`
- `saveEmail()`: after email INSERT, loop `email.attachments` and INSERT into attachments table
- `getEmail()`: after fetching email, do a second sql() call to get attachments, attach to returned Email
- `getEmails()`: include `has_attachments, attachment_count` in SELECT
- `rowsToEmails()`: map the new columns including `has_attachments` as Boolean

**Step 4: Run test to verify it passes**

Run: `bun test test/unit/db9.test.ts`

**Step 5: Commit**

```
feat(db9): upgrade schema with attachments table and metadata columns
```

---

## Task 3: sqlite getAttachment() — return attachment content from text_content

**Files:**
- Modify: `src/providers/storage/sqlite.ts`
- Test: `test/unit/sqlite.test.ts`

**Step 1: Write failing test**

```typescript
test('getAttachment returns text attachment content', async () => {
  // First save an email with a text attachment
  await provider.saveEmail({
    id: 'dl-email',
    // ... standard fields ...
    attachments: [{
      id: 'dl-att-1',
      email_id: 'dl-email',
      filename: 'data.csv',
      content_type: 'text/csv',
      size_bytes: 20,
      content_disposition: 'attachment',
      content_id: null,
      mime_part_index: 0,
      text_content: 'col1,col2\nval1,val2',
      text_extraction_status: 'done',
      storage_key: null,
      created_at: new Date().toISOString(),
    }],
    // ...
  })

  const result = await provider.getAttachment!('dl-att-1')
  expect(result).not.toBeNull()
  expect(result!.filename).toBe('data.csv')
  expect(result!.contentType).toBe('text/csv')
  expect(new TextDecoder().decode(result!.data)).toBe('col1,col2\nval1,val2')
})

test('getAttachment returns null for non-text attachment', async () => {
  // Save email with binary attachment (text_extraction_status: 'unsupported')
  // ...
  const result = await provider.getAttachment!('binary-att')
  expect(result).toBeNull()
})
```

**Step 2: Run to verify fails**

**Step 3: Implement getAttachment in sqlite**

```typescript
async getAttachment(id) {
  const row = db.prepare(
    'SELECT filename, content_type, text_content, text_extraction_status FROM attachments WHERE id = ?'
  ).get(id) as { filename: string; content_type: string; text_content: string; text_extraction_status: string } | null
  if (!row || row.text_extraction_status !== 'done' || !row.text_content) return null
  return {
    data: new TextEncoder().encode(row.text_content).buffer as ArrayBuffer,
    filename: row.filename,
    contentType: row.content_type,
  }
},
```

Note: sqlite/db9 can only serve text attachments from `text_content`. Binary attachment download requires object storage (R2), which only the Worker has. This is an acceptable limitation — document it.

**Step 4: Run test, verify pass**

**Step 5: Commit**

```
feat(sqlite): implement getAttachment for text-extractable attachments
```

---

## Task 4: db9 getAttachment() — same approach

**Files:**
- Modify: `src/providers/storage/db9.ts`
- Test: `test/unit/db9.test.ts`

Same pattern as Task 3 but using db9 SQL API. Query `SELECT filename, content_type, text_content, text_extraction_status FROM attachments WHERE id = '...'`.

**Commit:**
```
feat(db9): implement getAttachment for text-extractable attachments
```

---

## Task 5: Fix sqlite searchEmails wildcard escaping

**Files:**
- Modify: `src/providers/storage/sqlite.ts`
- Test: `test/unit/sqlite.test.ts`

**Step 1: Write failing test**

```typescript
test('searchEmails escapes LIKE wildcards in query', async () => {
  await provider.saveEmail({
    id: 'wild-1',
    mailbox: 'test@x.com',
    subject: 'discount 100% off',
    // ...
  })
  await provider.saveEmail({
    id: 'wild-2',
    mailbox: 'test@x.com',
    subject: 'something else',
    // ...
  })

  const results = await provider.searchEmails('test@x.com', { query: '100%' })
  // Should match only wild-1, not wild-2 (% should not act as wildcard)
  expect(results).toHaveLength(1)
  expect(results[0]!.id).toBe('wild-1')
})
```

**Step 2: Run to verify it fails** (currently `100%` becomes `%100%%` which matches everything)

**Step 3: Fix — add escaping**

```typescript
// Before building pattern:
const escaped = options.query.replace(/%/g, '\\%').replace(/_/g, '\\_')
const pattern = `%${escaped}%`
// Add ESCAPE '\\' to each LIKE clause
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```
fix(sqlite): escape % and _ in search queries to prevent wildcard injection
```

---

## Task 6: Record outbound emails after send

**Files:**
- Modify: `src/core/send.ts`
- Test: `test/unit/send.test.ts`
- Test: `test/e2e/flow.test.ts`

**Step 1: Write failing test**

In `test/e2e/flow.test.ts`, add after the existing send test:

```typescript
test('send records outbound email in storage', async () => {
  // After sending, verify the email appears in provider.getEmails with direction: 'outbound'
  const outbound = await provider.getEmails('inbox@e2e.test', { direction: 'outbound' })
  // Should have at least 1 outbound (from earlier test)
  expect(outbound.length).toBeGreaterThanOrEqual(1)
})
```

**Step 2: Run to verify it fails** (send currently doesn't call saveEmail)

**Step 3: Implement**

In `send.ts`, after `provider.send()` returns successfully, call `getStorage().saveEmail()` to persist the outbound record. Wrap in try/catch so storage failure doesn't break the send flow. Skip for remote provider (Worker records its own outbound).

```typescript
export async function send(options: SendOptions): Promise<SendResult> {
  // ... existing code ...
  const result = await provider.send({ ... })

  // Record outbound email in local storage (best-effort)
  try {
    const storage = await getStorage()
    if (storage.name !== 'remote') {
      await storage.saveEmail({
        id: result.id,
        mailbox: from,
        from_address: from,
        from_name: '',
        to_address: to.join(', '),
        subject: options.subject,
        body_text: options.text ?? '',
        body_html: options.html ?? '',
        code: null,
        headers: options.headers ?? {},
        metadata: { provider: result.provider },
        direction: 'outbound',
        status: 'sent',
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    }
  } catch {}

  return result
}
```

**Step 4: Run tests**

Run: `bun test test/unit/send.test.ts test/e2e/flow.test.ts`

**Step 5: Commit**

```
feat(send): record outbound emails in local storage after successful send
```

---

## Task 7: Align Attachment type with mails.dev API response

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/cli/commands/inbox.ts`
- Test: `test/unit/cli.test.ts`

**Step 1: Write failing test — inbox detail handles both size and size_bytes**

**Step 2: Normalize in types**

Add `size` as optional alias in `Attachment` type:

```typescript
export interface Attachment {
  // ... existing fields ...
  size_bytes: number | null
  size?: number | null  // mails.dev compat alias
  // ...
}
```

**Step 3: Fix inbox.ts to use a clean getter**

Replace the cast hack:
```typescript
const size = attachment.size_bytes ?? attachment.size ?? 0
```

**Step 4: Run tests**

**Step 5: Commit**

```
fix(types): add size alias to Attachment for mails.dev API compatibility
```

---

## Task 8: Add message_id column to sqlite and db9

**Files:**
- Modify: `src/providers/storage/sqlite.ts` (already done in Task 1 as part of schema upgrade)
- Modify: `src/providers/storage/db9.ts` (already done in Task 2 as part of schema upgrade)

This is covered by Tasks 1 and 2. `message_id` is included in the schema upgrades. `saveEmail()` and `rowToEmail()` both map it. No separate task needed.

---

## Task 9: E2E tests — full flow with attachments on sqlite

**Files:**
- Modify: `test/e2e/flow.test.ts`

Add tests to the existing e2e flow:

```typescript
test('N. save and retrieve email with attachments', async () => {
  await provider.saveEmail({
    id: 'att-flow-1',
    mailbox: 'inbox@e2e.test',
    // ... with attachments array ...
    has_attachments: true,
    attachment_count: 2,
  })

  const emails = await provider.getEmails('inbox@e2e.test')
  const match = emails.find(e => e.id === 'att-flow-1')
  expect(match!.has_attachments).toBe(true)
  expect(match!.attachment_count).toBe(2)

  const detail = await provider.getEmail('att-flow-1')
  expect(detail!.attachments).toHaveLength(2)
})

test('N+1. getAttachment returns text attachment content', async () => {
  const result = await provider.getAttachment!('csv-att-id')
  expect(result).not.toBeNull()
  expect(result!.filename).toBe('data.csv')
})

test('N+2. outbound email recorded after send', async () => {
  // verify outbound emails appear in getEmails
})
```

**Commit:**
```
test(e2e): add attachment and outbound recording flow tests
```

---

## Task 10: E2E test — db9 search with attachment fields

**Files:**
- Modify: `test/e2e/db9-search.test.ts`

Add test that verifies:
- Emails saved with `has_attachments: true` return the flag in getEmails()
- getEmail() returns attachment metadata from the attachments table
- searchEmails includes `attachment_search_text` in results (verify via attachment_names)

This test hits the real db9 API (skip if no credentials).

**Commit:**
```
test(e2e): add db9 attachment metadata and search tests
```

---

## Execution Order

```
Task 1 (sqlite schema)  ──► Task 3 (sqlite getAttachment) ──► Task 5 (sqlite search fix)
Task 2 (db9 schema)     ──► Task 4 (db9 getAttachment)
Task 6 (outbound recording)
Task 7 (Attachment type fix)
Task 9 (sqlite e2e)
Task 10 (db9 e2e)
```

Tasks 1-2 are independent and can be parallelized.
Tasks 3-4 depend on 1-2 respectively.
Tasks 5-7 are independent of each other.
Tasks 9-10 are final integration tests.

---

## Out of Scope (documented limitations)

1. **Binary attachment download for sqlite/db9** — only text-extractable attachments can be served. Binary download requires object storage (R2/S3), which only the Worker has. Document this in error messages.
2. **OSS Worker `/api/attachment` endpoint** — separate PR to the Worker, not part of this plan.
3. **Outbound attachment recording** — `send()` records the email metadata but not attachment binaries in local storage.
