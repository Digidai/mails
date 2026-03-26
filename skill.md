# mails — Email for AI Agents

You can send emails, receive emails, search your inbox, and extract verification codes. You have a free `@mails.dev` mailbox or can use a self-hosted domain.

**Capabilities:** send (with attachments), receive, inbox search (FTS5), verification code extraction (EN/ZH/JA/KO), email deletion, webhook notifications.

## Onboarding (follow these steps in order)

### Step 1: Install

```bash
npm install -g mails-agent
```

Verify: `mails version` should print a version number.

### Step 2: Claim a mailbox

You need a `@mails.dev` email address. This requires a human to approve (one-time).

```bash
mails claim <pick-a-name>
```

**If you have a browser** (local machine): it will open automatically. The human approves, and the CLI receives the API key.

**If you don't have a browser** (sandbox, SSH, CI): the CLI will show a URL like this:

```
  Claiming myagent@mails.dev

  Open this link to confirm:

    https://mails.dev?session=xxx&claim=myagent&source=cli

  Waiting...
```

Relay the URL to your human user. Once they confirm in the browser, the CLI will continue and save the credentials to `~/.mails/config.json`.

Verify: `mails config get mailbox` should print your address. `mails config get api_key` should print `mk_...`.

### Step 3: Test receiving — check your inbox

Your mailbox is ready to receive emails. Check it:

```bash
mails inbox
```

Expected: `No emails found.` (empty inbox is normal for a new mailbox).

### Step 4: Send an email

After claiming, you can send emails immediately — no extra config needed (100 free/month):

```bash
mails send --to user@example.com --subject "Hello" --body "World"
```

Verify: `Sent via mails.dev (id: ...)` confirms the email was sent. The sender address is your claimed mailbox.

To send unlimited emails, configure your own Resend API key:

```bash
mails config set resend_api_key re_YOUR_KEY
```

### Step 5: Test search and verification code

Search your inbox:

```bash
mails inbox --query "test"
```

Wait for a verification code:

```bash
mails code --to YOUR_MAILBOX@mails.dev --timeout 30
```

This long-polls for up to 30 seconds. When an email with a verification code arrives, it prints the code to stdout. If no code arrives, it exits with code 1.

### Onboarding complete

You now have:
- `~/.mails/config.json` with your mailbox, API key, and send config
- A working `@mails.dev` address that receives emails
- The ability to send and search emails

---

## CLI Reference

```
mails claim <name>        Claim name@mails.dev (max 10 per user)
mails send                Send an email (with optional attachments)
mails inbox               List or search received emails
mails code                Wait for a verification code
mails config              View or modify configuration
mails help                Show help
mails version             Show version
```

### claim

```bash
mails claim myagent
```

Opens browser (or shows a URL for manual confirmation) for human approval. On success, saves `mailbox`, `api_key`, and `default_from` to config. Each human user can create up to 10 mailboxes.

### send

```bash
mails send --to user@example.com --subject "Subject" --body "Plain text body"
mails send --to user@example.com --subject "Subject" --html "<h1>HTML body</h1>"
mails send --from "Name <email>" --to user@example.com --subject "Subject" --body "Text"
mails send --to user@example.com --subject "Report" --body "See attached" --attach report.pdf
mails send --to user@example.com --subject "Files" --body "Two files" --attach a.txt --attach b.csv
```

Uses `default_from` from config if `--from` is not specified. Send priority: `worker_url` (via Worker /api/send) > `api_key` (via mails.dev) > `resend_api_key` (direct Resend).

### inbox

```bash
mails inbox                                  # List recent emails
mails inbox --mailbox addr@mails.dev         # Specify mailbox
mails inbox --query "password reset"         # Search emails
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <email-id>                       # Show full email details (with attachments)
```

### code

```bash
mails code --to addr@mails.dev              # Wait 30s (default)
mails code --to addr@mails.dev --timeout 60 # Wait 60s
```

Prints the verification code to stdout (for piping: `CODE=$(mails code --to ...)`). Details go to stderr. Exits with code 1 if no code received within timeout.

### config

```bash
mails config                    # Show all
mails config set <key> <value>  # Set a value
mails config get <key>          # Get a value
mails config path               # Show config file path
```

Config file: `~/.mails/config.json`

| Key | Set by | Description |
|-----|--------|-------------|
| `mailbox` | `mails claim` | Your receiving address |
| `api_key` | `mails claim` | API key for hosted mails.dev service (mk_...) |
| `resend_api_key` | manual | Resend API key for sending emails |
| `default_from` | `mails claim` or manual | Default sender address |
| `storage_provider` | manual | `sqlite` or `remote` (auto-detected) |
| `worker_url` | manual | Self-hosted Worker URL (enables remote provider) |
| `worker_token` | manual | Auth token for self-hosted Worker |

## Self-Hosted Setup

