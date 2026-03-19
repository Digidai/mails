import { describe, expect, test, afterEach, mock } from 'bun:test'
import { createRemoteProvider } from '../../src/providers/storage/remote'
import type { Email, Attachment } from '../../src/core/types'

const API = 'http://localhost:9999'
const MAILBOX = 'agent@mails.dev'

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-001',
    email_id: 'email-1',
    filename: 'report.pdf',
    content_type: 'application/pdf',
    size_bytes: 1024,
    content_disposition: 'attachment',
    content_id: null,
    mime_part_index: 0,
    text_content: '',
    text_extraction_status: 'unsupported',
    storage_key: null,
    downloadable: false,
    created_at: '2026-03-20T00:00:00Z',
    ...overrides,
  }
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    mailbox: MAILBOX,
    from_address: 'sender@example.com',
    from_name: 'Sender',
    to_address: MAILBOX,
    subject: 'Report Q1',
    body_text: 'See attached report.',
    body_html: '',
    code: null,
    headers: {},
    metadata: {},
    direction: 'inbound',
    status: 'received',
    has_attachments: true,
    attachment_count: 1,
    received_at: '2026-03-20T10:00:00Z',
    created_at: '2026-03-20T10:00:00Z',
    ...overrides,
  }
}

describe('Remote provider: attachment download', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // --- 1. getEmail returns attachment metadata ---

  test('1. getEmail returns email with attachment metadata from /v1/email', async () => {
    const attachment = makeAttachment()
    const email = makeEmail({ attachments: [attachment] })

    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify(email))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getEmail('email-1')

    expect(requestUrl).toContain('/v1/email')
    expect(requestUrl).toContain('id=email-1')
    expect(result).not.toBeNull()
    expect(result!.has_attachments).toBe(true)
    expect(result!.attachments).toHaveLength(1)
    expect(result!.attachments![0]!.id).toBe('att-001')
    expect(result!.attachments![0]!.filename).toBe('report.pdf')
    expect(result!.attachments![0]!.content_type).toBe('application/pdf')
    expect(result!.attachments![0]!.size_bytes).toBe(1024)
  })

  test('2. getEmail returns email with multiple attachments', async () => {
    const email = makeEmail({
      attachment_count: 3,
      attachments: [
        makeAttachment({ id: 'a1', filename: 'doc.pdf', content_type: 'application/pdf', size_bytes: 5000 }),
        makeAttachment({ id: 'a2', filename: 'data.csv', content_type: 'text/csv', size_bytes: 200 }),
        makeAttachment({ id: 'a3', filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: 30000 }),
      ],
    })

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(email))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getEmail('email-1')

    expect(result!.attachments).toHaveLength(3)
    expect(result!.attachments![0]!.filename).toBe('doc.pdf')
    expect(result!.attachments![1]!.filename).toBe('data.csv')
    expect(result!.attachments![2]!.filename).toBe('photo.jpg')
  })

  // --- 2. getAttachment downloads binary ---

  test('3. getAttachment downloads binary from /v1/attachment', async () => {
    const pdfContent = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF magic bytes
    let requestUrl = ''
    let authHeader = ''

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      requestUrl = url
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? ''
      return new Response(pdfContent, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="report.pdf"',
        },
      })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getAttachment!('att-001')

    expect(requestUrl).toContain('/v1/attachment')
    expect(requestUrl).toContain('id=att-001')
    expect(authHeader).toBe('Bearer mk_test')
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('report.pdf')
    expect(result!.contentType).toBe('application/pdf')
    expect(new Uint8Array(result!.data)).toEqual(pdfContent)
  })

  test('4. getAttachment uses /api/attachment in public mode', async () => {
    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="data.csv"',
        },
      })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX })
    const result = await provider.getAttachment!('att-002')

    expect(requestUrl).toContain('/api/attachment')
    expect(requestUrl).toContain('id=att-002')
    expect(result!.filename).toBe('data.csv')
    expect(result!.contentType).toBe('text/csv')
  })

  test('5. getAttachment returns null for 404', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getAttachment!('nonexistent')

    expect(result).toBeNull()
  })

  test('6. getAttachment throws on server error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    expect(provider.getAttachment!('att-err')).rejects.toThrow('API error')
  })

  test('7. getAttachment falls back to "download" when no filename in header', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(new Uint8Array([0]), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getAttachment!('att-noname')

    expect(result!.filename).toBe('download')
    expect(result!.contentType).toBe('application/octet-stream')
  })

  // --- 3. Full flow: list → detail → download ---

  test('8. full flow: inbox list shows attachment count, detail shows metadata, download works', async () => {
    const attachment = makeAttachment({ id: 'att-flow-1', filename: 'notes.txt', content_type: 'text/plain', size_bytes: 11 })
    const email = makeEmail({
      id: 'flow-email-1',
      attachment_count: 1,
      attachments: [attachment],
    })
    const fileContent = new TextEncoder().encode('hello world')

    let callCount = 0
    globalThis.fetch = mock(async (url: string) => {
      callCount++
      if ((url as string).includes('/v1/inbox')) {
        return new Response(JSON.stringify({
          emails: [{
            id: email.id,
            mailbox: email.mailbox,
            from_address: email.from_address,
            from_name: email.from_name,
            subject: email.subject,
            code: null,
            direction: 'inbound',
            status: 'received',
            received_at: email.received_at,
            has_attachments: true,
            attachment_count: 1,
          }],
        }))
      }
      if ((url as string).includes('/v1/email')) {
        return new Response(JSON.stringify(email))
      }
      if ((url as string).includes('/v1/attachment')) {
        return new Response(fileContent, {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Disposition': 'attachment; filename="notes.txt"',
          },
        })
      }
      return new Response('Not found', { status: 404 })
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })

    // Step 1: list inbox — should show has_attachments
    const inbox = await provider.getEmails(MAILBOX)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.has_attachments).toBe(true)
    expect(inbox[0]!.attachment_count).toBe(1)

    // Step 2: get email detail — should include attachment metadata
    const detail = await provider.getEmail('flow-email-1')
    expect(detail!.attachments).toHaveLength(1)
    expect(detail!.attachments![0]!.id).toBe('att-flow-1')
    expect(detail!.attachments![0]!.filename).toBe('notes.txt')

    // Step 3: download attachment — should get binary content
    const download = await provider.getAttachment!('att-flow-1')
    expect(download).not.toBeNull()
    expect(download!.filename).toBe('notes.txt')
    expect(download!.contentType).toBe('text/plain')
    expect(new TextDecoder().decode(download!.data)).toBe('hello world')

    expect(callCount).toBe(3)
  })

  // --- 4. mails.dev API response format (size vs size_bytes) ---

  test('9. handles mails.dev attachment format (size field instead of size_bytes)', async () => {
    // mails.dev returns { size } not { size_bytes } in attachment records
    const apiResponse = {
      id: 'email-compat',
      mailbox: MAILBOX,
      from_address: 'sender@test.com',
      from_name: '',
      to_address: MAILBOX,
      subject: 'compat test',
      body_text: 'test',
      body_html: '',
      code: null,
      direction: 'inbound',
      status: 'received',
      has_attachments: 1,
      attachments: [
        { id: 'a1', filename: 'file.zip', content_type: 'application/zip', size: 99999, disposition: 'attachment' },
      ],
      received_at: '2026-03-20T00:00:00Z',
      created_at: '2026-03-20T00:00:00Z',
    }

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(apiResponse))
    }) as typeof fetch

    const provider = createRemoteProvider({ url: API, mailbox: MAILBOX, apiKey: 'mk_test', token: 'mk_test' })
    const result = await provider.getEmail('email-compat')

    expect(result).not.toBeNull()
    expect(result!.attachments).toHaveLength(1)
    const att = result!.attachments![0]! as Record<string, unknown>
    expect(att.filename).toBe('file.zip')
    expect(att.content_type).toBe('application/zip')
    expect(att.size ?? att.size_bytes).toBe(99999)
  })
})
