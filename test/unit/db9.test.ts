import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createDb9Provider } from '../../src/providers/storage/db9'
import type { Email } from '../../src/core/types'

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'test-1',
    mailbox: 'agent@test.com',
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: 'agent@test.com',
    subject: 'Test',
    body_text: 'Hello',
    body_html: '<p>Hello</p>',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    received_at: '2025-01-01T00:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('db9 provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('init executes CREATE TABLE', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.init()
    expect(executedQuery).toContain('CREATE TABLE IF NOT EXISTS emails')
  })

  test('saveEmail executes INSERT', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail())
    expect(executedQuery).toContain('INSERT INTO emails')
    expect(executedQuery).toContain('test-1')
    expect(executedQuery).toContain('agent@test.com')
  })

  test('saveEmail escapes single quotes', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ subject: "It's a test" }))
    expect(executedQuery).toContain("It''s a test")
  })

  test('saveEmail handles null code', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ code: null }))
    expect(executedQuery).toContain('NULL')
  })

  test('saveEmail handles non-null code', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 1 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.saveEmail(makeEmail({ code: '123456' }))
    expect(executedQuery).toContain("'123456'")
  })

  test('getEmails returns parsed emails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['e-1', 'agent@test.com', 'sender@x.com', 'Sender', 'agent@test.com', 'Hi', 'Hello', '', null, '{}', '{}', 'inbound', 'received', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.getEmails('agent@test.com')
    expect(emails).toHaveLength(1)
    expect(emails[0]!.id).toBe('e-1')
    expect(emails[0]!.subject).toBe('Hi')
    expect(emails[0]!.direction).toBe('inbound')
  })

  test('getEmails filters by direction', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getEmails('agent@test.com', { direction: 'outbound' })
    expect(executedQuery).toContain("direction = 'outbound'")
  })

  test('getEmail returns single email', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, '{}', '{}', 'inbound', 'received', '2025-01-01', '2025-01-01'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const email = await provider.getEmail('e-1')
    expect(email).not.toBeNull()
    expect(email!.id).toBe('e-1')
  })

  test('getEmail returns null when not found', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    expect(await provider.getEmail('nope')).toBeNull()
  })

  test('searchEmails builds hybrid FTS query', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.searchEmails('agent@test.com', {
      query: `"reset password" OR owner's`,
      direction: 'inbound',
      limit: 5,
    })

    expect(executedQuery).toContain("websearch_to_tsquery('simple'")
    expect(executedQuery).toContain("to_tsvector('simple'")
    expect(executedQuery).toContain('ts_rank(')
    expect(executedQuery).toContain('from_address ILIKE')
    expect(executedQuery).toContain('code ILIKE')
    expect(executedQuery).toContain("direction = 'inbound'")
    expect(executedQuery).toContain("owner''s")
  })

  test('searchEmails returns parsed emails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['search-1', 'agent@test.com', 'sender@x.com', 'Sender', 'agent@test.com', 'Reset password', 'Hello', '', '123456', '{}', '{}', 'inbound', 'received', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.searchEmails('agent@test.com', { query: 'reset' })
    expect(emails).toHaveLength(1)
    expect(emails[0]!.id).toBe('search-1')
    expect(emails[0]!.code).toBe('123456')
  })

  test('getCode returns code on first poll', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['code', 'from_address', 'subject'],
        rows: [['999888', 'noreply@svc.com', 'Your code']],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getCode('agent@test.com', { timeout: 3 })
    expect(result).not.toBeNull()
    expect(result!.code).toBe('999888')
    expect(result!.from).toBe('noreply@svc.com')
  })

  test('getCode returns null on timeout', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ columns: ['code', 'from_address', 'subject'], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const result = await provider.getCode('agent@test.com', { timeout: 1 })
    expect(result).toBeNull()
  })

  test('getCode includes since filter', async () => {
    let executedQuery = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      executedQuery = body.query
      return new Response(JSON.stringify({ columns: ['code', 'from_address', 'subject'], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    await provider.getCode('agent@test.com', { timeout: 1, since: '2025-06-01T00:00:00Z' })
    expect(executedQuery).toContain('2025-06-01')
  })

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Unauthorized', { status: 401 })
    }) as typeof fetch

    const provider = createDb9Provider('bad-token', 'db-123')
    expect(provider.init()).rejects.toThrow('db9 error (401)')
  })

  test('sends correct auth header', async () => {
    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('my-secret-token', 'db-123')
    await provider.init()
    expect(authHeader).toBe('Bearer my-secret-token')
  })

  test('uses correct database URL', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ columns: [], rows: [], row_count: 0 }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'my-db-id')
    await provider.init()
    expect(requestUrl).toBe('https://api.db9.ai/customer/databases/my-db-id/sql')
  })

  test('getEmails handles JSONB object headers', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({
        columns: ['id', 'mailbox', 'from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html', 'code', 'headers', 'metadata', 'direction', 'status', 'received_at', 'created_at'],
        rows: [
          ['e-1', 'a@b.com', 's@x.com', '', 'a@b.com', 'Sub', 'Body', '', null, { 'X-Custom': 'val' }, { key: 'value' }, 'inbound', 'received', '2025-01-01', '2025-01-01'],
        ],
        row_count: 1,
      }))
    }) as typeof fetch

    const provider = createDb9Provider('token', 'db-123')
    const emails = await provider.getEmails('a@b.com')
    expect(emails[0]!.headers).toEqual({ 'X-Custom': 'val' })
    expect(emails[0]!.metadata).toEqual({ key: 'value' })
  })
})
