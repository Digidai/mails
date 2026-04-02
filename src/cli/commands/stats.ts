import { loadConfig } from '../../core/config.js'

export async function statsCommand() {
  const config = loadConfig()

  if (!config.api_key && !config.worker_url) {
    console.error('No API key or worker URL configured. Run: mails claim <name>')
    process.exit(1)
  }

  const apiUrl = process.env.MAILS_API_URL || config.worker_url || 'https://mails-worker.genedai.workers.dev'
  const token = config.api_key || config.worker_token
  const isV1 = !!config.api_key
  const path = isV1 ? '/v1/stats' : '/api/stats'

  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    const url = new URL(path, apiUrl)
    if (!isV1 && config.mailbox) url.searchParams.set('to', config.mailbox)
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

  const stats = await res.json() as {
    mailbox?: string
    total_emails?: number
    inbound?: number
    outbound?: number
    emails_this_month?: number
    sends_this_month?: number
    monthly_limit?: number
  }

  console.log('')
  console.log('  mails stats')
  console.log('  ───────────')
  if (stats.mailbox) console.log(`  Mailbox:      ${stats.mailbox}`)
  if (stats.total_emails !== undefined) {
    console.log(`  Total emails: ${stats.total_emails}`)
    if (stats.inbound !== undefined) console.log(`    Inbound:    ${stats.inbound}`)
    if (stats.outbound !== undefined) console.log(`    Outbound:   ${stats.outbound}`)
  }
  if (stats.emails_this_month !== undefined) {
    console.log(`  This month:   ${stats.emails_this_month}`)
  }
  if (stats.sends_this_month !== undefined && stats.monthly_limit !== undefined) {
    console.log(`  Send quota:   ${stats.sends_this_month}/${stats.monthly_limit}`)
  }
  console.log('')
}
