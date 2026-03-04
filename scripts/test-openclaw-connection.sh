#!/bin/bash
# Test Holler ↔ OpenClaw compatibility
# Usage: ./test-openclaw-connection.sh [holler-url] [api-key]

HOLLER_URL="${1:-http://localhost:1920}"
API_KEY="${2:-$(grep JIMBOMESH_HOLLER_API_KEY .env 2>/dev/null | cut -d= -f2)}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: API key not found"
  echo "Usage: $0 [holler-url] [api-key]"
  echo "Or set JIMBOMESH_HOLLER_API_KEY in .env"
  exit 1
fi

echo "🥃 Testing Holler OpenAI Compatibility"
echo "   URL: $HOLLER_URL"
echo ""

PASS=0
FAIL=0

test_endpoint() {
  local name="$1"
  local method="$2"
  local path="$3"
  local data="$4"
  local expect="$5"

  printf "  %-50s " "$name"

  if [ "$method" = "GET" ]; then
    RESP=$(curl -s -w "\n%{http_code}" -H "X-API-Key: $API_KEY" "$HOLLER_URL$path" 2>/dev/null)
  else
    RESP=$(curl -s -w "\n%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      "$HOLLER_URL$path" \
      -d "$data" 2>/dev/null)
  fi

  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$CODE" = "$expect" ]; then
    echo "✅ ($CODE)"
    PASS=$((PASS+1))
  else
    echo "❌ (got $CODE, expected $expect)"
    if [ -n "$BODY" ]; then
      echo "     Response: $BODY" | head -c 100
      echo ""
    fi
    FAIL=$((FAIL+1))
  fi
}

# Run tests
test_endpoint "Health check" GET "/health" "" "200"

test_endpoint "List models (GET /v1/models)" GET "/v1/models" "" "200"

test_endpoint "Chat completion (non-streaming)" POST "/v1/chat/completions" \
  '{"model":"llama3.1:8b","messages":[{"role":"user","content":"Say ok"}],"stream":false,"max_tokens":5}' \
  "200"

test_endpoint "Chat completion (streaming)" POST "/v1/chat/completions" \
  '{"model":"llama3.1:8b","messages":[{"role":"user","content":"Say ok"}],"stream":true,"max_tokens":5}' \
  "200"

test_endpoint "Embeddings" POST "/v1/embeddings" \
  '{"model":"nomic-embed-text","input":"test"}' \
  "200"

test_endpoint "Invalid model (should 404)" POST "/v1/chat/completions" \
  '{"model":"nonexistent-model","messages":[{"role":"user","content":"test"}]}' \
  "404"

# Test missing auth (use a different curl without API key)
printf "  %-50s " "Missing auth (should 401)"
RESP=$(curl -s -w "\n%{http_code}" "$HOLLER_URL/v1/models" 2>/dev/null)
CODE=$(echo "$RESP" | tail -1)
if [ "$CODE" = "401" ]; then
  echo "✅ ($CODE)"
  PASS=$((PASS+1))
else
  echo "❌ (got $CODE, expected 401)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ $FAIL -eq 0 ]; then
  echo "🥃 All tests passed! Your Holler is OpenClaw-ready."
  exit 0
else
  echo "⚠️  Some tests failed. Check your Holler configuration."
  exit 1
fi
