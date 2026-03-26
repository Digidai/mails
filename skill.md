# mails — Email for AI Agents

You can send emails, receive emails, search your inbox, and extract verification codes. Deploy on your own domain with Cloudflare (free tier). Full control, no third-party dependency.

**Capabilities:** send (with attachments), receive, inbox search (FTS5), verification code extraction (EN/ZH/JA/KO), email deletion, webhook notifications.

## Onboarding (follow these steps in order)

### Step 1: Install

```bash
npm install -g mails-agent
```

Verify: `mails version` should print a version number.

### Step 2: Deploy your Worker

You need a Cloudflare Worker to receive and send emails. This requires: a domain on Cloudflare + a Resend account.

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — paste the database_id from the output above
wrangler d1 execute mails --file=schema.sql
wrangler secret put AUTH_TOKEN           # strong random token for API auth
wrangler secret put RESEND_API_KEY       # your re_... key from Resend
wrangler deploy
```

Then set up Cloudflare Email Routing:
1. Cloudflare Dashboard → your domain → **Email** → **Email Routing** → Enable
2. **Routing rules** → **Catch-all** → **Send to a Worker** → select your Worker

### Step 3: Configure the CLI

```bash
mails config set worker_url https://mails-worker.your-subdomain.workers.dev
mails config set worker_token YOUR_AUTH_TOKEN
mails config set mailbox agent@yourdomain.com
mails config set default_from agent@yourdomain.com
```

Verify: `mails config` should show all four values.

### Step 4: Test receiving — check your inbox

Your mailbox is ready to receive emails. Check it:

```bash
mails inbox
```

Expected: `No emails found.` (empty inbox is normal for a new mailbox).

### Step 5: Send an email

```bash
mails send --to user@example.com --subject "Hello" --body "World"
```

Verify: `Sent via worker (id: ...)` confirms the email was sent. The sender address is your configured `default_from`.

### Step 6: Test search and verification code

Search your inbox:

```bash
mails inbox --query "test"
```

Wait for a verification code:

```bash
mails code --to agent@yourdomain.com --timeout 30
```

This long-polls for up to 30 seconds. When an email with a verification code arrives, it prints the code to stdout. If no code arrives, it exits with code 1.

### Onboarding complete

You now have:
- `~/.mails/config.json` with your worker_url, worker_token, mailbox, and default_from
- A working email address on your own domain that receives emails
- The ability to send and search emails

---

## CLI Reference

```
mails send                Send an email (with optional attachments)
mails inbox               List or search received emails
mails code                Wait for a verification code
mails config              View or modify configuration
mails help                Show help
mails version             Show version
```

### send

```bash
mails send --to user@example.com --subject "Subject" --body "Plain text body"
mails send --to user@example.com --subject "Subject" --html "<h1>HTML body</h1>"
mails send --from "Name <email>" --to user@example.com --subject "Subject" --body "Text"
mails send --to user@example.com --subject "Report" --body "See attached" --attach report.pdf
mails send --to user@example.com --subject "Files" --body "Two files" --attach a.txt --attach b.csv
```

Uses `default_from` from config if `--from` is not specified. Send priority: `worker_url` (via Worker /api/send) > `resend_api_key` (direct Resend).

### inbox

```bash
mails inbox                                  # List recent emails
mails inbox --mailbox agent@yourdomain.com   # Specify mailbox
mails inbox --query "password reset"         # Search emails
mails inbox --query "invoice" --direction inbound --limit 10
mails inbox <email-id>                       # Show full email details (with attachments)
```

### code

```bash
mails code --to agent@yourdomain.com              # Wait 30s (default)
mails code --to agent@yourdomain.com --timeout 60 # Wait 60s
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
| `mailbox` | manual | Your receiving address |
| `worker_url` | manual | Worker URL (enables remote provider) |
| `worker_token` | manual | Auth token for Worker |
| `resend_api_key` | manual | Resend API key for sending emails |
| `default_from` | manual | Default sender address |
| `storage_provider` | manual | `sqlite` or `remote` (auto-detected) |

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
const emails = await getInbox('agent@yourdomain.com', { limit: 10 })

// Search inbox
const results = await searchInbox('agent@yourdomain.com', {
  query: 'password reset',
  direction: 'inbound',
  limit: 5,
})

// Wait for verification code
const code = await waitForCode('agent@yourdomain.com', { timeout: 30 })
if (code) console.log(code.code) // "123456"
```

## API (Direct HTTP)

For agents that prefer raw HTTP over the CLI/SDK. All endpoints are on your Worker.

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

Worker API endpoints:

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

## Links

- npm: https://www.npmjs.com/package/mails-agent
- GitHub: https://github.com/Digidai/mails
