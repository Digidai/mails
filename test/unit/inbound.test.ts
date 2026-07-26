import { describe, test, expect } from 'bun:test'
import {
  handleResendInbound,
  ingestParsedInbound,
  resolveInboundRecipient,
} from '../../worker/src/handlers/inbound'

/** Generate a valid Svix signature (mirrors resend-sig.ts verification). */
async function signWebhook(secret: string, svixId: string, timestamp: string, body: string) {
  const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0))
  const toSign = `${svixId}.${timestamp}.${body}`
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign))
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

const TEST_SECRET = 'whsec_' + btoa('test-secret-key-for-unit-tests!')

/**
 * Minimal D1 mock. `emailsInsertChanges` controls the meta.changes returned by
 * the `INSERT OR IGNORE INTO emails` statement (1 = stored, 0 = duplicate).
 * All SELECTs return null; all batches resolve.
 */
function mockEnv(emailsInsertChanges = 1) {
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => sql.includes('SELECT token, status')
          ? { token: 'mk_test', status: 'active', expires_at: null }
          : null,
        all: async () => ({ results: [] }),
        run: async () => ({
          meta: { changes: sql.includes('INSERT OR IGNORE INTO emails') ? emailsInsertChanges : 1 },
        }),
      }),
    }),
    batch: async () => [],
  }
  return { DB: db } as any
}

const mockCtx = () => ({ waitUntil: (p: Promise<unknown>) => { if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {}) } }) as any

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-id-1',
    mailbox: 'bot@example.com',
    realFrom: 'sender@other.com',
    fromName: 'Sender',
    envelopeFrom: 'sender@other.com',
    subject: 'Your code is 123456',
    bodyText: 'Hello, your verification code is 123456.',
    bodyHtml: '',
    headers: {},
    messageId: '<msg-1@other.com>',
    inReplyTo: null,
    references: null,
    attachments: [],
    attachmentCount: 0,
    attachmentNames: '',
    attachmentSearchText: '',
    rawKey: null,
    source: 'resend-inbound' as const,
    ...overrides,
  }
}

describe('handleResendInbound — signature gate', () => {
  test('returns 503 when webhook secret is not configured', async () => {
    const req = new Request('http://localhost/api/resend-inbound', {
      method: 'POST', body: JSON.stringify({ type: 'email.received', data: { email_id: 'x' } }),
    })
    const res = await handleResendInbound(req, { DB: {} } as any, mockCtx())
    expect(res.status).toBe(503)
  })

  test('returns 401 on an invalid signature', async () => {
    const req = new Request('http://localhost/api/resend-inbound', {
      method: 'POST',
      headers: { 'svix-id': 'm1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,bogus' },
      body: JSON.stringify({ type: 'email.received', data: { email_id: 'x' } }),
    })
    const res = await handleResendInbound(req, { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: {} } as any, mockCtx())
    expect(res.status).toBe(401)
  })

  test('acknowledges (200) and ignores non-email.received events', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = await signWebhook(TEST_SECRET, 'm2', ts, body)
    const req = new Request('http://localhost/api/resend-inbound', {
      method: 'POST',
      headers: { 'svix-id': 'm2', 'svix-timestamp': ts, 'svix-signature': sig },
      body,
    })
    const res = await handleResendInbound(req, { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: {} } as any, mockCtx())
    expect(res.status).toBe(200)
    const data = await res.json() as { ignored?: string }
    expect(data.ignored).toBe('email.delivered')
  })
})

describe('ingestParsedInbound', () => {
  test('stores a new inbound email (duplicate=false)', async () => {
    const result = await ingestParsedInbound(mockEnv(1), mockCtx(), baseInput())
    expect(result.duplicate).toBe(false)
  })

  test('reports a duplicate when INSERT OR IGNORE makes no change', async () => {
    const result = await ingestParsedInbound(mockEnv(0), mockCtx(), baseInput())
    expect(result.duplicate).toBe(true)
  })
})

describe('resolveInboundRecipient', () => {
  test('accepts an active, unexpired mailbox', async () => {
    const result = await resolveInboundRecipient(mockEnv(), 'BOT@EXAMPLE.COM')
    expect(result).toEqual({ accepted: true, token: 'mk_test' })
  })

  test('rejects an unknown mailbox', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => null }),
        }),
      },
    } as any
    const result = await resolveInboundRecipient(env, 'unknown@example.com')
    expect(result.accepted).toBe(false)
  })

  test('rejects an expired provisional mailbox', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              token: 'mk_expired',
              status: 'active',
              expires_at: new Date(Date.now() - 60_000).toISOString(),
            }),
          }),
        }),
      },
    } as any
    const result = await resolveInboundRecipient(env, 'expired@example.com')
    expect(result.accepted).toBe(false)
  })

  test('rejects a paused mailbox', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              token: 'mk_paused',
              status: 'paused',
              expires_at: null,
            }),
          }),
        }),
      },
    } as any
    const result = await resolveInboundRecipient(env, 'paused@example.com')
    expect(result.accepted).toBe(false)
  })
})
