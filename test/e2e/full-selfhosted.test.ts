/**
 * Full end-to-end test: self-hosted (open-source worker) mode.
 *
 * Tests the complete lifecycle against the deployed OSS worker at test.mails.dev:
 *   1. Send email TO e2e@test.mails.dev (from kimeeru.com)
 *   2. Email arrives via Cloudflare Email Routing → OSS Worker → D1
 *   3. CLI queries via remote provider (worker_url + worker_token)
 *   4. Search inbox
 *   5. Query verification code
 *
 * Requires .env with:
 *   RESEND_API_KEY=re_xxx              (kimeeru key, for sending TO test.mails.dev)
 *   OSS_WORKER_URL=https://mails-oss-test.o-u-turing.workers.dev
 *   OSS_WORKER_TOKEN=oss_e2e_xxx       (AUTH_TOKEN set on the worker)
 *   OSS_MAILBOX=e2e@test.mails.dev
 *
 * Run: bun test test/e2e/full-selfhosted.test.ts
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import { createResendProvider } from '../../src/providers/send/resend'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const OSS_WORKER_URL = process.env.OSS_WORKER_URL || 'https://mails-oss-test.o-u-turing.workers.dev'
const OSS_WORKER_TOKEN = process.env.OSS_WORKER_TOKEN || ''
const OSS_MAILBOX = process.env.OSS_MAILBOX || 'e2e@test.mails.dev'

const skip = !RESEND_API_KEY || !OSS_WORKER_TOKEN

const VERIFICATION_CODE = String(Math.floor(100000 + Math.random() * 900000))

describe.skipIf(skip)('Full E2E: self-hosted OSS worker', () => {
  beforeAll(() => {
    console.log(`  Worker: ${OSS_WORKER_URL}`)
    console.log(`  Mailbox: ${OSS_MAILBOX}`)
    console.log(`  Code: ${VERIFICATION_CODE}`)
  })

  test('1. send email TO self-hosted mailbox', async () => {
    const resend = createResendProvider(RESEND_API_KEY!)
    const result = await resend.send({
      from: 'mails oss-e2e <noreply@kimeeru.com>',
      to: [OSS_MAILBOX],
      subject: `[oss-e2e] code: ${VERIFICATION_CODE}`,
      text: `Your verification code is ${VERIFICATION_CODE}. Self-hosted E2E test.`,
    })

    console.log(`  Sent to ${OSS_MAILBOX}: ${result.id}`)
    expect(result.id).toBeTruthy()
  })

  test('2. wait for email to arrive via Email Routing', async () => {
    // Poll the worker API directly (with AUTH_TOKEN)
    const deadline = Date.now() + 30000
    let arrived = false

    while (Date.now() < deadline) {
      const res = await fetch(`${OSS_WORKER_URL}/api/inbox?to=${encodeURIComponent(OSS_MAILBOX)}&limit=1`, {
        headers: OSS_WORKER_TOKEN ? { Authorization: `Bearer ${OSS_WORKER_TOKEN}` } : {},
      })
      const data = await res.json() as { emails: Array<{ subject: string }> }
      if (data.emails.some(e => e.subject.includes(VERIFICATION_CODE))) {
        console.log(`  Email arrived: ${data.emails[0]!.subject}`)
        arrived = true
        break
      }
      await new Promise(r => setTimeout(r, 3000))
    }

    expect(arrived).toBe(true)
  }, 35000)

  test('3. query inbox via remote provider (worker_url + worker_token)', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const emails = await provider.getEmails(OSS_MAILBOX, { limit: 5 })
    console.log(`  Inbox: ${emails.length} email(s)`)
    expect(emails.length).toBeGreaterThanOrEqual(1)

    const latest = emails[0]!
    expect(latest.mailbox).toBe(OSS_MAILBOX)
  })

  test('4. search inbox via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const results = await provider.searchEmails(OSS_MAILBOX, { query: VERIFICATION_CODE })
    console.log(`  Search '${VERIFICATION_CODE}': ${results.length} result(s)`)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.subject).toContain(VERIFICATION_CODE)
  })

  test('5. query verification code via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const result = await provider.getCode(OSS_MAILBOX, { timeout: 5 })
    expect(result).not.toBeNull()
    console.log(`  Code: ${result!.code}`)
    expect(result!.code).toBe(VERIFICATION_CODE)
  })

  test('6. get email detail via remote provider', async () => {
    const provider = createRemoteProvider({
      url: OSS_WORKER_URL,
      mailbox: OSS_MAILBOX,
      token: OSS_WORKER_TOKEN || undefined,
    })

    const emails = await provider.getEmails(OSS_MAILBOX, { limit: 1 })
    const detail = await provider.getEmail(emails[0]!.id)
    expect(detail).not.toBeNull()
    expect(detail!.body_text).toContain(VERIFICATION_CODE)
    console.log(`  Detail: ${detail!.id} — ${detail!.subject}`)
  })
})
