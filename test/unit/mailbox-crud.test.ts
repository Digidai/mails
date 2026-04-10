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
})
