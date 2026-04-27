import { describe, test, expect } from 'bun:test'

describe('Mailbox PATCH/DELETE', () => {
  test('PATCH /api/mailbox updates webhook_url', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')

    let updatedUrl: string | null = null
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              if (sql.includes('UPDATE')) updatedUrl = args[0] as string
              return { meta: { changes: 1 } }
            },
            first: async () => ({ mailbox: 'test@test.com', webhook_url: null, status: 'active', created_at: '2026-01-01' }),
          }),
        }),
      },
    } as any

    const request = new Request('http://localhost/api/mailbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_url: 'https://example.com/hook' }),
    })

    const res = await handleMailbox(request, env, 'test@test.com')
    expect(res.status).toBe(200)
    const data = await res.json() as { webhook_url: string }
    expect(data.webhook_url).toBe('https://example.com/hook')
    expect(updatedUrl).toBe('https://example.com/hook')
  })

  test('DELETE /api/mailbox cascade deletes all data', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')

    const deletedTables: string[] = []
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
        batch: async (stmts: any[]) => {
          for (const stmt of stmts) {
            deletedTables.push('batch-delete')
          }
          return []
        },
      },
    } as any

    const request = new Request('http://localhost/api/mailbox', { method: 'DELETE' })
    const res = await handleMailbox(request, env, 'test@test.com')
    expect(res.status).toBe(200)
    const data = await res.json() as { ok: boolean; deleted: string }
    expect(data.ok).toBe(true)
    expect(data.deleted).toBe('test@test.com')
  })

  test('DELETE /api/mailbox deletes attachment storage_key blobs', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')

    const deletedKeys: string[] = []
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            all: async () => {
              if (sql.includes('SELECT raw_key')) {
                return { results: [{ raw_key: 'raw/test/1' }] }
              }
              if (sql.includes('SELECT storage_key')) {
                return { results: [{ storage_key: 'attachments/test/1' }] }
              }
              return { results: [] }
            },
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
        batch: async () => [],
      },
      ATTACHMENTS: {
        delete: async (key: string) => { deletedKeys.push(key) },
      },
    } as any

    const request = new Request('http://localhost/api/mailbox', { method: 'DELETE' })
    const res = await handleMailbox(request, env, 'test@test.com')
    const data = await res.json() as { r2_blobs_deleted: number }

    expect(res.status).toBe(200)
    expect(deletedKeys).toEqual(['raw/test/1', 'attachments/test/1'])
    expect(data.r2_blobs_deleted).toBe(2)
  })

  test('PATCH /api/mailbox rejects invalid JSON', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const env = { DB: {} } as any
    const request = new Request('http://localhost/api/mailbox', {
      method: 'PATCH',
      body: 'not json',
    })
    const res = await handleMailbox(request, env, 'test@test.com')
    expect(res.status).toBe(400)
  })

  test('handleMailbox requires mailbox', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const env = { DB: {} } as any
    const request = new Request('http://localhost/api/mailbox', { method: 'GET' })
    const res = await handleMailbox(request, env)
    expect(res.status).toBe(400)
  })

  // Regression tests for Phase 1/2 Agent team findings
  const makeRequest = (body: unknown) => new Request('http://localhost/api/mailbox', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const stubEnv = () => ({
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => ({ mailbox: 'test@test.com', webhook_url: 'https://existing.com/hook' }),
        }),
      }),
    },
  } as any)

  test('PATCH rejects javascript: URL (XSS prevention)', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 'javascript:alert(1)' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toMatch(/http|https/i)
  })

  test('PATCH rejects non-URL string', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 'not-a-url' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(400)
  })

  test('PATCH rejects private webhook URLs', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 'http://127.0.0.1/hook' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toContain('private')
  })

  test('PATCH rejects numeric webhook_url', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 123 }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(400)
  })

  test('PATCH accepts null to clear webhook_url', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: null }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(200)
  })

  test('PATCH accepts empty string to clear webhook_url', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: '' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(200)
  })

  test('PATCH ignores unknown fields (does NOT null webhook_url)', async () => {
    // Regression: PATCH {random_field: "xyz"} previously nulled webhook_url.
    // Now it should return current state with a "nothing updated" note.
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ random_field: 'xyz' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(200)
    const data = await res.json() as { webhook_url: string; note?: string }
    expect(data.webhook_url).toBe('https://existing.com/hook')
    expect(data.note).toContain('No recognized fields')
  })

  test('PATCH rejects array body', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest([1, 2, 3]), stubEnv(), 'test@test.com')
    expect(res.status).toBe(400)
  })

  test('PATCH accepts http:// URL', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 'http://example.com/hook' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(200)
  })

  test('PATCH accepts https:// URL', async () => {
    const { handleMailbox } = await import('../../worker/src/handlers/mailbox')
    const res = await handleMailbox(makeRequest({ webhook_url: 'https://example.com/hook' }), stubEnv(), 'test@test.com')
    expect(res.status).toBe(200)
  })
})
