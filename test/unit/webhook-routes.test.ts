import { describe, test, expect } from 'bun:test'

describe('Webhook Routes (Smart Routing)', () => {
  test('GET /api/mailbox/routes returns empty array initially', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: [] }),
          }),
        }),
      },
    } as any

    const request = new Request('http://localhost/api/mailbox/routes', { method: 'GET' })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env, 'test@test.com')
    expect(res.status).toBe(200)
    const data = await res.json() as { routes: unknown[] }
    expect(data.routes).toEqual([])
  })

  test('PUT /api/mailbox/routes validates label', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')
    const env = { DB: {} } as any

    const request = new Request('http://localhost/api/mailbox/routes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'invalid_label', webhook_url: 'https://example.com' }),
    })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env, 'test@test.com')
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Invalid label')
  })

  test('PUT /api/mailbox/routes validates webhook_url', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')
    const env = { DB: {} } as any

    const request = new Request('http://localhost/api/mailbox/routes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'code', webhook_url: 'not-a-url' }),
    })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env, 'test@test.com')
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('Invalid webhook_url')
  })

  test('PUT /api/mailbox/routes upserts valid route', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')

    let insertedLabel = ''
    const env = {
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              insertedLabel = args[2] as string
              return { meta: { changes: 1 } }
            },
          }),
        }),
      },
    } as any

    const request = new Request('http://localhost/api/mailbox/routes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'code', webhook_url: 'https://example.com/code-hook' }),
    })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env, 'test@test.com')
    expect(res.status).toBe(200)
    expect(insertedLabel).toBe('code')
  })

  test('DELETE /api/mailbox/routes requires label param', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')
    const env = { DB: {} } as any
    const request = new Request('http://localhost/api/mailbox/routes', { method: 'DELETE' })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env, 'test@test.com')
    expect(res.status).toBe(400)
  })

  test('getWebhookRoutes returns label→url map', async () => {
    const { getWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [
                { label: 'code', webhook_url: 'https://example.com/code' },
                { label: 'newsletter', webhook_url: 'https://example.com/newsletter' },
              ],
            }),
          }),
        }),
      },
    } as any

    const routes = await getWebhookRoutes(env, 'test@test.com')
    expect(routes).toEqual({
      code: 'https://example.com/code',
      newsletter: 'https://example.com/newsletter',
    })
  })

  test('requires mailbox', async () => {
    const { handleWebhookRoutes } = await import('../../worker/src/handlers/webhook-routes')
    const env = { DB: {} } as any
    const request = new Request('http://localhost/api/mailbox/routes', { method: 'GET' })
    const url = new URL('http://localhost/api/mailbox/routes')
    const res = await handleWebhookRoutes(request, url, env)
    expect(res.status).toBe(400)
  })
})
