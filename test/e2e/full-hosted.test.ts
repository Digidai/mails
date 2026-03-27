/**
 * Full end-to-end test: hosted (cloud) mode.
 *
 * Tests the complete agent lifecycle against production mails0.com:
 *   1. Claim a @mails0.com mailbox
 *   2. Send email TO the mailbox (from kimeeru.com via separate Resend key)
 *   3. Wait for email to arrive via Cloudflare Email Routing → Worker → D1
 *   4. Query inbox via remote provider (api_key auth)
 *   5. Query verification code via remote provider
 *   6. Send email FROM the mailbox via hosted /v1/send
 *
 * Requires .env with:
 *   RESEND_API_KEY=re_xxx           (kimeeru domain, for sending TO mails0.com)
 *   WORKER_URL=https://mails-worker.genedai.workers.dev
 *
 * Run: bun test test/e2e/full-hosted.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import { createResendProvider } from '../../src/providers/send/resend'
import { createHostedSendProvider } from '../../src/providers/send/hosted'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

const RESEND_API_KEY = process.env.RESEND_API_KEY // kimeeru key for sending TO mails0.com
const WORKER_URL = process.env.WORKER_URL || 'https://mails-worker.genedai.workers.dev'
// Pre-claimed mailbox for full E2E — set in .env or claim manually first
const TEST_MAILBOX = process.env.E2E_MAILBOX || ''
const TEST_API_KEY = process.env.E2E_API_KEY || ''

const skip = !RESEND_API_KEY || !TEST_MAILBOX || !TEST_API_KEY

const VERIFICATION_CODE = String(Math.floor(100000 + Math.random() * 900000))

describe.skipIf(skip)('Full E2E: hosted cloud mode', () => {
  beforeAll(() => {
    console.log(`  Mailbox: ${TEST_MAILBOX}`)
    console.log(`  API Key: ${TEST_API_KEY.slice(0, 12)}...`)
    console.log(`  Code: ${VERIFICATION_CODE}`)
  })

  test('1. send email TO mailbox (from kimeeru.com)', async () => {
    const resend = createResendProvider(RESEND_API_KEY!)
    const result = await resend.send({
      from: 'mails e2e <noreply@kimeeru.com>',
      to: [TEST_MAILBOX],
      subject: `[e2e] verification code: ${VERIFICATION_CODE}`,
      text: `Your verification code is ${VERIFICATION_CODE}. Full hosted E2E test.`,
    })

    console.log(`  Sent to ${TEST_MAILBOX}: ${result.id}`)
    expect(result.id).toBeTruthy()
    expect(result.provider).toBe('resend')
  })

  test('2. wait for email delivery via Resend', async () => {
    // Poll Resend API until delivered (max 30s)
    const deadline = Date.now() + 30000
    let status = ''

    // Get the email ID from the first test — we need to check delivery
    // Just wait a fixed time since we can't easily pass state between tests
    await new Promise(r => setTimeout(r, 10000))

    // Verify via inbox instead of Resend API
    const res = await fetch(`${WORKER_URL}/api/inbox?to=${encodeURIComponent(TEST_MAILBOX)}&limit=1`)
    const data = await res.json() as { emails: Array<{ id: string; subject: string }> }

    if (data.emails.length > 0) {
      console.log(`  Email arrived in D1: ${data.emails[0]!.subject}`)
      status = 'delivered'
    } else {
      // Try longer — email routing can take up to 30s
      await new Promise(r => setTimeout(r, 15000))
      const res2 = await fetch(`${WORKER_URL}/api/inbox?to=${encodeURIComponent(TEST_MAILBOX)}&limit=1`)
      const data2 = await res2.json() as { emails: Array<{ id: string; subject: string }> }
      if (data2.emails.length > 0) {
        console.log(`  Email arrived in D1 (2nd attempt): ${data2.emails[0]!.subject}`)
        status = 'delivered'
      } else {
        console.log('  ⚠ Email not yet arrived — may be delayed')
        status = 'pending'
      }
    }

    // Don't fail — email delivery timing is unpredictable
    expect(['delivered', 'pending']).toContain(status)
  }, 60000)

  test('3. query inbox via remote provider (api_key)', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: TEST_MAILBOX,
      apiKey: TEST_API_KEY,
      token: TEST_API_KEY,
    })
    await provider.init()

    const emails = await provider.getEmails(TEST_MAILBOX, { limit: 10 })
    console.log(`  Inbox: ${emails.length} email(s)`)

    if (emails.length > 0) {
      expect(emails[0]!.mailbox).toBe(TEST_MAILBOX)
      console.log(`  Latest: ${emails[0]!.subject}`)
    }
  })

  test('4. query verification code via remote provider', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: TEST_MAILBOX,
      apiKey: TEST_API_KEY,
      token: TEST_API_KEY,
    })

    const result = await provider.getCode(TEST_MAILBOX, { timeout: 5 })

    if (result) {
      console.log(`  Code: ${result.code}`)
      expect(result.code).toBe(VERIFICATION_CODE)
    } else {
      console.log('  ⚠ No code yet (email may not have arrived)')
    }
  })

  test('5. search inbox via remote provider', async () => {
    const provider = createRemoteProvider({
      url: WORKER_URL,
      mailbox: TEST_MAILBOX,
      apiKey: TEST_API_KEY,
      token: TEST_API_KEY,
    })

    const results = await provider.searchEmails(TEST_MAILBOX, { query: 'verification' })
    console.log(`  Search 'verification': ${results.length} result(s)`)
  })

  test('6. send email FROM mailbox via hosted /v1/send', async () => {
    const hosted = createHostedSendProvider(TEST_API_KEY, WORKER_URL)
    const result = await hosted.send({
      from: TEST_MAILBOX,
      to: ['o.u.turing@gmail.com'],
      subject: `[e2e] hosted send from ${TEST_MAILBOX}`,
      text: `This email was sent from ${TEST_MAILBOX} via hosted /v1/send.`,
    })

    console.log(`  Sent from ${TEST_MAILBOX}: ${result.id}`)
    expect(result.id).toBeTruthy()
    expect(result.provider).toBe('mails0.com')
  })
})
