export function helpCommand() {
  console.log(`
mails-agent - Email infrastructure for AI agents

Usage:
  mails <command> [options]

Commands:
  claim         Claim a @mails0.com mailbox for your agent
  send          Send an email
  inbox         List received emails
  code          Wait for a verification code
  config        View or modify configuration
  help          Show this help message
  version       Show version

Claim:
  mails claim <name>                    Claim name@mails0.com (max 10 per user)
                                        Opens browser for human approval.
                                        In headless mode, shows a URL
                                        for the human to confirm.

Send:
  mails send --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --html <html>
  mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --body <text> --attach ./invoice.pdf

Inbox:
  mails inbox                           List recent emails
  mails inbox --mailbox <address>       List emails for a specific mailbox
  mails inbox --query "reset password"  Search emails in a mailbox
  mails inbox --query "invoice" --direction inbound --limit 10
  mails inbox --threads                 List email threads
  mails inbox --label notification      Filter by label (newsletter, notification, code, personal)
  mails inbox <id>                      Show email details

Code:
  mails code --to <address>             Wait for a verification code
  mails code --to <address> --timeout 60

Config:
  mails config                    Show current config
  mails config set <key> <value>  Set a config value
  mails config get <key>          Get a config value
  mails config path               Show config file path

Environment:
  MAILS_API_URL       Override API base URL (default: https://mails-worker.genedai.workers.dev)
  MAILS_CLAIM_URL     Override claim page URL (default: https://mails0.com)

https://github.com/Digidai/mails
`.trim())
}
