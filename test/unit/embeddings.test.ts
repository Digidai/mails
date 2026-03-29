import { describe, expect, test, mock } from 'bun:test'
import { buildEmbeddingText, generateAndStoreEmbedding, semanticSearch } from '../../worker/src/embeddings.js'
import type { Env } from '../../worker/src/types.js'

describe('buildEmbeddingText', () => {
  test('combines subject, from name, and body text', () => {
    const result = buildEmbeddingText('Hello World', 'Alice', 'This is the body')
    expect(result).toBe('Hello World\nAlice\nThis is the body')
  })

  test('filters out empty parts', () => {
    const result = buildEmbeddingText('Subject only', '', '')
    expect(result).toBe('Subject only')
  })

  test('truncates body text to MAX_TEXT_LENGTH', () => {
    const longBody = 'x'.repeat(10000)
    const result = buildEmbeddingText('Sub', 'From', longBody)
    expect(result.length).toBeLessThan(8100)
  })

  test('handles all empty inputs', () => {
    const result = buildEmbeddingText('', '', '')
    expect(result).toBe('')
  })
})

describe('generateAndStoreEmbedding', () => {
  test('returns silently when AI binding is missing', async () => {
    const env = { DB: {} } as unknown as Env
    await generateAndStoreEmbedding(env, 'id-1', 'test@mails0.com', 'Sub', 'From', 'Body')
    // Should not throw
  })

  test('returns silently when VECTORIZE binding is missing', async () => {
    const env = { DB: {}, AI: {} } as unknown as Env
    await generateAndStoreEmbedding(env, 'id-1', 'test@mails0.com', 'Sub', 'From', 'Body')
    // Should not throw
  })

  test('returns silently when text is empty', async () => {
    const upsert = mock(async () => {})
    const env = {
      DB: {},
      AI: { run: mock(async () => ({ data: [[0.1, 0.2]] })) },
      VECTORIZE: { upsert },
    } as unknown as Env

    await generateAndStoreEmbedding(env, 'id-1', 'test@mails0.com', '', '', '')
    expect(upsert).not.toHaveBeenCalled()
  })

  test('generates embedding and upserts to Vectorize', async () => {
    const mockVector = Array(768).fill(0.1)
    const upsert = mock(async () => {})
    const env = {
      DB: {},
      AI: { run: mock(async () => ({ data: [mockVector] })) },
      VECTORIZE: { upsert },
    } as unknown as Env

    await generateAndStoreEmbedding(env, 'email-123', 'agent@mails0.com', 'Hello', 'Alice', 'Body text')

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0]
    expect(call[0][0].id).toBe('email-123')
    expect(call[0][0].values).toEqual(mockVector)
    expect(call[0][0].metadata).toEqual({ mailbox: 'agent@mails0.com' })
  })

  test('handles AI error gracefully', async () => {
    const env = {
      DB: {},
      AI: { run: mock(async () => { throw new Error('AI unavailable') }) },
      VECTORIZE: { upsert: mock(async () => {}) },
    } as unknown as Env

    // Should not throw
    await generateAndStoreEmbedding(env, 'id-1', 'test@mails0.com', 'Sub', 'From', 'Body')
  })
})

describe('semanticSearch', () => {
  test('returns empty when AI binding is missing', async () => {
    const env = { DB: {} } as unknown as Env
    const results = await semanticSearch(env, 'test query', 'agent@mails0.com')
    expect(results).toEqual([])
  })

  test('returns empty when VECTORIZE binding is missing', async () => {
    const env = { DB: {}, AI: {} } as unknown as Env
    const results = await semanticSearch(env, 'test query', 'agent@mails0.com')
    expect(results).toEqual([])
  })

  test('returns matched results from Vectorize', async () => {
    const queryVector = Array(768).fill(0.5)
    const env = {
      DB: {},
      AI: { run: mock(async () => ({ data: [queryVector] })) },
      VECTORIZE: {
        query: mock(async () => ({
          matches: [
            { id: 'email-1', score: 0.95 },
            { id: 'email-2', score: 0.82 },
          ],
        })),
      },
    } as unknown as Env

    const results = await semanticSearch(env, 'password reset', 'agent@mails0.com', 10)

    expect(results).toEqual([
      { id: 'email-1', score: 0.95 },
      { id: 'email-2', score: 0.82 },
    ])

    // Verify Vectorize was called with correct filter
    const vectorizeCall = (env.VECTORIZE!.query as ReturnType<typeof mock>).mock.calls[0]
    expect(vectorizeCall[0]).toEqual(queryVector)
    expect(vectorizeCall[1].filter).toEqual({ mailbox: 'agent@mails0.com' })
    expect(vectorizeCall[1].topK).toBe(10)
  })

  test('handles Vectorize error gracefully', async () => {
    const env = {
      DB: {},
      AI: { run: mock(async () => ({ data: [Array(768).fill(0.1)] })) },
      VECTORIZE: { query: mock(async () => { throw new Error('Vectorize down') }) },
    } as unknown as Env

    const results = await semanticSearch(env, 'test', 'agent@mails0.com')
    expect(results).toEqual([])
  })
})
