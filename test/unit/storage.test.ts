import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { saveConfig } from '../../src/core/config'
import { getStorage, resetStorage } from '../../src/core/storage'
import type { MailsConfig } from '../../src/core/types'

describe('storage resolver', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    } as MailsConfig)
  })

  afterEach(async () => {
    await resetStorage()
    globalThis.fetch = originalFetch
  })

  test('resolves sqlite by default', async () => {
    const provider = await getStorage()
    expect(provider.name).toBe('sqlite')
  })

  test('caches provider on second call', async () => {
    const p1 = await getStorage()
    const p2 = await getStorage()
    expect(p1).toBe(p2)
  })

  test('re-resolves provider when config changes', async () => {
    const sqliteProvider = await getStorage()
    expect(sqliteProvider.name).toBe('sqlite')

    saveConfig({
      mode: 'selfhosted',
      domain: 'example.com',
      mailbox: 'agent@example.com',
      send_provider: 'resend',
      storage_provider: 'remote',
      worker_url: 'https://worker.example.com',
      worker_token: 'worker-token',
    } as MailsConfig)

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization
      expect(auth).toBe('Bearer worker-token')
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const remoteProvider = await getStorage()
    expect(remoteProvider.name).toBe('remote')
    expect(remoteProvider).not.toBe(sqliteProvider)
  })

  test('resetStorage clears cached instance', async () => {
    const p1 = await getStorage()
    await resetStorage()
    const p2 = await getStorage()
    expect(p1).not.toBe(p2)
  })
})