Deploy your own Worker instead of using mails.dev. Requires: a domain on Cloudflare + a Resend account.

### 1. Set up Resend (sending)

1. Register at [resend.com](https://resend.com) → **Domains** → **Add Domain**
2. Add the DNS records Resend provides to your Cloudflare DNS:
   - SPF: `TXT` on `@` → `v=spf1 include:amazonses.com ~all`
   - DKIM: 3 `CNAME` records as provided
   - DMARC: `TXT` on `_dmarc` → `v=DMARC1; p=none;`
3. Wait for verification, then copy your API key (`re_...`)

### 2. Deploy Worker

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — paste the database_id from the output above
wrangler d1 execute mails --file=schema.sql
wrangler secret put AUTH_TOKEN           # strong random token for API auth
wrangler secret put RESEND_API_KEY       # your re_... key
wrangler deploy
```

### 3. Set up Email Routing (receiving)

1. Cloudflare Dashboard → your domain → **Email** → **Email Routing** → Enable
2. **Routing rules** → **Catch-all** → **Send to a Worker** → select your Worker

### 4. Configure the CLI

```bash
mails config set worker_url https://mails-worker.your-subdomain.workers.dev
mails config set worker_token YOUR_AUTH_TOKEN
mails config set mailbox agent@yourdomain.com
mails config set default_from agent@yourdomain.com
```

### 5. Verify

```bash
mails inbox                          # Should show empty inbox
mails send --to test@gmail.com --subject "Test" --body "Self-hosted works"
```

All commands (`mails send`, `mails inbox`, `mails code`) now go through your Worker. No client-side Resend key needed — the Worker holds it as a secret.

Worker secrets reference:

| Secret | Required | Description |
|--------|----------|-------------|
| `AUTH_TOKEN` | Recommended | All `/api/*` endpoints require `Authorization: Bearer <token>` |
| `RESEND_API_KEY` | For sending | Worker calls Resend API to send emails via `/api/send` |
| `WEBHOOK_SECRET` | Optional | HMAC-SHA256 key for signing webhook payloads (`X-Webhook-Signature` header) |

## SDK (Programmatic Usage)

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails-agent'

// Send an email
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
const emails = await getInbox('myagent@mails.dev', { limit: 10 })

// Search inbox
const results = await searchInbox('myagent@mails.dev', {
  query: 'password reset',
  direction: 'inbound',
  limit: 5,
})

// Wait for verification code
const code = await waitForCode('myagent@mails.dev', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## API (Direct HTTP)

For agents that prefer raw HTTP over the CLI/SDK.

### Claim flow (no auth, hosted only)

```bash
# Start session
curl -X POST https://api.mails.dev/v1/claim/start \
  -H "Content-Type: application/json" \
  -d '{"name": "myagent"}'
# → {"session_id": "xxx", "expires_in": 600}

# Poll until human confirms (every 2s)
curl "https://api.mails.dev/v1/claim/poll?session=xxx"
# → {"status": "pending"}
# → {"status": "complete", "mailbox": "myagent@mails.dev", "api_key": "mk_xxx"}
```

### Hosted endpoints (mails.dev, requires API key from claim)

```bash
# Send email (100 free/month, then $0.002/email via x402 USDC)
curl -X POST -H "Authorization: Bearer mk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.mails.dev/v1/send" \
  -d '{"to":["user@example.com"],"subject":"Hello","text":"World"}'

# Send with attachment (≤10MB total)
curl -X POST -H "Authorization: Bearer mk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.mails.dev/v1/send" \
  -d '{"to":["user@example.com"],"subject":"Report","text":"See attached","attachments":[{"filename":"report.pdf","content":"<base64>","content_type":"application/pdf"}]}'

# List inbox
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox"

# Search inbox
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/inbox?query=password+reset&direction=inbound"

# Wait for verification code
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/code?timeout=30"

# Get email detail
curl -H "Authorization: Bearer mk_YOUR_API_KEY" \
  "https://api.mails.dev/v1/email?id=EMAIL_ID"
```

### Self-hosted endpoints (your Worker, optional AUTH_TOKEN)

```bash
# Send email (via Worker's RESEND_API_KEY)
curl -X POST -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  "https://your-worker.example.com/api/send" \
  -d '{"to":["user@example.com"],"subject":"Hello","text":"World"}'

# List inbox
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com"

# Search inbox (uses FTS5 full-text search)
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com&query=invoice"

# Wait for verification code
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/code?to=agent@yourdomain.com&timeout=30"

# Get current user info
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/me"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILS_API_URL` | `https://api.mails.dev` | Override API base URL |
| `MAILS_CLAIM_URL` | `https://mails.dev` | Override claim page URL |

## Links

- Website: https://mails.dev
- npm: https://www.npmjs.com/package/mails-agent
- GitHub: https://github.com/Digidai/mails
