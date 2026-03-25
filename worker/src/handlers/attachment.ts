import type { Env } from '../types'

export async function handleGetAttachment(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  // Get attachment metadata from D1
  let query = `
    SELECT a.* FROM attachments a
    JOIN emails e ON a.email_id = e.id
    WHERE a.id = ?`
  const params: string[] = [id]

  // If mailbox is known, scope to that mailbox (prevent cross-mailbox access)
  if (mailbox) {
    query += ' AND e.mailbox = ?'
    params.push(mailbox)
  }

  const attachment = await env.DB.prepare(query).bind(...params).first<{
    id: string
    filename: string
    content_type: string
    storage_key: string | null
    text_content: string
  }>()

  if (!attachment) return Response.json({ error: 'Attachment not found' }, { status: 404 })

  // If stored in R2, fetch from there
  if (attachment.storage_key && env.ATTACHMENTS) {
    const object = await env.ATTACHMENTS.get(attachment.storage_key)
    if (!object) {
      return Response.json({ error: 'Attachment file not found in storage' }, { status: 404 })
    }
    const safeFilename = attachment.filename.replace(/["\\]/g, '_')
    return new Response(object.body, {
      headers: {
        'Content-Type': attachment.content_type,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    })
  }

  // If text content is available, return it
  if (attachment.text_content) {
    const safeFilename = attachment.filename.replace(/["\\]/g, '_')
    return new Response(attachment.text_content, {
      headers: {
        'Content-Type': attachment.content_type,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    })
  }

  return Response.json({ error: 'Attachment content not available' }, { status: 404 })
}
