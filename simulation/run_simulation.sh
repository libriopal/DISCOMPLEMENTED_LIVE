#!/usr/bin/env bash
#
# Monte Carlo Simulation Runner
#
# Runs the full pipeline:
#   1. Dataset ingestion (stream WildChat + SaaS sales from HuggingFace)
#   2. Bot persona generation (10-60 bots from real data patterns)
#   3. Monte Carlo simulation (bots stress-test the pipeline API)
#   4. Report generation (exploits found, credit usage, recommendations)
#
# Credit Safety:
#   - Total budget: 500 credits (hard cap)
#   - Per-bot: 50 credits (hard cap)
#   - Per-conversation: 30 turns (hard cap)
#   - Circuit breaker: 3 tripwire hits = bot killed
#   - Burn rate: 10 credits/min = all bots paused
#
set -euo pipefail

API_URL="${1:-https://discomplemented.com}"
NUM_BOTS="${2:-30}"
CONCURRENCY="${3:-5}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Monte Carlo Value-Assurance Simulation Framework       ║"
echo "║  Discomplement / Bicameral                              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "API: $API_URL"
echo "Bots: $NUM_BOTS (concurrency: $CONCURRENCY)"
echo "Credit budget: 500 total, 50 per-bot"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "ERROR: Python 3 required"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
pip3 install -q datasets aiohttp 2>&1 | tail -1

# Step 1: Dataset ingestion
echo ""
echo "=== Step 1: Dataset Ingestion ==="
python3 simulation/dataset_ingestion.py

# Step 2: Run simulation
echo ""
echo "=== Step 2: Monte Carlo Simulation ==="
python3 simulation/monte_carlo_engine.py --api "$API_URL" --bots "$NUM_BOTS" --concurrency "$CONCURRENCY"

echo ""
echo "=== Simulation Complete ==="
echo "Reports saved in simulation/report_*.json"
