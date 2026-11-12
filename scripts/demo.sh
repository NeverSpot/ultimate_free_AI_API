#!/usr/bin/env bash
# Stranger clone test — should complete in <5 minutes on a fresh machine
# Prerequisites: Docker Desktop (or Docker Engine + Compose plugin), git
# Usage: ./scripts/demo.sh
#
# This script clones the repo to a temp directory, launches the full stack,
# verifies health, and sends a streamed completion. It proves a stranger can
# go from zero to a working gateway in under 5 minutes.

set -euo pipefail

DEMO_DIR="${DEMO_DIR:-/tmp/ultimate-frre-ai-demo-$$}"
CLEANUP=${CLEANUP:-1}

cleanup() {
  if [ "$CLEANUP" = "1" ] && [ -d "$DEMO_DIR" ]; then
    echo ""
    echo "🧹 Cleaning up..."
    cd "$DEMO_DIR" && docker compose --profile app down -v 2>/dev/null || true
    rm -rf "$DEMO_DIR"
    echo "✅ Cleanup complete."
  else
    echo ""
    echo "📁 Demo directory preserved at: $DEMO_DIR"
    echo "🧹 Manual cleanup: cd $DEMO_DIR && docker compose --profile app down -v && rm -rf $DEMO_DIR"
  fi
}

trap cleanup EXIT

START_TIME=$(date +%s)

echo "🚀 Ultimate Free AI — Stranger Clone Demo"
echo "=========================================="
echo ""

# 1. Clone
echo "📥 Step 1/5: Cloning repo..."
git clone https://github.com/rishu/Ultimate_frre_ai.git "$DEMO_DIR"
cd "$DEMO_DIR"
echo "   ✅ Cloned to $DEMO_DIR"
echo ""

# 2. Configure
echo "⚙️  Step 2/5: Configuring environment..."
cp .env.example .env
sed -i 's/ADMIN_TOKEN=.*/ADMIN_TOKEN=demo-token/' .env 2>/dev/null \
  || sed -i '' 's/ADMIN_TOKEN=.*/ADMIN_TOKEN=demo-token/' .env
echo "   ✅ .env configured with demo token"
echo ""

# 3. Launch
echo "🐳 Step 3/5: Starting stack (docker compose --profile app up -d --wait)..."
docker compose --profile app up -d --wait
echo "   ✅ All services healthy"
echo ""

# 4. Verify health
echo "🏥 Step 4/5: Checking health..."
HEALTH_RESPONSE=$(curl -sf http://localhost/healthz)
echo "   Response: $HEALTH_RESPONSE"
echo "   ✅ Health check passed"
echo ""

# 5. Stream a completion
echo "🌊 Step 5/5: Streaming a completion..."
echo "   Request: POST /v1/chat/completions (stream=true)"
echo "   ---"
curl -sN -X POST http://localhost/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-token" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Write a haiku about containers"}],"stream":true}'
echo ""
echo "   ---"
echo "   ✅ Streaming completion received"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=========================================="
echo "✅ Demo complete!"
echo "⏱️  Total time: ${ELAPSED}s"
if [ "$ELAPSED" -lt 300 ]; then
  echo "🎯 Under 5 minutes — stranger clone test PASSED"
else
  echo "⚠️  Over 5 minutes (${ELAPSED}s) — investigate Docker pull times"
fi
echo "=========================================="
