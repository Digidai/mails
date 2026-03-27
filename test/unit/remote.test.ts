import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'

const API = 'http://localhost:9999'
const MAILBOX = 'agent@test.com'

describe('Remote provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // --- Public mode (self-hosted, no apiKey) ---

  test('getEmails calls /api/inbox with ?to= in public mode', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [{ id: '1', subject: 'Test' }] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.init()
    const emails = await provider.getEmails(MAILBOX, { limit: 5, direction: 'inbound' })

    expect(requestUrl).toContain('/api/inbox')
    expect(requestUrl).toContain('to=agent%40test.com')
    expect(requestUrl).toContain('limit=5')
    expect(requestUrl).toContain('direction=inbound')
    expect(emails).toHaveLength(1)
  })

  test('getCode calls /api/code with ?to= in public mode', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ code: '123456', from: 'a@b.com', subject: 'Code' }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const result = await provider.getCode(MAILBOX, { timeout: 5 })

    expect(requestUrl).toContain('/api/code')
    expect(requestUrl).toContain('to=agent%40test.com')
    expect(requestUrl).toContain('timeout=5')
    expect(result).toEqual({ code: '123456', from: 'a@b.com', subject: 'Code' })
  })

  test('getCode returns null when no code', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ code: null }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(await provider.getCode(MAILBOX, { timeout: 1 })).toBeNull()
  })

  test('getEmail calls /api/email', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'e1', subject: 'Detail' }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const email = await provider.getEmail('e1')
    expect(email).not.toBeNull()
    expect(email!.id).toBe('e1')
  })

  test('getEmail returns null for 404', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(await provider.getEmail('nope')).toBeNull()
  })

  test('searchEmails calls /api/inbox with ?query=', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.searchEmails(MAILBOX, { query: 'reset', limit: 10, direction: 'outbound' })

    expect(requestUrl).toContain('/api/inbox')
    expect(requestUrl).toContain('query=reset')
    expect(requestUrl).toContain('direction=outbound')
  })

  test('saveEmail throws read-only error', async () => {
    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.saveEmail({} as any)).rejects.toThrow('read-only')
  })

  // --- Authenticated mode (mails0.com hosted, with apiKey) ---

  test('uses /v1/* paths and Bearer header when apiKey is set', async () => {
    let requestUrl = ''
    let authHeader = ''
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      requestUrl = url
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? ''
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    await provider.getEmails(MAILBOX)

    expect(requestUrl).toContain('/v1/inbox')
    expect(requestUrl).not.toContain('to=')
    expect(authHeader).toBe('Bearer mk_test')
  })

  test('uses /v1/code without ?to= when apiKey is set', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ code: null }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    await provider.getCode(MAILBOX, { timeout: 3, since: '2025-01-01' })

    expect(requestUrl).toContain('/v1/code')
    expect(requestUrl).not.toContain('to=')
    expect(requestUrl).toContain('since=2025-01-01')
  })

  // --- Self-hosted with worker_token ---

  test('sends Bearer header with worker_token in public mode', async () => {
    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? ''
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, token: 'myworkertoken' })
    await provider.getEmails(MAILBOX)

    expect(authHeader).toBe('Bearer myworkertoken')
  })

  // --- Error handling ---

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getEmails(MAILBOX)).rejects.toThrow('API error')
  })

  test('throws on search API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.searchEmails(MAILBOX, { query: 'x' })).rejects.toThrow('API error')
  })

  test('throws on code API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getCode(MAILBOX)).rejects.toThrow('API error')
  })

  test('throws on email detail API error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    expect(provider.getEmail('x')).rejects.toThrow('API error')
  })

  // --- Default params ---

  test('uses defaults when no options provided', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ emails: [] }))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    await provider.getEmails(MAILBOX)
    expect(requestUrl).toContain('limit=20')
    expect(requestUrl).toContain('offset=0')
  })
})
