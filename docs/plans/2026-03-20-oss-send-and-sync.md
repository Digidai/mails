# OSS Worker Send + CLI Sync — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify self-hosted mode with hosted mode: OSS Worker handles both send and receive, CLI adds sync to download emails to local sqlite.

**Architecture:** Add `POST /api/send` to OSS Worker (Resend + D1 outbound recording). Add `GET /api/sync` for incremental pull. CLI gets a new send provider for OSS mode and a `mails sync` command. All three modes (hosted, self-hosted, standalone) use a consistent send path.

**Tech Stack:** Cloudflare Worker (D1, Resend), Bun, TypeScript, bun:test

---

## Task 1: OSS Worker — add `POST /api/send`

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Write failing test**

In `test/unit/worker.test.ts` (or inline test), verify that the Worker handles POST /api/send:
- Accepts JSON body with `{ from, to, subject, text, html?, reply_to?, attachments? }`
- Calls Resend API with correct payload
- Records outbound email in D1
- Returns `{ id, from }`
- Requires AUTH_TOKEN if configured

**Step 2: Implement POST /api/send handler**

In `worker/src/index.ts`, add route:

```typescript
case '/api/send':
  if (request.method !== 'POST') {
    response = Response.json({ error: 'Method not allowed' }, { status: 405 })
  } else {
    response = await handleSend(request, env)
  }
  break
```

Implement `handleSend`:

```typescript
async function handleSend(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    from: string
    to: string[]
    subject: string
    text?: string
    html?: string
    reply_to?: string
    attachments?: Array<{ filename: string; content: string; content_type?: string }>
  }

  if (!body.from || !body.to?.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }
  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html body is required' }, { status: 400 })
  }
  if (!env.RESEND_API_KEY) {
    return Response.json({ error: 'RESEND_API_KEY not configured on this worker' }, { status: 500 })
  }

  // Send via Resend
  const resendBody: Record<string, unknown> = {
    from: body.from,
    to: body.to,
    subject: body.subject,
  }
  if (body.text) resendBody.text = body.text
  if (body.html) resendBody.html = body.html
  if (body.reply_to) resendBody.reply_to = body.reply_to
  if (body.attachments?.length) {
    resendBody.attachments = body.attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      ...(a.content_type ? { content_type: a.content_type } : {}),
    }))
  }

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendBody),
  })

  const resendData = await resendRes.json() as { id?: string; message?: string }
  if (!resendRes.ok) {
    return Response.json({ error: resendData.message ?? 'Resend error' }, { status: resendRes.status })
  }

  // Record outbound in D1
  const id = resendData.id ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const mailbox = body.from // outbound mailbox = sender address

  await env.DB.prepare(`
    INSERT INTO emails (
      id, mailbox, from_address, from_name, to_address, subject,
      body_text, body_html, code, headers, metadata, message_id,
      has_attachments, attachment_count, attachment_names, attachment_search_text,
      raw_storage_key, direction, status, received_at, created_at
    ) VALUES (?, ?, ?, '', ?, ?, ?, ?, NULL, '{}', '{}', NULL, ?, ?, '', '', NULL, 'outbound', 'sent', ?, ?)
  `).bind(
    id, mailbox, body.from, body.to.join(', '), body.subject,
    body.text ?? '', body.html ?? '',
    body.attachments?.length ? 1 : 0,
    body.attachments?.length ?? 0,
    now, now,
  ).run()

  return Response.json({ id, from: body.from })
}
```

**Step 3: Add RESEND_API_KEY to Env type**

```typescript
export interface Env {
  DB: D1Database
  AUTH_TOKEN?: string
  RESEND_API_KEY?: string  // NEW
}
```

**Step 4: Run tests, commit**

```
feat(worker): add POST /api/send — outbound emails via Resend with D1 recording
```

---

## Task 2: CLI — add OSS send provider

**Files:**
- Create: `src/providers/send/oss.ts`
- Modify: `src/core/send.ts`
- Test: `test/unit/oss-send.test.ts`

**Step 1: Create OSS send provider**

`src/providers/send/oss.ts`:

