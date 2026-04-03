import { describe, test, expect } from 'bun:test'
import { recordEvent } from '../../worker/src/handlers/events'

// Minimal D1 mock
function mockDB() {
  const rows: Record<string, unknown>[] = []
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          rows.push({ sql, args })
          return { meta: { changes: 1 } }
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    }),
    batch: async (stmts: unknown[]) => stmts,
    _rows: rows,
  }
}

function mockEnv(db = mockDB()) {
  return { DB: db as unknown as D1Database } as any
}

describe('SSE Events', () => {
  test('recordEvent inserts into events table', async () => {
    const db = mockDB()
    const env = mockEnv(db)

    await recordEvent(env, 'message.received', 'agent@mails0.com', {
      email_id: 'abc-123',
      from: 'sender@test.com',
    })

    expect(db._rows.length).toBe(1)
    expect(db._rows[0]!.sql).toContain('INSERT INTO events')
  })

  test('recordEvent does not throw on DB error', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => { throw new Error('DB unavailable') },
          }),
        }),
      },
    } as any

    // Should not throw
    await recordEvent(env, 'message.received', 'agent@mails0.com', {})
  })
})
