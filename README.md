# mails

Email infrastructure for AI agents. Send and receive emails programmatically.

[![npm](https://img.shields.io/npm/v/mails)](https://www.npmjs.com/package/mails)
[![license](https://img.shields.io/npm/l/mails)](https://github.com/chekusu/mails/blob/main/LICENSE)

[日本語](https://github.com/chekusu/mails/blob/main/README.ja.md) | [中文](https://github.com/chekusu/mails/blob/main/README.zh.md)

## Features

- **Send emails** via Resend with attachment support
- **Receive emails** via Cloudflare Email Routing Worker
- **Search inbox** — keyword search across subject, body, sender, code
- **Verification code extraction** — auto-extracts codes from emails (EN/ZH/JA/KO)
- **Attachments** — send files via CLI (`--attach`) or SDK, receive and parse MIME attachments
- **Storage providers** — local SQLite, [db9.ai](https://db9.ai) cloud PostgreSQL, or remote Worker API
- **Zero runtime dependencies** — Resend provider uses raw `fetch()`
- **Hosted service** — free `@mails.dev` mailboxes via `mails claim`
- **Self-hosted** — deploy your own Worker with optional AUTH_TOKEN

## Install

```bash
npm install -g mails
# or
bun install -g mails
# or use directly
npx mails
```

## Quick Start

### Hosted (mails.dev)

```bash
mails claim myagent                  # Claim myagent@mails.dev (free)
mails send --to user@example.com --subject "Hello" --body "World"  # 100 free/month
mails inbox                          # List received emails
mails inbox --query "password"       # Search emails
mails code --to myagent@mails.dev    # Wait for verification code
```

No Resend key needed — hosted users get 100 free sends/month. For unlimited sending, set your own key: `mails config set resend_api_key re_YOUR_KEY`

### Self-Hosted

```bash
cd worker && wrangler deploy         # Deploy your own Worker
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_TOKEN
mails config set mailbox agent@yourdomain.com
mails inbox                          # Queries your Worker API
```

## CLI Reference

### claim

```bash
mails claim <name>                   # Claim name@mails.dev (max 10 per user)
```

### send

```bash
mails send --to <email> --subject <subject> --body <text>
mails send --to <email> --subject <subject> --html "<h1>Hello</h1>"
mails send --from "Name <email>" --to <email> --subject <subject> --body <text>
mails send --to <email> --subject "Report" --body "See attached" --attach report.pdf
```

### inbox

```bash
mails inbox                                  # List recent emails
mails inbox --mailbox agent@test.com         # Specific mailbox
mails inbox --query "password reset"         # Search emails
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <id>                             # View email details + attachments
```

### code

```bash
mails code --to agent@test.com              # Wait for code (default 30s)
mails code --to agent@test.com --timeout 60 # Custom timeout
```

The code is printed to stdout for easy piping: `CODE=$(mails code --to agent@test.com)`

### config

```bash
mails config                    # Show all config
mails config set <key> <value>  # Set a value
mails config get <key>          # Get a value
```

## SDK Usage

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

// Send
const result = await send({
  to: 'user@example.com',
  subject: 'Hello',
  text: 'World',
})

// Send with attachment
await send({
  to: 'user@example.com',
  subject: 'Report',
  text: 'See attached',
  attachments: [{ path: './report.pdf' }],
})

// List inbox
const emails = await getInbox('agent@mails.dev', { limit: 10 })

// Search inbox
const results = await searchInbox('agent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
})

// Wait for verification code
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Email Worker

The `worker/` directory contains a Cloudflare Email Routing Worker for receiving emails.

### Setup

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — set your D1 database ID
wrangler d1 execute mails --file=schema.sql
wrangler deploy
```

Then configure Cloudflare Email Routing to forward to this worker.

### Secure the Worker (optional)

```bash
wrangler secret put AUTH_TOKEN    # Set a secret token
```

If `AUTH_TOKEN` is set, all `/api/*` endpoints require `Authorization: Bearer <token>`. `/health` is always public.

### Worker API

| Endpoint | Description |
|----------|-------------|
| `GET /api/inbox?to=<addr>&limit=20` | List emails |
| `GET /api/inbox?to=<addr>&query=<text>` | Search emails |
| `GET /api/code?to=<addr>&timeout=30` | Long-poll for verification code |
| `GET /api/email?id=<id>` | Get email by ID (with attachments) |
| `GET /health` | Health check (always public) |

## Storage Providers

The CLI auto-detects the storage provider:
- `api_key` in config → remote (mails.dev hosted)
- `worker_url` in config → remote (self-hosted Worker)
- Otherwise → local SQLite

### SQLite (default)

Local database at `~/.mails/mails.db`. Zero config.

### db9.ai

Cloud PostgreSQL for AI agents. Full-text search with ranking.

```bash
mails config set storage_provider db9
mails config set db9_token YOUR_TOKEN
mails config set db9_database_id YOUR_DB_ID
```

### Remote (Worker API)

Queries the Worker HTTP API directly. Auto-enabled when `api_key` or `worker_url` is configured.

## Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `mailbox` | | Your receiving address |
| `api_key` | | API key for mails.dev hosted service |
| `worker_url` | | Self-hosted Worker URL |
| `worker_token` | | Auth token for self-hosted Worker |
| `resend_api_key` | | Resend API key |
| `default_from` | | Default sender address |
| `storage_provider` | auto | `sqlite`, `db9`, or `remote` |

## Testing

```bash
bun test              # Unit + mock E2E tests
bun test:coverage     # With coverage report
bun test:live         # Live E2E with real Resend + Cloudflare (requires .env)
```

125 unit tests + 42 E2E tests across 6 test suites.

## License

MIT
