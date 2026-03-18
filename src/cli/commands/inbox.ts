import { getInbox, getEmail } from '../../core/receive.js'
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
        const availability = attachment.downloadable ? 'downloadable' : 'metadata-only'
        console.log(`- ${attachment.id}  ${attachment.filename} (${attachment.content_type}, ${size} bytes, ${availability})`)
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

  const limit = opts.limit ? parseInt(opts.limit) : 20
  const emails = await getInbox(mailbox, { limit })

  if (emails.length === 0) {
    console.log('No emails found.')
    return
  }

  for (const email of emails) {
    const code = email.code ? ` [${email.code}]` : ''
    const from = email.from_name || email.from_address
    console.log(`${email.id.slice(0, 8)}  ${email.received_at.slice(0, 16)}  ${from.padEnd(24).slice(0, 24)}  ${email.subject.slice(0, 40)}${code}`)
  }
}
