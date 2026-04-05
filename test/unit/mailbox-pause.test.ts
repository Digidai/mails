import { describe, test, expect } from 'bun:test'
import { handleMailbox, handleMailboxPause, handleMailboxResume } from '../../worker/src/handlers/mailbox'

function mockDB(row: Record<string, unknown> | null = null) {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => row,
        run: async () => ({ meta: { changes: row ? 1 : 0 } }),
      }),
    }),
  } as unknown as D1Database
}

function mockEnv(db = mockDB()) {
  return { DB: db } as any
}

describe('Mailbox Pause/Resume', () => {
  test('GET /api/mailbox returns mailbox info', async () => {
    const db = mockDB({
      mailbox: 'agent@mails0.com',
      webhook_url: 'https://hook.example.com',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const req = new Request('http://localhost/api/mailbox', { method: 'GET' })
    const res = await handleMailbox(req, mockEnv(db), 'agent@mails0.com')

    expect(res.status).toBe(200)
    const data = await res.json() as { mailbox: string; status: string; webhook_url: string }
    expect(data.mailbox).toBe('agent@mails0.com')
    expect(data.status).toBe('active')
    expect(data.webhook_url).toBe('https://hook.example.com')
  })

  test('GET /api/mailbox returns 400 without mailbox', async () => {
    const req = new Request('http://localhost/api/mailbox', { method: 'GET' })
    const res = await handleMailbox(req, mockEnv())
    expect(res.status).toBe(400)
  })

  test('GET /api/mailbox returns 404 for unknown mailbox', async () => {
    const req = new Request('http://localhost/api/mailbox', { method: 'GET' })
    const res = await handleMailbox(req, mockEnv(mockDB(null)), 'unknown@mails0.com')
    expect(res.status).toBe(404)
  })

  test('PATCH /api/mailbox/pause sets status to paused', async () => {
    let updatedStatus = ''
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("status = 'paused'")) updatedStatus = 'paused'
            return { meta: { changes: 1 } }
          },
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/mailbox/pause', { method: 'PATCH' })
    const res = await handleMailboxPause(req, mockEnv(db), 'agent@mails0.com')

    expect(res.status).toBe(200)
    const data = await res.json() as { mailbox: string; status: string }
    expect(data.status).toBe('paused')
    expect(updatedStatus).toBe('paused')
  })

  test('PATCH /api/mailbox/resume sets status to active', async () => {
    let updatedStatus = ''
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          run: async () => {
            if (sql.includes("status = 'active'")) updatedStatus = 'active'
            return { meta: { changes: 1 } }
          },
        }),
      }),
    } as unknown as D1Database

    const req = new Request('http://localhost/api/mailbox/resume', { method: 'PATCH' })
    const res = await handleMailboxResume(req, mockEnv(db), 'agent@mails0.com')

    expect(res.status).toBe(200)
    const data = await res.json() as { mailbox: string; status: string }
    expect(data.status).toBe('active')
    expect(updatedStatus).toBe('active')
  })

  test('pause rejects non-PATCH method', async () => {
    const req = new Request('http://localhost/api/mailbox/pause', { method: 'GET' })
    const res = await handleMailboxPause(req, mockEnv(), 'agent@mails0.com')
    expect(res.status).toBe(405)
  })

  test('resume rejects non-PATCH method', async () => {
    const req = new Request('http://localhost/api/mailbox/resume', { method: 'GET' })
    const res = await handleMailboxResume(req, mockEnv(), 'agent@mails0.com')
    expect(res.status).toBe(405)
  })

  test('pause requires mailbox', async () => {
    const req = new Request('http://localhost/api/mailbox/pause', { method: 'PATCH' })
    const res = await handleMailboxPause(req, mockEnv())
    expect(res.status).toBe(400)
  })

  test('resume requires mailbox', async () => {
    const req = new Request('http://localhost/api/mailbox/resume', { method: 'PATCH' })
    const res = await handleMailboxResume(req, mockEnv())
    expect(res.status).toBe(400)
  })
})
