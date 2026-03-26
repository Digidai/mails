import { describe, expect, test, afterEach, mock, beforeEach } from 'bun:test'
import { saveConfig, resolveApiKey } from '../../src/core/config'
import type { MailsConfig } from '../../src/core/types'

describe('resolveApiKey', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    } as MailsConfig)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('fetches mailbox from /v1/me and saves to config', async () => {
    let requestUrl = ''
    let authHeader = ''
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      requestUrl = url
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ mailbox: 'agent@mails0.com' }))
    }) as typeof fetch

    const result = await resolveApiKey('mk_test_key')

    expect(result).toBe('agent@mails0.com')
    expect(requestUrl).toContain('/v1/me')
    expect(authHeader).toBe('Bearer mk_test_key')

    // Verify saved to config
    const { loadConfig } = await import('../../src/core/config')
    const config = loadConfig()
    expect(config.mailbox).toBe('agent@mails0.com')
    expect(config.default_from).toBe('agent@mails0.com')
  })

  test('returns null on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Invalid' }), { status: 401 })
    }) as typeof fetch

    expect(await resolveApiKey('mk_bad')).toBeNull()
  })

  test('returns null on network error', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network error')
    }) as typeof fetch

    expect(await resolveApiKey('mk_offline')).toBeNull()
  })

  test('returns null when response has no mailbox', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({}))
    }) as typeof fetch

    expect(await resolveApiKey('mk_empty')).toBeNull()
  })
})
