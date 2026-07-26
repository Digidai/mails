# mails-agent

Email infrastructure for AI agents. Send, receive, search, and extract verification codes.

[![npm](https://img.shields.io/npm/v/mails-agent)](https://www.npmjs.com/package/mails-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Digidai/mails/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/mails-agent)](https://www.npmjs.com/package/mails-agent)

[日本語](README.ja.md) | [中文](README.zh.md)

<p align="center">
  <img src="docs/demo.gif" alt="mails-agent demo: install, claim, send, inbox, code extraction" width="720">
</p>

> **Agent Integration:** Use [mails-skills](https://github.com/Digidai/mails-skills) to give your Claude Code, OpenClaw, or any AI agent email capabilities with one command.

## Why mails?

Unlike raw email APIs that only send, mails gives your agent a complete email identity — send, receive, search, and extract verification codes in one package. Deploy on your own domain with Cloudflare (free tier). Full control, no third-party dependency.

## Features

- **Send emails** — via Resend with CC/BCC, In-Reply-To threading, and attachment support
- **Receive emails** — via Cloudflare Email Routing **or** Resend Inbound → Worker → D1, with raw-first R2 persistence (zero email loss)
- **Search inbox** — FTS5 full-text search across subject, body, sender, code
- **Semantic search** — AI-powered vector search via Workers AI + Cloudflare Vectorize (keyword, semantic, hybrid modes). Semantic/hybrid require an `AI` binding **and** a `VECTORIZE` index in `wrangler.toml`; without them, search transparently falls back to keyword (FTS5) only.
- **Dashboard console** — visual email management UI at `mails0.com/console`
- **Verification code extraction** — auto-extracts 4-8 char codes (EN/ZH/JA/KO)
- **Email threading** — auto-assign `thread_id` via In-Reply-To / References headers
- **Auto labels** — rule-based classification: newsletter, notification, code, personal
- **Structured data extraction** — extract orders, shipping, calendar, receipts from emails (rule-based, no LLM)
- **Attachments** — send via CLI (`--attach`) or SDK; receive with R2 storage for large files
- **Webhook notifications** — POST to your URL on email receive, with HMAC-SHA256 signature verification
- **SSE real-time events** — subscribe to `message.received` events via `/api/events`
- **Mailbox isolation** — per-token mailbox binding via `auth_tokens` D1 table with scoped keys
- **Mailbox pause/resume** — temporarily stop processing for a mailbox
- **Suppression list** — auto-suppress bounced/complained recipients, protects domain reputation
- **Rate limits** — per-mailbox daily send limits (configurable via `DAILY_SEND_LIMIT`)
- **Custom domains** — manage and verify custom sending domains via API
- **Inbound idempotency** — deduplication via `message_id`, safe against replay/redelivery
- **Smart email routing** — per-label webhook URLs, route different email types (code/newsletter/notification/personal) to different endpoints
- **Mailbox CRUD** — update webhook URL via `PATCH /api/mailbox`, cascade delete via `DELETE /api/mailbox`
- **One-click deploy** — `mails deploy` automates the entire self-hosting setup (D1, secrets, Worker) via wrangler
- **Delete API** — remove processed emails with cascade cleanup (attachments + R2)
- **Storage providers** — local SQLite (dev) or remote Worker API (production)
- **Small runtime surface** — hosted flows use Node's native `fetch()`; local SQLite mode uses Bun
- **Self-hosted** — deploy your own Worker on Cloudflare (free tier), full control over your data

## Install

Hosted CLI requires Node.js 20+. Local SQLite mode requires Bun.

```bash
npm install -g mails-agent
# or
bun install -g mails-agent
# or use directly
npx mails-agent
```

## Quick Start

```bash
# Automatic agent-safe start: no browser and no API key printed
mails bootstrap
mails inbox
mails code --timeout 60

# Upgrade to a permanent named mailbox with human approval
mails claim myagent
```

`mails bootstrap` creates a random, receive-only mailbox for 72 hours. It can
read/search email and extract verification codes, but cannot send, manage
domains/webhooks, download attachments, or create more mailboxes. For production
control and outbound email, use the self-hosting guide below.

## How it works

```
                          SENDING                                    RECEIVING

  Agent                                              External
    |                                                  |
    |  mails send --to user@example.com                |  email to agent@yourdomain.com
    |                                                  |
    v                                                  v
+--------+                                   +-------------------+
|  CLI   |------ /api/send ----------------->| Cloudflare Email  |
|  /SDK  |<----- /api/inbox -----------------|     Routing       |
+--------+                                   +-------------------+
    |                                                  |
    v                                                  v
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
    |
    |  query via CLI/SDK
    v
  Agent
    mails inbox
    mails inbox --query "code"
    mails code --to agent@yourdomain.com
```

## CLI Reference

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

### deploy

One-click self-hosting setup. Automates D1 creation, schema migration, secret setup, and Worker deployment.

```bash
cd worker
mails deploy                    # Automated setup via wrangler
```

Prerequisites: `wrangler login` and a Cloudflare account. The command generates a random AUTH_TOKEN and prompts for RESEND_API_KEY.

## SDK Usage

```typescript
import { send, getInbox, searchInbox, getEmail, deleteEmail, waitForCode } from 'mails-agent'

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
const emails = await getInbox('agent@yourdomain.com', { limit: 10 })

// Search inbox
const results = await searchInbox('agent@yourdomain.com', {
  query: 'password reset',
  direction: 'inbound',
})

// Get email details (with attachments)
const email = await getEmail('email-id')

// Delete email (cascade: attachments + R2)
await deleteEmail('email-id')

// Wait for verification code
const code = await waitForCode('agent@yourdomain.com', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## Storage Providers

The CLI auto-detects the storage provider:
- `worker_url` in config → remote (queries Worker API)
- Otherwise → local SQLite (`~/.mails/mails.db`)

<details>
<summary><strong>Config Keys</strong></summary>

| Key | Set by | Description |
|-----|--------|-------------|
| `mailbox` | manual | Your receiving address |
| `worker_url` | manual | Worker URL (enables remote provider) |
| `worker_token` | manual | Auth token for Worker |
| `resend_api_key` | manual | Resend API key (not needed when worker_url is set) |
| `default_from` | manual | Default sender address |
| `storage_provider` | auto | `sqlite` or `remote` (auto-detected) |

</details>

<details>
<summary><strong>Self-Hosted Deployment (Full Guide)</strong></summary>

Run the entire email system on your own domain using Cloudflare + Resend. Full control, no third-party dependency.

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

### Step 4: Set up inbound email

There are two supported ways to receive mail. Pick **one**.

**Option A — Cloudflare Email Routing** (when your domain's zone is on Cloudflare):

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → your domain → **Email** → **Email Routing**
2. Click **Enable Email Routing** (Cloudflare will add MX records automatically)
3. Go to **Routing rules** → **Catch-all address** → set action to **Send to a Worker** → select your deployed Worker
4. Now all emails to `*@example.com` will be routed to your Worker (handled by the Worker's `email()` handler)

**Option B — Resend Inbound** (when your domain is NOT on Cloudflare, or you already use Resend for sending):

1. In Resend, add your domain and verify the **Receiving MX** record it provides.
2. Set the inbound signing secret on the Worker:
   ```bash
   wrangler secret put RESEND_WEBHOOK_SECRET   # the webhook's "signing secret" (whsec_...)
   ```
3. In Resend → **Webhooks**, create a webhook pointing at your Worker and subscribe it to `email.received` (you can subscribe delivery events too):
   ```
   https://<your-worker>.workers.dev/api/resend-webhook
   ```
   (A dedicated `POST /api/resend-inbound` endpoint also exists if you prefer a separate webhook.)
4. Incoming mail now arrives as an `email.received` event; the Worker fetches the body + attachments from Resend, stores them in D1/R2, extracts verification codes, and fires your user webhooks — same as the Email Routing path.

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
| `WEBHOOK_SECRET` | Optional | HMAC-SHA256 key for signing outbound webhook payloads (`X-Webhook-Signature` header) |
| `RESEND_WEBHOOK_SECRET` | Recommended | Svix HMAC-SHA256 secret for verifying Resend delivery callbacks. **If not set, all delivery webhooks are rejected (503).** |
| `DAILY_SEND_LIMIT` | Optional | Max emails per mailbox per day (default: 100) |

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
| `GET /api/threads?to=<addr>` | List conversation threads |
| `GET /api/thread?id=<id>&to=<addr>` | Get all emails in a thread |
| `GET /api/search?to=<addr>&q=<text>&mode=hybrid` | Semantic/hybrid search (alias for inbox with mode=hybrid) |
| `POST /api/extract` | Extract structured data (order, shipping, calendar, receipt, code) |
| `GET /api/events?to=<addr>` | SSE stream of real-time email events |
| `GET /api/stats?to=<addr>` | Mailbox usage statistics |
| `GET /api/domains` | List/manage custom sending domains |
| `POST /api/claim/auto` | Headless mailbox claim (returns API key) |
| `GET /api/mailbox` | Mailbox info (status, settings) |
| `PATCH /api/mailbox` | Update mailbox webhook_url |
| `DELETE /api/mailbox` | Cascade delete mailbox and all its data |
| `POST /api/mailbox/pause` | Pause mailbox processing |
| `POST /api/mailbox/resume` | Resume mailbox processing |
| `GET /api/mailbox/routes` | List label-specific webhook routes |
| `PUT /api/mailbox/routes` | Upsert label-specific webhook route |
| `DELETE /api/mailbox/routes?label=` | Delete label-specific webhook route |
| `GET /api/me` | Worker info and capabilities |
| `GET /health` | Health check (always public, no auth) |

### Send Priority

When the CLI/SDK sends an email, it checks config in this order:

1. `worker_url` → sends via your Worker's `/api/send` (recommended)
2. `resend_api_key` → sends directly to Resend API

Once `worker_url` is set, you don't need `resend_api_key` on the client — the Worker holds the Resend key as a secret.

</details>

<details>
<summary><strong>Testing</strong></summary>

```bash
bun test              # Unit + mock E2E tests
bun test:coverage     # With coverage report
bun test:live         # Live E2E with real Resend + Cloudflare (requires .env)
```

360 tests across 44 test files.

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
| **[mails-agent-mcp](https://github.com/Digidai/mails-mcp)** | MCP Server for AI agents | Claude Desktop, Cursor, any MCP client |
| **[mails-agent (Python)](https://github.com/Digidai/mails-python)** | Python SDK | Python developers, async agents |
| **[mails-skills](https://github.com/Digidai/mails-skills)** | Skill files for AI agents | AI agents (Claude Code, OpenClaw, Cursor) |

**Quick agent setup:**
```bash
# MCP Server (Claude Desktop / Cursor)
npm install -g mails-agent-mcp

# Python SDK
pip install mails-agent

# Agent Skills
git clone https://github.com/Digidai/mails-skills && cd mails-skills && ./install.sh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and PR guidelines.

## Acknowledgments

This project is based on [mails](https://github.com/chekusu/mails) by [turing](https://github.com/guo-yu), originally created as email infrastructure for AI agents. We forked and extended it with mailbox isolation, webhook notifications, delete API, R2 attachment storage, Worker file refactoring, and comprehensive test coverage (360 tests). Thank you to the original author for the excellent foundation.

## License

MIT — see [LICENSE](LICENSE) for details. Original copyright retained per MIT terms.
