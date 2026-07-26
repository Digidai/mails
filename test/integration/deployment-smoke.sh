#!/usr/bin/env bash
#
# Read-only production smoke test. It validates the deployed Worker and its
# security boundaries without creating a mailbox or writing funnel data.

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://api.mails0.com}"

curlh() {
  curl -sS -w $'\n[HTTP:%{http_code}]' --max-time 20 "$@"
}

require() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != *"$expected"* ]]; then
    printf 'FAIL %s\nexpected: %s\nactual: %.500s\n' "$name" "$expected" "$actual"
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

HEALTH=""
for _attempt in $(seq 1 18); do
  HEALTH="$(curlh "$WORKER_URL/health")"
  if [[ "$HEALTH" == *'"auth_schema":true'* ]]; then
    break
  fi
  sleep 5
done

require "health returns 200" "[HTTP:200]" "$HEALTH"
require "database binding is ready" '"db":true' "$HEALTH"
require "auth schema is ready" '"auth_schema":true' "$HEALTH"
require "bootstrap schema is ready" '"bootstrap_schema":true' "$HEALTH"
require "funnel schema is ready" '"funnel_schema":true' "$HEALTH"
require "growth schema is ready" '"growth_schema":true' "$HEALTH"
require "bootstrap config is ready" '"bootstrap_config":true' "$HEALTH"

CROSS_ORIGIN="$(curlh -X POST "$WORKER_URL/v1/bootstrap" \
  -H 'Origin: https://example.com' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deployment-smoke-cross-origin' \
  -d '{}')"
require "cross-origin bootstrap is blocked" "[HTTP:403]" "$CROSS_ORIGIN"

MISSING_KEY="$(curlh -X POST "$WORKER_URL/v1/bootstrap" \
  -H 'Content-Type: application/json' \
  -d '{}')"
require "bootstrap requires idempotency key" "[HTTP:400]" "$MISSING_KEY"

CORS="$(curlh -X OPTIONS "$WORKER_URL/v1/bootstrap" \
  -H 'Origin: https://mails0.com' \
  -D -)"
require "first-party preflight succeeds" "[HTTP:200]" "$CORS"
require "preflight allows idempotency header" "Idempotency-Key" "$CORS"

printf 'Deployment smoke passed without creating persistent data.\n'
