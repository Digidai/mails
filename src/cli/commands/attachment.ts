import { downloadAttachment } from '../../core/attachment.js'

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
      continue
    }

    if (!result._positional) {
      result._positional = arg
    }
  }

  return result
}

export async function attachmentCommand(args: string[]) {
  const opts = parseArgs(args)
  const id = opts._positional

  if (!id) {
    console.error('Usage: mails attachment <attachment-id> [--output <path>]')
    process.exit(1)
  }

  const path = await downloadAttachment(id, opts.output)
  console.log(path)
}
