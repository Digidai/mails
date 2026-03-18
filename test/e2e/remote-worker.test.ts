/**
 * E2E test: remote provider ↔ self-hosted Worker (open-source).
 *
 * Tests the full CLI light client flow:
 *   CLI (remote provider) → Worker HTTP API (/api/*) → D1
 *
 * Also tests Worker AUTH_TOKEN enforcement.
 *
 * Prerequisites:
 *   cd worker && bun install && npx wrangler d1 execute mails --local --file=schema.sql
 *
 * Run: bun test test/e2e/remote-worker.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { join } from 'path'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import type { Email } from '../../src/core/types'
import { execSync } from 'child_process'

const WORKER_DIR = join(import.meta.dir, '../../worker')
const PORT = 3170 // Use a different port to avoid conflicts
const API = `http://localhost:${PORT}`
const AUTH_TOKEN = 'e2e_test_token_' + Date.now()
const MAILBOX = `e2e-remote-${Date.now()}@test.com`

let workerProc: Subprocess | null = null

function d1(sql: string) {
  execSync(
    `cd ${WORKER_DIR} && npx wrangler d1 execute mails --local --command "${sql.replace(/"/g, '\\"')}"`,
    { stdio: 'pipe' },
  )
}

async function waitForServer(url: string, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not start`)
}

describe('E2E: remote provider ↔ self-hosted Worker', () => {
  beforeAll(async () => {
    // Ensure schema — use only CREATE statements (ALTER IF NOT EXISTS is not valid SQLite)
    const createSchema = `
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, from_address TEXT NOT NULL,
        from_name TEXT DEFAULT '', to_address TEXT NOT NULL, subject TEXT DEFAULT '',
        body_text TEXT DEFAULT '', body_html TEXT DEFAULT '', code TEXT,
        headers TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}',
        message_id TEXT, has_attachments INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0, attachment_names TEXT DEFAULT '',
        attachment_search_text TEXT DEFAULT '', raw_storage_key TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
        received_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, email_id TEXT NOT NULL, filename TEXT NOT NULL,
        content_type TEXT NOT NULL, size_bytes INTEGER, content_disposition TEXT,
        content_id TEXT, mime_part_index INTEGER NOT NULL, text_content TEXT DEFAULT '',
        text_extraction_status TEXT NOT NULL DEFAULT 'pending', storage_key TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
    `
    try {
      execSync(`cd ${WORKER_DIR} && npx wrangler d1 execute mails --local --command "${createSchema.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
    } catch {}

    // Write .dev.vars with AUTH_TOKEN so wrangler picks it up
    const { writeFileSync: writeFile } = await import('fs')
    writeFile(join(WORKER_DIR, '.dev.vars'), `AUTH_TOKEN=${AUTH_TOKEN}\n`)

    // Start worker
    workerProc = spawn({
      cmd: ['npx', 'wrangler', 'dev', '--port', String(PORT)],
      cwd: WORKER_DIR,
      stdout: 'ignore',
      stderr: 'ignore',
    })

    await waitForServer(`${API}/health`)

    // Seed test emails
    const now = new Date().toISOString()
    d1(`INSERT INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, direction, status, received_at, created_at) VALUES ('remote-e1', '${MAILBOX}', 'sender@test.com', 'Sender', '${MAILBOX}', 'Password reset', 'Your code is 112233', '', '112233', 'inbound', 'received', '${now}', '${now}')`)
    d1(`INSERT INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, direction, status, received_at, created_at) VALUES ('remote-e2', '${MAILBOX}', 'billing@test.com', 'Billing', '${MAILBOX}', 'Invoice ready', 'Your invoice is attached', '', NULL, 'inbound', 'received', '${now}', '${now}')`)
    d1(`INSERT INTO emails (id, mailbox, from_address, from_name, to_address, subject, body_text, body_html, code, direction, status, received_at, created_at) VALUES ('remote-e3', 'other@test.com', 'x@y.com', '', 'other@test.com', 'Other mailbox', 'Should not appear', '', NULL, 'inbound', 'received', '${now}', '${now}')`)
  }, 20000)

  afterAll(() => {
    if (workerProc) {
      workerProc.kill()
      workerProc = null
    }
    try {
      d1(`DELETE FROM emails WHERE id IN ('remote-e1','remote-e2','remote-e3')`)
    } catch {}
    // Clean up .dev.vars
    try {
      const { rmSync: rm } = require('fs')
      rm(join(WORKER_DIR, '.dev.vars'), { force: true })
    } catch {}
  })

  // --- AUTH_TOKEN enforcement ---

  test('rejects requests without token when AUTH_TOKEN is set', async () => {
    const res = await fetch(`${API}/api/inbox?to=${MAILBOX}`)
    expect(res.status).toBe(401)
  })

  test('accepts requests with correct token', async () => {
    const res = await fetch(`${API}/api/inbox?to=${MAILBOX}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { emails: any[] }
    expect(data.emails.length).toBeGreaterThanOrEqual(2)
  })

  test('rejects requests with wrong token', async () => {
    const res = await fetch(`${API}/api/inbox?to=${MAILBOX}`, {
      headers: { Authorization: 'Bearer wrong_token' },
    })
    expect(res.status).toBe(401)
  })

  test('/health is always public', async () => {
    const res = await fetch(`${API}/health`)
    expect(res.status).toBe(200)
  })

  // --- Remote provider (self-hosted mode) ---

  test('getEmails via remote provider', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    await provider.init()

    const emails = await provider.getEmails(MAILBOX, { limit: 10 })
    expect(emails.length).toBeGreaterThanOrEqual(2)
    expect(emails.every((e: Email) => e.mailbox === MAILBOX)).toBe(true)
  })

  test('getEmail detail via remote provider', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const email = await provider.getEmail('remote-e1')
    expect(email).not.toBeNull()
    expect(email!.subject).toBe('Password reset')
    expect(email!.code).toBe('112233')
  })

  test('getEmail returns null for nonexistent', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    expect(await provider.getEmail('nonexistent')).toBeNull()
  })

  test('getCode via remote provider', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const result = await provider.getCode(MAILBOX, { timeout: 3 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('112233')
  })

  test('searchEmails via remote provider', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const results = await provider.searchEmails(MAILBOX, { query: 'invoice' })
    expect(results).toHaveLength(1)
    expect(results[0]!.subject).toBe('Invoice ready')
  })

  test('searchEmails returns empty for no match', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const results = await provider.searchEmails(MAILBOX, { query: 'nonexistent_xyz' })
    expect(results).toHaveLength(0)
  })

  test('mailbox isolation — cannot see other mailbox emails', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const emails = await provider.getEmails(MAILBOX)
    expect(emails.every((e: Email) => e.mailbox === MAILBOX)).toBe(true)
    expect(emails.some((e: Email) => e.id === 'remote-e3')).toBe(false)
  })

  test('direction filter works', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    const outbound = await provider.getEmails(MAILBOX, { direction: 'outbound' })
    expect(outbound).toHaveLength(0) // all seeded emails are inbound
  })

  // --- saveEmail is read-only ---

  test('saveEmail throws', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: AUTH_TOKEN })
    expect(provider.saveEmail({} as Email)).rejects.toThrow('read-only')
  })
})
