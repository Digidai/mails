import type { Env } from '../types'
import { getWebhookRoutes } from './webhook-routes'

interface WebhookPayload {
  event: string
  email_id: string
  mailbox: string
  labels?: string[]
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

async function signPayloadV2(body: string, secret: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))
  const hex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${timestamp},v1=${hex}`
}

/**
 * Check if a webhook URL targets the mails-gtm-agent Worker.
 * When true, use the MAILS_GTM_WORKER Service Binding instead of HTTP fetch
 * to avoid Cloudflare error 1042 on same-account worker-to-worker calls.
 */
function isServiceBindingTarget(url: string, env: Env): boolean {
  try {
    const parsed = new URL(url)
    const allowedHosts = (env.MAILS_GTM_WORKER_HOSTS ?? 'mails-gtm-agent.genedai.workers.dev')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
    return allowedHosts.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
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

  // Smart routing: check for label-specific webhook URLs
  const labels = (payload.labels as string[] | undefined) ?? []
  const routes = labels.length > 0 ? await getWebhookRoutes(env, mailbox) : {}
  const labelUrls = labels.map(l => routes[l]).filter((u): u is string => !!u)

  // Fire to all unique URLs (default + label-specific)
  const allUrls = new Set<string>()
  if (webhookUrl) allUrls.add(webhookUrl)
  for (const u of labelUrls) allUrls.add(u)
  if (allUrls.size === 0) return

  // Fire webhooks in parallel
  await Promise.all([...allUrls].map(url => fireToUrl(env, mailbox, url, payload)))
}

/**
 * Fire a webhook to a single URL with retry logic.
 */
async function fireToUrl(
  env: Env,
  mailbox: string,
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<void> {

  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': payload.event,
    'X-Webhook-Id': payload.email_id,
  }

  if (env.WEBHOOK_SECRET) {
    headers['X-Webhook-Signature'] = await signPayload(body, env.WEBHOOK_SECRET)
    const timestamp = Math.floor(Date.now() / 1000).toString()
    headers['X-Webhook-Timestamp'] = timestamp
    headers['X-Webhook-Signature-V2'] = await signPayloadV2(body, env.WEBHOOK_SECRET, timestamp)
  }

  // Use Service Binding if the webhook URL points to mails-gtm-agent (same Cloudflare account).
  // This avoids error 1042 on worker-to-worker HTTP calls.
  const useServiceBinding = env.MAILS_GTM_WORKER && isServiceBindingTarget(webhookUrl, env)

  // Keep total retry time under 15s to fit within Workers waitUntil() limits
  const retryDelays = [0, 1000, 3000, 8000]
  let lastError = ''

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, retryDelays[attempt]!))
    }

    try {
      const res = useServiceBinding
        ? await env.MAILS_GTM_WORKER!.fetch(new Request(webhookUrl, { method: 'POST', headers, body }))
        : await fetch(webhookUrl, { method: 'POST', headers, body })
      if (res.ok) {
        console.log(`Webhook fired to ${webhookUrl} status=${res.status} event=${payload.event} attempt=${attempt + 1}`)
        // Only reset failures for the DEFAULT webhook (not label routes)
        // This prevents a label route success from masking default webhook failures
        const defaultUrl = await getWebhookUrl(env, mailbox)
        if (webhookUrl === defaultUrl) {
          await resetWebhookFailures(env, mailbox).catch(() => {})
        }
        return
      }
      if (res.status >= 400 && res.status < 500) {
        // 4xx: client error. Don't retry, but DO count as a failure.
        // Permanent 4xx errors (wrong URL, auth failure) should eventually
        // trigger the circuit breaker rather than silently dropping data forever.
        console.warn(`Webhook ${webhookUrl} returned ${res.status} (4xx, counting as failure)`)
        await incrementWebhookFailures(env, mailbox)
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
