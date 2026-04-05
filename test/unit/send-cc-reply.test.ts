import { describe, test, expect, mock, afterEach } from 'bun:test'
import { handleSend, checkSuppressionList, extractEmail, parseFromName } from '../../worker/src/handlers/send'

// Minimal D1 mock
function mockDB(options: {
  suppressedEmails?: Record<string, string>
  dailyCounts?: Record<string, number>
  referencedMessage?: { thread_id: string | null; message_id: string | null; in_reply_to: string | null; references: string | null } | null
} = {}) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('suppression_list')) {
            const email = args[0] as string
            if (options.suppressedEmails?.[email]) {
              return { email, reason: options.suppressedEmails[email] }
            }
            return null
          }
          if (sql.includes('daily_send_counts')) {
            const mailbox = args[0] as string
            const count = options.dailyCounts?.[mailbox] ?? 0
            return count > 0 ? { count } : null
          }
          if (sql.includes('thread_id') && sql.includes('message_id')) {
            return options.referencedMessage ?? null
          }
          return null
        },
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database
}

function mockEnv(db = mockDB(), resendApiKey = 'test-key') {
  return {
    DB: db,
    RESEND_API_KEY: resendApiKey,
  } as any
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Send with CC, BCC, and inReplyTo', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('passes cc and bcc to Resend API', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'resend-1' }))
    }) as typeof fetch

    const res = await handleSend(
      makeRequest({
        from: 'test@example.com',
        to: ['a@b.com'],
        cc: ['cc1@b.com', 'cc2@b.com'],
        bcc: ['bcc@b.com'],
        subject: 'Test',
        text: 'Hello',
      }),
      mockEnv(),
    )

    expect(res.status).toBe(200)
    expect(capturedBody.cc).toEqual(['cc1@b.com', 'cc2@b.com'])
    expect(capturedBody.bcc).toEqual(['bcc@b.com'])
  })

  test('sets In-Reply-To and References headers when in_reply_to is provided', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'resend-2' }))
    }) as typeof fetch

    const db = mockDB({
      referencedMessage: {
        thread_id: 'thread-abc',
        message_id: '<original@example.com>',
        in_reply_to: null,
        references: '<root@example.com>',
      },
    })

    const res = await handleSend(
      makeRequest({
        from: 'test@example.com',
        to: ['a@b.com'],
        subject: 'Re: Test',
        text: 'Reply',
        in_reply_to: '<original@example.com>',
      }),
      mockEnv(db),
    )

    expect(res.status).toBe(200)
    const headers = capturedBody.headers as Record<string, string>
    expect(headers['In-Reply-To']).toBe('<original@example.com>')
    expect(headers['References']).toBe('<root@example.com> <original@example.com>')

    const data = await res.json() as { thread_id: string }
    expect(data.thread_id).toBe('thread-abc')
  })

  test('sets In-Reply-To header even when referenced message not found', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'resend-3' }))
    }) as typeof fetch

    const db = mockDB({ referencedMessage: null })

    const res = await handleSend(
      makeRequest({
        from: 'test@example.com',
        to: ['a@b.com'],
        subject: 'Re: Test',
        text: 'Reply',
        in_reply_to: '<missing@example.com>',
      }),
      mockEnv(db),
    )

    expect(res.status).toBe(200)
    const headers = capturedBody.headers as Record<string, string>
    expect(headers['In-Reply-To']).toBe('<missing@example.com>')
    expect(headers['References']).toBe('<missing@example.com>')
  })

  test('stores cc and bcc in metadata', async () => {
    let insertedMetadata = ''
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => null,
          run: async () => {
            if (sql.includes('INSERT INTO emails')) {
              // metadata is the 10th bind parameter (index 9)
              insertedMetadata = args[9] as string
            }
            return { meta: { changes: 1 } }
          },
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'resend-4' }))
    }) as typeof fetch

    await handleSend(
      makeRequest({
        from: 'test@example.com',
        to: ['a@b.com'],
        cc: ['cc@b.com'],
        bcc: ['bcc@b.com'],
        subject: 'Test',
        text: 'Body',
      }),
      mockEnv(db),
    )

    const metadata = JSON.parse(insertedMetadata)
    expect(metadata.cc).toEqual(['cc@b.com'])
    expect(metadata.bcc).toEqual(['bcc@b.com'])
  })

  test('does not include cc/bcc keys in Resend body when empty', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'resend-5' }))
    }) as typeof fetch

    await handleSend(
      makeRequest({
        from: 'test@example.com',
        to: ['a@b.com'],
        subject: 'Test',
        text: 'Hello',
      }),
      mockEnv(),
    )

    expect(capturedBody.cc).toBeUndefined()
    expect(capturedBody.bcc).toBeUndefined()
  })
})
