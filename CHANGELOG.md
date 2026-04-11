# Changelog

All notable changes to this project will be documented in this file.

## [1.9.0] - 2026-04-10

### Added
- **Mailbox management** — `PATCH /api/mailbox` to update webhook_url, `DELETE /api/mailbox` for full cascade delete (emails, attachments, labels, ingest_log, routes, auth_tokens)
- **Smart email routing** — per-label webhook URLs via new `webhook_routes` table. `PUT /api/mailbox/routes` to set label-specific webhooks (code, newsletter, notification, personal). Webhooks fire to all matching URLs in parallel (default + label-specific)
- **One-click deploy CLI** — `mails deploy` automates the full self-hosting setup: D1 creation, schema migration, secret setup (RESEND_API_KEY + AUTH_TOKEN), and Worker deployment via wrangler
- **Enhanced stats** — `/api/stats` now returns ingest_log counts (pending/parsed/failed), suppression_list count, webhook_routes count. CLI `mails stats` displays the new fields
- **CF Email Service research** — `docs/cf-email-research.md` documents findings, integration plan, and blockers (waiting for GA)
- **11 new tests** (4 mailbox CRUD + 7 webhook routes) — total 360 across 44 files

### Changed
- `fireWebhookWithRetry` now dispatches webhooks in parallel to default URL + label-specific URLs

## [1.8.0] - 2026-04-10

### Security
- **Webhook signature required** — `POST /api/resend-webhook` now returns 503 when `RESEND_WEBHOOK_SECRET` is not configured (was: open to all)
- **Suppression fail-closed** — send is rejected (503) when suppression list check fails, protecting domain reputation from sending to bounced/complained addresses
- **Inbound idempotency** — `UNIQUE INDEX` on `(mailbox, message_id)` with `INSERT OR IGNORE` prevents duplicate emails on replay/redelivery

### Added
- **Raw-first R2 persistence** — inbound emails are stored as raw MIME to R2 before parsing; if MIME parsing fails, the raw email is preserved and can be reprocessed
- **Ingest log** — new `ingest_log` D1 table tracks email ingestion state (pending/parsed/failed) across all processing stages
- **Send double-send prevention** — Resend success returns immediately to client; D1 outbound record written asynchronously via `waitUntil` (prevents client retry causing duplicate sends)
- **Raw cleanup cron** — extends scheduled handler to delete R2 raw blobs older than 30 days for successfully parsed emails
- **6 new tests** for raw-first persistence, webhook security, suppression fail-closed — total 349 across 42 files
- **`test:e2e` script** — Worker-requiring E2E tests moved to separate command

### Fixed
- Empty `catch` blocks in send handler now log warnings for real D1 errors (distinguish from expected "table not exist" during migration)
- Rate limit check logs warning on failure (fail-open with visibility)

## [1.7.0] - 2026-04-05

### Added
- **CC/BCC support** — send emails with `cc` and `bcc` recipients
- **In-Reply-To on send** — outbound emails can specify `in_reply_to` for proper threading
- **SSE real-time events** — `GET /api/events` for streaming `message.received` events
- **Delivery tracking** — Resend webhook handler updates email status (delivered/bounced/complained)
- **Suppression list** — auto-suppress bounced/complained recipients in `suppression_list` table
- **Per-mailbox rate limits** — `daily_send_counts` table with configurable `DAILY_SEND_LIMIT`
- **Mailbox pause/resume** — `POST /api/mailbox/pause` and `/resume` endpoints
- **Scoped API keys** — `scope` column on `auth_tokens` (mailbox vs full)
- **Custom domains** — `GET/POST /api/domains` for managing sending domains with DNS verification
- **Headless claim** — `POST /api/claim/auto` for programmatic mailbox creation
- **Events cleanup cron** — hourly scheduled handler deletes SSE events older than 24h

### Security
- Auth scope fallback for pre-migration databases
- Webhook signature verification for Resend callbacks (Svix HMAC-SHA256)

## [1.6.0] - 2026-03-28

### Added
- **Semantic Search** — Workers AI embeddings (`@cf/baai/bge-base-en-v1.5`) + Cloudflare Vectorize
  - Emails are automatically embedded on receive via `ctx.waitUntil()`
  - `GET /api/inbox?query=...&mode=semantic` — pure vector search
  - `GET /api/inbox?query=...&mode=hybrid` — FTS5 + semantic with Reciprocal Rank Fusion
  - `GET /api/search?q=...` — new alias endpoint, defaults to `mode=hybrid`
  - CLI: `mails inbox --query "keyword" --semantic` or `--mode hybrid`
  - Graceful degradation: returns empty results when AI/VECTORIZE bindings are absent
