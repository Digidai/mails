import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { MailsConfig } from '../../src/core/types'

const fakeConfig: MailsConfig = {
  mode: 'hosted',
  domain: 'mails0.com',
  mailbox: 'agent@mails0.com',
  send_provider: 'resend',
  storage_provider: 'sqlite',
}

describe('doctor command', () => {
  let output: string[]
  let origLog: typeof console.log
  let origError: typeof console.error
  let origExit: typeof process.exit

  beforeEach(() => {
    output = []
    origLog = console.log
    origError = console.error
    origExit = process.exit
    console.log = (msg?: unknown) => { output.push(String(msg ?? '')) }
    console.error = (msg?: unknown) => { output.push(String(msg ?? '')) }
  })

  afterEach(() => {
    console.log = origLog
    console.error = origError
    process.exit = origExit
  })

  test('shows config check pass when config exists', async () => {
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand({
      configFile: '/tmp/mails-config.json',
      configExists: true,
      loadConfig: () => fakeConfig,
    })
    const text = output.join('\n')
    expect(text).toContain('Config:')
  })

  test('shows API check when api_key is configured', async () => {
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand({
      configFile: '/tmp/mails-config.json',
      configExists: true,
      loadConfig: () => ({ ...fakeConfig, api_key: 'mk_test_key' }),
      apiUrl: 'https://api.test',
      fetch: async () => new Response(JSON.stringify({
        mailbox: 'agent@mails0.com',
        send: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })
    const text = output.join('\n')
    expect(text).toContain('API:')
    expect(text).toContain('connected')
  })

  test('shows mails doctor header', async () => {
    const { doctorCommand } = await import('../../src/cli/commands/doctor.js')
    await doctorCommand({
      configFile: '/tmp/mails-config.json',
      configExists: false,
      loadConfig: () => fakeConfig,
    })
    const text = output.join('\n')
    expect(text).toContain('mails doctor')
  })
})
