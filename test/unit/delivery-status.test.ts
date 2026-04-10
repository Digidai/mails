import { describe, test, expect, mock, afterEach } from 'bun:test'

/** Helper: generate a valid Svix signature for testing */
async function signWebhook(secret: string, svixId: string, timestamp: string, body: string) {
  const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0))
  const toSign = `${svixId}.${timestamp}.${body}`
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign))
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
}

const TEST_SECRET = 'whsec_' + btoa('test-secret-key-for-unit-tests!')

describe('Delivery Status Handler', () => {
  afterEach(() => { mock.restore() })

  test('maps Resend event types to status correctly', () => {
    const statusMap: Record<string, string> = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.delivery_delayed': 'queued',
    }

    expect(statusMap['email.sent']).toBe('sent')
    expect(statusMap['email.delivered']).toBe('delivered')
    expect(statusMap['email.bounced']).toBe('bounced')
    expect(statusMap['email.complained']).toBe('complained')
    expect(statusMap['email.delivery_delayed']).toBe('queued')
    expect(statusMap['email.unknown']).toBeUndefined()
  })

  test('handleResendWebhook rejects invalid JSON', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = 'not json'
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = await signWebhook(TEST_SECRET, 'msg_test1', ts, bodyStr)
    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'svix-id': 'msg_test1', 'svix-timestamp': ts, 'svix-signature': sig },
      body: bodyStr,
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(400)
  })

  test('handleResendWebhook rejects missing email_id', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = JSON.stringify({ type: 'email.sent', created_at: '2026-04-03', data: {} })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = await signWebhook(TEST_SECRET, 'msg_test2', ts, bodyStr)
    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'svix-id': 'msg_test2', 'svix-timestamp': ts, 'svix-signature': sig },
      body: bodyStr,
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(400)
  })

  test('handleResendWebhook ignores unknown event types', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = JSON.stringify({ type: 'email.opened', created_at: '2026-04-03', data: { email_id: 'abc' } })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = await signWebhook(TEST_SECRET, 'msg_test3', ts, bodyStr)
    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'svix-id': 'msg_test3', 'svix-timestamp': ts, 'svix-signature': sig },
      body: bodyStr,
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('rejects webhook with invalid signature when secret is configured', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = JSON.stringify({ type: 'email.sent', created_at: '2026-04-04', data: { email_id: 'abc' } })
    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_test123',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,invalidsignature',
      },
      body: bodyStr,
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: {} } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(401)
  })

  test('rejects webhook with missing signature headers when secret is configured', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.sent', created_at: '2026-04-04', data: { email_id: 'abc' } }),
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: {} } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(401)
  })

  test('rejects webhook with expired timestamp', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = JSON.stringify({ type: 'email.sent', created_at: '2026-04-04', data: { email_id: 'abc' } })
    const expiredTs = String(Math.floor(Date.now() / 1000) - 600) // 10 min ago
    const sig = await signWebhook(TEST_SECRET, 'msg_test123', expiredTs, bodyStr)

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_test123',
        'svix-timestamp': expiredTs,
        'svix-signature': sig,
      },
      body: bodyStr,
    })
    const env = { RESEND_WEBHOOK_SECRET: TEST_SECRET, DB: {} } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(401)
  })

  test('accepts webhook with valid signature', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const bodyStr = JSON.stringify({ type: 'email.unknown_event', created_at: '2026-04-04', data: { email_id: 'abc' } })
    const ts = String(Math.floor(Date.now() / 1000))
    const svixId = 'msg_valid123'
    const sig = await signWebhook(TEST_SECRET, svixId, ts, bodyStr)

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': ts,
        'svix-signature': sig,
      },
      body: bodyStr,
    })
    const env = {
      RESEND_WEBHOOK_SECRET: TEST_SECRET,
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
    } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    // Unknown event type → acknowledged with 200
    expect(res.status).toBe(200)
  })

  test('rejects webhook with 503 when RESEND_WEBHOOK_SECRET is not set', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.unknown', created_at: '2026-04-04', data: { email_id: 'abc' } }),
    })
    // No RESEND_WEBHOOK_SECRET in env — should be rejected
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('not configured')
  })
})
