import { loadConfig, updateConfig } from '../../core/config.js'
import { clientHeaders } from '../../core/client.js'

const API_URL = process.env.MAILS_API_URL || 'https://api.mails0.com'

type BootstrapResponse = {
  mailbox?: string
  api_key?: string
  scope?: 'provisional'
  expires_at?: string
  capabilities?: string[]
  error?: string
  code?: string
}

export async function bootstrapCommand(): Promise<void> {
  const config = loadConfig()

  if (config.api_key && config.mailbox) {
    const existing = await checkExisting(config.api_key)
    if (existing) {
      console.log(`Mailbox ready: ${config.mailbox}`)
      if (existing.expires_at) console.log(`Expires: ${existing.expires_at}`)
      console.log('Upgrade to a permanent mailbox: mails claim <name>')
      return
    }
  }

  const idempotencyKey = config.bootstrap_idempotency_key || crypto.randomUUID()
  if (!config.bootstrap_idempotency_key) {
    updateConfig({ bootstrap_idempotency_key: idempotencyKey })
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}/v1/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...clientHeaders('provisional-bootstrap'),
      },
      body: '{}',
    })
  } catch (error) {
    throw new Error(`Cannot connect to ${API_URL}: ${error instanceof Error ? error.message : error}`)
  }

  const data = await response.json() as BootstrapResponse
  if (!response.ok || !data.mailbox || !data.api_key || !data.expires_at) {
    throw new Error(data.error || `Bootstrap failed with HTTP ${response.status}`)
  }

  updateConfig({
    mode: 'hosted',
    domain: 'mails0.com',
    mailbox: data.mailbox,
    default_from: data.mailbox,
    api_key: data.api_key,
    worker_url: API_URL,
    storage_provider: 'remote',
    token_scope: 'provisional',
    token_expires_at: data.expires_at,
    bootstrap_idempotency_key: idempotencyKey,
  })

  // Make the first authenticated request immediately so installation and
  // successful API activation are distinguishable in server-side telemetry.
  const inbox = await fetch(`${API_URL}/v1/inbox?limit=1`, {
    headers: {
      Authorization: `Bearer ${data.api_key}`,
      ...clientHeaders('provisional-bootstrap'),
    },
  })
  if (!inbox.ok) {
    throw new Error(`Mailbox was created but the first inbox check failed with HTTP ${inbox.status}`)
  }

  console.log(`Temporary mailbox ready: ${data.mailbox}`)
  console.log(`Expires: ${data.expires_at}`)
  console.log('Capabilities: receive, read, search, and verification codes')
  console.log('API key saved securely to ~/.mails/config.json (not printed)')
  console.log('Upgrade to a permanent mailbox: mails claim <name>')
}

async function checkExisting(apiKey: string): Promise<{ expires_at?: string | null } | null> {
  try {
    const response = await fetch(`${API_URL}/v1/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...clientHeaders('bootstrap-reuse'),
      },
    })
    if (!response.ok) return null
    return await response.json() as { expires_at?: string | null }
  } catch {
    return null
  }
}
