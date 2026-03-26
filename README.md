# mails-agent

Email infrastructure for AI agents. Send, receive, search, and extract verification codes.

[![npm](https://img.shields.io/npm/v/mails-agent)](https://www.npmjs.com/package/mails-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Digidai/mails/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/mails-agent)](https://www.npmjs.com/package/mails-agent)

[日本語](README.ja.md) | [中文](README.zh.md)

> **Agent Integration:** Use [mails-skills](https://github.com/Digidai/mails-skills) to give your Claude Code, OpenClaw, or any AI agent email capabilities with one command.

## Why mails?

Unlike raw email APIs that only send, mails gives your agent a complete email identity — send, receive, search, and extract verification codes in one package. Claim a free `@mails.dev` mailbox and start in 30 seconds, or self-host on your own domain.

## Features

- **Send emails** — via Resend with attachment support
- **Receive emails** — via Cloudflare Email Routing → Worker → D1
- **Search inbox** — FTS5 full-text search across subject, body, sender, code
- **Verification code extraction** — auto-extracts 4-8 char codes (EN/ZH/JA/KO)
- **Attachments** — send via CLI (`--attach`) or SDK; receive with R2 storage for large files
- **Webhook notifications** — POST to your URL on email receive, with HMAC-SHA256 signature
- **Mailbox isolation** — per-token mailbox binding via `auth_tokens` D1 table
- **Delete API** — remove processed emails with cascade cleanup (attachments + R2)
- **Storage providers** — local SQLite (dev) or remote Worker API (production)
- **Zero runtime dependencies** — all providers use raw `fetch()`
- **Hosted service** — free `@mails.dev` mailboxes via `mails claim` (100 sends/month)
- **Self-hosted** — deploy your own Worker on Cloudflare (free tier)

## Install

```bash
npm install -g mails-agent
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

## How it works

```
                          SENDING                                    RECEIVING

  Agent                                              External
    |                                                  |
    |  mails send --to user@example.com                |  email to agent@mails.dev
    |                                                  |
    v                                                  v
+--------+         +----------+              +-------------------+
|  CLI   |-------->|  Resend  |---> SMTP --->| Cloudflare Email  |
|  /SDK  |         |   API    |              |     Routing       |
+--------+         +----------+              +-------------------+
    |                                                  |
    |  or POST /v1/send (hosted)                       |  email() handler
    |                                                  v
    v                                          +-------------+
+-------------------+                          |   Worker    |
| mails.dev Cloud   |                          | (your own)  |
| (100 free/month)  |                          +-------------+
+-------------------+                                  |
                                                       |  store
                                                       v
                                  +--------------------------------------+
                                  |           Storage Provider           |
                                  |                                      |
                                  |     D1 (Worker)  /  SQLite          |
                                  +--------------------------------------+
                                                       |
                                              query via CLI/SDK
                                                       |
                                                       v
                                                    Agent
                                              mails inbox
                                              mails inbox --query "code"
                                              mails code --to agent@mails.dev
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
import { send, getInbox, searchInbox, getEmail, deleteEmail, waitForCode } from 'mails'

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

// Get email details (with attachments)
const email = await getEmail('email-id')

// Delete email (cascade: attachments + R2)
await deleteEmail('email-id')

// Wait for verification code
const code = await waitForCode('agent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Storage Providers

The CLI auto-detects the storage provider:
- `api_key` or `worker_url` in config → remote (queries Worker API)
- Otherwise → local SQLite (`~/.mails/mails.db`)

<details>
<summary><strong>Config Keys</strong></summary>

| Key | Set by | Description |
|-----|--------|-------------|
| `mailbox` | `mails claim` or manual | Your receiving address |
| `api_key` | `mails claim` | API key for mails.dev hosted service (mk_...) |
| `worker_url` | manual | Self-hosted Worker URL |
| `worker_token` | manual | Auth token for self-hosted Worker |
| `resend_api_key` | manual | Resend API key (not needed when worker_url is set) |
| `default_from` | `mails claim` or manual | Default sender address |
| `storage_provider` | auto | `sqlite` or `remote` (auto-detected) |

</details>

<details>
<summary><strong>Self-Hosted Deployment (Full Guide)</strong></summary>

Run the entire email system on your own domain using Cloudflare + Resend. No dependency on mails.dev.

### Prerequisites

| What | Why | Cost |
|------|-----|------|
| A domain (e.g. `example.com`) | Email address `agent@example.com` | You already own one |
| Cloudflare account | DNS, Email Routing, Worker, D1 | Free tier is enough |
| Resend account | SMTP delivery | Free 100 emails/day |

### Step 1: Add domain to Cloudflare

If your domain's DNS is not already on Cloudflare, add it at [dash.cloudflare.com](https://dash.cloudflare.com). Update your registrar's nameservers to the ones Cloudflare provides.

### Step 2: Set up Resend for sending

1. Create a [Resend](https://resend.com) account
2. Go to **Domains** → **Add Domain** → enter your domain (e.g. `example.com`)
3. Resend will give you DNS records to add. Go to Cloudflare DNS and add:
   - **SPF** — `TXT` record on `@`: `v=spf1 include:amazonses.com ~all` (Resend uses SES)
   - **DKIM** — `CNAME` records as provided by Resend (usually 3 records)
   - **DMARC** — `TXT` record on `_dmarc`: `v=DMARC1; p=none;` (start with `none`, tighten later)
4. Wait for Resend to verify your domain (usually minutes, can take up to 48h)
5. Copy your Resend API key (`re_...`) from the Resend dashboard

### Step 3: Deploy the Worker

```bash
cd worker
bun install

# Create D1 database
wrangler d1 create mails
# → Copy the database_id from the output

# Edit wrangler.toml — paste your database_id
# Replace REPLACE_WITH_YOUR_DATABASE_ID with the actual ID

# Initialize database schema
wrangler d1 execute mails --file=schema.sql

# Set secrets
wrangler secret put AUTH_TOKEN         # Choose a strong random token
wrangler secret put RESEND_API_KEY     # Paste your re_... key from Resend

# Deploy
wrangler deploy
# → Note the Worker URL: https://mails-worker.<your-subdomain>.workers.dev
```

### Step 4: Set up Cloudflare Email Routing

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain → **Email** → **Email Routing**
2. Click **Enable Email Routing** (Cloudflare will add MX records automatically)
3. Go to **Routing rules** → **Catch-all address** → set action to **Send to a Worker** → select your deployed Worker
4. Now all emails to `*@example.com` will be routed to your Worker

### Step 5: (Optional) Create R2 bucket for large attachments

```bash
wrangler r2 create mails-attachments
```

The R2 binding is already configured in `wrangler.toml`. Redeploy after creating the bucket:

```bash
wrangler deploy
```

### Step 6: Configure the CLI

```bash
mails config set worker_url https://mails-worker.<your-subdomain>.workers.dev
mails config set worker_token YOUR_AUTH_TOKEN       # Same token from Step 3
mails config set mailbox agent@example.com          # Your email address
mails config set default_from agent@example.com     # Default sender
```

### Step 7: Verify

```bash
# Check Worker is reachable
curl https://mails-worker.<your-subdomain>.workers.dev/health

# Check inbox (should be empty)
mails inbox

# Send a test email
mails send --to your-personal@gmail.com --subject "Test" --body "Hello from self-hosted mails"

# Send an email TO your mailbox from any email client, then:
mails inbox
```

### Architecture after setup

```
Your Agent                              External sender
    |                                        |
    |  mails send / mails inbox              |  email to agent@example.com
    v                                        v
+--------+                         +-------------------+
|  CLI   |------ /api/send ------->|  Cloudflare Email |
|  /SDK  |<----- /api/inbox -------|     Routing       |
+--------+                         +-------------------+
    |                                        |
    v                                        v
+--------------------------------------------------+
|              Your Cloudflare Worker               |
|  /api/send → Resend API → SMTP delivery          |
|  /api/inbox, /api/code → D1 query (FTS5 search)  |
|  email() handler → parse MIME → store in D1       |
+--------------------------------------------------+
    |               |
    v               v
+--------+    +------------+
|   D1   |    |     R2     |
| emails |    | attachments|
+--------+    +------------+
```

### Worker Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `AUTH_TOKEN` | Recommended | API authentication token. If set, all `/api/*` endpoints require `Authorization: Bearer <token>` |
| `RESEND_API_KEY` | Yes (for sending) | Resend API key (`re_...`). The Worker uses this to send emails via `/api/send` |
| `WEBHOOK_SECRET` | Optional | HMAC-SHA256 key for signing webhook payloads (`X-Webhook-Signature` header) |

### Worker API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/send` | Send email (requires `RESEND_API_KEY` secret) |
| `GET /api/inbox?to=<addr>&limit=20` | List emails |
| `GET /api/inbox?to=<addr>&query=<text>` | Search emails (FTS5 full-text search) |
| `GET /api/code?to=<addr>&timeout=30` | Long-poll for verification code |
| `GET /api/email?id=<id>` | Get email by ID (with attachments) |
| `DELETE /api/email?id=<id>` | Delete email (and its attachments + R2 objects) |
| `GET /api/attachment?id=<id>` | Download attachment |
| `GET /api/me` | Worker info and capabilities |
| `GET /health` | Health check (always public, no auth) |

### Send Priority

When the CLI/SDK sends an email, it checks config in this order:

1. `worker_url` → sends via your Worker's `/api/send` (recommended for self-hosted)
2. `api_key` → sends via mails.dev hosted service
3. `resend_api_key` → sends directly to Resend API

Once `worker_url` is set, you don't need `resend_api_key` on the client — the Worker holds the Resend key as a secret.

</details>

<details>
<summary><strong>Testing</strong></summary>

```bash
bun test              # Unit + mock E2E tests
bun test:coverage     # With coverage report
bun test:live         # Live E2E with real Resend + Cloudflare (requires .env)
```

187 tests across 20 test files.

</details>

## Ecosystem

```
┌─────────────────────────────────────────────────────────────┐
│                        mails ecosystem                       │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐  │
│  │  mails CLI   │    │  mails Worker    │    │   mails   │  │
│  │  & SDK       │───▶│  (Cloudflare)    │◀───│  -skills  │  │
│  │              │    │                  │    │           │  │
│  │ npm i mails- │    │  Receive + Send  │    │  Agent    │  │
│  │    agent     │    │                  │    │           │  │
│  │              │    │  + Search + Code │    │  Skills   │  │
│  └──────────────┘    └──────────────────┘    └───────────┘  │
│    Human / Script        Infrastructure        AI Agents    │
└─────────────────────────────────────────────────────────────┘
```

| Project | What it is | Who uses it |
|---|---|---|
| **[mails](https://github.com/Digidai/mails)** (this repo) | Email server (Worker) + CLI + SDK | Developers deploying email infra |
| **[mails-skills](https://github.com/Digidai/mails-skills)** | Skill files for AI agents | AI agents (Claude Code, OpenClaw, Cursor) |

**Quick agent setup:**
```bash
git clone https://github.com/Digidai/mails-skills && cd mails-skills && ./install.sh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and PR guidelines.

## Acknowledgments

This project is based on [mails](https://github.com/chekusu/mails) by [turing](https://github.com/guo-yu), originally created as email infrastructure for AI agents. We forked and extended it with mailbox isolation, webhook notifications, delete API, R2 attachment storage, Worker file refactoring, and comprehensive test coverage (187 tests). Thank you to the original author for the excellent foundation.

## License

MIT — see [LICENSE](LICENSE) for details. Original copyright retained per MIT terms.
