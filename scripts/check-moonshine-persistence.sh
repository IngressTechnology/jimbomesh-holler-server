#!/usr/bin/env bash
# Moonshine lifetime persistence sanity check (JIM-557)
# Usage: ./scripts/check-moonshine-persistence.sh [holler-url] [api-key] [timeout-seconds]

set -euo pipefail

HOLLER_URL="${1:-http://localhost:1920}"
API_KEY="${2:-}"
TIMEOUT_SECONDS="${3:-120}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required."
  exit 1
fi

if [ -z "${API_KEY}" ] && [ -f ".env" ]; then
  API_KEY="$(awk -F= '/^JIMBOMESH_HOLLER_API_KEY=/{val=$2} END{gsub(/\r/,"",val); print val}' .env)"
fi

if [ -z "${API_KEY}" ]; then
  echo "Error: API key not provided and not found in .env"
  echo "Usage: $0 [holler-url] [api-key] [timeout-seconds]"
  exit 1
fi

fetch_moonshine_lifetime() {
  curl -sS -H "X-API-Key: ${API_KEY}" "${HOLLER_URL}/admin/api/stats" | node -e "
    let data;
    try {
      data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    } catch (_) {
      process.stderr.write('Failed to parse /admin/api/stats response\\n');
      process.exit(2);
    }
    const val = data && data.summary ? data.summary.moonshine_earned_lifetime : null;
    if (val == null || Number.isNaN(Number(val))) {
      process.stderr.write('moonshine_earned_lifetime missing in stats summary\\n');
      process.exit(3);
    }
    process.stdout.write(String(Number(val)));
  "
}

wait_for_holler() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: ${API_KEY}" "${HOLLER_URL}/health")"
    if [ "${code}" = "200" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "Moonshine persistence sanity check"
echo "  URL: ${HOLLER_URL}"
echo "  Timeout: ${TIMEOUT_SECONDS}s"
echo ""

BEFORE="$(fetch_moonshine_lifetime)"
echo "Before restart: ${BEFORE} MSH"

echo "Triggering Holler restart..."
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  "${HOLLER_URL}/admin/api/restart" \
  -d '{"target":"holler"}' >/dev/null || true

echo "Waiting for Holler to become healthy again..."
if ! wait_for_holler; then
  echo "FAIL: Holler did not come back healthy within ${TIMEOUT_SECONDS}s."
  exit 1
fi

AFTER="$(fetch_moonshine_lifetime)"
echo "After restart:  ${AFTER} MSH"

if node -e "
  const before = Number(process.argv[1]);
  const after = Number(process.argv[2]);
  process.exit(Number.isFinite(before) && Number.isFinite(after) && after >= before ? 0 : 1);
" "${BEFORE}" "${AFTER}"; then
  echo "PASS: Lifetime Moonshine persisted across restart (after >= before)."
  exit 0
fi

echo "FAIL: Lifetime Moonshine decreased after restart."
exit 1
