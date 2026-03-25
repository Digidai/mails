import type { Env } from '../types'

export async function handleGetEmail(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  // If mailbox is known (from auth_tokens), scope query to that mailbox
  let emailQuery = 'SELECT * FROM emails WHERE id = ?'
  const emailParams: string[] = [id]
  if (mailbox) {
    emailQuery += ' AND mailbox = ?'
    emailParams.push(mailbox)
  }

  const row = await env.DB.prepare(emailQuery).bind(...emailParams).first<{
    id: string
    mailbox: string
    from_address: string
    from_name: string
    to_address: string
    subject: string
    body_text: string
    body_html: string
    code: string | null
    headers: string
    metadata: string
    direction: 'inbound' | 'outbound'
    status: 'received' | 'sent' | 'failed' | 'queued'
    message_id: string | null
    has_attachments: number
    attachment_count: number
    attachment_names: string
    attachment_search_text: string
    raw_storage_key: string | null
    received_at: string
    created_at: string
  }>()

  if (!row) return Response.json({ error: 'Email not found' }, { status: 404 })

  const attachments = await env.DB.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
  ).bind(id).all<{
    id: string
    email_id: string
    filename: string
    content_type: string
    size_bytes: number | null
    content_disposition: string | null
    content_id: string | null
    mime_part_index: number
    text_content: string
    text_extraction_status: string
    storage_key: string | null
    created_at: string
  }>()

  return Response.json({
    ...row,
    headers: safeJsonParse(row.headers, {}),
    metadata: safeJsonParse(row.metadata, {}),
    has_attachments: Boolean(row.has_attachments),
    attachment_count: row.attachment_count ?? 0,
    attachments: attachments.results.map((attachment) => ({
      ...attachment,
      downloadable: Boolean(attachment.storage_key),
    })),
  })
}

export async function handleDeleteEmail(url: URL, env: Env, mailbox?: string): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  // Verify email exists and belongs to this mailbox
  let checkQuery = 'SELECT id, mailbox FROM emails WHERE id = ?'
  const checkParams: string[] = [id]
  if (mailbox) {
    checkQuery += ' AND mailbox = ?'
    checkParams.push(mailbox)
  }

  const email = await env.DB.prepare(checkQuery).bind(...checkParams).first<{ id: string; mailbox: string }>()
  if (!email) return Response.json({ error: 'Email not found' }, { status: 404 })

  // Get attachment storage_keys for R2 cleanup
  const attachments = await env.DB.prepare(
    'SELECT storage_key FROM attachments WHERE email_id = ?'
  ).bind(id).all<{ storage_key: string | null }>()

  // Delete email + attachments from D1 (FTS5 delete trigger handles emails_fts)
  // Scope DELETE by mailbox for defense-in-depth (prevents TOCTOU race)
  let deleteEmailSql = 'DELETE FROM emails WHERE id = ?'
  const deleteParams: string[] = [id]
  if (mailbox) {
    deleteEmailSql += ' AND mailbox = ?'
    deleteParams.push(mailbox)
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments WHERE email_id = ?').bind(id),
    env.DB.prepare(deleteEmailSql).bind(...deleteParams),
  ])

  // Clean up R2 objects (best-effort, don't fail the request)
  if (env.ATTACHMENTS) {
    for (const att of attachments.results) {
      if (att.storage_key) {
        try {
          await env.ATTACHMENTS.delete(att.storage_key)
        } catch {
          console.error(`Failed to delete R2 object: ${att.storage_key}`)
        }
      }
    }
  }

  return Response.json({ deleted: true })
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
