import { loadConfig } from '../../core/config.js'
import { clientHeaders } from '../../core/client.js'

function getApiDetails(config: ReturnType<typeof loadConfig>) {
  const apiUrl = process.env.MAILS_API_URL || config.worker_url || 'https://api.mails0.com'
  const token = config.api_key || config.worker_token
  const isV1 = !!config.api_key
  return { apiUrl, token, isV1 }
}

export async function threadCommand(args: string[]) {
  const config = loadConfig()
  const { apiUrl, token, isV1 } = getApiDetails(config)

  if (!token && !config.worker_url) {
    console.error('No API key or worker URL configured. Run: mails claim <name>')
    process.exit(1)
  }

  const headers: Record<string, string> = clientHeaders('thread')
  if (token) headers['Authorization'] = `Bearer ${token}`

  const subcommand = args[0]

  if (subcommand === 'list' || !subcommand) {
    // mails thread list — GET /api/threads
    const path = isV1 ? '/v1/threads' : '/api/threads'
    const url = new URL(path, apiUrl)
    if (!isV1 && config.mailbox) url.searchParams.set('to', config.mailbox)

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

    const data = await res.json() as { threads?: Array<{ thread_id: string; subject: string; message_count: number; from_address: string; from_name: string; received_at: string }> }
    const threads = data.threads ?? []

    if (threads.length === 0) {
      console.log('No threads found.')
      return
    }

    for (const thread of threads) {
      const from = thread.from_name || thread.from_address
      console.log(`${thread.thread_id.slice(0, 8)}  [${thread.message_count}]  ${thread.received_at.slice(0, 16)}  ${from.padEnd(24).slice(0, 24)}  ${thread.subject.slice(0, 40)}`)
    }
    return
  }

  // mails thread <id> — GET /api/thread?id=<id>
  const threadId = subcommand
  const path = isV1 ? '/v1/thread' : '/api/thread'
  const url = new URL(path, apiUrl)
  url.searchParams.set('id', threadId)

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

  const data = await res.json() as { thread_id?: string; emails?: Array<{ id: string; from_address: string; from_name: string; subject: string; received_at: string; body_text: string }> }
  const emails = data.emails ?? []

  if (emails.length === 0) {
    console.log('Thread not found or empty.')
    return
  }

  console.log(`Thread: ${data.thread_id}`)
  console.log(`Messages: ${emails.length}`)
  console.log('---')

  for (const email of emails) {
    const from = email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address
    console.log(`  From: ${from}`)
    console.log(`  Date: ${email.received_at}`)
    console.log(`  Subject: ${email.subject}`)
    console.log(`  ${(email.body_text || '').slice(0, 200)}`)
    console.log('  ---')
  }
}
