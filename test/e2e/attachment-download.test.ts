/**
 * E2E: attachment receive + download.
 *
 * Part A — OSS worker (test.mails.dev): attachment metadata
 *   1. Send email with attachments TO e2e@test.mails.dev
 *   2. Wait for arrival
 *   3. Verify inbox list shows has_attachments / attachment_count
 *   4. Verify email detail includes attachment metadata
 *
 * Part B — Hosted worker (mails.dev): attachment binary download
 *   5. Send email with attachment TO e2etest@mails.dev
 *   6. Wait for arrival
 *   7. Download attachment via /v1/attachment and verify content
 *
 * Requires .env with:
 *   RESEND_API_KEY=re_xxx
 *   OSS_WORKER_URL, OSS_WORKER_TOKEN, OSS_MAILBOX   (Part A)
 *   E2E_MAILBOX, E2E_API_KEY                         (Part B)
 *
 * Run: bun test test/e2e/attachment-download.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import { createResendProvider } from '../../src/providers/send/resend'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const WORKER_URL = process.env.WORKER_URL || 'https://mails-dev-worker.o-u-turing.workers.dev'

// Part A: OSS worker (test.mails.dev)
const OSS_WORKER_URL = process.env.OSS_WORKER_URL || 'https://mails-oss-test.o-u-turing.workers.dev'
const OSS_WORKER_TOKEN = process.env.OSS_WORKER_TOKEN || ''
const OSS_MAILBOX = process.env.OSS_MAILBOX || 'e2e@test.mails.dev'

// Part B: Hosted worker (mails.dev)
const E2E_MAILBOX = process.env.E2E_MAILBOX || ''
const E2E_API_KEY = process.env.E2E_API_KEY || ''

const UNIQUE_TAG = `att-${Date.now()}`
const CSV_CONTENT = `name,score\nalice,100\nbob,95\n${UNIQUE_TAG}`
const TXT_CONTENT = `Attachment E2E.\nTag: ${UNIQUE_TAG}`

const SAVE_DIR = join(import.meta.dir, '..', '.e2e-att-downloads')

// ─── Part A: OSS worker — attachment metadata ───────────────────────────

const skipOss = !RESEND_API_KEY || !OSS_WORKER_TOKEN

let ossEmailId = ''

describe.skipIf(skipOss)('E2E attachment: OSS worker (test.mails.dev) — metadata', () => {
  beforeAll(() => {
    console.log(`  OSS Worker: ${OSS_WORKER_URL}`)
    console.log(`  Mailbox: ${OSS_MAILBOX}`)
    console.log(`  Tag: ${UNIQUE_TAG}`)
  })

  test('1. send email with attachments TO self-hosted mailbox', async () => {
    const resend = createResendProvider(RESEND_API_KEY!)
    const result = await resend.send({
      from: 'mails att-e2e <noreply@kimeeru.com>',
      to: [OSS_MAILBOX],
      subject: `[att-e2e] ${UNIQUE_TAG}`,
      text: `Attachment test. Tag: ${UNIQUE_TAG}`,
      attachments: [
        {
          filename: 'data.csv',
          content: Buffer.from(CSV_CONTENT).toString('base64'),
          content_type: 'text/csv',
        },
        {
          filename: 'notes.txt',
          content: Buffer.from(TXT_CONTENT).toString('base64'),
          content_type: 'text/plain',
        },
      ],
    })

    console.log(`  Sent with 2 attachments: ${result.id}`)
    expect(result.id).toBeTruthy()
  })

  test('2. wait for email to arrive via Email Routing', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const emails = await provider.getEmails(OSS_MAILBOX, { limit: 5 })
      const match = emails.find(e => e.subject.includes(UNIQUE_TAG))
      if (match) {
        ossEmailId = match.id
        console.log(`  Arrived: ${match.id} — ${match.subject}`)
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }

    expect(ossEmailId).toBeTruthy()
  }, 50000)

  test('3. inbox list shows has_attachments and attachment_count', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const emails = await provider.getEmails(OSS_MAILBOX, { limit: 5 })
    const email = emails.find(e => e.id === ossEmailId)

    expect(email).toBeTruthy()
    expect(email!.has_attachments).toBe(true)
    expect(email!.attachment_count).toBeGreaterThanOrEqual(2)
    console.log(`  has_attachments: ${email!.has_attachments}, count: ${email!.attachment_count}`)
  })

  test('4. email detail includes attachment metadata', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const detail = await provider.getEmail(ossEmailId)
    expect(detail).not.toBeNull()
    expect(detail!.attachments).toBeDefined()
    expect(detail!.attachments!.length).toBeGreaterThanOrEqual(2)

    const filenames = detail!.attachments!.map(a => a.filename)
    expect(filenames).toContain('data.csv')
    expect(filenames).toContain('notes.txt')

    for (const att of detail!.attachments!) {
      expect(att.id).toBeTruthy()
      expect(att.content_type).toBeTruthy()
      console.log(`  Attachment: ${att.id} — ${att.filename} (${att.content_type}, ${att.size_bytes} bytes)`)
    }

    // OSS worker extracts text from text attachments
    const csvAtt = detail!.attachments!.find(a => a.filename === 'data.csv')
    if (csvAtt?.text_content) {
      expect(csvAtt.text_content).toContain(UNIQUE_TAG)
      console.log(`  CSV text extracted: ${csvAtt.text_content.slice(0, 50)}...`)
    }
  })
})

// ─── Part B: Hosted worker — attachment binary download ─────────────────

const skipHosted = !RESEND_API_KEY || !E2E_MAILBOX || !E2E_API_KEY

let hostedEmailId = ''
let hostedAttachmentIds: string[] = []

describe.skipIf(skipHosted)('E2E attachment: hosted (mails.dev) — download', () => {
  beforeAll(() => {
    console.log(`  Hosted Worker: ${WORKER_URL}`)
    console.log(`  Mailbox: ${E2E_MAILBOX}`)
    console.log(`  Tag: ${UNIQUE_TAG}`)
  })

  afterAll(() => {
    if (existsSync(SAVE_DIR)) rmSync(SAVE_DIR, { recursive: true })
  })

  test('5. send email with attachments TO hosted mailbox', async () => {
    const resend = createResendProvider(RESEND_API_KEY!)
    const result = await resend.send({
      from: 'mails att-e2e <noreply@kimeeru.com>',
      to: [E2E_MAILBOX],
      subject: `[att-e2e] ${UNIQUE_TAG}`,
      text: `Attachment download test. Tag: ${UNIQUE_TAG}`,
      attachments: [
        {
          filename: 'data.csv',
          content: Buffer.from(CSV_CONTENT).toString('base64'),
          content_type: 'text/csv',
        },
        {
          filename: 'notes.txt',
          content: Buffer.from(TXT_CONTENT).toString('base64'),
          content_type: 'text/plain',
        },
      ],
    })

    console.log(`  Sent with 2 attachments: ${result.id}`)
    expect(result.id).toBeTruthy()
  })

  test('6. wait for email to arrive', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: E2E_MAILBOX,
      apiKey: E2E_API_KEY,
      token: E2E_API_KEY,
    })

    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const emails = await provider.getEmails(E2E_MAILBOX, { limit: 5 })
      const match = emails.find(e => e.subject.includes(UNIQUE_TAG))
      if (match) {
        hostedEmailId = match.id
        console.log(`  Arrived: ${match.id} — ${match.subject}`)
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }

    expect(hostedEmailId).toBeTruthy()
  }, 50000)

  test('7. email detail includes attachment metadata', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: E2E_MAILBOX,
      apiKey: E2E_API_KEY,
      token: E2E_API_KEY,
    })

    const detail = await provider.getEmail(hostedEmailId)
    expect(detail).not.toBeNull()
    expect(detail!.attachments).toBeDefined()
    expect(detail!.attachments!.length).toBeGreaterThanOrEqual(2)

    for (const att of detail!.attachments!) {
      console.log(`  Attachment: ${att.id} — ${att.filename} (${att.content_type})`)
    }

    hostedAttachmentIds = detail!.attachments!.map(a => a.id)
    const filenames = detail!.attachments!.map(a => a.filename)
    expect(filenames).toContain('data.csv')
    expect(filenames).toContain('notes.txt')
  })

  test('8. download attachment binary via /v1/attachment', async () => {
    expect(hostedAttachmentIds.length).toBeGreaterThanOrEqual(2)

    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: E2E_MAILBOX,
      apiKey: E2E_API_KEY,
      token: E2E_API_KEY,
    })

    for (const attId of hostedAttachmentIds) {
      const download = await provider.getAttachment!(attId)
      expect(download).not.toBeNull()

      const content = new TextDecoder().decode(download!.data)
      console.log(`  Downloaded: ${download!.filename} (${download!.contentType}, ${download!.data.byteLength} bytes)`)

      if (download!.filename === 'data.csv') {
        expect(content).toContain('name,score')
        expect(content).toContain(UNIQUE_TAG)
      } else if (download!.filename === 'notes.txt') {
        expect(content).toContain('Attachment E2E')
        expect(content).toContain(UNIQUE_TAG)
      }
    }
  })

  test('9. /v1/attachment returns 404 for invalid id', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: E2E_MAILBOX,
      apiKey: E2E_API_KEY,
      token: E2E_API_KEY,
    })

    const result = await provider.getAttachment!('nonexistent-id')
    expect(result).toBeNull()
  })

  test('10. download and save attachments to disk', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: E2E_MAILBOX,
      apiKey: E2E_API_KEY,
      token: E2E_API_KEY,
    })

    const detail = await provider.getEmail(hostedEmailId)
    expect(detail!.attachments!.length).toBeGreaterThanOrEqual(2)

    mkdirSync(SAVE_DIR, { recursive: true })

    for (const att of detail!.attachments!) {
      const download = await provider.getAttachment!(att.id)
      expect(download).not.toBeNull()

      const dest = join(SAVE_DIR, download!.filename)
      writeFileSync(dest, Buffer.from(download!.data))
      console.log(`  Saved: ${dest}`)
      expect(existsSync(dest)).toBe(true)
    }

    // Verify saved file contents
    const csvPath = join(SAVE_DIR, 'data.csv')
    if (existsSync(csvPath)) {
      const csv = await readFile(csvPath, 'utf-8')
      expect(csv).toContain(UNIQUE_TAG)
      console.log(`  Verified: data.csv contains tag`)
    }

    const txtPath = join(SAVE_DIR, 'notes.txt')
    if (existsSync(txtPath)) {
      const txt = await readFile(txtPath, 'utf-8')
      expect(txt).toContain(UNIQUE_TAG)
      console.log(`  Verified: notes.txt contains tag`)
    }
  })
})
