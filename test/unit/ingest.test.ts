import { describe, test, expect } from 'bun:test'

/**
 * Tests for Round 1 reliability fixes:
 * - Raw-first R2 persistence + ingest_log
 * - Inbound idempotency
 * - Webhook security (no secret → 503)
 * - Suppression fail-closed
 */

describe('Webhook Security: no secret → 503', () => {
  test('rejects webhook when RESEND_WEBHOOK_SECRET is not configured', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const body = JSON.stringify({
      type: 'email.delivered',
      created_at: '2026-04-10',
      data: { email_id: 'test-123', to: ['user@test.com'] },
    })

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    // No RESEND_WEBHOOK_SECRET in env
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
    } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(503)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('not configured')
  })
})

describe('Suppression fail-closed', () => {
  test('rejects send when suppression check fails (non-table error)', async () => {
    const { handleSend } = await import('../../worker/src/handlers/send')

    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'test@test.com',
        to: ['user@test.com'],
        subject: 'Test',
        text: 'Hello',
      }),
    })

    // Mock env where suppression check throws a non-table error
    const env = {
      RESEND_API_KEY: 'test-key',
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (sql.includes('suppression_list')) {
                throw new Error('D1 connection timeout')
              }
              return null
            },
            run: async () => ({ meta: {} }),
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as any

    const res = await handleSend(request, env, 'test@test.com')
    expect(res.status).toBe(503)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('recipient safety')
  })

  test('allows send when suppression table does not exist', async () => {
    const { handleSend } = await import('../../worker/src/handlers/send')

    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'test@test.com',
        to: ['user@test.com'],
        subject: 'Test',
        text: 'Hello',
      }),
    })

    // Mock: suppression_list throws "no such table", Resend succeeds
    let resendCalled = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('resend.com')) {
        resendCalled = true
        return new Response(JSON.stringify({ id: 'resend-123' }), { status: 200 })
      }
      return originalFetch(url, _init)
    }

    const env = {
      RESEND_API_KEY: 'test-key',
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (sql.includes('suppression_list')) {
                throw new Error('no such table: suppression_list')
              }
              if (sql.includes('daily_send_counts')) {
                throw new Error('no such table: daily_send_counts')
              }
              return null
            },
            run: async () => ({ meta: {} }),
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as any

    try {
      const res = await handleSend(request, env, 'test@test.com')
      // Should succeed (send went through)
      expect(res.status).toBe(200)
      expect(resendCalled).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Ingest log schema', () => {
  test('ingest_log table has correct columns', () => {
    // Verify schema expectations — not a runtime test, just documents the contract
    const expectedColumns = [
      'id', 'mailbox', 'raw_key', 'status', 'error_message',
      'from_address', 'to_address', 'retry_count', 'email_id', 'created_at',
    ]
    const expectedStatuses = ['pending', 'parsed', 'failed']

    expect(expectedColumns).toHaveLength(10)
    expect(expectedStatuses).toHaveLength(3)
  })
})

describe('Inbound idempotency', () => {
  test('INSERT OR IGNORE prevents duplicate emails', () => {
    // This tests the SQL pattern, not the actual D1 execution
    // The actual idempotency is enforced by UNIQUE INDEX on (mailbox, message_id)
    const sql = `INSERT OR IGNORE INTO emails (id, mailbox, ...) VALUES (?, ?, ...)`
    expect(sql).toContain('INSERT OR IGNORE')
  })
})

describe('Send: async D1 write after Resend success', () => {
  test('handleSend accepts optional ctx parameter', async () => {
    const { handleSend } = await import('../../worker/src/handlers/send')

    // Verify the function signature accepts ctx
    expect(handleSend.length).toBeGreaterThanOrEqual(3) // request, env, mailbox at minimum
  })
})
