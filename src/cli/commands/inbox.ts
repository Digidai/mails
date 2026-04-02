import { getInbox, searchInbox, getEmail, getThreads } from '../../core/receive.js'
import { loadConfig } from '../../core/config.js'

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        result[key] = value
        i++
      } else {
        result[key] = 'true' // boolean flag (e.g. --threads)
      }
    } else if (!result._positional) {
      result._positional = arg
    }
  }
  return result
}

export async function inboxCommand(args: string[]) {
  const opts = parseArgs(args)

  // mails inbox <id> — show single email
  if (opts._positional) {
    const email = await getEmail(opts._positional)
    if (!email) {
      console.error(`Email not found: ${opts._positional}`)
      process.exit(1)
    }
    console.log(`From: ${email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}`)
    console.log(`To: ${email.to_address}`)
    console.log(`Subject: ${email.subject}`)
    console.log(`Date: ${email.received_at}`)
    if (email.code) console.log(`Code: ${email.code}`)
    console.log(`Status: ${email.status}`)
    if (email.attachments?.length) {
      console.log('Attachments:')
      for (const attachment of email.attachments) {
        const size = attachment.size_bytes ?? 0
        console.log(`- ${attachment.filename} (${attachment.content_type}, ${size} bytes)`)
      }
    }
    console.log('---')
    console.log(email.body_text || '(no text body)')
    return
  }

  // mails inbox — list emails
  const config = loadConfig()
  const mailbox = opts.mailbox ?? config.mailbox
  if (!mailbox) {
    console.error('No mailbox specified. Use --mailbox <address> or set: mails config set mailbox <address>')
    process.exit(1)
  }

  const rawLimit = opts.limit ? parseInt(opts.limit, 10) : 20
  const limit = Number.isNaN(rawLimit) ? 20 : Math.max(1, Math.min(200, rawLimit))

  // mails inbox --threads — list threads
  if (opts.threads) {
    const threads = await getThreads(mailbox, { limit })
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

  const direction = opts.direction === 'inbound' || opts.direction === 'outbound'
    ? opts.direction
    : undefined
  const query = opts.query?.trim()
  const label = opts.label?.trim()

  const mode = opts.semantic ? 'semantic' as const : (opts.mode as 'keyword' | 'semantic' | 'hybrid' | undefined)

  const emails = query
    ? await searchInbox(mailbox, { query, direction, limit, ...(label ? { label } : {}), ...(mode ? { mode } : {}) })
    : await getInbox(mailbox, { limit, direction, ...(label ? { label } : {}) })

  if (emails.length === 0) {
    if (query) {
      console.log(`No emails found for query: ${query}`)
    } else {
      console.log('No emails yet. Try:')
      console.log(`  mails send --to ${mailbox} --subject "Test" --body "Hello"`)
      console.log('  mails demo')
    }
    return
  }

  const plain = opts.plain === 'true' || !!process.env.NO_COLOR || !process.stdout.isTTY

  if (plain) {
    // Plain mode: tab-separated, no colors, no emoji
    for (const email of emails) {
      const from = email.from_name || email.from_address
      console.log(`${email.id.slice(0, 8)}\t${email.received_at.slice(0, 16)}\t${from}\t${email.subject}${email.code ? `\t${email.code}` : ''}`)
    }
  } else {
    // Rich mode: colored table with emoji labels
    const RESET = '\x1b[0m'
    const DIM = '\x1b[2m'
    const BOLD = '\x1b[1m'
    const CYAN = '\x1b[36m'
    const GREEN = '\x1b[32m'

    const labelEmoji: Record<string, string> = {
      newsletter: '📬',
      notification: '🔔',
      code: '🔑',
      personal: '👤',
    }

    console.log(`${DIM}  ID        Date              From                      Subject${RESET}`)
    console.log(`${DIM}  ────────  ────────────────  ────────────────────────  ────────────────────────────${RESET}`)
    for (const email of emails) {
      const from = (email.from_name || email.from_address).padEnd(24).slice(0, 24)
      const subject = email.subject.slice(0, 36)
      const codeStr = email.code ? `${GREEN} [${email.code}]${RESET}` : ''
      const label = email.metadata?.label ? ` ${labelEmoji[email.metadata.label as string] ?? ''}` : ''
      console.log(`  ${CYAN}${email.id.slice(0, 8)}${RESET}  ${DIM}${email.received_at.slice(0, 16)}${RESET}  ${BOLD}${from}${RESET}  ${subject}${codeStr}${label}`)
    }
    console.log(`${DIM}  ${emails.length} email${emails.length === 1 ? '' : 's'}${RESET}`)
  }
}
