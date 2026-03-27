/**
 * Live E2E test — sends real emails and tests receive via mails0.com worker.
 *
 * Requires .env with:
 *   RESEND_API_KEY=re_xxx
 *   DEFAULT_FROM=Name <noreply@yourdomain.com>  (must NOT be @mails0.com to avoid suppression)
 *   TEST_TO=your-email@example.com
 *   WORKER_URL=https://mails-worker.genedai.workers.dev
 *
 * Run:  bun test test/e2e/live.test.ts
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import { createResendProvider } from '../../src/providers/send/resend'
import { send } from '../../src/core/send'
import { setConfigValue } from '../../src/core/config'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const DEFAULT_FROM = process.env.DEFAULT_FROM
const TEST_TO = process.env.TEST_TO
const WORKER_URL = process.env.WORKER_URL || 'https://mails-worker.genedai.workers.dev'

const skip = !RESEND_API_KEY || !DEFAULT_FROM || !TEST_TO

// Unique mailbox for this test run to avoid collisions
const testMailbox = `e2e-${Date.now()}@mails0.com`

describe.skipIf(skip)('Live E2E: send emails', () => {
  beforeAll(() => {
    setConfigValue('resend_api_key', RESEND_API_KEY!)
    setConfigValue('default_from', DEFAULT_FROM!)
  })

  test('send plain text email', async () => {
    const provider = createResendProvider(RESEND_API_KEY!)
    const result = await provider.send({
      from: DEFAULT_FROM!,
      to: [TEST_TO!],
      subject: `[mails live test] Plain text — ${new Date().toISOString()}`,
      text: 'This is a live E2E test from the mails CLI.',
    })

    console.log(`  Sent plain text: ${result.id}`)
    expect(result.id).toBeTruthy()
    expect(result.provider).toBe('resend')
  })

  test('send HTML email', async () => {
    const provider = createResendProvider(RESEND_API_KEY!)
    const result = await provider.send({
      from: DEFAULT_FROM!,
      to: [TEST_TO!],
      subject: `[mails live test] HTML — ${new Date().toISOString()}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">mails live test</h2>
          <p>This HTML email was sent by the <code>mails</code> CLI E2E test suite.</p>
          <p style="color: #666; font-size: 12px;">Sent at ${new Date().toISOString()}</p>
        </div>
      `,
    })

    console.log(`  Sent HTML: ${result.id}`)
    expect(result.id).toBeTruthy()
  })

  test('send via unified send() function', async () => {
    const result = await send({
      to: TEST_TO!,
      subject: `[mails live test] SDK send() — ${new Date().toISOString()}`,
      text: 'Sent using the mails SDK send() function.',
    })

    console.log(`  Sent via send(): ${result.id}`)
    expect(result.id).toBeTruthy()
    expect(result.provider).toBe('resend')
  })
})

describe.skipIf(skip)('Live E2E: receive emails via mails0.com worker', () => {
  const verificationCode = String(Math.floor(100000 + Math.random() * 900000))
  let sentEmailId = ''

  beforeAll(() => {
    setConfigValue('resend_api_key', RESEND_API_KEY!)
  })

  test('send email to mails0.com mailbox', async () => {
    const provider = createResendProvider(RESEND_API_KEY!)
    const result = await provider.send({
      from: DEFAULT_FROM!,
      to: [testMailbox],
      subject: `[e2e] verification code: ${verificationCode}`,
      text: `Your verification code is ${verificationCode}. This is an automated test.`,
    })

    sentEmailId = result.id
    console.log(`  Sent to ${testMailbox}: ${result.id} (code: ${verificationCode})`)
    expect(result.id).toBeTruthy()
  })

  test('wait for email delivery via Resend API', async () => {
    // Poll Resend until delivered (max 30s)
    const deadline = Date.now() + 30000
    let status = ''

    while (Date.now() < deadline) {
      const res = await fetch(`https://api.resend.com/emails/${sentEmailId}`, {
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
      })
      const data = await res.json() as { last_event: string }
      status = data.last_event

      if (status === 'delivered') break
      if (status === 'bounced' || status === 'suppressed') break

      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`  Resend delivery status: ${status}`)
    expect(status).toBe('delivered')
  }, 35000)

  test('query inbox via worker API', async () => {
    // Wait a bit for worker to process
    await new Promise(r => setTimeout(r, 3000))

    const res = await fetch(`${WORKER_URL}/api/inbox?to=${encodeURIComponent(testMailbox)}&limit=10`)
    const data = await res.json() as { emails: Array<{ id: string; subject: string; code: string | null }> }

    console.log(`  Inbox has ${data.emails.length} email(s)`)
    expect(data.emails.length).toBeGreaterThanOrEqual(1)

    const email = data.emails[0]!
    expect(email.subject).toContain(verificationCode)
    expect(email.code).toBe(verificationCode)
  })

  test('query verification code via worker API', async () => {
    const res = await fetch(`${WORKER_URL}/api/code?to=${encodeURIComponent(testMailbox)}&timeout=5`)
    const data = await res.json() as { code: string | null; from: string; subject: string }

    console.log(`  Code: ${data.code}`)
    expect(data.code).toBe(verificationCode)
  })

  test('get email detail via worker API', async () => {
    // First get the email ID from inbox
    const inboxRes = await fetch(`${WORKER_URL}/api/inbox?to=${encodeURIComponent(testMailbox)}`)
    const inbox = await inboxRes.json() as { emails: Array<{ id: string }> }
    const emailId = inbox.emails[0]!.id

    const res = await fetch(`${WORKER_URL}/api/email?id=${emailId}`)
    const email = await res.json() as { id: string; body_text: string; code: string; from_name: string }

    console.log(`  Email detail: ${email.id}`)
    expect(email.body_text).toContain(verificationCode)
    expect(email.code).toBe(verificationCode)
  })
})
