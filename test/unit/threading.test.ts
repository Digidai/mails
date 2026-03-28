import { describe, expect, test, mock } from 'bun:test'
import { resolveThreadId } from '../../worker/src/threading.js'

/**
 * Mock DB that supports both:
 *  - .first() for In-Reply-To single lookups
 *  - .all()  for References batch IN(...) lookups
 */
function mockDB(results: Record<string, { thread_id: string } | null> = {}) {
  return {
    prepare: mock((sql: string) => ({
      bind: mock((...args: unknown[]) => ({
        first: mock(async () => {
          const messageId = args[0] as string
          return results[messageId] ?? null
        }),
        all: mock(async () => {
          // For IN(...) queries, args are [ref1, ref2, ..., mailbox]
          // Return all matching results
          const matched: Array<{ message_id: string; thread_id: string }> = []
          for (const arg of args) {
            const r = results[arg as string]
            if (r) {
              matched.push({ message_id: arg as string, thread_id: r.thread_id })
            }
          }
          return { results: matched }
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

  test('treats empty string in_reply_to as null', async () => {
    const db = mockDB({})
    const result = await resolveThreadId('', null, '<msg@example.com>', db, 'test@mails0.com')
    expect(result).toMatch(/^[0-9a-f]{8}-/)
    // Should NOT have called prepare with empty string lookup
  })

  test('treats whitespace-only in_reply_to as null', async () => {
    const db = mockDB({})
    const result = await resolveThreadId('  ', null, '<msg@example.com>', db, 'test@mails0.com')
    expect(result).toMatch(/^[0-9a-f]{8}-/)
  })

  test('handles RFC 2822 folded references header', async () => {
    const db = mockDB({ '<msg-1@example.com>': { thread_id: 'thread-folded' } })
    // RFC 2822 allows folding with CRLF + whitespace
    const foldedRefs = '<msg-0@example.com>\r\n <msg-1@example.com>'
    const result = await resolveThreadId(null, foldedRefs, '<msg-2@example.com>', db, 'test@mails0.com')
    expect(result).toBe('thread-folded')
  })

  test('handles LF-only folded references header', async () => {
    const db = mockDB({ '<msg-1@example.com>': { thread_id: 'thread-lf' } })
    const foldedRefs = '<msg-0@example.com>\n <msg-1@example.com>'
    const result = await resolveThreadId(null, foldedRefs, '<msg-2@example.com>', db, 'test@mails0.com')
    expect(result).toBe('thread-lf')
  })

  test('treats empty string references as null', async () => {
    const db = mockDB({})
    const result = await resolveThreadId(null, '', '<msg@example.com>', db, 'test@mails0.com')
    expect(result).toMatch(/^[0-9a-f]{8}-/)
  })
})
