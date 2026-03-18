# mails — Email for AI Agents

Send and receive emails. Get a free `@mails.dev` mailbox or use your own domain.

## Onboarding (follow these steps in order)

### Step 1: Install

```bash
npm install -g mails
```

Verify: `mails version` should print a version number.

### Step 2: Claim a mailbox

You need a `@mails.dev` email address. This requires a human to approve (one-time).

```bash
mails claim <pick-a-name>
```

**If you have a browser** (local machine): it will open automatically. The human approves, and the CLI receives the API key.

**If you don't have a browser** (sandbox, SSH, CI): the CLI will show a code like this:

```
  Claiming myagent@mails.dev

  To complete, ask a human to visit:

    https://mails.dev/claim

  and enter this code:

    KDNR-CHPC

  Waiting...
```

Relay the URL and code to your human user. Once they confirm, the CLI will continue and save the credentials to `~/.mails/config.json`.

Verify: `mails config get mailbox` should print your address. `mails config get api_key` should print `mk_...`.

### Step 3: Test receiving — check your inbox

Your mailbox is ready to receive emails. Check it:

```bash
mails inbox
```

Expected: `No emails found.` (empty inbox is normal for a new mailbox).

### Step 4: Configure sending

To send emails, you need a Resend API key. Get one at https://resend.com, then:

```bash
mails config set resend_api_key re_YOUR_KEY
mails config set default_from "YourAgent <yourname@mails.dev>"
```

Note: sending from `@mails.dev` requires the domain to be verified on Resend. If you use a different sending domain (e.g. your own), set `default_from` accordingly.

### Step 5: Test sending

Send a test email to yourself:

```bash
mails send --to YOUR_MAILBOX@mails.dev --subject "Test" --body "Hello from mails"
```

Replace `YOUR_MAILBOX@mails.dev` with the address from Step 2. If sending from the same domain fails (Resend may suppress same-domain delivery), try sending to a different email address.

Verify: `Sent via resend (id: ...)` confirms the email was sent.

### Step 6: Test search and verification code

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

Opens browser (or shows device code) for human approval. On success, saves `mailbox` and `api_key` to config. Each human user can create up to 10 mailboxes.

### send

```bash
mails send --to user@example.com --subject "Subject" --body "Plain text body"
mails send --to user@example.com --subject "Subject" --html "<h1>HTML body</h1>"
mails send --from "Name <email>" --to user@example.com --subject "Subject" --body "Text"
mails send --to user@example.com --subject "Report" --body "See attached" --attach report.pdf
mails send --to user@example.com --subject "Files" --body "Two files" --attach a.txt --attach b.csv
```

Uses `default_from` from config if `--from` is not specified. Requires `resend_api_key` in config.

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
| `default_from` | manual | Default sender address |
| `storage_provider` | manual | `sqlite`, `db9`, or `remote` (auto-detected) |
| `worker_url` | manual | Self-hosted Worker URL (enables remote provider) |
| `worker_token` | manual | Auth token for self-hosted Worker |

## Self-Hosted Setup

Deploy your own Worker instead of using mails.dev:

```bash
cd worker
bun install
wrangler d1 create mails
# Edit wrangler.toml — set your D1 database ID
wrangler d1 execute mails --file=schema.sql
wrangler deploy
```

Then configure Cloudflare Email Routing to forward to this worker.

Secure the Worker API (optional but recommended):

```bash
wrangler secret put AUTH_TOKEN    # set a secret token
```

Configure the CLI to use your Worker:

```bash
mails config set worker_url https://your-worker.example.com
mails config set worker_token YOUR_AUTH_TOKEN    # same as above
mails config set mailbox agent@yourdomain.com
```

Now `mails inbox`, `mails code`, and `mails inbox --query` query your Worker directly. No local database needed.

## SDK (Programmatic Usage)

```typescript
import { send, getInbox, searchInbox, waitForCode } from 'mails'

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
# → {"session_id": "xxx", "device_code": "ABCD-1234", "expires_in": 600}

# Poll until human confirms (every 2s)
curl "https://api.mails.dev/v1/claim/poll?session=xxx"
# → {"status": "pending"}
# → {"status": "complete", "mailbox": "myagent@mails.dev", "api_key": "mk_xxx"}
```

### Hosted endpoints (mails.dev, requires API key from claim)

```bash
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
# List inbox
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com"

# Search inbox
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/inbox?to=agent@yourdomain.com&query=invoice"

# Wait for verification code
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  "https://your-worker.example.com/api/code?to=agent@yourdomain.com&timeout=30"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAILS_API_URL` | `https://api.mails.dev` | Override API base URL |
| `MAILS_CLAIM_URL` | `https://mails.dev/claim` | Override claim page URL |

## Links

- Website: https://mails.dev
- npm: https://www.npmjs.com/package/mails
- GitHub: https://github.com/chekusu/mails
