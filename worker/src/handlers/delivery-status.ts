import type { Env } from '../types'
import { recordEvent } from './events'
import { fireWebhookWithRetry } from './webhook'

/**
 * Verify Resend webhook signature (Svix).
 * Resend signs webhooks with svix-id, svix-timestamp, svix-signature headers.
 * See: https://resend.com/docs/dashboard/webhooks/introduction
 */
async function verifyResendSignature(
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const svixId = request.headers.get('svix-id')
  const svixTimestamp = request.headers.get('svix-timestamp')
  const svixSignature = request.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) return false

  // Reject timestamps older than 5 minutes
  const ts = parseInt(svixTimestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > 300) return false

  // Svix secret is base64-encoded after "whsec_" prefix
  const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0))

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))

  // svix-signature may contain multiple signatures separated by spaces (v1,xxx v1,yyy)
  const signatures = svixSignature.split(' ')
  return signatures.some(s => {
    const val = s.split(',')[1]
    return val === expected
  })
}

/**
 * Resend webhook callback handler.
 * POST /api/resend-webhook — receives delivery status updates from Resend.
 *
 * Resend events: email.sent, email.delivered, email.bounced,
 * email.complained, email.delivery_delayed
 *
 * Updates the email status in D1 and fires user webhooks + SSE events.
 * Signature verified via RESEND_WEBHOOK_SECRET (Svix HMAC-SHA256).
 */
export async function handleResendWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text()

  // Require webhook signature verification — reject if secret not configured
  if (!env.RESEND_WEBHOOK_SECRET) {
    return Response.json({ error: 'Webhook secret not configured' }, { status: 503 })
  }
  const valid = await verifyResendSignature(request, rawBody, env.RESEND_WEBHOOK_SECRET)
  if (!valid) {
    return Response.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

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
    body = JSON.parse(rawBody)
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

  // Add to suppression list on bounce or complaint
  if (newStatus === 'bounced' || newStatus === 'complained') {
    const recipients = body.data.to ?? []
    const reason = newStatus === 'bounced' ? 'bounce' : 'complaint'
    const now = new Date().toISOString()
    for (const recipient of recipients) {
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO suppression_list (email, reason, created_at) VALUES (?, ?, ?)'
        ).bind(recipient, reason, now).run()
      } catch {
        // suppression_list table may not exist — skip
      }
    }
  }

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
