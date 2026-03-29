import { describe, expect, test } from 'bun:test'

// Use dynamic imports with cache-busting to avoid mock.module() pollution
// from other test files (e.g. cli.test.ts) that run in the same process.
let counter = 0
async function freshIndex() {
  counter++
  return await import(`../../src/index.ts?t=idx_${counter}`)
}

describe('index exports', () => {
  test('exports searchInbox', async () => {
    const mod = await freshIndex()
    expect(typeof mod.searchInbox).toBe('function')
  })

  test('exports createWorkerSendProvider', async () => {
    const mod = await freshIndex()
    expect(typeof mod.createWorkerSendProvider).toBe('function')
  })

  test('exports resetStorage', async () => {
    const mod = await freshIndex()
    expect(typeof mod.resetStorage).toBe('function')
  })

  test('exports deleteEmail', async () => {
    const mod = await freshIndex()
    expect(typeof mod.deleteEmail).toBe('function')
  })
})