```typescript
import type { SendProvider, SendResult } from '../../core/types.js'

export function createOSSSendProvider(workerUrl: string, token?: string): SendProvider {
  return {
    name: 'oss',
    async send(options) {
      const body: Record<string, unknown> = {
        from: options.from,
        to: options.to,
        subject: options.subject,
      }
      if (options.text) body.text = options.text
      if (options.html) body.html = options.html
      if (options.replyTo) body.reply_to = options.replyTo
      if (options.attachments?.length) {
        body.attachments = options.attachments.map(a => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        }))
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${workerUrl}/api/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) throw new Error(`OSS send error (${res.status}): ${data.error ?? res.statusText}`)

      return { id: data.id!, provider: 'oss' }
    },
  }
}
```

**Step 2: Update send.ts provider resolution**

In `resolveProvider()`, add OSS mode between hosted and resend:

```typescript
function resolveProvider(): SendProvider {
  const config = loadConfig()

  // 1. api_key → hosted (mails.dev /v1/send)
  if (config.api_key) {
    return createHostedSendProvider(config.api_key)
  }

  // 2. worker_url → OSS worker /api/send (NEW)
  if (config.worker_url) {
    return createOSSSendProvider(
      config.worker_url,
      config.worker_token,
    )
  }

  // 3. resend_api_key → direct Resend (standalone)
  if (config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  throw new Error('No send provider configured. Run: mails claim <name> or configure worker_url/resend_api_key')
}
```

**Step 3: Remove outbound recording from send.ts**

The outbound recording block (lines 65-89) is no longer needed — Worker records outbound in D1, and standalone Resend has no storage. Remove it. This also removes the `import { getStorage }` dependency.

```typescript
// DELETE these lines:
// import { getStorage } from './storage.js'
// try { const storage = await getStorage() ... } catch {}
```

**Step 4: Write tests, commit**

```
feat(send): add OSS send provider, route worker_url to /api/send
```

---

## Task 3: OSS Worker — add `GET /api/sync`

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Implement sync endpoint**

```typescript
case '/api/sync':
  response = await handleSync(url, env)
  break
```

```typescript
async function handleSync(url: URL, env: Env): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z'
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  // Get emails since timestamp (full fields for local storage)
  const rows = await env.DB.prepare(`
    SELECT * FROM emails
    WHERE mailbox = ? AND received_at > ?
    ORDER BY received_at ASC
    LIMIT ? OFFSET ?
  `).bind(to, since, limit, offset).all()

  // For each email, fetch attachments
  const emails = []
  for (const row of rows.results) {
    const emailRow = row as Record<string, unknown>
    const attachments = await env.DB.prepare(
      'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
    ).bind(emailRow.id).all()

    emails.push({
      ...emailRow,
      headers: safeJsonParse(emailRow.headers as string, {}),
      metadata: safeJsonParse(emailRow.metadata as string, {}),
      has_attachments: Boolean(emailRow.has_attachments),
      attachments: attachments.results,
    })
  }

  // Count total for has_more
  const countResult = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails WHERE mailbox = ? AND received_at > ?'
  ).bind(to, since).first<{ total: number }>()

  const total = countResult?.total ?? 0

  return Response.json({
    emails,
    total,
    has_more: offset + limit < total,
  })
}
```

**Step 2: Test, commit**

```
feat(worker): add GET /api/sync — incremental email pull with attachments
```

---

## Task 4: CLI — add `mails sync` command

**Files:**
- Create: `src/cli/commands/sync.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/core/config.ts` (add `last_sync` config key)
- Test: `test/unit/sync.test.ts`

**Step 1: Implement sync command**

`src/cli/commands/sync.ts`:

