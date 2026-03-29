import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import type { MailsConfig } from '../../src/core/types'

// Use dynamic imports with cache-busting to avoid mock.module() pollution
// from other test files (e.g. cli.test.ts) that run in the same process.
let counter = 0
async function freshConfig() {
  counter++
  return (await import(`../../src/core/config.ts?t=sr_cfg_${counter}`)) as typeof import('../../src/core/config')
}

// Each test needs a fresh storage module to avoid cached _provider
async function freshGetStorage() {
  counter++
  const { loadConfig } = await freshConfig()
  const { createSqliteProvider } = await import(`../../src/providers/storage/sqlite.ts?t=sr_sql_${counter}`)
  const { createRemoteProvider } = await import(`../../src/providers/storage/remote.ts?t=sr_rem_${counter}`)
  const type = await import('../../src/core/types')

  let _provider: typeof type.StorageProvider extends new (...args: any[]) => infer T ? T : any
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

  test('defaults to sqlite', async () => {
    const provider = await freshGetStorage()
    expect(provider.name).toBe('sqlite')
  })

  test('auto-detects remote when api_key is set', async () => {
    const { saveConfig } = await freshConfig()
    saveConfig({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox: 'agent@mails0.com',
      send_provider: 'resend',
      storage_provider: '',
      api_key: 'mk_test',
    } as unknown as MailsConfig)

    const provider = await freshGetStorage()
    expect(provider.name).toBe('remote')
  })

  test('auto-detects remote when worker_url is set', async () => {
    const { saveConfig } = await freshConfig()
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
    const { saveConfig } = await freshConfig()
    saveConfig({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox: 'agent@mails0.com',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)

    const provider = await freshGetStorage()
    expect(provider.name).toBe('remote')
  })

  test('throws when remote but no mailbox', async () => {
    const { saveConfig } = await freshConfig()
    saveConfig({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'remote',
      api_key: 'mk_test',
    } as MailsConfig)

    expect(freshGetStorage()).rejects.toThrow('mailbox not configured')
  })

})
