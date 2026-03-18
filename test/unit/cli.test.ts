import { describe, expect, test, mock, afterEach } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { setConfigValue, loadConfig, saveConfig } from '../../src/core/config'

describe('CLI: send command', () => {
  const originalFetch = globalThis.fetch
  const attachmentPath = join(import.meta.dir, '..', '.cli-attachment.txt')
  const downloadPath = join(import.meta.dir, '..', '.cli-download.txt')

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (existsSync(attachmentPath)) rmSync(attachmentPath)
    if (existsSync(downloadPath)) rmSync(downloadPath)
  })

  test('send command parses args correctly', async () => {
    // Setup config
    setConfigValue('resend_api_key', 're_test')
    setConfigValue('default_from', 'Bot <bot@test.com>')

    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg_cli' }))
    }) as typeof fetch

    // Import and call directly
    const { send } = await import('../../src/core/send')
    const result = await send({
      to: 'user@example.com',
      subject: 'CLI Test',
      text: 'Hello from CLI',
      attachments: [
        {
          filename: 'notes.txt',
          content: new TextEncoder().encode('hello attachment'),
          contentType: 'text/plain',
        },
      ],
    })

    expect(sentBody.to).toEqual(['user@example.com'])
    expect(sentBody.subject).toBe('CLI Test')
    expect(sentBody.text).toBe('Hello from CLI')
    expect(sentBody.attachments).toEqual([
      {
        filename: 'notes.txt',
        content: Buffer.from('hello attachment').toString('base64'),
        content_type: 'text/plain',
      },
    ])
    expect(result.id).toBe('msg_cli')
  })

  test('send command supports repeated --attach flags', async () => {
    setConfigValue('resend_api_key', 're_test')
    setConfigValue('default_from', 'Bot <bot@test.com>')
    writeFileSync(attachmentPath, 'attachment from path')

    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg_cli_attach' }))
    }) as typeof fetch

    const { sendCommand } = await import('../../src/cli/commands/send')
    const originalLog = console.log
    console.log = () => {}

    try {
      await sendCommand([
        '--to', 'user@example.com',
        '--subject', 'CLI Attach',
        '--body', 'See attached',
        '--attach', attachmentPath,
      ])
    } finally {
      console.log = originalLog
    }

    expect(sentBody.attachments).toEqual([
      {
        filename: '.cli-attachment.txt',
        content: Buffer.from('attachment from path').toString('base64'),
        content_type: 'text/plain',
      },
    ])
  })

  test('attachment command downloads a remote attachment to disk', async () => {
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'resend',
      storage_provider: 'sqlite',
      attachment_blob_store: 'filesystem',
      worker_url: 'https://worker.test',
      worker_api_key: 'worker-secret',
    })

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-secret')
      return new Response('cli attachment', {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename="cli.txt"',
        },
      })
    }) as typeof fetch

    const { attachmentCommand } = await import('../../src/cli/commands/attachment')
    const originalLog = console.log
    console.log = () => {}

    try {
      await attachmentCommand(['att-1', '--output', downloadPath])
    } finally {
      console.log = originalLog
    }

    expect(existsSync(downloadPath)).toBe(true)
  })
})

describe('CLI: config command', () => {
  test('config set and get work', () => {
    setConfigValue('domain', 'cli-test.com')
    const { getConfigValue } = require('../../src/core/config')
    expect(getConfigValue('domain')).toBe('cli-test.com')
  })

  test('config loads defaults for missing file', () => {
    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.send_provider).toBe('resend')
  })
})

describe('CLI: help command', () => {
  test('helpCommand outputs text', () => {
    const { helpCommand } = require('../../src/cli/commands/help')
    // Just verify it doesn't throw
    const originalLog = console.log
    let output = ''
    console.log = (msg: string) => { output = msg }
    helpCommand()
    console.log = originalLog
    expect(output).toContain('mails')
    expect(output).toContain('send')
    expect(output).toContain('inbox')
    expect(output).toContain('code')
    expect(output).toContain('serve')
    expect(output).toContain('attachment')
    expect(output).toContain('config')
    expect(output).toContain('mails.dev')
  })
})
