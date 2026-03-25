import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { handleSend, extractEmail, parseFromName } from '../../worker/src/handlers/send'
import { handleGetAttachment } from '../../worker/src/handlers/attachment'
import { handleGetEmail, handleDeleteEmail } from '../../worker/src/handlers/email'
import { fireWebhook, getWebhookUrl } from '../../worker/src/handlers/webhook'
import { resolveAuth, _resetAuthCache } from '../../worker/src/handlers/auth'
import type { Env } from '../../worker/src/types'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock D1PreparedStatement that chains .bind().first()/.run()/.all()
 */
function mockStatement(result: unknown = null, allResults: unknown[] = []) {
  const stmt: any = {
    bind: mock((..._args: unknown[]) => stmt),
    first: mock(async () => result),
    run: mock(async () => ({ success: true })),
    all: mock(async () => ({ results: allResults })),
  }
  return stmt
}

/**
 * Creates a mock D1Database with configurable prepare behaviour.
 * `prepareHandler` receives the SQL string and returns a mock statement.
 */
function mockDB(prepareHandler?: (sql: string) => any): any {
  const defaultStmt = mockStatement()
  return {
    prepare: mock((sql: string) => prepareHandler ? prepareHandler(sql) : defaultStmt),
    batch: mock(async (stmts: any[]) => stmts.map(() => ({ success: true }))),
  }
}

/**
 * Creates a mock R2Bucket.
 */
function mockR2(objects: Record<string, { body: ReadableStream | string }> = {}): any {
  return {
    get: mock(async (key: string) => objects[key] ?? null),
    put: mock(async () => ({})),
    delete: mock(async () => {}),
  }
}

/**
 * Builds a minimal Env for testing.
 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: mockDB(),
    ...overrides,
  }
}

/**
 * Helper to build a JSON Request.
 */
function jsonRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request('https://worker.test/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// handleSend
// ---------------------------------------------------------------------------

describe('handleSend', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns 501 when no RESEND_API_KEY', async () => {
    const env = makeEnv()
    const req = jsonRequest({ from: 'a@b.com', to: ['c@d.com'], subject: 'Hi', text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(501)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('not available')
  })

  test('returns 415 when Content-Type is not application/json', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = new Request('https://worker.test/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(415)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('application/json')
  })

  test('returns 400 for invalid JSON body', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = new Request('https://worker.test/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Invalid JSON')
  })

  test('returns 400 when missing required field: from', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({ to: ['c@d.com'], subject: 'Hi', text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Missing required fields')
  })

  test('returns 400 when missing required field: to', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({ from: 'a@b.com', subject: 'Hi', text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
  })

  test('returns 400 when missing required field: subject', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({ from: 'a@b.com', to: ['c@d.com'], text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
  })

  test('returns 400 when to is empty array', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({ from: 'a@b.com', to: [], subject: 'Hi', text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
  })

  test('returns 400 when no text or html body', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({ from: 'a@b.com', to: ['c@d.com'], subject: 'Hi' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('text or html')
  })

  test('returns 400 when too many recipients (>50)', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const recipients = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`)
    const req = jsonRequest({ from: 'a@b.com', to: recipients, subject: 'Hi', text: 'Body' })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Too many recipients')
  })

  test('returns 400 when subject too long (>998)', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'x'.repeat(999),
      text: 'Body',
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Subject too long')
  })

  test('returns 400 when text body too large', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Hi',
      text: 'x'.repeat(500_001),
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Body too large')
  })

  test('returns 400 when html body too large', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Hi',
      html: 'x'.repeat(1_000_001),
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Body too large')
  })

  test('returns 403 when from address does not match mailbox (mailbox isolation)', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({
      from: 'other@evil.com',
      to: ['c@d.com'],
      subject: 'Hi',
      text: 'Body',
    })
    const res = await handleSend(req, env, 'me@legit.com')
    expect(res.status).toBe(403)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('must match your mailbox')
  })

  test('returns 403 when from address in angle brackets does not match mailbox', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'key' })
    const req = jsonRequest({
      from: 'Alice <other@evil.com>',
      to: ['c@d.com'],
      subject: 'Hi',
      text: 'Body',
    })
    const res = await handleSend(req, env, 'me@legit.com')
    expect(res.status).toBe(403)
  })

  test('successful send returns internal id + provider_id', async () => {
    const db = mockDB()
    const env = makeEnv({ RESEND_API_KEY: 'rsk_test_123', DB: db })

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ id: 'resend-abc' }), { status: 200 })
    ) as typeof fetch

    const req = jsonRequest({
      from: 'agent@example.com',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello world',
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(200)

    const data = await res.json() as { id: string; provider_id: string }
    expect(data.id).toBeDefined()
    expect(data.provider_id).toBe('resend-abc')

    // Verify D1 insert was called
    expect(db.prepare).toHaveBeenCalled()

    globalThis.fetch = originalFetch
  })

  test('successful send with mailbox matching from address', async () => {
    const db = mockDB()
    const env = makeEnv({ RESEND_API_KEY: 'rsk_test_123', DB: db })

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ id: 'resend-def' }), { status: 200 })
    ) as typeof fetch

    const req = jsonRequest({
      from: 'Agent <agent@example.com>',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello world',
    })
    // Mailbox matches from address
    const res = await handleSend(req, env, 'agent@example.com')
    expect(res.status).toBe(200)

    const data = await res.json() as { id: string; provider_id: string }
    expect(data.provider_id).toBe('resend-def')

    globalThis.fetch = originalFetch
  })

  test('forwards Resend API errors', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'rsk_test_123' })

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 422 })
    ) as typeof fetch

    const req = jsonRequest({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Test',
      text: 'Body',
    })
    const res = await handleSend(req, env)
    expect(res.status).toBe(422)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('Invalid API key')

    globalThis.fetch = originalFetch
  })
})

describe('extractEmail', () => {
  test('extracts email from angle brackets', () => {
    expect(extractEmail('Alice <alice@example.com>')).toBe('alice@example.com')
  })

  test('returns raw string when no angle brackets', () => {
    expect(extractEmail('alice@example.com')).toBe('alice@example.com')
  })

  test('handles quoted name', () => {
    expect(extractEmail('"Alice Bob" <alice@example.com>')).toBe('alice@example.com')
  })
})

describe('parseFromName', () => {
  test('extracts name before angle brackets', () => {
    expect(parseFromName('Alice <alice@example.com>')).toBe('Alice')
  })

  test('extracts quoted name', () => {
    expect(parseFromName('"Alice Bob" <alice@example.com>')).toBe('Alice Bob')
  })

  test('returns empty string when no name', () => {
    expect(parseFromName('alice@example.com')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// handleGetAttachment
// ---------------------------------------------------------------------------

describe('handleGetAttachment', () => {
  test('returns 400 when no id param', async () => {
    const env = makeEnv()
    const url = new URL('https://worker.test/api/attachment')
    const res = await handleGetAttachment(url, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Missing ?id=')
  })

  test('returns 404 when attachment not found', async () => {
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/attachment?id=nonexistent')
    const res = await handleGetAttachment(url, env)
    expect(res.status).toBe(404)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('not found')
  })

  test('returns file from R2 when storage_key exists', async () => {
    const attachmentRow = {
      id: 'att-1',
      filename: 'report.pdf',
      content_type: 'application/pdf',
      storage_key: 'emails/att-1/report.pdf',
      text_content: '',
    }
    const stmt = mockStatement(attachmentRow)
    const db = mockDB(() => stmt)

    const r2body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('PDF content'))
        controller.close()
      },
    })
    const r2 = mockR2({
      'emails/att-1/report.pdf': { body: r2body },
    })

    const env = makeEnv({ DB: db, ATTACHMENTS: r2 })
    const url = new URL('https://worker.test/api/attachment?id=att-1')
    const res = await handleGetAttachment(url, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('report.pdf')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('returns 404 when storage_key exists but R2 object missing', async () => {
    const attachmentRow = {
      id: 'att-2',
      filename: 'report.pdf',
      content_type: 'application/pdf',
      storage_key: 'emails/att-2/report.pdf',
      text_content: '',
    }
    const stmt = mockStatement(attachmentRow)
    const db = mockDB(() => stmt)
    const r2 = mockR2({}) // empty — object not found
    const env = makeEnv({ DB: db, ATTACHMENTS: r2 })

    const url = new URL('https://worker.test/api/attachment?id=att-2')
    const res = await handleGetAttachment(url, env)
    expect(res.status).toBe(404)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('file not found in storage')
  })

  test('returns text_content fallback when no R2', async () => {
    const attachmentRow = {
      id: 'att-3',
      filename: 'notes.txt',
      content_type: 'text/plain',
      storage_key: null,
      text_content: 'These are my notes.',
    }
    const stmt = mockStatement(attachmentRow)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db }) // No ATTACHMENTS R2 bucket

    const url = new URL('https://worker.test/api/attachment?id=att-3')
    const res = await handleGetAttachment(url, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain')
    expect(res.headers.get('Content-Disposition')).toContain('notes.txt')
    const text = await res.text()
    expect(text).toBe('These are my notes.')
  })

  test('returns 404 when no content available (no R2, no text_content)', async () => {
    const attachmentRow = {
      id: 'att-4',
      filename: 'empty.bin',
      content_type: 'application/octet-stream',
      storage_key: null,
      text_content: '',
    }
    const stmt = mockStatement(attachmentRow)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })

    const url = new URL('https://worker.test/api/attachment?id=att-4')
    const res = await handleGetAttachment(url, env)
    expect(res.status).toBe(404)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('not available')
  })

  test('mailbox isolation: returns 404 for attachment from different mailbox', async () => {
    // When mailbox is provided, the query adds AND e.mailbox = ? which should
    // cause no result to be returned for a cross-mailbox attachment
    const stmt = mockStatement(null) // simulates no match due to mailbox filter
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })

    const url = new URL('https://worker.test/api/attachment?id=att-other')
    const res = await handleGetAttachment(url, env, 'my@mailbox.com')

    expect(res.status).toBe(404)
    // Verify that bind was called with the mailbox parameter
    expect(stmt.bind).toHaveBeenCalledWith('att-other', 'my@mailbox.com')
  })

  test('sanitizes filename with special characters', async () => {
    const attachmentRow = {
      id: 'att-5',
      filename: 'file"with\\quotes.txt',
      content_type: 'text/plain',
      storage_key: null,
      text_content: 'content',
    }
    const stmt = mockStatement(attachmentRow)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })

    const url = new URL('https://worker.test/api/attachment?id=att-5')
    const res = await handleGetAttachment(url, env)
    expect(res.status).toBe(200)
    const disposition = res.headers.get('Content-Disposition') ?? ''
    // Quotes and backslashes should be replaced with underscores
    expect(disposition).not.toContain('"file"')
    expect(disposition).not.toContain('\\')
  })
})

// ---------------------------------------------------------------------------
// handleGetEmail
// ---------------------------------------------------------------------------

describe('handleGetEmail', () => {
  test('returns 400 when no id param', async () => {
    const env = makeEnv()
    const url = new URL('https://worker.test/api/email')
    const res = await handleGetEmail(url, env)
    expect(res.status).toBe(400)
  })

  test('returns 404 when email not found', async () => {
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/email?id=no-such')
    const res = await handleGetEmail(url, env)
    expect(res.status).toBe(404)
  })

  test('returns email with parsed headers/metadata and attachments', async () => {
    const emailRow = {
      id: 'email-1',
      mailbox: 'user@example.com',
      from_address: 'sender@example.com',
      from_name: 'Sender',
      to_address: 'user@example.com',
      subject: 'Hello',
      body_text: 'Hi there',
      body_html: '<p>Hi there</p>',
      code: null,
      headers: '{"X-Custom":"value"}',
      metadata: '{"key":"val"}',
      direction: 'inbound',
      status: 'received',
      message_id: '<msg@example.com>',
      has_attachments: 1,
      attachment_count: 1,
      attachment_names: 'file.txt',
      attachment_search_text: 'file content',
      raw_storage_key: null,
      received_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    }
    const attachmentRows = [
      {
        id: 'att-1',
        email_id: 'email-1',
        filename: 'file.txt',
        content_type: 'text/plain',
        size_bytes: 100,
        content_disposition: 'attachment',
        content_id: null,
        mime_part_index: 0,
        text_content: 'file content',
        text_extraction_status: 'done',
        storage_key: 'emails/att-1/file.txt',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]

    let callIndex = 0
    const db = mockDB((sql: string) => {
      if (sql.includes('FROM emails')) {
        return mockStatement(emailRow)
      }
      return mockStatement(null, attachmentRows)
    })
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/email?id=email-1')
    const res = await handleGetEmail(url, env)

    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.id).toBe('email-1')
    expect(data.subject).toBe('Hello')
    // headers and metadata should be parsed JSON
    expect(data.headers).toEqual({ 'X-Custom': 'value' })
    expect(data.metadata).toEqual({ key: 'val' })
    // has_attachments should be boolean
    expect(data.has_attachments).toBe(true)
    // attachments should include downloadable flag
    expect(data.attachments).toHaveLength(1)
    expect(data.attachments[0].downloadable).toBe(true)
  })

  test('mailbox isolation: scopes query to mailbox', async () => {
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/email?id=email-x')
    const res = await handleGetEmail(url, env, 'my@mailbox.com')

    expect(res.status).toBe(404)
    // The first prepare call should contain AND mailbox = ?
    const firstPrepareCall = (db.prepare as any).mock.calls[0]
    expect(firstPrepareCall[0]).toContain('mailbox')
  })
})

// ---------------------------------------------------------------------------
// handleDeleteEmail
// ---------------------------------------------------------------------------

describe('handleDeleteEmail', () => {
  test('returns 400 when no id param', async () => {
    const env = makeEnv()
    const url = new URL('https://worker.test/api/email')
    const res = await handleDeleteEmail(url, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Missing ?id=')
  })

  test('returns 404 when email not found', async () => {
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/email?id=no-such')
    const res = await handleDeleteEmail(url, env)
    expect(res.status).toBe(404)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('not found')
  })

  test('deletes email + attachments + R2 objects', async () => {
    const emailRow = { id: 'email-1', mailbox: 'user@example.com' }
    const attachmentRows = [
      { storage_key: 'emails/att-1/file.pdf' },
      { storage_key: 'emails/att-2/image.png' },
      { storage_key: null }, // attachment without R2 storage
    ]

    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT id, mailbox')) {
        return mockStatement(emailRow)
      }
      if (sql.includes('SELECT storage_key')) {
        return mockStatement(null, attachmentRows)
      }
      // DELETE statements
      return mockStatement()
    })

    const r2 = mockR2()
    const env = makeEnv({ DB: db, ATTACHMENTS: r2 })
    const url = new URL('https://worker.test/api/email?id=email-1')
    const res = await handleDeleteEmail(url, env)

    expect(res.status).toBe(200)
    const data = await res.json() as { deleted: boolean }
    expect(data.deleted).toBe(true)

    // Verify batch delete was called
    expect(db.batch).toHaveBeenCalled()

    // Verify R2 delete was called for non-null storage keys
    expect(r2.delete).toHaveBeenCalledTimes(2)
    expect(r2.delete).toHaveBeenCalledWith('emails/att-1/file.pdf')
    expect(r2.delete).toHaveBeenCalledWith('emails/att-2/image.png')
  })

  test('deletes email even without R2 bucket configured', async () => {
    const emailRow = { id: 'email-2', mailbox: 'user@example.com' }
    const attachmentRows = [{ storage_key: 'some-key' }]

    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT id, mailbox')) {
        return mockStatement(emailRow)
      }
      if (sql.includes('SELECT storage_key')) {
        return mockStatement(null, attachmentRows)
      }
      return mockStatement()
    })

    const env = makeEnv({ DB: db }) // No ATTACHMENTS R2
    const url = new URL('https://worker.test/api/email?id=email-2')
    const res = await handleDeleteEmail(url, env)

    expect(res.status).toBe(200)
    const data = await res.json() as { deleted: boolean }
    expect(data.deleted).toBe(true)
  })

  test('mailbox isolation: returns 404 for email from different mailbox', async () => {
    // With mailbox set, the check query adds AND mailbox = ?, so if
    // the email belongs to another mailbox, first() returns null
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = new URL('https://worker.test/api/email?id=email-other')
    const res = await handleDeleteEmail(url, env, 'my@mailbox.com')

    expect(res.status).toBe(404)
    // Verify bind was called with both id and mailbox
    expect(stmt.bind).toHaveBeenCalledWith('email-other', 'my@mailbox.com')
  })

  test('handles R2 delete failure gracefully', async () => {
    const emailRow = { id: 'email-3', mailbox: 'user@example.com' }
    const attachmentRows = [{ storage_key: 'fail-key' }]

    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT id, mailbox')) {
        return mockStatement(emailRow)
      }
      if (sql.includes('SELECT storage_key')) {
        return mockStatement(null, attachmentRows)
      }
      return mockStatement()
    })

    const r2: any = {
      get: mock(async () => null),
      put: mock(async () => ({})),
      delete: mock(async () => { throw new Error('R2 network error') }),
    }
    const env = makeEnv({ DB: db, ATTACHMENTS: r2 })
    const url = new URL('https://worker.test/api/email?id=email-3')

    // Should not throw — R2 cleanup is best-effort
    const res = await handleDeleteEmail(url, env)
    expect(res.status).toBe(200)
    const data = await res.json() as { deleted: boolean }
    expect(data.deleted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fireWebhook
// ---------------------------------------------------------------------------

describe('fireWebhook', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  const samplePayload = {
    event: 'email.received' as const,
    email_id: 'email-1',
    mailbox: 'user@example.com',
    from: 'sender@example.com',
    subject: 'Test',
    received_at: '2026-01-01T00:00:00Z',
    message_id: '<msg@example.com>',
    has_attachments: false,
    attachment_count: 0,
  }

  test('sends POST with correct payload', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit = {}

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string
      capturedInit = init ?? {}
      return new Response('OK', { status: 200 })
    }) as typeof fetch

    const env = makeEnv()
    await fireWebhook(env, samplePayload, 'https://hooks.example.com/email')

    expect(capturedUrl).toBe('https://hooks.example.com/email')
    expect(capturedInit.method).toBe('POST')
    const headers = capturedInit.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Webhook-Event']).toBe('email.received')
    expect(headers['X-Webhook-Id']).toBe('email-1')

    const body = JSON.parse(capturedInit.body as string)
    expect(body.email_id).toBe('email-1')
    expect(body.mailbox).toBe('user@example.com')

    globalThis.fetch = originalFetch
  })

  test('includes HMAC signature when WEBHOOK_SECRET is set', async () => {
    let capturedHeaders: Record<string, string> = {}

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response('OK', { status: 200 })
    }) as typeof fetch

    const env = makeEnv({ WEBHOOK_SECRET: 'my-secret-key' })
    await fireWebhook(env, samplePayload, 'https://hooks.example.com/email')

    expect(capturedHeaders['X-Webhook-Signature']).toBeDefined()
    expect(capturedHeaders['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]+$/)

    globalThis.fetch = originalFetch
  })

  test('does not include signature when no WEBHOOK_SECRET', async () => {
    let capturedHeaders: Record<string, string> = {}

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response('OK', { status: 200 })
    }) as typeof fetch

    const env = makeEnv()
    await fireWebhook(env, samplePayload, 'https://hooks.example.com/email')

    expect(capturedHeaders['X-Webhook-Signature']).toBeUndefined()

    globalThis.fetch = originalFetch
  })

  test('handles fetch failure gracefully (does not throw)', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network unreachable')
    }) as typeof fetch

    const env = makeEnv()
    // Should not throw
    await fireWebhook(env, samplePayload, 'https://hooks.example.com/email')

    globalThis.fetch = originalFetch
  })
})

describe('getWebhookUrl', () => {
  test('returns webhook_url when configured', async () => {
    const stmt = mockStatement({ webhook_url: 'https://hooks.example.com/email' })
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = await getWebhookUrl(env, 'user@example.com')
    expect(url).toBe('https://hooks.example.com/email')
  })

  test('returns null when no webhook configured', async () => {
    const stmt = mockStatement(null)
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = await getWebhookUrl(env, 'user@example.com')
    expect(url).toBeNull()
  })

  test('returns null when table does not exist (query throws)', async () => {
    const stmt: any = {
      bind: mock((..._args: unknown[]) => stmt),
      first: mock(async () => { throw new Error('no such table: auth_tokens') }),
      run: mock(async () => ({ success: true })),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => stmt)
    const env = makeEnv({ DB: db })
    const url = await getWebhookUrl(env, 'user@example.com')
    expect(url).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveAuth
// ---------------------------------------------------------------------------

describe('resolveAuth', () => {
  beforeEach(() => {
    _resetAuthCache()
  })

  test('returns null when auth_tokens table exists but no token provided', async () => {
    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT 1 FROM auth_tokens')) {
        return mockStatement(null) // .run() succeeds = table exists
      }
      return mockStatement(null)
    })
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails')
    const result = await resolveAuth(req, env)
    expect(result).toBeNull()
  })

  test('returns null when auth_tokens table exists but token is invalid', async () => {
    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT 1 FROM auth_tokens')) {
        return mockStatement(null) // table exists
      }
      return mockStatement(null) // no matching row
    })
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Bearer bad-token' },
    })
    const result = await resolveAuth(req, env)
    expect(result).toBeNull()
  })

  test('returns mailbox when valid token found in auth_tokens', async () => {
    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT 1 FROM auth_tokens')) {
        return mockStatement(null) // table exists
      }
      return mockStatement({ mailbox: 'user@example.com' })
    })
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    const result = await resolveAuth(req, env)
    expect(result).not.toBeNull()
    expect(result!.mailbox).toBe('user@example.com')
  })

  test('returns null for non-Bearer Authorization header', async () => {
    const db = mockDB((sql: string) => {
      if (sql.includes('SELECT 1 FROM auth_tokens')) {
        return mockStatement(null)
      }
      return mockStatement(null)
    })
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })
    const result = await resolveAuth(req, env)
    expect(result).toBeNull()
  })
})

describe('resolveAuth — legacy AUTH_TOKEN mode', () => {
  beforeEach(() => {
    _resetAuthCache()
  })

  test('returns { mailbox: null } when AUTH_TOKEN matches', async () => {
    // Make auth_tokens table check fail (table doesn't exist)
    const failStmt: any = {
      bind: mock((..._args: unknown[]) => failStmt),
      first: mock(async () => null),
      run: mock(async () => { throw new Error('no such table: auth_tokens') }),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => failStmt)
    const env = makeEnv({ DB: db, AUTH_TOKEN: 'my-secret' })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Bearer my-secret' },
    })
    const result = await resolveAuth(req, env)
    expect(result).not.toBeNull()
    expect(result!.mailbox).toBeNull()
  })

  test('returns null when AUTH_TOKEN does not match', async () => {
    const failStmt: any = {
      bind: mock((..._args: unknown[]) => failStmt),
      first: mock(async () => null),
      run: mock(async () => { throw new Error('no such table: auth_tokens') }),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => failStmt)
    const env = makeEnv({ DB: db, AUTH_TOKEN: 'my-secret' })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    const result = await resolveAuth(req, env)
    expect(result).toBeNull()
  })

  test('returns null when AUTH_TOKEN set but no token provided', async () => {
    const failStmt: any = {
      bind: mock((..._args: unknown[]) => failStmt),
      first: mock(async () => null),
      run: mock(async () => { throw new Error('no such table: auth_tokens') }),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => failStmt)
    const env = makeEnv({ DB: db, AUTH_TOKEN: 'my-secret' })
    const req = new Request('https://worker.test/api/emails')
    const result = await resolveAuth(req, env)
    expect(result).toBeNull()
  })
})

describe('resolveAuth — no auth configured (public access)', () => {
  beforeEach(() => {
    _resetAuthCache()
  })

  test('returns { mailbox: null } when no auth is configured', async () => {
    // Make auth_tokens table check fail (table doesn't exist)
    const failStmt: any = {
      bind: mock((..._args: unknown[]) => failStmt),
      first: mock(async () => null),
      run: mock(async () => { throw new Error('no such table: auth_tokens') }),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => failStmt)
    // No AUTH_TOKEN set, no auth_tokens table
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails')
    const result = await resolveAuth(req, env)
    expect(result).not.toBeNull()
    expect(result!.mailbox).toBeNull()
  })

  test('returns { mailbox: null } even with a Bearer token when no auth configured', async () => {
    const failStmt: any = {
      bind: mock((..._args: unknown[]) => failStmt),
      first: mock(async () => null),
      run: mock(async () => { throw new Error('no such table: auth_tokens') }),
      all: mock(async () => ({ results: [] })),
    }
    const db = mockDB(() => failStmt)
    const env = makeEnv({ DB: db })
    const req = new Request('https://worker.test/api/emails', {
      headers: { Authorization: 'Bearer some-token' },
    })
    const result = await resolveAuth(req, env)
    expect(result).not.toBeNull()
    expect(result!.mailbox).toBeNull()
  })
})
