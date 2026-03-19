import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDb9Provider } from '../../src/providers/storage/db9'
import type { Email } from '../../src/core/types'

const DB9_TOKEN = process.env.DB9_TOKEN
const DB9_DATABASE_ID = process.env.DB9_DATABASE_ID
const skip = !DB9_TOKEN || !DB9_DATABASE_ID
const REPO_ROOT = join(import.meta.dir, '..', '..')

function makeEmail(mailbox: string, overrides: Partial<Email> = {}): Email {
  const now = new Date().toISOString()
  return {
    id: `db9-search-${crypto.randomUUID()}`,
    mailbox,
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: mailbox,
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: null,
    headers: {},
    metadata: { source: 'db9-search-e2e' },
    direction: 'inbound',
    status: 'received',
    received_at: now,
    created_at: now,
    ...overrides,
  }
}

describe.skipIf(skip)('E2E: db9 inbox search', () => {
  let provider: ReturnType<typeof createDb9Provider>
  let tempHome = ''
  let mailbox = ''

  beforeAll(async () => {
    provider = createDb9Provider(DB9_TOKEN!, DB9_DATABASE_ID!)
    await provider.init()

    tempHome = mkdtempSync(join(tmpdir(), 'mails-db9-search-'))
    mailbox = `search-e2e-${Date.now()}@e2e.test`

    const configDir = join(tempHome, '.mails')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox,
      send_provider: 'resend',
      storage_provider: 'db9',
      db9_token: DB9_TOKEN,
      db9_database_id: DB9_DATABASE_ID,
    }, null, 2) + '\n')

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

  test('searches subject and code against live db9', async () => {
    const resetResults = await provider.searchEmails(mailbox, { query: 'reset', limit: 10 })
    expect(resetResults).toHaveLength(1)
    expect(resetResults[0]!.subject).toBe('Reset Password')
    expect(resetResults[0]!.code).toBe('654321')

    const codeResults = await provider.searchEmails(mailbox, { query: '654321', limit: 10 })
    expect(codeResults).toHaveLength(1)
    expect(codeResults[0]!.subject).toBe('Reset Password')
    expect(codeResults[0]!.code).toBe('654321')
  })

  test('save email with attachments and retrieve metadata', async () => {
    const emailId = `att-e2e-${Date.now()}`
    const attId = `att-${Date.now()}`

    await provider.saveEmail(makeEmail(mailbox, {
      id: emailId,
      from_address: 'att-test@example.com',
      from_name: 'Attachment Test',
      subject: 'DB9 attachment e2e test',
      body_text: 'This email has an attachment.',
      body_html: '',
      has_attachments: true,
      attachment_count: 1,
      attachment_names: 'test-data.csv',
      attachment_search_text: 'header1,header2\nrow1,row2',
      attachments: [{
        id: attId,
        email_id: emailId,
        filename: 'test-data.csv',
        content_type: 'text/csv',
        size_bytes: 30,
        content_disposition: 'attachment',
        content_id: null,
        mime_part_index: 0,
        text_content: 'header1,header2\nrow1,row2',
        text_extraction_status: 'done',
        storage_key: null,
        created_at: new Date().toISOString(),
      }],
    }))

    // Verify getEmails returns attachment flags
    const emails = await provider.getEmails(mailbox, { limit: 10 })
    const match = emails.find(e => e.id === emailId)
    expect(match).toBeTruthy()
    expect(match!.has_attachments).toBe(true)
    expect(match!.attachment_count).toBe(1)

    // Verify getEmail returns attachment detail
    const detail = await provider.getEmail(emailId)
    expect(detail).not.toBeNull()
    expect(detail!.attachments).toBeDefined()
    expect(detail!.attachments!).toHaveLength(1)
    expect(detail!.attachments![0]!.filename).toBe('test-data.csv')
    expect(detail!.attachments![0]!.content_type).toBe('text/csv')

    console.log(`  DB9 attachment e2e: saved and retrieved ${emailId} with 1 attachment`)
  })

  test('getAttachment returns text content from db9', async () => {
    // Find the attachment email we saved above
    const emails = await provider.getEmails(mailbox, { limit: 10 })
    const attEmail = emails.find(e => e.subject === 'DB9 attachment e2e test')
    expect(attEmail).toBeTruthy()

    const detail = await provider.getEmail(attEmail!.id)
    expect(detail?.attachments?.length).toBeGreaterThanOrEqual(1)

    const att = detail!.attachments![0]!
    const download = await provider.getAttachment!(att.id)
    expect(download).not.toBeNull()
    expect(download!.filename).toBe('test-data.csv')
    expect(new TextDecoder().decode(download!.data)).toContain('header1')

    console.log(`  DB9 getAttachment: downloaded ${download!.filename}`)
  })

  test('search finds emails by attachment text content via FTS', async () => {
    const results = await provider.searchEmails(mailbox, { query: 'header1' })
    expect(results.length).toBeGreaterThanOrEqual(1)
    const match = results.find(e => e.subject === 'DB9 attachment e2e test')
    expect(match).toBeTruthy()

    console.log(`  DB9 attachment search: found ${results.length} result(s) for 'header1'`)
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
