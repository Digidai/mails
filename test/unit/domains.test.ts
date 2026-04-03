import { describe, test, expect, mock, afterEach } from 'bun:test'
import { handleDomains } from '../../worker/src/handlers/domains'

function mockDB(rows: unknown[] = []) {
  const stmt = {
    all: async () => ({ results: rows }),
    first: async () => rows[0] ?? null,
    run: async () => ({ meta: { changes: rows.length > 0 ? 1 : 0 } }),
    bind: (...args: unknown[]) => stmt,
  }
  return {
    prepare: (sql: string) => stmt,
  } as unknown as D1Database
}

function mockEnv(db = mockDB()) {
  return { DB: db } as any
}

describe('Custom Domains Handler', () => {
  afterEach(() => { mock.restore() })

  test('GET /domains returns list', async () => {
    const db = mockDB([{ id: '1', domain: 'test.com', status: 'pending', mx_verified: 0, spf_verified: 0, dkim_verified: 0, created_at: '2026-04-03', verified_at: null }])
    const req = new Request('http://localhost/v1/domains', { method: 'GET' })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv(db))
    expect(res.status).toBe(200)
    const body = await res.json() as { domains: unknown[] }
    expect(body.domains).toHaveLength(1)
  })

  test('POST /domains creates domain and returns DNS records', async () => {
    const db = mockDB() // no existing domain
    const req = new Request('http://localhost/v1/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv(db))
    expect(res.status).toBe(201)
    const body = await res.json() as { domain: string; dns_records: Record<string, unknown> }
    expect(body.domain).toBe('example.com')
    expect(body.dns_records).toBeDefined()
    expect(body.dns_records.mx).toBeDefined()
    expect(body.dns_records.spf).toBeDefined()
  })

  test('POST /domains rejects invalid domain', async () => {
    const req = new Request('http://localhost/v1/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'nodot' }),
    })
    const url = new URL('http://localhost/api/domains')
    const res = await handleDomains(req, url, mockEnv())
    expect(res.status).toBe(400)
  })

  test('DELETE /domains/:id removes domain', async () => {
    const db = mockDB([{ id: '1' }])
    const req = new Request('http://localhost/v1/domains/1', { method: 'DELETE' })
    const url = new URL('http://localhost/api/domains/1')
    const res = await handleDomains(req, url, mockEnv(db))
    expect(res.status).toBe(200)
  })

  test('DELETE /domains/:id returns 404 for missing', async () => {
    const db = mockDB() // empty = no changes
    const req = new Request('http://localhost/v1/domains/999', { method: 'DELETE' })
    const url = new URL('http://localhost/api/domains/999')
    const res = await handleDomains(req, url, mockEnv(db))
    expect(res.status).toBe(404)
  })
})
