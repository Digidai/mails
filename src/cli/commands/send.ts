import { send } from '../../core/send.js'

interface ParsedArgs {
  values: Record<string, string>
  lists: {
    cc: string[]
    bcc: string[]
  }
  attachments: string[]
}

function parseArgs(args: string[]): ParsedArgs {
  const values: Record<string, string> = {}
  const lists = { cc: [] as string[], bcc: [] as string[] }
  const attachments: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        if (key === 'attach') {
          attachments.push(value)
        } else if (key === 'cc' || key === 'bcc') {
          lists[key]!.push(value)
        } else {
          values[key] = value
        }
        i++
      }
    }
  }

  return { values, lists, attachments }
}

export async function sendCommand(args: string[]) {
  const { values: opts, lists, attachments } = parseArgs(args)

  if (!opts['to']) {
    console.error('Usage: mails send --to <email> --subject <subject> --body <text> [--html <html>] [--from <from>] [--cc <email>] [--bcc <email>] [--reply-to <email>] [--in-reply-to <message-id>] [--attach <path>]')
    process.exit(1)
  }

  if (!opts['subject']) {
    console.error('Missing --subject')
    process.exit(1)
  }

  if (!opts['body'] && !opts['html']) {
    console.error('Missing --body or --html')
    process.exit(1)
  }

  const result = await send({
    from: opts['from'],
    to: opts['to'],
    cc: lists.cc.length ? lists.cc : undefined,
    bcc: lists.bcc.length ? lists.bcc : undefined,
    subject: opts['subject'],
    text: opts['body'],
    html: opts['html'],
    replyTo: opts['reply-to'],
    inReplyTo: opts['in-reply-to'],
    attachments: attachments.map((path) => ({ path })),
  })

  console.log(`Sent via ${result.provider} (id: ${result.id})`)
}
