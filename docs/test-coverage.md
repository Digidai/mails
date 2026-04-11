# Test Coverage Analysis

Last updated: 2026-04-11 (post v1.9.1)

## Current test counts

- **Unit tests:** 399 pass, 0 fail across 45 test files
- **Integration smoke test:** 50+ assertions in `test/integration/api-smoke.sh`
- **Agent team QA prompts:** 3 reusable prompts in `test/prompts/`

## Covered

### Handler logic (unit tests with mocked D1)

| Handler | File | Coverage |
|---------|------|----------|
| `handleSend` | `send-regression.test.ts`, `send.test.ts`, `send-cc-reply.test.ts`, `send-attachments.test.ts` | field validation, type coercion, CC/BCC/array, attachments, from mismatch, idempotency via waitUntil |
| `handleInbox` | `send-regression.test.ts` | param validation (direction, limit, mode, label) |
| `handleMailbox` | `mailbox-crud.test.ts` | PATCH validation, unknown field preservation, DELETE cascade |
| `handleWebhookRoutes` | `webhook-routes.test.ts` | CRUD, label validation, URL validation |
| `handleResendWebhook` | `delivery-status.test.ts`, `suppression.test.ts` | signature verification, missing secret, status mapping |
| `handleGetCode` | `send-regression.test.ts`, `worker-handlers.test.ts` | cross-mailbox rejection, timeout validation |
| `handleClaimAuto` | `claim-auto.test.ts` | name validation, reserved names, duplicates |
| `handleMailboxPause/Resume` | `mailbox-pause.test.ts` | status transitions |
| `handleDomains` | `domains.test.ts`, `domains-extended.test.ts` | CRUD, verification flow |
| `handleExtract` | `extract-data.test.ts`, `extract-code.test.ts` | code/order/shipping/calendar/receipt extraction |
| `handleEvents` | `events.test.ts`, `sse-events-fix.test.ts` | SSE stream, connected event, keepalive |

### Regex / logic functions

| Function | Coverage |
|----------|----------|
| `extractCode` | 17 unit tests — English, Chinese (`是：` dual delimiter), Japanese (`です`), Korean, date rejection (year + YYYYMMDD), false positive prevention |
| `extractOrder` | 6 tests — order_id matching, total with "is" keyword, merchant cleaning, null fallback |
| `extractShipping` | UPS/FedEx/USPS/DHL tracking number detection |
| `extractCalendar` | ICS parsing basics |
| `extractReceipt` | amount/date/payment method extraction |
| `resolveThreadId` | `threading.test.ts` |
| `detectLabels` | `auto-label.test.ts` — newsletter/notification/code/personal rules |
| `parseIncomingEmail` | `mime.test.ts`, `receive.test.ts` — MIME parsing, attachments, headers |

### Regression tests (sedimented from Agent Team findings)

All 25 bugs found during Phase 1/2 agent team testing have at least one unit test
anchoring their fix. New regression tests added in v1.9.1:

- `send-regression.test.ts` — 16 tests covering to-as-string, numeric from, cc normalization, in_reply_to scope, inbox param validation, code cross-mailbox rejection
- `mailbox-crud.test.ts` (extended) — 9 tests for PATCH validation (javascript: URL, numeric, null, empty string, unknown field preservation, array body, http/https acceptance)
- `extract-code.test.ts` (extended) — 6 tests for date rejection (4-digit years, 8-digit YYYYMMDD) and Chinese dual delimiter
- `extract-data.test.ts` (extended) — 3 tests for merchant domain cleaning (not localpart, strip `send.`/`bounce.` prefixes)

### HTTP integration (black-box, real deployment)

`test/integration/api-smoke.sh` covers:
- 9 categories × 40+ assertions
- Runs against any deployment URL (production, staging, local)
- Creates a fresh mailbox, tests, cleans up via cascade delete
- Every assertion maps to a specific fixed bug — used as CI/CD smoke test post-deploy

## NOT covered (gaps)

### High priority — meaningful user scenarios not yet automated

