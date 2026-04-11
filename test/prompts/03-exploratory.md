IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. Black-box HTTP test only, using curl.

You are a senior QA engineer testing the mails-agent production API. Your job: find bugs by making real HTTP requests. Probe deeply. Test edge cases. Try to break it.

## Credentials

- Base URL: https://mails-worker.genedai.workers.dev
- API Key: $API_KEY
- Mailbox: $MAILBOX
- Use /v1/* paths (hosted mode)

## Endpoints available

- GET /health (public)
- GET /v1/me
- GET /v1/mailbox, PATCH /v1/mailbox, DELETE /v1/mailbox
- PATCH /v1/mailbox/pause, PATCH /v1/mailbox/resume
- GET/PUT/DELETE /v1/mailbox/routes
- POST /v1/send (fields: from, to, cc, bcc, subject, text, html, reply_to, in_reply_to, headers, attachments)
- GET /v1/inbox (query params: query, mode=keyword|semantic|hybrid, direction=inbound|outbound, label, limit, offset)
- GET /v1/email?id=, DELETE /v1/email?id=
- GET /v1/code?to=&timeout=&since=
- GET /v1/threads, GET /v1/thread?id=
- GET /v1/stats
- POST /v1/extract {email_id, type: code|order|shipping|calendar|receipt}
- GET /v1/domains, POST /v1/domains, POST /v1/domains/:id/verify, DELETE /v1/domains/:id
- GET /v1/events (SSE)

## What to test

Run at least 20 distinct scenarios covering:

1. **Happy paths** for each endpoint (quick sanity check)
2. **Validation errors** — missing fields, wrong types (string/number/array/null), oversized inputs, special characters, empty strings
3. **Auth boundaries** — no token, empty bearer, case-sensitivity (`BEARER` vs `Bearer`), malformed tokens
4. **Edge cases** — unicode in subjects/bodies (中文, 日本語, 한국어, emoji 🎉), CRLF injection attempts, very long strings, JSON injection
5. **Verification code extraction** — various formats (English "code is 123456", Chinese "验证码：123456", Japanese "認証コードは 789 です"), and **false positives** (dates, order numbers, phone numbers, ZIP codes)
6. **Round-trip** — send to yourself, wait ~10s, verify inbox has the email, verify extraction works
7. **Concurrent operations** — multiple sends at once, multiple inbox reads while sends in flight
8. **Pagination** — limit, offset, boundary conditions
9. **Search modes** — keyword, semantic, hybrid; test CJK queries, 1/2/3-char queries, special characters
10. **Labels** — auto-labeling after receive, filter by label, case sensitivity
11. **Threading** — send with in_reply_to, verify thread grouping, verify thread_id response field
12. **Delete cascade** — delete a single email, delete mailbox (cleanup)

## Red flags to watch for

- HTTP 500 — should never happen from user input (always 4xx)
- Silent failures (returning 200 but nothing happened)
- Data type leaks (e.g. database column names in error messages)
- Cross-request state leaks (one request's data in another's response)
- Missing fields in responses
- Undocumented behavior (params that are silently ignored or reinterpreted)
- Security issues (XSS vectors in stored fields, SSRF via webhook URLs, injection in search)

## Report format

```
PASS: <what worked>
BUG P0: <crash/security/data-loss>
BUG P1: <user-visible, non-data-loss>
BUG P2: <DX, minor>
WEIRD: <works but surprising>
QUESTION: <needs clarification>
```

## Budget

~15-20 minutes. Cleanup your test data at the end (delete emails you created, remove routes you added, reset webhook_url). Do NOT delete the mailbox itself.
