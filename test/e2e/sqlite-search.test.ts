import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSqliteProvider } from '../../src/providers/storage/sqlite'
import type { Email } from '../../src/core/types'

const REPO_ROOT = join(import.meta.dir, '..', '..')

function makeEmail(mailbox: string, overrides: Partial<Email> = {}): Email {
  const now = new Date().toISOString()
  return {
    id: `sqlite-search-${crypto.randomUUID()}`,
    mailbox,
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: mailbox,
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: null,
    headers: {},
    metadata: { source: 'sqlite-search-e2e' },
    direction: 'inbound',
    status: 'received',
    received_at: now,
    created_at: now,
    ...overrides,
  }
}

describe('E2E: sqlite inbox search', () => {
  let tempHome = ''
  let mailbox = ''

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'mails-sqlite-search-'))
    mailbox = `search-e2e-${Date.now()}@e2e.test`

    const configDir = join(tempHome, '.mails')
    const dbPath = join(configDir, 'mails.db')
    mkdirSync(configDir, { recursive: true })

    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      mode: 'hosted',
      domain: 'mails0.com',
      mailbox,
      send_provider: 'resend',
      storage_provider: 'sqlite',
    }, null, 2) + '\n')

    const provider = createSqliteProvider(dbPath)
    await provider.init()

    await provider.saveEmail(makeEmail(mailbox, {
      subject: 'Reset Password',
      from_name: 'Security Team',
      from_address: 'noreply@service.com',
      body_text: 'Use code 654321 to continue.',
      body_html: '<p>Use code 654321 to continue.</p>',
      code: '654321',
    }))

    const later = new Date(Date.now() + 1000).toISOString()
    await provider.saveEmail(makeEmail(mailbox, {
      subject: 'Invoice follow-up',
      from_name: 'Billing',
      from_address: 'billing@example.com',
      body_text: 'Your invoice is ready.',
      body_html: '',
      direction: 'outbound',
      status: 'sent',
      received_at: later,
      created_at: later,
    }))

    await provider.saveEmail(makeEmail(`other-${mailbox}`, {
      subject: 'Invoice from another mailbox',
      from_address: 'other@example.com',
      body_text: 'Should not be returned.',
    }))
  })

  afterAll(() => {
    if (tempHome && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test('searches subject and code against local sqlite', async () => {
    const provider = createSqliteProvider(join(tempHome, '.mails', 'mails.db'))
    await provider.init()

    const resetResults = await provider.searchEmails(mailbox, { query: 'reset', limit: 10 })
    expect(resetResults).toHaveLength(1)
    expect(resetResults[0]!.subject).toBe('Reset Password')
    expect(resetResults[0]!.code).toBe('654321')

    const codeResults = await provider.searchEmails(mailbox, { query: '654321', limit: 10 })
    expect(codeResults).toHaveLength(1)
    expect(codeResults[0]!.subject).toBe('Reset Password')
    expect(codeResults[0]!.code).toBe('654321')
  })

  test('prints scoped results via CLI', () => {
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        'run',
        'src/cli/index.ts',
        'inbox',
        '--mailbox',
        mailbox,
        '--query',
        'invoice',
        '--direction',
        'outbound',
      ],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tempHome,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = new TextDecoder().decode(proc.stdout)
    const stderr = new TextDecoder().decode(proc.stderr)

    expect(proc.exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Invoice follow-up')
    expect(stdout).not.toContain('Reset Password')
    expect(stdout).not.toContain('another mailbox')
  })
})
