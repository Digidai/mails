# mails — Email for AI Agents

You can send emails, receive emails, search your inbox, and extract verification codes. Deploy on your own domain with Cloudflare (free tier). Full control, no third-party dependency.

**Capabilities:** send (with CC/BCC, In-Reply-To threading, attachments), receive (raw-first R2 persistence, zero email loss), inbox search (FTS5), semantic search (Workers AI + Vectorize, keyword/semantic/hybrid modes), verification code extraction (EN/ZH/JA/KO), email deletion, webhook notifications (HMAC-SHA256 verified), smart email routing (per-label webhook URLs), SSE real-time events, email threading, auto labels (newsletter/notification/code/personal), structured data extraction (orders, shipping, calendar, receipts), mailbox CRUD (PATCH/DELETE), mailbox pause/resume, suppression list (auto-suppress bounced/complained), per-mailbox rate limits, custom domains, inbound idempotency, scoped API keys, headless mailbox claim, one-click self-hosting (`mails deploy`), dashboard console (mails0.com/console).

## Onboarding (follow these steps in order)

### Step 1: Install

```bash
npm install -g mails-agent
```

Verify: `mails version` should print a version number.

### Step 2: Create a temporary receive-only mailbox

For an automatic first run, create a random mailbox without opening a browser:

```bash
mails bootstrap
```

This stores the API key locally without printing it. The mailbox expires after
72 hours and supports receive, read, search, and verification-code extraction
only. It cannot send email or create additional mailboxes.

### Step 3: Verify the temporary mailbox

```bash
mails doctor
mails inbox
```

To keep a named mailbox, run `mails claim <name>` and complete the browser
approval. For production domains, outbound email, and full data control, follow
the self-hosting guide in the repository README.

### Step 4: Test receiving — check your inbox

Your mailbox is ready to receive emails. Check it:

```bash
mails inbox
```

Expected: `No emails found.` (empty inbox is normal for a new mailbox).

### Step 5: Test search and verification code

Search your inbox:

```bash
mails inbox --query "test"
```

Wait for a verification code:

```bash
mails code --timeout 30
```

This long-polls for up to 30 seconds. When an email with a verification code arrives, it prints the code to stdout. If no code arrives, it exits with code 1.

### Onboarding complete

You now have:
- `~/.mails/config.json` with a hosted API key, mailbox, expiry, and API URL
- A working temporary `@mails0.com` address that receives emails
- The ability to receive, search, and extract verification codes

---

## CLI Reference

```
mails send                Send an email (with optional attachments)
mails bootstrap           Create an expiring receive-only mailbox automatically
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
mails inbox --label notification             # Filter by label
mails inbox --threads                        # List conversation threads
mails inbox --query "keyword" --semantic     # Semantic search (requires Vectorize)
mails inbox --query "keyword" --mode hybrid  # Hybrid search (FTS5 + semantic)
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
| `GET /api/inbox?to=<addr>&label=<label>` | Filter emails by label (newsletter, notification, code, personal) |
| `GET /api/attachment?id=<id>` | Download attachment |
| `GET /api/inbox?to=<addr>&query=<text>&mode=<mode>` | Search with mode: `keyword` (default), `semantic`, or `hybrid` |
| `GET /api/search?to=<addr>&q=<text>` | Search alias (defaults to `mode=hybrid`) |
| `GET /api/threads?to=<addr>` | List conversation threads |
| `GET /api/thread?id=<id>&to=<addr>` | Get all emails in a thread |
| `POST /api/extract` | Extract structured data (order, shipping, calendar, receipt, code) |
| `GET /api/me` | Worker info and capabilities |
| `GET /health` | Health check (always public, no auth) |

## Links

- npm: https://www.npmjs.com/package/mails-agent
- GitHub: https://github.com/Digidai/mails