- **Dashboard Console** — visual email management at `mails0.com/console`
  - View inbox, read emails, manage threads in a browser UI
  - Dark/light theme support, responsive design
- **67 new tests** (embeddings: 15, semantic search: 4, inbox handler modes: 48) — total 298 across 29 test files

### Performance
- Non-blocking embedding generation via `ctx.waitUntil()`
- Hybrid search runs FTS5 and Vectorize in parallel (`Promise.all`)

## [1.5.0] - 2026-03-28

### Added
- **Email Threads** — auto-assign `thread_id` by parsing In-Reply-To / References headers
  - `GET /api/threads` — list threads with latest message preview and count
  - `GET /api/thread?id=` — all emails in a thread (chronological)
  - CLI: `mails inbox --threads`
  - SDK: `getThreads()`, `getThread()`
- **Auto Labels** — rule-based classification on email receive
  - `newsletter` (List-Unsubscribe/List-Id), `notification` (noreply/alerts), `code` (verification code), `personal` (default)
  - `GET /api/inbox?label=` — filter by label
  - CLI: `mails inbox --label notification`
  - New `email_labels` D1 table with unique constraint
- **Structured Data Extraction** — rule-based, no LLM required
  - `POST /api/extract` — extract order, shipping, calendar, receipt, or code data
  - Supports UPS/FedEx/USPS/DHL tracking numbers, ICS calendar parsing, currency amounts
- **Schema migration** — `worker/migrations/0001-threads-and-labels.sql`
- **47 new tests** (threading: 11, labels: 17, extraction: 19) — total 231

### Security
- Case-insensitive header lookup for auto-labeling (postal-mime preserves original casing)
- Mandatory mailbox scoping on thread endpoints
- INSERT OR IGNORE for label idempotency
- Verified email.id for attachment queries in extract handler

### Performance
- Batch IN query for References chain (was N+1)
- CTE-based threads SQL (was nested correlated subqueries)

## [1.3.0] - 2026-03-26

### Added
- **Worker send provider** — send emails via self-hosted Worker `/api/send`
- **Mailbox isolation** — `auth_tokens` D1 table for per-token mailbox binding
- **Webhook notifications** — POST on email receive with HMAC-SHA256 signature
- **Delete API** — `DELETE /api/email` with cascade cleanup (attachments + R2)
- **R2 attachment upload** — large attachments (>100KB) auto-stored in R2 on receive
- **FTS5 full-text search** — replaces LIKE queries in Worker
- **From address validation** — `/api/send` enforces from matches token's mailbox
- **Error handling** — try/catch in email handler, network error wrapping in WorkerSendProvider
- **Key path logging** — console.log/error on email receive, send, and errors
- **SDK `getEmail` and `deleteEmail`** — available in remote, SQLite providers, and SDK export
- **Worker file split** — handlers/ directory for better maintainability
- **57 new handler tests** + 7 worker-send tests (187 total)
- **Git-based Worker deployment** via GitHub Actions

### Changed
- Send priority: `worker_url` > `api_key` > `resend_api_key`
- Error responses never leak internal details to clients
- `/api/me` no longer exposes auth configuration

### Removed
- DB9 storage provider (replaced by Worker + D1)
- Stale design doc (`docs/email-search-design.md`)

## [1.2.4] - 2026-03-25

### Fixed
- Remove device code from headless claim (not supported on current site)

## [1.2.3] - 2026-03-25

### Fixed
- Headless claim — show full URL with session params

## [1.2.2] - 2026-03-24

### Fixed
- Send priority — `api_key` (hosted) takes precedence over `resend_api_key`

## [1.2.1] - 2026-03-23

### Added
- Auto-resolve mailbox from `/v1/me` when `api_key` set but mailbox empty

## [1.2.0] - 2026-03-22

### Added
- Hosted send: 100 free/month + x402 payment
- Attachment support for send (CLI `--attach` flag + SDK)

## [1.1.0] - 2026-03-20

### Added
- Remote StorageProvider for light client mode
- Optional AUTH_TOKEN for open-source Worker
- E2E tests for remote provider ↔ self-hosted Worker
- Email search with FTS5 (Worker) and LIKE fallback (SQLite)
