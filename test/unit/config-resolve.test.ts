import { describe, expect, test, afterEach, mock, beforeEach } from 'bun:test'
import type { MailsConfig } from '../../src/core/types'

// Use dynamic imports with cache-busting to avoid mock.module() pollution
// from other test files (e.g. cli.test.ts) that run in the same process.
let counter = 0
async function freshConfig() {
  counter++
  return (await import(`../../src/core/config.ts?t=cr_${counter}`)) as typeof import('../../src/core/config')
}

describe('resolveApiKey', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    const { saveConfig } = await freshConfig()
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

    const { resolveApiKey } = await freshConfig()
    const result = await resolveApiKey('mk_test_key')

    expect(result).toBe('agent@mails0.com')
    expect(requestUrl).toContain('/v1/me')
    expect(authHeader).toBe('Bearer mk_test_key')

    // Verify saved to config
    const { loadConfig } = await freshConfig()
    const config = loadConfig()
    expect(config.mailbox).toBe('agent@mails0.com')
    expect(config.default_from).toBe('agent@mails0.com')
  })

  test('returns null on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Invalid' }), { status: 401 })
    }) as typeof fetch

    const { resolveApiKey } = await freshConfig()
    expect(await resolveApiKey('mk_bad')).toBeNull()
  })

  test('returns null on network error', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network error')
    }) as typeof fetch

    const { resolveApiKey } = await freshConfig()
    expect(await resolveApiKey('mk_offline')).toBeNull()
  })

  test('returns null when response has no mailbox', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({}))
    }) as typeof fetch

    const { resolveApiKey } = await freshConfig()
    expect(await resolveApiKey('mk_empty')).toBeNull()
  })
})
