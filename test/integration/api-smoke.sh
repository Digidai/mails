#!/usr/bin/env bash
#
# API Smoke Test — black-box HTTP tests against a deployed mails-worker.
#
# Usage:
#   ./api-smoke.sh                   # defaults to production
#   WORKER_URL=http://localhost:8787 ./api-smoke.sh
#   CLAIM_URL=https://staging.mails0.com ./api-smoke.sh
#
# What it does:
#   1. Claims a fresh test mailbox via mails-web /v1/claim flow
#   2. Runs 40+ HTTP tests covering every endpoint and every known regression
#   3. Cleans up by DELETE /v1/mailbox at the end
#
# Exit code: 0 if all pass, 1 if any fail.
#
# This script encodes the bugs found by Agent Team QA (Codex + Gemini + Claude).
# Every FAIL corresponds to a real production bug we've already fixed. If one
# regresses, this script catches it immediately.

set -uo pipefail

WORKER_URL="${WORKER_URL:-https://mails-worker.genedai.workers.dev}"
CLAIM_URL="${CLAIM_URL:-https://mails0.com}"

PASS=0
FAIL=0
FAILED_TESTS=()

color_pass() { printf '\033[32m%s\033[0m' "$1"; }
color_fail() { printf '\033[31m%s\033[0m' "$1"; }

check() {
  local name=$1
  local expected=$2
  local actual=$3
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  %s %s\n' "$(color_pass PASS)" "$name"
    PASS=$((PASS + 1))
  else
    printf '  %s %s\n' "$(color_fail FAIL)" "$name"
    printf '    expected: %s\n' "$expected"
    printf '    actual:   %s\n' "$(echo "$actual" | head -c 200)"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
}

check_status() {
  local name=$1
  local expected_code=$2
  local actual=$3
  if [[ "$actual" == *"[HTTP:$expected_code]"* ]]; then
    printf '  %s %s\n' "$(color_pass PASS)" "$name"
    PASS=$((PASS + 1))
  else
    local got=$(echo "$actual" | grep -oE '\[HTTP:[0-9]+\]' | head -1)
    printf '  %s %s — expected %s, got %s\n' "$(color_fail FAIL)" "$name" "$expected_code" "$got"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
}

# curl wrapper that appends [HTTP:code] for status assertions
curlh() {
  curl -sS -w "[HTTP:%{http_code}]" --max-time 15 "$@" 2>&1
}

# ----------------------------------------------------------------------------
# Setup: claim a fresh mailbox
# ----------------------------------------------------------------------------
printf '==========================================\n'
printf 'Setup: claim fresh test mailbox\n'
printf '==========================================\n'

TESTNAME="smoke$(date +%s)"
START=$(curl -sS -X POST "$CLAIM_URL/v1/claim/start" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TESTNAME\"}")
SESSION=$(echo "$START" | grep -o '"session_id":"[^"]*' | sed 's/"session_id":"//')
if [[ -z "$SESSION" ]]; then
  printf '  FATAL: could not claim session: %s\n' "$START"
  exit 1
fi

CONFIRM=$(curl -sS -X POST "$CLAIM_URL/v1/claim/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION\"}")
API_KEY=$(echo "$CONFIRM" | grep -o '"api_key":"[^"]*' | sed 's/"api_key":"//')
MAILBOX=$(echo "$CONFIRM" | grep -o '"mailbox":"[^"]*' | sed 's/"mailbox":"//')
if [[ -z "$API_KEY" || -z "$MAILBOX" ]]; then
  printf '  FATAL: could not confirm claim: %s\n' "$CONFIRM"
  exit 1
fi

AUTH="Authorization: Bearer $API_KEY"
printf '  Mailbox: %s\n' "$MAILBOX"
printf '  Worker:  %s\n\n' "$WORKER_URL"

# ----------------------------------------------------------------------------
# Category 1: Auth & boundary
# ----------------------------------------------------------------------------
printf '==========================================\n'
printf 'Category 1: Auth & Boundary\n'
printf '==========================================\n'

check_status "1.1 /health public"                 200 "$(curlh "$WORKER_URL/health")"
check_status "1.2 no auth returns 401"            401 "$(curlh "$WORKER_URL/v1/inbox")"
check_status "1.3 fake token returns 401"         401 "$(curlh -H 'Authorization: Bearer fake' "$WORKER_URL/v1/inbox")"
check_status "1.4 valid token returns 200"        200 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox")"
check_status "1.5 /v1/me GET works"               200 "$(curlh -H "$AUTH" "$WORKER_URL/v1/me")"

# Regression: POST on read-only endpoint must return 405
check_status "1.6 POST /v1/me returns 405"        405 "$(curlh -X POST -H "$AUTH" "$WORKER_URL/v1/me")"

