import type { Env } from '../types'

export async function handleSend(request: Request, env: Env, mailbox?: string): Promise<Response> {
  if (!env.RESEND_API_KEY) {
    return Response.json(
      { error: 'Email sending is not available' },
      { status: 501 }
    )
  }

  let body: {
    from: string
    to: string[]
    subject: string
    text?: string
    html?: string
    reply_to?: string
    headers?: Record<string, string>
    attachments?: Array<{ filename: string; content: string; content_type?: string; content_id?: string }>
  }

  const contentType = request.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/json')) {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 })
  }

  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.from || !body.to?.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }

  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html body is required' }, { status: 400 })
  }

  if (body.to.length > 50) {
    return Response.json({ error: 'Too many recipients (max 50)' }, { status: 400 })
  }

  if (body.subject.length > 998) {
    return Response.json({ error: 'Subject too long (max 998 characters)' }, { status: 400 })
  }

  if ((body.text?.length ?? 0) > 500_000 || (body.html?.length ?? 0) > 1_000_000) {
    return Response.json({ error: 'Body too large' }, { status: 400 })
  }

  // Validate from address matches mailbox (if mailbox isolation is active)
  if (mailbox) {
    const fromEmail = extractEmail(body.from)
    if (fromEmail !== mailbox) {
      return Response.json(
        { error: `From address must match your mailbox: ${mailbox}` },
        { status: 403 }
      )
    }
  }

  // Build Resend API request
  const resendBody: Record<string, unknown> = {
    from: body.from,
    to: body.to,
    subject: body.subject,
  }
  if (body.text) resendBody.text = body.text
  if (body.html) resendBody.html = body.html
  if (body.reply_to) resendBody.reply_to = body.reply_to
  if (body.headers && Object.keys(body.headers).length > 0) {
    resendBody.headers = body.headers
  }
  if (body.attachments?.length) {
    resendBody.attachments = body.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.content_type ? { content_type: a.content_type } : {}),
      ...(a.content_id ? { content_id: a.content_id } : {}),
    }))
  }

  console.log(`Sending email from=${extractEmail(body.from)} to=${body.to.join(',')} subject="${body.subject.slice(0, 50)}"`)

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendBody),
  })

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({})) as { message?: string }
    const safeMessage = resendRes.status === 422
      ? (err.message ?? 'Validation error')
      : `Failed to send email (${resendRes.status})`
    console.error(`Send failed: ${safeMessage}`)
    return Response.json(
      { error: safeMessage },
      { status: resendRes.status }
    )
  }

  const resendData = await resendRes.json() as { id: string }

  // Record outbound email in D1
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const fromEmail = extractEmail(body.from)
  const fromName = parseFromName(body.from)
  const attachmentNames = body.attachments?.map(a => a.filename).join(', ') ?? ''

  await env.DB.prepare(`
    INSERT INTO emails (
      id, mailbox, from_address, from_name, to_address, subject,
      body_text, body_html, code, headers, metadata,
      has_attachments, attachment_count, attachment_names, attachment_search_text,
      direction, status, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?, ?, ?, '', 'outbound', 'sent', ?, ?)
  `).bind(
    id,
    fromEmail,
    fromEmail,
    fromName,
    body.to.join(', '),
    body.subject,
    body.text ?? '',
    body.html ?? '',
    JSON.stringify({ resend_id: resendData.id }),
    body.attachments?.length ? 1 : 0,
    body.attachments?.length ?? 0,
    attachmentNames,
    now,
    now,
  ).run()

  console.log(`Email sent id=${id} resend_id=${resendData.id}`)

  return Response.json({ id, provider_id: resendData.id })
}

export function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

export function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1]! : from
}
