import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { createWorkerSendProvider } from '../../src/providers/send/worker'

describe('Worker send provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends email via /api/send', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    let capturedHeaders: Record<string, string> = {}

    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body as string)
      capturedHeaders = init.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'resend-123' }))
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://my-worker.example.com', 'my-token')
    const result = await provider.send({
      from: 'agent@example.com',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello',
    })

    expect(result.id).toBe('resend-123')
    expect(result.provider).toBe('worker')
    expect(capturedUrl).toBe('https://my-worker.example.com/api/send')
    expect(capturedHeaders['Authorization']).toBe('Bearer my-token')
    expect(capturedHeaders['Content-Type']).toBe('application/json')
    expect(capturedBody.from).toBe('agent@example.com')
    expect(capturedBody.to).toEqual(['user@example.com'])
    expect(capturedBody.subject).toBe('Test')
    expect(capturedBody.text).toBe('Hello')
  })

  test('sends without auth token when not provided', async () => {
    let capturedHeaders: Record<string, string> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'msg-1' }))
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://worker.example.com')
    await provider.send({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Test',
      text: 'Body',
    })

    expect(capturedHeaders['Authorization']).toBeUndefined()
  })

  test('includes html and reply_to when provided', async () => {
    let capturedBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg-2' }))
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://worker.example.com', 'tok')
    await provider.send({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Test',
      html: '<h1>Hi</h1>',
      replyTo: 'reply@example.com',
    })

    expect(capturedBody.html).toBe('<h1>Hi</h1>')
    expect(capturedBody.reply_to).toBe('reply@example.com')
    expect(capturedBody.text).toBeUndefined()
  })

  test('includes attachments when provided', async () => {
    let capturedBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'msg-3' }))
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://worker.example.com', 'tok')
    await provider.send({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'Test',
      text: 'See attached',
      attachments: [
        { filename: 'test.pdf', content: 'base64data', contentType: 'application/pdf' },
      ],
    })

    const attachments = capturedBody.attachments as Array<Record<string, string>>
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe('test.pdf')
    expect(attachments[0]!.content).toBe('base64data')
    expect(attachments[0]!.content_type).toBe('application/pdf')
  })

  test('throws on error response', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://worker.example.com', 'bad-token')

    expect(
      provider.send({
        from: 'a@b.com',
        to: ['c@d.com'],
        subject: 'Test',
        text: 'Body',
      })
    ).rejects.toThrow('Worker send error: Unauthorized')
  })

  test('wraps network errors with Worker URL context', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch

    const provider = createWorkerSendProvider('https://worker.example.com', 'tok')

    expect(
      provider.send({
        from: 'a@b.com',
        to: ['c@d.com'],
        subject: 'Test',
        text: 'Body',
      })
    ).rejects.toThrow('Cannot connect to Worker at https://worker.example.com')
  })

  test('provider name is worker', () => {
    const provider = createWorkerSendProvider('https://worker.example.com')
    expect(provider.name).toBe('worker')
  })
})
