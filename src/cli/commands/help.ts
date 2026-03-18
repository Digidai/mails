export function helpCommand() {
  console.log(`
mails - Email infrastructure for AI agents

Usage:
  mails <command> [options]

Commands:
  login         Sign in to mails.dev
  claim         Claim a @mails.dev mailbox for your agent
  send          Send an email
  inbox         List received emails
  code          Wait for a verification code
  config        View or modify configuration
  help          Show this help message
  version       Show version

Account:
  mails login                           Sign in via mails.dev
  mails login --token <token>           Save token directly
  mails claim <name>                    Claim name@mails.dev (max 10 per user)

Send:
  mails send --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --html <html>
  mails send --from "Name <email>" --to <email> --subject <subject> --body <text>

Inbox:
  mails inbox                           List recent emails
  mails inbox --mailbox <address>       List emails for a specific mailbox
  mails inbox --query "reset password"  Search emails in a mailbox
  mails inbox --query "invoice" --direction inbound --limit 10
  mails inbox <id>                      Show email details

Code:
  mails code --to <address>             Wait for a verification code
  mails code --to <address> --timeout 60

Config:
  mails config                    Show current config
  mails config set <key> <value>  Set a config value
  mails config get <key>          Get a config value
  mails config path               Show config file path

https://mails.dev
`.trim())
}
