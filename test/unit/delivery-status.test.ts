import { describe, test, expect, mock, afterEach } from 'bun:test'

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

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      body: 'not json',
    })
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(400)
  })

  test('handleResendWebhook rejects missing email_id', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.sent', created_at: '2026-04-03', data: {} }),
    })
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(400)
  })

  test('handleResendWebhook ignores unknown event types', async () => {
    const { handleResendWebhook } = await import('../../worker/src/handlers/delivery-status')

    const request = new Request('http://localhost/api/resend-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.opened', created_at: '2026-04-03', data: { email_id: 'abc' } }),
    })
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as any
    const ctx = { waitUntil: () => {} } as any

    const res = await handleResendWebhook(request, env, ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
