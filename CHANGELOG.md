# Changelog

All notable changes to this project will be documented in this file.

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
- **SDK `deleteEmail`** — available in remote, SQLite providers, and SDK export
- **Worker file split** — handlers/ directory for better maintainability
- **53 new handler tests** + 7 worker-send tests (187 total)
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
