import type { Env } from '../types'
import { recordEvent } from './events'
import { fireWebhookWithRetry } from './webhook'

/**
 * Resend webhook callback handler.
 * POST /api/resend-webhook — receives delivery status updates from Resend.
 *
 * Resend events: email.sent, email.delivered, email.bounced,
 * email.complained, email.delivery_delayed
 *
 * Updates the email status in D1 and fires user webhooks + SSE events.
 */
export async function handleResendWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: {
    type: string
    created_at: string
    data: {
      email_id?: string
      from?: string
      to?: string[]
      subject?: string
      [key: string]: unknown
    }
  }

  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const resendId = body.data?.email_id
  if (!resendId) {
    return Response.json({ error: 'Missing email_id' }, { status: 400 })
  }

  // Map Resend event types to our status
  const statusMap: Record<string, string> = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
    'email.delivery_delayed': 'queued',
  }

  const newStatus = statusMap[body.type]
  if (!newStatus) {
    // Unknown event type, acknowledge but ignore
    return Response.json({ ok: true })
  }

  // Find the email by resend_id in metadata
  const row = await env.DB.prepare(
    "SELECT id, mailbox FROM emails WHERE json_extract(metadata, '$.resend_id') = ? LIMIT 1"
  ).bind(resendId).first<{ id: string; mailbox: string }>()

  if (!row) {
    console.warn(`Resend webhook: no email found for resend_id=${resendId}`)
    return Response.json({ ok: true })
  }

  // Update status
  await env.DB.prepare(
    'UPDATE emails SET status = ? WHERE id = ?'
  ).bind(newStatus, row.id).run()

  console.log(`Delivery status: email=${row.id} resend_id=${resendId} status=${newStatus}`)

  // Record SSE event
  ctx.waitUntil(recordEvent(env, `message.${newStatus}`, row.mailbox, {
    email_id: row.id,
    resend_id: resendId,
    status: newStatus,
    from: body.data.from,
    to: body.data.to,
    timestamp: body.created_at,
  }))

  // Fire user webhook
  ctx.waitUntil(fireWebhookWithRetry(env, row.mailbox, {
    event: `message.${newStatus}`,
    email_id: row.id,
    mailbox: row.mailbox,
    status: newStatus,
    timestamp: body.created_at,
  }))

  return Response.json({ ok: true })
}