| Gap | Why it matters | How to test |
|-----|----------------|-------------|
| **Attachment round-trip to R2** | Large attachments >100KB auto-upload to R2 and get downloaded via `/v1/attachment`. Only unit tested against mocks, never end-to-end with real R2. | Integration test that sends an email with a 200KB attachment, waits for inbound, then downloads via `/v1/attachment?id=` and verifies byte equality |
| **Delivery status callbacks** | Resend sends `/api/resend-webhook` on delivery events. Handler is unit tested with signed payloads, but we've never verified that real Resend callbacks actually arrive and update `emails.status`. | Send an email to a real external address (e.g. a gmail account you own), wait ~30s, poll `/v1/email?id=` and check `status` transitions from `sent` → `delivered`. Requires having an external test address. |
| **Suppression list auto-population** | When a recipient bounces or complains, they should get added to `suppression_list` automatically via the Resend webhook. Unit tests cover the insert, but we've never verified it end-to-end by triggering a real bounce. | Send to `bounce@simulator.amazonses.com` — this is SES's standard bounce simulator. Wait, then verify `suppression_list` has the entry. |
| **Daily send rate limit triggering** | `DAILY_SEND_LIMIT` env var. Handler returns 429 on 101st send, but never tested against a real counter. Also: does the counter reset correctly at midnight UTC? | Unit test: mock D1 to return count=100, verify 429. Integration: deploy with `DAILY_SEND_LIMIT=5`, fire 6 sends, verify last returns 429. |
| **Semantic search quality** | We have tests that confirm `mode=semantic` doesn't crash, but no tests for retrieval quality — "does searching 'password reset' actually return password reset emails?" Vectorize is eventually consistent and might have indexing lag. | Seed 20 emails with known topics, query with paraphrased terms, check top-5 recall. Requires golden dataset. |
| **CJK FTS5 edge cases** | Trigram works for ≥3 chars, LIKE falls back for <3. Untested: queries with mixed CJK + ASCII (`验证码123`), queries with punctuation (`你好，世界`), queries with fullwidth characters (`测试，搜索`). | Unit test with mocked FTS5 results |
| **Thread merging edge cases** | What if an inbound email's `in_reply_to` points to another inbound email (not the outbound sender)? What about forwarded emails that break the References chain? | Unit test resolveThreadId with various header combinations |
| **Webhook retry behavior** | 4 retries with specific backoff schedule. Unit tested via mocks, never verified against a webhook.site that delays responses. Also: auto-pause after 10 failures is tested in unit but not observed in production. | Integration test with an intentionally slow webhook receiver |
| **Scoped vs full API keys** | `auth_tokens.scope` column exists. Mailbox-scoped keys should reject cross-mailbox access. Only partially tested. | Unit test handler logic for scope enforcement |
| **Migration rollback** | If migration 0007 (FTS5 trigram) fails mid-way, is the DB left in a bad state? | Document rollback procedure; test on a staging D1 |
| **Cold start latency** | First request after deploy is slower. No baseline measured. | Benchmark script: measure P50/P95/P99 cold start over 100 deploys |
| **R2 cleanup cron** | Scheduled cron deletes raw email blobs older than 30 days. No test that the cron runs or that cleanup happens. | Manual: set `created_at` to 40 days ago in ingest_log, wait for next cron tick, verify R2 blob is gone |

### Medium priority — lower likelihood but real

| Gap | Why |
|-----|-----|
| **Vectorize index eventual consistency** | New emails embedded via `waitUntil` — there's a lag before they appear in semantic search. Users might see "empty results" right after send. |
| **Worker deployment atomicity** | What happens to in-flight requests during deploy? Any requests dropped? |
| **D1 concurrent writes** | D1 serializes writes. Is there a write storm scenario that backs up? |
| **Large inbox performance** | What's the P95 for `/v1/inbox` at 10K emails in a mailbox? At 100K? |
| **Base64 attachment decoding** | We validate base64 format, but never decode to check the actual bytes round-trip. |
| **Custom domain DNS verification** | `/v1/domains/:id/verify` calls Cloudflare DoH. Verified to not crash, but actual DNS lookup logic tested only with mocks. |
| **Claim flow across regions** | `/v1/claim/start` → session stored in D1 → `/v1/claim/poll` polls. If user's claim session is in region A but poll goes to region B, does it work? |

