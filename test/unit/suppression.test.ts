import { describe, test, expect, mock, afterEach } from 'bun:test'
import { handleSend, checkSuppressionList } from '../../worker/src/handlers/send'

describe('Bounce Suppression List', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('checkSuppressionList returns null when no suppressed recipients', async () => {
    const db = {
      prepare: () => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db } as any
    const result = await checkSuppressionList(env, ['good@example.com'])
    expect(result).toBeNull()
  })

  test('checkSuppressionList returns suppressed email', async () => {
    const db = {
      prepare: () => ({
        bind: (..._args: unknown[]) => ({
          first: async () => ({ email: 'bad@example.com', reason: 'bounce' }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db } as any
    const result = await checkSuppressionList(env, ['bad@example.com'])
    expect(result).not.toBeNull()
    expect(result!.email).toBe('bad@example.com')
    expect(result!.reason).toBe('bounce')
  })

  test('handleSend rejects suppressed recipient with 400', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) {
              return { email: 'bounced@example.com', reason: 'bounce' }
            }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test-key' } as any
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'sender@example.com',
        to: ['bounced@example.com'],
        subject: 'Test',
        text: 'Hello',
      }),
    })

    const res = await handleSend(req, env)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('suppressed')
    expect(data.error).toContain('bounced@example.com')
  })

  test('delivery-status handler inserts into suppression_list on bounce', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    let insertedEmails: string[] = []
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('json_extract')) {
              return { id: 'email-1', mailbox: 'mb@test.com' }
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT OR IGNORE INTO suppression_list')) {
              insertedEmails.push(args[0] as string)
            }
            return { meta: { changes: 1 } }
          },
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'email.bounced',
        created_at: '2026-04-03',
        data: { email_id: 'resend-1', to: ['bounced@user.com'] },
      }),
    })

    const env = { DB: db } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(req, env, ctx)
    expect(res.status).toBe(200)
    expect(insertedEmails).toContain('bounced@user.com')
  })

  test('delivery-status handler inserts into suppression_list on complaint', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    let insertedReasons: string[] = []
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('json_extract')) {
              return { id: 'email-2', mailbox: 'mb@test.com' }
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT OR IGNORE INTO suppression_list')) {
              insertedReasons.push(args[1] as string)
            }
            return { meta: { changes: 1 } }
          },
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'email.complained',
        created_at: '2026-04-03',
        data: { email_id: 'resend-2', to: ['complained@user.com'] },
      }),
    })

    const env = { DB: db } as any
    const ctx = { waitUntil: () => {} } as any

    await handleResendWebhook(req, env, ctx)
    expect(insertedReasons).toContain('complaint')
  })
})
