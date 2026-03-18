#!/usr/bin/env bun
import { sendCommand } from './commands/send.js'
import { inboxCommand } from './commands/inbox.js'
import { codeCommand } from './commands/code.js'
import { configCommand } from './commands/config.js'
import { claimCommand } from './commands/claim.js'
import { helpCommand } from './commands/help.js'
import { serveCommand } from './commands/serve.js'
import { attachmentCommand } from './commands/attachment.js'

const args = process.argv.slice(2)
const command = args[0]

async function main() {
  switch (command) {
    case 'send':
      await sendCommand(args.slice(1))
      break
    case 'inbox':
      await inboxCommand(args.slice(1))
      break
    case 'code':
      await codeCommand(args.slice(1))
      break
    case 'claim':
      await claimCommand(args.slice(1))
      break
    case 'config':
      await configCommand(args.slice(1))
      break
    case 'serve':
      await serveCommand(args.slice(1))
      break
    case 'attachment':
      await attachmentCommand(args.slice(1))
      break
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      helpCommand()
      break
    case 'version':
    case '--version':
    case '-v':
      console.log('mails v1.0.1')
      break
    default:
      console.error(`Unknown command: ${command}`)
      helpCommand()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