### Low priority — exotic scenarios

- Worker hard timeout at 30s on very large emails
- Concurrent deletes (two clients both DELETE /v1/email?id= on the same id)
- Unicode normalization edge cases (é as e + combining mark vs precomposed)
- Emoji in mailbox names
- Time zone edge cases in `daily_send_counts` reset

## Evaluation

### What's working

- **Unit test coverage is strong** for handler logic. Every P0/P1 bug has a test.
- **Regression tests are comprehensive.** The 25 Agent Team findings all have unit tests + integration script coverage.
- **CJK support is tested at multiple levels** — regex (extractCode), SQL (FTS5 + LIKE fallback), real HTTP round-trip.
- **Validation is defensive.** After v1.9.1, every input field has explicit type checking.

### Weakest areas

1. **End-to-end flows that depend on real CF infrastructure.** We simulate everything we can with mocks, but some code paths (R2 attachment upload, Vectorize indexing, Resend delivery callbacks, CF Email Routing delivery) only work in production and have no automated verification.

2. **Performance / latency.** Zero benchmarks. Users will hit P99 latency issues before we see them in dashboards.

3. **Quality metrics for fuzzy features.** Semantic search, auto-labeling, extraction — we test "it doesn't crash" but not "it gives good answers."

4. **Operational scenarios.** Migration rollback, deploy atomicity, D1 pool exhaustion, cold start — none tested.

## Recommended next investments (priority ordered)

1. **`test/integration/api-smoke.sh` in CI post-deploy** — already written. Hook it into the `deploy-worker.yml` workflow as a final step. Currently the deploy is "green" the moment `wrangler deploy` finishes, which doesn't verify anything actually works.

2. **Attachment round-trip integration test** — send a 150KB file, wait, download, verify hash. Needs a real mailbox but no external infrastructure beyond what we already have.

3. **Delivery status integration test** — send to `success@simulator.amazonses.com` and `bounce@simulator.amazonses.com`, poll status, verify delivered/bounced transitions + suppression list insert. This verifies the entire Resend webhook pipeline.

4. **Benchmark script `test/benchmark/latency.sh`** — measure P50/P95/P99 for each endpoint. Store baseline, compare on each release. First sign of a regression.

5. **Agent team exploratory prompt in CI** — run `test/prompts/03-exploratory.md` weekly against production. Low cost, highest bug-finding per dollar.

6. **Semantic search golden set** — 20 emails × 5 query paraphrases = 100 test pairs. Measures retrieval quality over time.

7. **Runbook: migration rollback + D1 disaster recovery** — currently undocumented.

## Test running matrix

| Test type | When to run | Cost | Signal |
|-----------|-------------|------|--------|
| `bun test` (unit) | Every commit | <10s | High for handler bugs, low for integration issues |
| `api-smoke.sh` (integration) | Post-deploy | ~60s | Catches env/config/deploy issues unit tests miss |
| Agent team regression (`01-regression.md`) | Pre-release | 5-10 min × 3 agents | Verifies historic P0/P1 fixes didn't regress |
| Multi-agent scenario (`02-multi-agent-scenario.md`) | When touching send.ts, threading, mailbox handlers | 10-15 min | Catches cross-mailbox / multi-tenant issues unit tests can't see |
| Exploratory (`03-exploratory.md`) | Weekly against prod | 15-20 min | Highest novel-bug yield |
| Benchmarks | Monthly or on suspected regression | 5 min | Latency regressions |

## Bug find ratio (from v1.9.0 → v1.9.1 dataset)

| Method | Bugs found |
|--------|-----------|
| Manual testing by me | 3 |
| Agent team regression (Phase 1) | 17 |
| Agent team multi-agent scenario (Phase 2) | 5 |
| **Total** | **25** |

**Agent team found 8× more bugs than manual testing** in similar time. The multi-agent scenario specifically found 2 bugs (cross-mailbox leak, from_address envelope) that no single-mailbox test would ever have caught.
