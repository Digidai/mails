import { describe, test, expect, mock, afterEach } from 'bun:test'
import { handleSend } from '../../worker/src/handlers/send'

describe('Per-mailbox Send Rate Limits', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  function makeRequest(from: string) {
    return new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: ['recipient@example.com'],
        subject: 'Test',
        text: 'Hello',
      }),
    })
  }

  test('returns 429 when daily limit is reached', async () => {
    // After atomic increment, count = 101 (was at limit 100, +1).
    // checkDailySendLimit sees 101 > 100, decrements back, returns 429.
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('daily_send_counts')) return { count: 101 }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(429)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Daily send limit')
  })

  test('allows sending when under limit', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'resend-ok' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('daily_send_counts')) return { count: 5 }
            if (sql.includes('thread_id')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(200)
  })

  test('respects custom DAILY_SEND_LIMIT', async () => {
    // After atomic increment, count = 11 (was at custom limit 10, +1).
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('daily_send_counts')) return { count: 11 }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test', DAILY_SEND_LIMIT: '10' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(429)
  })

  test('blocks known phishing-style account verification subjects from untrusted mailbox', async () => {
    let resendCalled = false
    globalThis.fetch = mock(async () => {
      resendCalled = true
      return new Response(JSON.stringify({ id: 'should-not-send' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('auth_tokens')) return null
            if (sql.includes("direction = 'inbound'")) return { count: 0 }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'fresh@mails0.com'
    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: mailbox,
        to: ['recipient@example.com'],
        subject: 'Action Required: Verify Your Account',
        text: 'Please verify your account at https://example.com/login',
      }),
    })

    const res = await handleSend(request, env, mailbox)
    expect(res.status).toBe(400)
    expect(resendCalled).toBe(false)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('abuse protection')
  })

  test('returns 429 when global daily send limit is reached', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('SELECT created_at FROM auth_tokens')) {
              return { created_at: '2026-01-01T00:00:00.000Z' }
            }
            if (sql.includes("direction = 'inbound'")) return { count: 1 }
            if (sql.includes('COALESCE(SUM(count)')) return { count: 201 }
            if (sql.includes('daily_send_counts')) return { count: 1 }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test', GLOBAL_DAILY_SEND_LIMIT: '200' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(429)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Global daily send limit')
  })

  test('skips rate limit when no mailbox (self-hosted)', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'resend-nomail' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    // No mailbox passed — self-hosted mode
    const res = await handleSend(makeRequest('sender@example.com'), env)
    expect(res.status).toBe(200)
  })

  test('increments daily count after successful send', async () => {
    let incrementCalled = false
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'resend-inc' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          run: async () => {
            if (sql.includes('INSERT INTO daily_send_counts')) {
              incrementCalled = true
            }
            return { meta: { changes: 1 } }
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)
    expect(res.status).toBe(200)
    expect(incrementCalled).toBe(true)
  })
})
