import type { Env } from '../types'
import { extractStructuredData, type ExtractionType } from '../extract-data'

const VALID_TYPES = new Set<ExtractionType>(['order', 'shipping', 'calendar', 'receipt', 'code'])

export async function handleExtract(request: Request, url: URL, env: Env, mailbox?: string): Promise<Response> {
  let body: { email_id?: string; type?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { email_id, type } = body
  if (!email_id) {
    return Response.json({ error: 'Missing email_id' }, { status: 400 })
  }
  if (!type || !VALID_TYPES.has(type as ExtractionType)) {
    return Response.json({ error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(', ')}` }, { status: 400 })
  }

  // Fetch the email with mailbox scoping for security
  let query = 'SELECT id, subject, body_text, from_address, from_name FROM emails WHERE id = ?'
  const params: unknown[] = [email_id]
  if (mailbox) {
    query += ' AND mailbox = ?'
    params.push(mailbox)
  }

  const email = await env.DB.prepare(query).bind(...params).first<{
    id: string
    subject: string
    body_text: string
    from_address: string
    from_name: string
  }>()

  if (!email) {
    return Response.json({ error: 'Email not found' }, { status: 404 })
  }

  // Fetch attachments for calendar extraction (use verified email.id, not raw user input)
  const { results: attachments } = await env.DB.prepare(
    'SELECT content_type, text_content FROM attachments WHERE email_id = ?'
  ).bind(email.id).all<{ content_type: string; text_content: string }>()

  const result = extractStructuredData(
    type as ExtractionType,
    email.subject ?? '',
    email.body_text ?? '',
    email.from_address,
    email.from_name ?? '',
    attachments ?? []
  )

  return Response.json({ email_id, extraction: result })
}