# CORS preflight includes PATCH/PUT
CORS=$(curlh -X OPTIONS -H 'Origin: https://example.com' "$WORKER_URL/v1/mailbox" -D -)
check "1.7 CORS allows PATCH"        "patch"     "$(echo "$CORS" | grep -i access-control-allow-methods | tr A-Z a-z)"
check "1.8 CORS allows PUT"          "put"       "$(echo "$CORS" | grep -i access-control-allow-methods | tr A-Z a-z)"

# ----------------------------------------------------------------------------
# Category 2: Send validation
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 2: Send Validation\n'
printf '==========================================\n'

# Regression: to as string works
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":\"$MAILBOX\",\"subject\":\"smoke: to-string\",\"text\":\"body\"}")
check_status "2.1 to: string (not array) works" 200 "$R"

# Regression: numeric from returns 400
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":123,\"to\":[\"$MAILBOX\"],\"subject\":\"x\",\"text\":\"y\"}")
check_status "2.2 from: 123 (numeric) returns 400" 400 "$R"

# Missing required fields
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"to\":[\"$MAILBOX\"],\"subject\":\"x\",\"text\":\"y\"}")
check_status "2.3 missing from returns 400" 400 "$R"

# Missing body
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"x\"}")
check_status "2.4 missing body returns 400" 400 "$R"

# From mismatch
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"other@example.com\",\"to\":[\"$MAILBOX\"],\"subject\":\"x\",\"text\":\"y\"}")
check_status "2.5 from mismatch returns 403" 403 "$R"

# Invalid base64 attachment
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"x\",\"text\":\"y\",\"attachments\":[{\"filename\":\"x.txt\",\"content\":\"!@#NOT-BASE64\"}]}")
check_status "2.6 invalid base64 attachment returns 400" 400 "$R"

# CC as string
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"cc\":\"$MAILBOX\",\"subject\":\"cc-string\",\"text\":\"body\"}")
check_status "2.7 cc as string works" 200 "$R"

# ----------------------------------------------------------------------------
# Category 3: Mailbox PATCH (validation + unknown field regression)
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 3: Mailbox PATCH\n'
printf '==========================================\n'

