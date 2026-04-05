import { loadConfig } from '../../core/config.js'

function getApiDetails(config: ReturnType<typeof loadConfig>) {
  const apiUrl = process.env.MAILS_API_URL || config.worker_url || 'https://mails-worker.genedai.workers.dev'
  const token = config.api_key || config.worker_token
  const isV1 = !!config.api_key
  return { apiUrl, token, isV1 }
}

export async function webhookCommand(args: string[]) {
  const config = loadConfig()
  const { apiUrl, token, isV1 } = getApiDetails(config)

  if (!token && !config.worker_url) {
    console.error('No API key or worker URL configured. Run: mails claim <name>')
    process.exit(1)
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const subcommand = args[0]

  if (subcommand === 'list' || !subcommand) {
    // mails webhook list — GET /api/mailbox to see webhook_url
    const path = isV1 ? '/v1/mailbox' : '/api/mailbox'
    const url = new URL(path, apiUrl)

    let res: Response
    try {
      res = await fetch(url.toString(), { headers })
    } catch (err) {
      console.error(`Cannot connect to ${apiUrl}: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      console.error(`API error: ${data.error ?? `HTTP ${res.status}`}`)
      process.exit(1)
    }

    const data = await res.json() as { mailbox?: string; webhook_url?: string | null; status?: string }
    console.log(`Mailbox: ${data.mailbox ?? 'unknown'}`)
    console.log(`Webhook: ${data.webhook_url ?? '(none)'}`)
    console.log(`Status:  ${data.status ?? 'active'}`)
    return
  }

  if (subcommand === 'set') {
    const webhookUrl = args[1]
    if (!webhookUrl) {
      console.error('Usage: mails webhook set <url>')
      process.exit(1)
    }

    // Update webhook URL via the mailbox endpoint
    // We need a way to set webhook_url — use a generic PATCH approach
    // For now, directly update via the API
    const path = isV1 ? '/v1/mailbox' : '/api/mailbox'
    const url = new URL(path, apiUrl)

    let res: Response
    try {
      res = await fetch(url.toString(), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ webhook_url: webhookUrl }),
      })
    } catch (err) {
      console.error(`Cannot connect to ${apiUrl}: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      console.error(`API error: ${data.error ?? `HTTP ${res.status}`}`)
      process.exit(1)
    }

    console.log(`Webhook URL set to: ${webhookUrl}`)
    return
  }

  console.error(`Unknown webhook subcommand: ${subcommand}`)
  console.error('Usage:')
  console.error('  mails webhook list       List configured webhooks')
  console.error('  mails webhook set <url>  Set webhook URL')
  process.exit(1)
}
