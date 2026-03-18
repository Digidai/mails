export function helpCommand() {
  console.log(`
mails - Email infrastructure for AI agents

Usage:
  mails <command> [options]

Commands:
  claim         Claim a @mails.dev mailbox for your agent
  send          Send an email
  inbox         List received emails
  attachment    Download an attachment by ID
  code          Wait for a verification code
  serve         Run a local inbound HTTP server for forwarded emails
  config        View or modify configuration
  help          Show this help message
  version       Show version

Claim:
  mails claim <name>                    Claim name@mails.dev (max 10 per user)
                                        Opens browser for human approval.
                                        In headless mode, shows a device code
                                        for the human to enter at mails.dev/claim.

Send:
  mails send --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --html <html>
  mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
  mails send --to <email> --subject <subject> --body <text> --attach ./invoice.pdf

Inbox:
  mails inbox                           List recent emails
  mails inbox --mailbox <address>       List emails for a specific mailbox
  mails inbox <id>                      Show email details

Attachment:
  mails attachment <id>                 Download an attachment by ID
  mails attachment <id> --output ./x    Download to a specific path

Serve:
  mails serve                           Run local inbound server on 127.0.0.1:8787
  mails serve --port 8787 --token xxx   Protect the inbound endpoint with a bearer token

Code:
  mails code --to <address>             Wait for a verification code
  mails code --to <address> --timeout 60

Config:
  mails config                    Show current config
  mails config set <key> <value>  Set a config value
  mails config get <key>          Get a config value
  mails config path               Show config file path

Environment:
  MAILS_API_URL       Override API base URL (default: https://api.mails.dev)
  MAILS_CLAIM_URL     Override claim page URL (default: https://mails.dev/claim)

https://mails.dev
`.trim())
}