```typescript
import { loadConfig, setConfigValue } from '../../core/config.js'
import { getStorage } from '../core/storage.js'

export async function syncCommand(args: string[]) {
  const config = loadConfig()

  const workerUrl = config.worker_url
  const apiKey = config.api_key
  const baseUrl = apiKey
    ? (process.env.MAILS_API_URL || 'https://mails-dev-worker.o-u-turing.workers.dev')
    : workerUrl

  if (!baseUrl) {
    console.error('No worker_url or api_key configured. Nothing to sync from.')
    process.exit(1)
  }

  const mailbox = config.mailbox
  if (!mailbox) {
    console.error('No mailbox configured. Run: mails config set mailbox <address>')
    process.exit(1)
  }

  const storage = await getStorage()
  if (storage.name === 'remote') {
    console.error('Cannot sync to remote storage. Set storage_provider to sqlite or db9.')
    process.exit(1)
  }

  // Parse args
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : config.last_sync
  const fromScratch = args.includes('--from-scratch')

  const syncSince = fromScratch ? '1970-01-01T00:00:00Z' : (since || '1970-01-01T00:00:00Z')

  // Build headers
  const headers: Record<string, string> = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  else if (config.worker_token) headers['Authorization'] = `Bearer ${config.worker_token}`

  // Determine sync endpoint path
  const usePath = apiKey ? '/v1/sync' : '/api/sync'
  const mailboxParam = apiKey ? '' : `to=${encodeURIComponent(mailbox)}&`

  let offset = 0
  let total = 0
  let synced = 0

  console.log(`Syncing from ${baseUrl} since ${syncSince}...`)

  while (true) {
    const url = `${baseUrl}${usePath}?${mailboxParam}since=${encodeURIComponent(syncSince)}&limit=100&offset=${offset}`
    const res = await fetch(url, { headers })

    if (!res.ok) {
      const data = await res.json() as { error?: string }
      console.error(`Sync error: ${data.error ?? res.statusText}`)
      process.exit(1)
    }

    const data = await res.json() as {
      emails: Array<Record<string, unknown>>
      total: number
      has_more: boolean
    }

    total = data.total

    for (const email of data.emails) {
      await storage.saveEmail(email as any)
      synced++
    }

    if (!data.has_more || data.emails.length === 0) break
    offset += data.emails.length

    process.stdout.write(`  ${synced}/${total} emails synced\r`)
  }

  // Update last_sync cursor
  const now = new Date().toISOString()
  setConfigValue('last_sync', now)

  console.log(`Synced ${synced} email(s). Last sync: ${now}`)
}
```

**Step 2: Register command in CLI**

In `src/cli/index.ts`:

```typescript
import { syncCommand } from './commands/sync.js'
// ...
case 'sync':
  await syncCommand(args.slice(1))
  break
```

**Step 3: Write tests, commit**

```
feat(cli): add mails sync — incremental pull from Worker to local storage
```

---

## Task 5: E2E tests — OSS send + sync

**Files:**
- Modify: `test/e2e/full-selfhosted.test.ts`

Add tests:

```typescript
test('9. send email FROM self-hosted mailbox via /api/send', async () => {
  // POST /api/send to OSS Worker
  // Verify response has id
  // Then check inbox for outbound email
})

test('10. sync emails to local sqlite', async () => {
  // Create local sqlite, sync from Worker, verify emails appear locally
})
```

**Commit:**
```
test(e2e): add OSS send and sync integration tests
```

---

## Task 6: Update help text and READMEs

**Files:**
- Modify: `src/cli/commands/help.ts`
- Modify: `README.md`, `README.zh.md`, `README.ja.md`

Add sync command to help and docs. Update self-hosted setup instructions:

```
Self-Hosted Setup:
  1. Deploy Worker:  cd worker && wrangler deploy
  2. Set Resend key: wrangler secret put RESEND_API_KEY
  3. Configure CLI:  mails config set worker_url https://your-worker.example.com
  4. Set mailbox:    mails config set mailbox agent@yourdomain.com
  5. Send:           mails send --to user@example.com --subject "Hello" --body "Hi"
  6. Sync inbox:     mails sync
  7. Read inbox:     mails inbox
```

Update E2E coverage table with outbound support for OSS.

**Commit:**
```
docs: update help and READMEs with sync command and OSS send setup
```

---

## Execution Order

```
Task 1 (Worker /api/send)  ──► Task 2 (CLI OSS send provider)
Task 3 (Worker /api/sync)  ──► Task 4 (CLI sync command)
                               Task 5 (E2E tests) ← depends on 1-4
                               Task 6 (Docs) ← depends on 1-4
```

Tasks 1+3 (Worker) can be done in parallel.
Tasks 2+4 (CLI) can be done in parallel after their Worker deps.
Tasks 5+6 are final.

---

## Out of Scope

1. **mails.dev hosted `/v1/sync` endpoint** — hosted Worker needs its own sync endpoint, but that's in the mails.dev repo
2. **db9 in Worker** — self-hosted db9 integration is deferred
3. **Background daemon sync** — `mails sync --watch` is future work
4. **Attachment binary sync** — sync pulls metadata only; binary download still uses Worker's `/api/attachment`
