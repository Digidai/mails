import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync } from 'node:fs'

// Use dynamic imports with cache-busting to avoid mock.module() pollution
// from other test files (e.g. cli.test.ts) that run in the same process.
let counter = 0
async function freshConfig() {
  counter++
  const mod = await import(`../../src/core/config.ts?t=cfg_${counter}`)
  return mod as typeof import('../../src/core/config')
}

describe('config', () => {
  beforeEach(async () => {
    const { saveConfig } = await freshConfig()
    // Reset config to defaults before each test
    saveConfig({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
    })
  })

  test('loadConfig returns defaults', async () => {
    const { loadConfig } = await freshConfig()
    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.domain).toBe('mails0.com')
    expect(config.send_provider).toBe('resend')
    expect(config.storage_provider).toBe('sqlite')
    expect(config.mailbox).toBe('')
  })

  test('saveConfig and loadConfig roundtrip', async () => {
    const { loadConfig, saveConfig } = await freshConfig()
    const config = loadConfig()
    config.resend_api_key = 'test_key_abc'
    config.domain = 'example.com'
    saveConfig(config)

    const loaded = loadConfig()
    expect(loaded.resend_api_key).toBe('test_key_abc')
    expect(loaded.domain).toBe('example.com')
  })

  test('getConfigValue returns undefined for unset key', async () => {
    const { getConfigValue } = await freshConfig()
    const val = getConfigValue('nonexistent_key')
    expect(val).toBeUndefined()
  })

  test('setConfigValue and getConfigValue', async () => {
    const { setConfigValue, getConfigValue } = await freshConfig()
    setConfigValue('resend_api_key', 're_test123')
    expect(getConfigValue('resend_api_key')).toBe('re_test123')
  })

  test('setConfigValue preserves existing values', async () => {
    const { setConfigValue, getConfigValue, loadConfig } = await freshConfig()
    setConfigValue('domain', 'test.com')
    setConfigValue('resend_api_key', 'key123')

    expect(getConfigValue('domain')).toBe('test.com')
    expect(getConfigValue('resend_api_key')).toBe('key123')
    expect(loadConfig().mode).toBe('hosted')
  })

  test('loadConfig returns defaults when config file does not exist', async () => {
    const { loadConfig, CONFIG_FILE } = await freshConfig()
    // Remove config file to trigger default branch
    if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE)

    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.domain).toBe('mails0.com')
    expect(config.storage_provider).toBe('sqlite')
  })
})
