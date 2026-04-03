import type { Env } from '../types'

interface WebhookPayload {
  event: string
  email_id: string
  mailbox: string
  [key: string]: unknown
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 */
async function signPayload(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

/**
 * Fire webhook with exponential backoff retry.
 * Retry schedule: 1s, 5s, 30s, 2min, 12min (5 retries max).
 * After 10 consecutive failures, marks webhook as FAILED in DB.
 */
export async function fireWebhookWithRetry(
  env: Env,
  mailbox: string,
  payload: WebhookPayload,
): Promise<void> {
  const webhookUrl = await getWebhookUrl(env, mailbox)
  if (!webhookUrl) return

  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': payload.event,
    'X-Webhook-Id': payload.email_id,
  }

  if (env.WEBHOOK_SECRET) {
    headers['X-Webhook-Signature'] = await signPayload(body, env.WEBHOOK_SECRET)
  }

  // Keep total retry time under 15s to fit within Workers waitUntil() limits
  const retryDelays = [0, 1000, 3000, 8000]
  let lastError = ''

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, retryDelays[attempt]!))
    }

    try {
      const res = await fetch(webhookUrl, { method: 'POST', headers, body })
      if (res.ok || res.status < 500) {
        // Success or client error (don't retry 4xx)
        console.log(`Webhook fired to ${webhookUrl} status=${res.status} event=${payload.event} attempt=${attempt + 1}`)
        if (res.ok) {
          // Reset failure count on success
          await resetWebhookFailures(env, mailbox).catch(() => {})
        }
        return
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    console.warn(`Webhook attempt ${attempt + 1}/${retryDelays.length} failed for ${webhookUrl}: ${lastError}`)
  }

  // All retries exhausted — increment failure counter
  console.error(`Webhook exhausted all retries for ${webhookUrl}: ${lastError}`)
  await incrementWebhookFailures(env, mailbox)
}

/**
 * Increment consecutive failure count. Auto-pause webhook after 10 failures.
 */
async function incrementWebhookFailures(env: Env, mailbox: string): Promise<void> {
  try {
    await env.DB.prepare(
      'UPDATE auth_tokens SET webhook_failures = COALESCE(webhook_failures, 0) + 1 WHERE mailbox = ? AND webhook_url IS NOT NULL'
    ).bind(mailbox).run()

    // Check if failures exceeded threshold
    const row = await env.DB.prepare(
      'SELECT webhook_failures FROM auth_tokens WHERE mailbox = ? LIMIT 1'
    ).bind(mailbox).first<{ webhook_failures: number }>()

    if (row && row.webhook_failures >= 10) {
      await env.DB.prepare(
        "UPDATE auth_tokens SET webhook_status = 'failed' WHERE mailbox = ?"
      ).bind(mailbox).run()
      console.error(`Webhook auto-paused for mailbox ${mailbox} after ${row.webhook_failures} consecutive failures`)
    }
  } catch (err) {
    console.error(`Failed to update webhook failures: ${err}`)
  }
}

/**
 * Reset failure count on successful delivery.
 */
async function resetWebhookFailures(env: Env, mailbox: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_tokens SET webhook_failures = 0, webhook_status = 'active' WHERE mailbox = ?"
  ).bind(mailbox).run()
}

/**
 * Look up webhook URL for a mailbox. Returns null if no webhook configured,
 * webhook is paused/failed, or table doesn't exist.
 */
export async function getWebhookUrl(env: Env, mailbox: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT webhook_url FROM auth_tokens WHERE mailbox = ? AND webhook_url IS NOT NULL AND COALESCE(webhook_status, 'active') = 'active' LIMIT 1"
    ).bind(mailbox).first<{ webhook_url: string }>()
    return row?.webhook_url ?? null
  } catch {
    return null
  }
}
