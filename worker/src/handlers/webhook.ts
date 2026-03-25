import type { Env } from '../types'

interface WebhookPayload {
  event: 'email.received'
  email_id: string
  mailbox: string
  from: string
  subject: string
  received_at: string
  message_id: string | null
  has_attachments: boolean
  attachment_count: number
}

/**
 * Fire webhook notification for a received email.
 * Called inside waitUntil() — does not block the email handler.
 * Includes HMAC-SHA256 signature for verification.
 */
export async function fireWebhook(
  env: Env,
  payload: WebhookPayload,
  webhookUrl: string,
): Promise<void> {
  const body = JSON.stringify(payload)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': 'email.received',
    'X-Webhook-Id': payload.email_id,
  }

  // HMAC-SHA256 signature using WEBHOOK_SECRET
  if (env.WEBHOOK_SECRET) {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const hex = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    headers['X-Webhook-Signature'] = `sha256=${hex}`
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
    })
    console.log(`Webhook fired to ${webhookUrl} status=${res.status} email_id=${payload.email_id}`)
  } catch (err) {
    console.error(`Webhook failed to ${webhookUrl}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Look up webhook URL for a mailbox from auth_tokens table.
 * Returns null if no webhook configured or table doesn't exist.
 */
export async function getWebhookUrl(env: Env, mailbox: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT webhook_url FROM auth_tokens WHERE mailbox = ? AND webhook_url IS NOT NULL LIMIT 1'
    ).bind(mailbox).first<{ webhook_url: string }>()
    return row?.webhook_url ?? null
  } catch {
    return null
  }
}
