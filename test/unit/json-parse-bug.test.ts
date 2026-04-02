import { describe, test, expect, mock, afterEach } from 'bun:test'

describe('JSON parse silent failure fix', () => {
  afterEach(() => {
    mock.restore()
  })

  test('hosted provider throws on non-JSON 502 response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }))
    ) as typeof fetch

    try {
      const { createHostedSendProvider } = await import('../../src/providers/send/hosted.js')
      const provider = createHostedSendProvider('test-key')
      await expect(provider.send({
        from: 'a@test.com',
        to: ['b@test.com'],
        subject: 'Test',
        text: 'Hello',
      })).rejects.toThrow(/non-JSON response|Unexpected/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('worker provider throws on non-JSON 502 response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }))
    ) as typeof fetch

    try {
      const { createWorkerSendProvider } = await import('../../src/providers/send/worker.js')
      const provider = createWorkerSendProvider('http://localhost:8787')
      await expect(provider.send({
        from: 'a@test.com',
        to: ['b@test.com'],
        subject: 'Test',
        text: 'Hello',
      })).rejects.toThrow(/non-JSON response|Unexpected/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