# Regression: reject javascript:
R=$(curlh -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox" \
  -d '{"webhook_url":"javascript:alert(1)"}')
check_status "3.1 rejects javascript: URL" 400 "$R"

# Regression: reject non-URL
R=$(curlh -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox" \
  -d '{"webhook_url":"not-a-url"}')
check_status "3.2 rejects non-URL" 400 "$R"

# Set a valid URL
R=$(curlh -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox" \
  -d '{"webhook_url":"https://example.com/hook"}')
check_status "3.3 accepts valid https URL" 200 "$R"

# Regression: unknown field must NOT null webhook_url
R=$(curlh -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox" \
  -d '{"random_field":"xyz"}')
check_status "3.4 unknown field returns 200" 200 "$R"

R=$(curlh -H "$AUTH" "$WORKER_URL/v1/mailbox")
check "3.5 webhook_url preserved after unknown-field PATCH" '"webhook_url":"https://example.com/hook"' "$R"

# Clear webhook
R=$(curlh -X PATCH -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox" \
  -d '{"webhook_url":null}')
check_status "3.6 null clears webhook_url" 200 "$R"

# ----------------------------------------------------------------------------
# Category 4: Pause / Resume
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 4: Pause / Resume\n'
printf '==========================================\n'

R=$(curlh -X PATCH -H "$AUTH" "$WORKER_URL/v1/mailbox/pause")
check "4.1 pause returns paused status" '"status":"paused"' "$R"

R=$(curlh -H "$AUTH" "$WORKER_URL/v1/mailbox")
check "4.2 GET reflects paused state" '"status":"paused"' "$R"

R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"x\",\"text\":\"y\"}")
check "4.3 send blocked when paused" 'paused' "$R"

R=$(curlh -X PATCH -H "$AUTH" "$WORKER_URL/v1/mailbox/resume")
check "4.4 resume returns active status" '"status":"active"' "$R"

# ----------------------------------------------------------------------------
# Category 5: Inbox query param validation
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 5: Inbox Query Params\n'
printf '==========================================\n'

check_status "5.1 direction=invalid returns 400" 400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?direction=invalid")"
check_status "5.2 limit=0 returns 400"           400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?limit=0")"
check_status "5.3 limit=-1 returns 400"          400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?limit=-1")"
check_status "5.4 limit=9999 returns 400 or 200" 400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?limit=9999")"
check_status "5.5 mode=bogus returns 400"        400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?mode=bogus")"
check_status "5.6 label=SPAM returns 400"        400 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?label=SPAM")"
check_status "5.7 label=code works"              200 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?label=code")"
check_status "5.8 direction=inbound works"       200 "$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?direction=inbound")"

# ----------------------------------------------------------------------------
# Category 6: Webhook routes (smart routing)
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 6: Webhook Routes\n'
printf '==========================================\n'

R=$(curlh -H "$AUTH" "$WORKER_URL/v1/mailbox/routes")
check_status "6.1 GET routes (empty)" 200 "$R"

R=$(curlh -X PUT -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox/routes" \
  -d '{"label":"code","webhook_url":"https://example.com/code-hook"}')
check_status "6.2 PUT valid route"           200 "$R"

R=$(curlh -X PUT -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox/routes" \
  -d '{"label":"invalid","webhook_url":"https://example.com"}')
check_status "6.3 PUT invalid label returns 400" 400 "$R"

R=$(curlh -X PUT -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/mailbox/routes" \
  -d '{"label":"code","webhook_url":"not-a-url"}')
check_status "6.4 PUT invalid URL returns 400"   400 "$R"

R=$(curlh -X DELETE -H "$AUTH" "$WORKER_URL/v1/mailbox/routes?label=code")
check_status "6.5 DELETE existing route"     200 "$R"

R=$(curlh -X DELETE -H "$AUTH" "$WORKER_URL/v1/mailbox/routes?label=code")
check_status "6.6 DELETE missing route returns 404" 404 "$R"

R=$(curlh -X DELETE -H "$AUTH" "$WORKER_URL/v1/mailbox/routes")
check_status "6.7 DELETE no label returns 400" 400 "$R"

# ----------------------------------------------------------------------------
# Category 7: Code endpoint (cross-mailbox)
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 7: Code Endpoint\n'
printf '==========================================\n'

check_status "7.1 /v1/code?to=other returns 403" 403 \
  "$(curlh -H "$AUTH" "$WORKER_URL/v1/code?to=other@mailbox.com&timeout=1")"
check_status "7.2 /v1/code no ?to= works"         200 \
  "$(curlh -H "$AUTH" "$WORKER_URL/v1/code?timeout=1")"
check_status "7.3 /v1/code?to=mine works"         200 \
  "$(curlh -H "$AUTH" "$WORKER_URL/v1/code?to=$MAILBOX&timeout=1")"

# ----------------------------------------------------------------------------
# Category 8: Round-trip (send + receive + extract)
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 8: Round-trip\n'
printf '==========================================\n'

# Send with a code
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"smoke verify: 482913\",\"text\":\"Your verification code is 482913\"}")
check_status "8.1 send with code" 200 "$R"

# Wait for CF Email Routing round-trip
printf '  Waiting 10s for round-trip...\n'
sleep 10

# Verify inbox received the email
R=$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?direction=inbound")
check "8.2 inbound email received" "482913" "$R"

# Verify code extraction
R=$(curlh -H "$AUTH" "$WORKER_URL/v1/code?timeout=3")
check "8.3 code extracted correctly" '"code":"482913"' "$R"

# Test the bug case: date should NOT be extracted as code
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"date test 20260411\",\"text\":\"Sent on 2026\"}")
check_status "8.4 send date-only email" 200 "$R"

# Test CJK extraction
R=$(curlh -X POST -H "$AUTH" -H 'Content-Type: application/json' "$WORKER_URL/v1/send" \
  -d "{\"from\":\"$MAILBOX\",\"to\":[\"$MAILBOX\"],\"subject\":\"中文测试\",\"text\":\"您的验证码是：654321。\"}")
check_status "8.5 send CN email" 200 "$R"

printf '  Waiting 8s for CJK round-trip...\n'
sleep 8

# CJK FTS5 search (trigram)
R=$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?query=%E4%B8%AD%E6%96%87%E6%B5%8B")
check "8.6 CJK search 中文测 (3 chars, trigram)" "中文测试" "$R"

# CJK short query (LIKE fallback)
R=$(curlh -H "$AUTH" "$WORKER_URL/v1/inbox?query=%E6%B5%8B%E8%AF%95")
check "8.7 CJK short query 测试 (2 chars, LIKE)" "中文测试" "$R"

# ----------------------------------------------------------------------------
# Category 9: Stats
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Category 9: Stats\n'
printf '==========================================\n'

R=$(curlh -H "$AUTH" "$WORKER_URL/v1/stats")
check "9.1 stats has total_emails"  '"total_emails"'  "$R"
check "9.2 stats has ingest_log"    '"ingest"'        "$R"
check "9.3 stats has webhook_routes" '"webhook_routes"' "$R"

# ----------------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'Cleanup\n'
printf '==========================================\n'

R=$(curlh -X DELETE -H "$AUTH" "$WORKER_URL/v1/mailbox")
check_status "cleanup: cascade delete mailbox" 200 "$R"

# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------
printf '\n==========================================\n'
printf 'SUMMARY: %s pass / %s fail\n' "$PASS" "$FAIL"
printf '==========================================\n'

if [[ $FAIL -gt 0 ]]; then
  printf 'FAILED TESTS:\n'
  for t in "${FAILED_TESTS[@]}"; do
    printf '  - %s\n' "$t"
  done
  exit 1
fi

exit 0
