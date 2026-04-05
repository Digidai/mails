import { describe, test, expect, mock, afterEach } from 'bun:test'
import { handleDomains } from '../../worker/src/handlers/domains'

function mockDB(rows: unknown[] = [], opts: { singleDomain?: Record<string, unknown> } = {}) {
  const stmt = {
    all: async () => ({ results: rows }),
    first: async () => opts.singleDomain ?? rows[0] ?? null,
    run: async () => ({ meta: { changes: rows.length > 0 ? 1 : 0 } }),
    bind: (..._args: unknown[]) => stmt,
  }
  return {
    prepare: (_sql: string) => stmt,
  } as unknown as D1Database
}

function mockEnv(db = mockDB()) {
  return { DB: db } as any
}

describe('Custom Domains Extended', () => {
  afterEach(() => { mock.restore() })

  test('GET /domains/:id returns domain with DNS records', async () => {
    const domain = {
      id: 'dom-1',
      domain: 'example.com',
      status: 'pending',
      mx_verified: 0,
      spf_verified: 0,
      dkim_verified: 0,
      created_at: '2026-04-03T00:00:00.000Z',
      verified_at: null,
    }
    const db = mockDB([], { singleDomain: domain })

    const req = new Request('http://localhost/api/domains/dom-1', { method: 'GET' })
    const url = new URL('http://localhost/api/domains/dom-1')
    const res = await handleDomains(req, url, mockEnv(db))

    expect(res.status).toBe(200)
    const data = await res.json() as {
      id: string
      domain: string
      dns_records: Record<string, unknown>
    }
    expect(data.id).toBe('dom-1')
    expect(data.domain).toBe('example.com')
    expect(data.dns_records).toBeDefined()
    expect(data.dns_records.mx).toBeDefined()
    expect(data.dns_records.spf).toBeDefined()
    expect(data.dns_records.dmarc).toBeDefined()
  })

  test('GET /domains/:id returns 404 for missing domain', async () => {
    const db = mockDB([], { singleDomain: undefined as any })
    // Redefine to return null
    const dbNull = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/domains/nonexistent', { method: 'GET' })
    const url = new URL('http://localhost/api/domains/nonexistent')
    const res = await handleDomains(req, url, mockEnv(dbNull))

    expect(res.status).toBe(404)
  })

  test('POST /domains rejects duplicate domain', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: 'existing' }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'existing.com' }),
    })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv(db))

    expect(res.status).toBe(409)
  })

  test('POST /domains rejects domain with no dot', async () => {
    const req = new Request('http://localhost/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'nodots' }),
    })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv())

    expect(res.status).toBe(400)
  })

  test('POST /domains rejects domain exceeding 253 chars', async () => {
    const longDomain = 'a'.repeat(250) + '.com'
    const req = new Request('http://localhost/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: longDomain }),
    })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv())

    expect(res.status).toBe(400)
  })

  test('unsupported method returns 405', async () => {
    const req = new Request('http://localhost/api/domains', { method: 'PUT' })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv())

    expect(res.status).toBe(405)
  })

  test('POST /domains/:id/verify verifies with DNS', async () => {
    const domain = {
      id: 'dom-verify',
      domain: 'verify.com',
      status: 'pending',
      mx_verified: 0,
      spf_verified: 0,
      dkim_verified: 0,
      created_at: '2026-04-03',
      verified_at: null,
    }
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => domain,
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database

    // Mock DNS fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string) => {
      if (typeof url === 'string' && url.includes('type=MX')) {
        return new Response(JSON.stringify({ Answer: [{ data: '10 isaac.mx.cloudflare.net.' }] }))
      }
      if (typeof url === 'string' && url.includes('type=TXT')) {
        return new Response(JSON.stringify({ Answer: [{ data: '"v=spf1 include:amazonses.com ~all"' }] }))
      }
      return new Response(JSON.stringify({}))
    }) as typeof fetch

    const req = new Request('http://localhost/api/domains/dom-verify/verify', { method: 'POST' })
    const url = new URL('http://localhost/api/domains/dom-verify/verify')
    const res = await handleDomains(req, url, mockEnv(db))

    globalThis.fetch = originalFetch

    expect(res.status).toBe(200)
    const data = await res.json() as { status: string; mx_verified: boolean; spf_verified: boolean }
    expect(data.mx_verified).toBe(true)
    expect(data.spf_verified).toBe(true)
    expect(data.status).toBe('dns_verified')
  })
})
