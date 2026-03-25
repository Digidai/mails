import { describe, expect, test } from 'bun:test'

describe('index exports', () => {
  test('exports searchInbox', async () => {
    const mod = await import('../../src/index')
    expect(typeof mod.searchInbox).toBe('function')
  })

  test('exports createWorkerSendProvider', async () => {
    const mod = await import('../../src/index')
    expect(typeof mod.createWorkerSendProvider).toBe('function')
  })

  test('exports resetStorage', async () => {
    const mod = await import('../../src/index')
    expect(typeof mod.resetStorage).toBe('function')
  })

  test('exports deleteEmail', async () => {
    const mod = await import('../../src/index')
    expect(typeof mod.deleteEmail).toBe('function')
  })
})
