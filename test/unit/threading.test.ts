import { describe, expect, test, mock } from 'bun:test'
import { resolveThreadId } from '../../worker/src/threading.js'

function mockDB(results: Record<string, { thread_id: string } | null> = {}) {
  return {
    prepare: mock((sql: string) => ({
      bind: mock((...args: unknown[]) => ({
        first: mock(async () => {
          const messageId = args[0] as string
          return results[messageId] ?? null
        }),
      })),
    })),
  } as unknown as D1Database
}

describe('resolveThreadId', () => {
  test('returns existing thread_id when in_reply_to matches', async () => {
    const db = mockDB({ '<msg-1@example.com>': { thread_id: 'thread-abc' } })
    const result = await resolveThreadId('<msg-1@example.com>', null, '<msg-2@example.com>', db, 'test@mails0.com')
    expect(result).toBe('thread-abc')
  })

  test('returns existing thread_id from references chain', async () => {
    const db = mockDB({ '<msg-0@example.com>': { thread_id: 'thread-xyz' } })
    const result = await resolveThreadId(null, '<msg-0@example.com> <msg-1@example.com>', '<msg-2@example.com>', db, 'test@mails0.com')
    // Should try msg-1 first (reversed), then msg-0
    expect(result).toBe('thread-xyz')
  })

  test('prefers latest reference in chain', async () => {
    const db = mockDB({
      '<msg-0@example.com>': { thread_id: 'thread-old' },
      '<msg-1@example.com>': { thread_id: 'thread-new' },
    })
    const result = await resolveThreadId(null, '<msg-0@example.com> <msg-1@example.com>', '<msg-2@example.com>', db, 'test@mails0.com')
    expect(result).toBe('thread-new')
  })

  test('generates new UUID when no match found', async () => {
    const db = mockDB({})
    const result = await resolveThreadId('<unknown@example.com>', null, '<msg-2@example.com>', db, 'test@mails0.com')
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('generates new UUID when both headers are null', async () => {
    const db = mockDB({})
    const result = await resolveThreadId(null, null, '<msg-1@example.com>', db, 'test@mails0.com')
    expect(result).toMatch(/^[0-9a-f]{8}-/)
  })

  test('in_reply_to takes priority over references', async () => {
    const db = mockDB({
      '<reply@example.com>': { thread_id: 'thread-reply' },
      '<ref@example.com>': { thread_id: 'thread-ref' },
    })
    const result = await resolveThreadId('<reply@example.com>', '<ref@example.com>', '<msg@example.com>', db, 'test@mails0.com')
    expect(result).toBe('thread-reply')
  })
})
