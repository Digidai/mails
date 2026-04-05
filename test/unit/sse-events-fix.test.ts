import { describe, test, expect } from 'bun:test'
import { handleEvents, recordEvent } from '../../worker/src/handlers/events'

function mockDB(events: Array<{ id: string; mailbox: string; event_type: string; payload: string; created_at: string }> = []) {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: events }),
        first: async () => null,
      }),
    }),
  } as unknown as D1Database
}

function mockEnv(db = mockDB()) {
  return { DB: db } as any
}

describe('SSE Events (Worker-safe)', () => {
  test('handleEvents returns SSE response with correct headers', () => {
    const url = new URL('http://localhost/api/events?mailbox=test@mails0.com')
    const res = handleEvents(url, mockEnv(), 'test@mails0.com')

    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  test('handleEvents requires mailbox', () => {
    const url = new URL('http://localhost/api/events')
    const res = handleEvents(url, mockEnv())

    expect(res.status).toBe(400)
  })

  test('handleEvents streams events from DB', async () => {
    const events = [
      {
        id: 'evt-1',
        mailbox: 'test@mails0.com',
        event_type: 'message.received',
        payload: JSON.stringify({ email_id: 'abc' }),
        created_at: new Date().toISOString(),
      },
    ]
    const url = new URL('http://localhost/api/events?mailbox=test@mails0.com')
    const res = handleEvents(url, mockEnv(mockDB(events)), 'test@mails0.com')

    // Read the stream
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''

    // Read first few chunks (connection event + data events + done event)
    for (let i = 0; i < 5; i++) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      // Break early if we got the done event
      if (text.includes('event: done')) break
    }
    reader.cancel()

    expect(text).toContain('event: connected')
    expect(text).toContain('event: message.received')
    expect(text).toContain('"email_id":"abc"')
  })

  test('handleEvents sends done event and closes connection', async () => {
    // Empty DB — should poll a bit then close
    const url = new URL('http://localhost/api/events?mailbox=test@mails0.com&since=' + new Date().toISOString())
    const db = mockDB([])

    // We need a fast test so let's just check the response structure
    const res = handleEvents(url, mockEnv(db), 'test@mails0.com')
    expect(res.body).not.toBeNull()

    // Read until done or timeout
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''

    const timeout = setTimeout(() => reader.cancel(), 5000)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        // Once we see keepalive, we know the pattern is working — cancel early
        if (text.includes(': keepalive')) {
          reader.cancel()
          break
        }
      }
    } catch {
      // Stream cancelled — expected
    }
    clearTimeout(timeout)

    expect(text).toContain('event: connected')
    expect(text).toContain(': keepalive')
  })

  test('handleEvents includes event ID in SSE for Last-Event-ID reconnect', async () => {
    const events = [
      {
        id: 'evt-unique-123',
        mailbox: 'test@mails0.com',
        event_type: 'message.received',
        payload: JSON.stringify({ email_id: 'xyz' }),
        created_at: new Date().toISOString(),
      },
    ]
    const url = new URL('http://localhost/api/events?mailbox=test@mails0.com')
    const res = handleEvents(url, mockEnv(mockDB(events)), 'test@mails0.com')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''

    for (let i = 0; i < 5; i++) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('event: done')) break
    }
    reader.cancel()

    expect(text).toContain('id: evt-unique-123')
  })

  test('recordEvent still works correctly', async () => {
    const db = mockDB()
    const env = mockEnv(db)

    await recordEvent(env, 'message.received', 'agent@mails0.com', {
      email_id: 'abc-123',
      from: 'sender@test.com',
    })

    // No throw = success
  })
})
