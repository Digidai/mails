IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. Black-box HTTP test only, using curl.

You are a regression test engineer. Your job: verify that 17+ bugs previously fixed in mails-agent are still fixed in the current production deployment. Report PASS/FAIL for each.

## Credentials (set by caller via env vars)

- Base URL: https://mails-worker.genedai.workers.dev
- API Key: $API_KEY
- Mailbox: $MAILBOX
- Use /v1/* paths

## Fixes to verify

### P0 — crashes and method bypass
1. **`POST /v1/send` with `to: "string"`** (not array) — should return 200, previously returned 500
2. **`POST /v1/me`** — should return 405 with `Allow: GET` header, previously returned 200 (method bypass)

### P1 — data integrity / security
3. **`extractCode` date rejection** — send an email with subject "QA date 20260411" body "Sent on 2026"; after round-trip (~10s) the inbound record should have `code: null`. Neither 4-digit year 2026 nor 8-digit date 20260411 should be extracted.
4. **`extractCode` Chinese dual delimiter** — send "您的验证码是：654321"; after round-trip, `GET /v1/code` should return `{"code":"654321",...}`. The `是：` sequence must be handled correctly.
5. **`PATCH /v1/mailbox` rejects `javascript:` URL** — with 400 and error mentioning "http:// or https://"
6. **`PATCH /v1/mailbox` unknown field preservation** — first set webhook_url to "https://example.com/hook", then PATCH with `{random_field: "xyz"}`, then GET — the webhook_url must still be set (not nulled).
7. **`GET /v1/inbox?direction=invalid`** — returns 400
8. **`GET /v1/inbox?limit=0`** — returns 400
9. **`GET /v1/inbox?limit=9999`** — returns 400 or clamps to 100
10. **`GET /v1/inbox?mode=bogus`** — returns 400
11. **`GET /v1/inbox?label=SPAM`** — returns 400 (not a valid label); label=code should return 200
12. **`GET /v1/code?to=other@mailbox.com`** — returns 403 (cross-mailbox rejection)
13. **CJK FTS5 search** — send email body "这是测试验证码", wait ~8s, GET /v1/inbox?query=验证码 (URL-encode) should find it
14. **CJK short query fallback** — GET /v1/inbox?query=测试 (2 chars) should also find via LIKE fallback
15. **`POST /v1/send` with `from: 123`** (numeric) — returns 400 with "must be a non-empty string"
16. **`POST /v1/send` with invalid base64 attachment** — `{content: "!@#NOT-BASE64"}` returns 400
17. **CORS OPTIONS** — `Access-Control-Allow-Methods` includes PATCH and PUT

### Phase 2 additions (v1.9.1)
18. **`from_address` is RFC5322 From** — after sending yourself an email, the inbound `from_address` should be your mailbox address (e.g. `test@mails0.com`), not a SES bounce address (like `0100019d...@send.mails0.com`)
19. **New sends get a thread_id** — after `POST /v1/send` without `in_reply_to`, the response should include a non-null `thread_id`
20. **`extractOrder` merchant uses domain** — send an email with "Your total is $99.99 Order #TEST-1" then `POST /v1/extract type=order`. The `merchant` field should be a clean domain (e.g. `mails0.com`), not a localpart alone or SES Message-ID prefix.

## Report format

For each fix:
- `FIX N: PASS — <one-line observation>`
- `FIX N: FAIL — <what's still wrong> — <reproduction>`

At the end, report any NEW bugs you found that aren't on the list.

## Budget

~10 minutes total. Don't explore beyond these 20 fixes. Clean up: delete any test emails you created via `DELETE /v1/email?id=<id>`.
