import { describe, test, expect, mock, afterEach } from 'bun:test'

describe('Webhook Retry', () => {
  afterEach(() => { mock.restore() })

  test('getWebhookUrl returns null for missing webhook', async () => {
    const { getWebhookUrl } = await import('../../worker/src/handlers/webhook')
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      },
    } as any

    const url = await getWebhookUrl(env, 'agent@test.com')
    expect(url).toBeNull()
  })

  test('getWebhookUrl returns URL when configured', async () => {
    const { getWebhookUrl } = await import('../../worker/src/handlers/webhook')
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ webhook_url: 'https://hooks.example.com/email' }),
          }),
        }),
      },
    } as any

    const url = await getWebhookUrl(env, 'agent@test.com')
    expect(url).toBe('https://hooks.example.com/email')
  })

  test('getWebhookUrl returns null on DB error', async () => {
    const { getWebhookUrl } = await import('../../worker/src/handlers/webhook')
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => { throw new Error('DB error') },
          }),
        }),
      },
    } as any

    const url = await getWebhookUrl(env, 'agent@test.com')
    expect(url).toBeNull()
  })

  test('fireWebhookWithRetry does nothing when no webhook configured', async () => {
    const { fireWebhookWithRetry } = await import('../../worker/src/handlers/webhook')
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            run: async () => ({}),
          }),
        }),
      },
    } as any

    // Should complete without error
    await fireWebhookWithRetry(env, 'agent@test.com', {
      event: 'message.received',
      email_id: 'test-123',
      mailbox: 'agent@test.com',
    })
  })
})
