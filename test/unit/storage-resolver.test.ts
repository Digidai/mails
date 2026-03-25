import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { saveConfig } from '../../src/core/config'
import type { MailsConfig } from '../../src/core/types'

// Each test needs a fresh storage module to avoid cached _provider
let counter = 0
async function freshGetStorage() {
  const { loadConfig } = await import('../../src/core/config')
  const { createSqliteProvider } = await import('../../src/providers/storage/sqlite')
  const { createRemoteProvider } = await import('../../src/providers/storage/remote')
  const type = await import('../../src/core/types')

  let _provider: type.StorageProvider | null = null
  const config = loadConfig()

  if (config.api_key || config.worker_url || config.storage_provider === 'remote') {
    const mailbox = config.mailbox || ''
    if (!mailbox) throw new Error('mailbox not configured')
    _provider = createRemoteProvider({
      url: config.worker_url || 'https://example.com',
      mailbox,
      apiKey: config.api_key,
      token: config.api_key || config.worker_token,
    })
  } else {
    _provider = createSqliteProvider()
  }

  await _provider.init()
  return _provider
}

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

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('defaults to sqlite', async () => {
    const provider = await freshGetStorage()
    expect(provider.name).toBe('sqlite')
  })

  test('auto-detects remote when api_key is set', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@mails.dev',
      send_provider: 'resend',
      storage_provider: '',
      api_key: 'mk_test',
    } as unknown as MailsConfig)

    const provider = await freshGetStorage()
    expect(provider.name).toBe('remote')
  })

  test('auto-detects remote when worker_url is set', async () => {
    saveConfig({
      mode: 'selfhosted',
      domain: 'test.com',
      mailbox: 'agent@test.com',
      send_provider: 'resend',
      storage_provider: '',
      worker_url: 'https://my-worker.example.com',
      worker_token: 'mytoken',
    } as unknown as MailsConfig)

    const provider = await freshGetStorage()
    expect(provider.name).toBe('remote')
  })

  test('explicit storage_provider=remote works', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ emails: [] }))) as typeof fetch
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: 'agent@mails.dev',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)

    const provider = await freshGetStorage()
    expect(provider.name).toBe('remote')
  })

  test('throws when remote but no mailbox', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)

    expect(freshGetStorage()).rejects.toThrow('mailbox not configured')
  })

})
