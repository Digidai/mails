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

  test('blocks known phishing-style subjects even from older mailboxes with inbound history', async () => {
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
            if (sql.includes('SELECT created_at FROM auth_tokens')) {
              return { created_at: '2026-01-01T00:00:00.000Z' }
            }
            if (sql.includes("direction = 'inbound'")) return { count: 3 }
            if (sql.includes('COALESCE(SUM(count)')) return { count: 1 }
            if (sql.includes('daily_send_counts')) return { count: 1 }
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'trusted@mails0.com'
    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: mailbox,
        to: ['recipient@example.com'],
        subject: 'Payment Required for Your Account',
        text: 'Please review your account billing status.',
      }),
    })

    const res = await handleSend(request, env, mailbox)
    expect(res.status).toBe(400)
    expect(resendCalled).toBe(false)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('high-risk')
  })

  test('blocks HTML-only credential links from untrusted mailboxes', async () => {
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
            if (sql.includes('SELECT created_at FROM auth_tokens')) {
              return { created_at: new Date().toISOString() }
            }
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
        subject: 'Urgent account notice',
        html: '<p>Please <a href="https://example.com/login">click here</a> to verify your account.</p>',
      }),
    })

    const res = await handleSend(request, env, mailbox)
    expect(res.status).toBe(400)
    expect(resendCalled).toBe(false)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('credential-action link')
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

  test('rejects sends when rate-limit storage fails', async () => {
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
            if (sql.includes('daily_send_counts')) {
              throw new Error('D1_ERROR: rate limit table unavailable')
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT INTO daily_send_counts')) {
              throw new Error('D1_ERROR: rate limit table unavailable')
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

    expect(res.status).toBe(429)
    expect(resendCalled).toBe(false)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Unable to verify send rate limits')
  })

  test('can explicitly fail open on rate-limit storage errors for local/self-hosted deployments', async () => {
    let resendCalled = false
    globalThis.fetch = mock(async () => {
      resendCalled = true
      return new Response(JSON.stringify({ id: 'resend-fail-open' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('suppression_list')) return null
            if (sql.includes('thread_id')) return null
            if (sql.includes('daily_send_counts')) {
              throw new Error('D1_ERROR: rate limit table unavailable')
            }
            return null
          },
          run: async () => {
            if (sql.includes('INSERT INTO daily_send_counts')) {
              throw new Error('D1_ERROR: rate limit table unavailable')
            }
            return { meta: { changes: 1 } }
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test', RATE_LIMIT_FAIL_OPEN: 'true' } as any
    const mailbox = 'sender@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(200)
    expect(resendCalled).toBe(true)
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

describe('Send Warm-up Gate', () => {
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
        subject: 'Hello from the warm-up test',
        text: 'Body',
      }),
    })
  }

  test('rejects send while warm-up window is in the future', async () => {
    let resendCalled = false
    globalThis.fetch = mock(async () => {
      resendCalled = true
      return new Response(JSON.stringify({ id: 'should-not-send' }))
    }) as typeof fetch

    const futureUnlock = new Date(Date.now() + 12 * 3600 * 1000).toISOString()
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('send_unlocks_at')) return { send_unlocks_at: futureUnlock }
            if (sql.includes('suppression_list')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'fresh@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(403)
    expect(resendCalled).toBe(false)
    const data = await res.json() as { error: string; send_unlocks_at: string; warmup_remaining_seconds: number }
    expect(data.error).toContain('warm-up')
    expect(data.send_unlocks_at).toBe(futureUnlock)
    expect(data.warmup_remaining_seconds).toBeGreaterThan(0)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  test('allows send after warm-up window elapsed (auto-clears column)', async () => {
    let resendCalled = false
    let clearedWarmup = false
    globalThis.fetch = mock(async () => {
      resendCalled = true
      return new Response(JSON.stringify({ id: 'warmup-cleared' }))
    }) as typeof fetch

    const pastUnlock = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('send_unlocks_at')) return { send_unlocks_at: pastUnlock }
            if (sql.includes('suppression_list')) return null
            return null
          },
          run: async () => {
            if (sql.includes('UPDATE auth_tokens SET send_unlocks_at = NULL')) {
              clearedWarmup = true
            }
            return { meta: { changes: 1 } }
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'graduated@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(200)
    expect(resendCalled).toBe(true)
    expect(clearedWarmup).toBe(true)
  })

  test('skips warm-up check when SEND_WARMUP_ENABLED=0', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'bypass' }))
    }) as typeof fetch

    const futureUnlock = new Date(Date.now() + 23 * 3600 * 1000).toISOString()
    let warmupQueried = false
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('send_unlocks_at')) {
              warmupQueried = true
              return { send_unlocks_at: futureUnlock }
            }
            if (sql.includes('suppression_list')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test', SEND_WARMUP_ENABLED: '0' } as any
    const mailbox = 'bypass@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(200)
    expect(warmupQueried).toBe(false)
  })

  test('fails open if send_unlocks_at column does not exist (legacy schema)', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'legacy-ok' }))
    }) as typeof fetch

    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes('send_unlocks_at')) {
              throw new Error('no such column: send_unlocks_at')
            }
            if (sql.includes('suppression_list')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    const env = { DB: db, RESEND_API_KEY: 'test' } as any
    const mailbox = 'legacy@mails0.com'
    const res = await handleSend(makeRequest(mailbox), env, mailbox)

    expect(res.status).toBe(200)
  })
})
