import { describe, test, expect } from 'bun:test'
import { handleClaimAuto, RESERVED_NAMES } from '../../worker/src/handlers/claim'

function mockDB(existingMailboxes: string[] = []) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT mailbox FROM auth_tokens WHERE mailbox')) {
            const mb = args[0] as string
            return existingMailboxes.includes(mb) ? { mailbox: mb } : null
          }
          return null
        },
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  } as unknown as D1Database
}

function mockEnv(db = mockDB()) {
  return { DB: db } as any
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/v1/claim/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Headless Claim (POST /v1/claim/auto)', () => {
  test('creates mailbox successfully', async () => {
    const auth = { mailbox: 'existing@mails0.com', scope: 'full' as const }
    const res = await handleClaimAuto(makeRequest({ name: 'newagent' }), mockEnv(), auth)

    expect(res.status).toBe(201)
    const data = await res.json() as { mailbox: string; api_key: string }
    expect(data.mailbox).toBe('newagent@mails0.com')
    expect(data.api_key).toMatch(/^mk_/)
  })

  test('rejects missing name', async () => {
    const auth = { mailbox: 'a@mails0.com', scope: 'full' as const }
    const res = await handleClaimAuto(makeRequest({}), mockEnv(), auth)
    expect(res.status).toBe(400)
  })

  test('rejects reserved names', async () => {
    const auth = { mailbox: 'a@mails0.com', scope: 'full' as const }
    const res = await handleClaimAuto(makeRequest({ name: 'admin' }), mockEnv(), auth)
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('reserved')
  })

  test('rejects invalid name format', async () => {
    const auth = { mailbox: 'a@mails0.com', scope: 'full' as const }

    const res2 = await handleClaimAuto(makeRequest({ name: 'has spaces' }), mockEnv(), auth)
    expect(res2.status).toBe(400)

    const res3 = await handleClaimAuto(makeRequest({ name: '-start-dash' }), mockEnv(), auth)
    expect(res3.status).toBe(400)

    const res4 = await handleClaimAuto(makeRequest({ name: 'a'.repeat(50) }), mockEnv(), auth)
    expect(res4.status).toBe(400)
  })

  test('rejects duplicate mailbox', async () => {
    const auth = { mailbox: 'a@mails0.com', scope: 'full' as const }
    const db = mockDB(['taken@mails0.com'])
    const res = await handleClaimAuto(makeRequest({ name: 'taken' }), mockEnv(db), auth)
    expect(res.status).toBe(409)
  })

  test('rejects non-POST method', async () => {
    const auth = { mailbox: 'a@mails0.com', scope: 'full' as const }
    const req = new Request('http://localhost/v1/claim/auto', { method: 'GET' })
    const res = await handleClaimAuto(req, mockEnv(), auth)
    expect(res.status).toBe(405)
  })

  test('RESERVED_NAMES includes common system names', () => {
    expect(RESERVED_NAMES.has('admin')).toBe(true)
    expect(RESERVED_NAMES.has('postmaster')).toBe(true)
    expect(RESERVED_NAMES.has('abuse')).toBe(true)
    expect(RESERVED_NAMES.has('support')).toBe(true)
    expect(RESERVED_NAMES.has('noreply')).toBe(true)
    expect(RESERVED_NAMES.has('test')).toBe(true)
    expect(RESERVED_NAMES.has('api')).toBe(true)
  })
})
