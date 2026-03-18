import { describe, expect, test } from 'bun:test'

describe('index exports', () => {
  test('exports searchInbox', async () => {
    const mod = await import('../../src/index')
    expect(typeof mod.searchInbox).toBe('function')
  })
})
