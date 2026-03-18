import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { getEmail, getInbox, waitForCode } from '../../src/core/receive'
import { saveConfig } from '../../src/core/config'

const DEFAULT_CONFIG = {
  mode: 'hosted' as const,
  domain: 'mails.dev',
  mailbox: '',
  send_provider: 'resend',
  storage_provider: 'sqlite',
  attachment_blob_store: 'filesystem',
}

describe('receive worker auth', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({
      ...DEFAULT_CONFIG,
      worker_url: 'https://worker.test',
      worker_api_key: 'worker-secret',
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    saveConfig(DEFAULT_CONFIG)
  })

  test('getInbox sends the configured worker bearer token', async () => {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-secret')
      return Response.json({ emails: [] })
    }) as typeof fetch

    const emails = await getInbox('agent@test.com')

    expect(emails).toEqual([])
  })

  test('getEmail sends the configured worker bearer token', async () => {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-secret')
      return Response.json({
        id: 'email-1',
        mailbox: 'agent@test.com',
        from_address: 'sender@test.com',
        from_name: 'Sender',
        to_address: 'agent@test.com',
        subject: 'Hello',
        body_text: 'Body',
        body_html: '',
        code: null,
        headers: {},
        metadata: {},
        direction: 'inbound',
        status: 'received',
        received_at: '2026-03-18T00:00:00.000Z',
        created_at: '2026-03-18T00:00:00.000Z',
      })
    }) as typeof fetch

    const email = await getEmail('email-1')

    expect(email?.id).toBe('email-1')
  })

  test('waitForCode sends the configured worker bearer token', async () => {
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-secret')
      return Response.json({
        code: '123456',
        from: 'sender@test.com',
        subject: 'Your code',
      })
    }) as typeof fetch

    const code = await waitForCode('agent@test.com')

    expect(code).toEqual({
      code: '123456',
      from: 'sender@test.com',
      subject: 'Your code',
    })
  })
})
