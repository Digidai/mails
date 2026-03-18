import { describe, expect, test } from 'bun:test'
import worker from '../../worker/src/index'

describe('worker HTTP auth', () => {
  test('rejects unauthenticated read requests when READ_TOKEN is set', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/api/attachment?id=att-1'),
      { READ_TOKEN: 'worker-secret' } as never
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})
