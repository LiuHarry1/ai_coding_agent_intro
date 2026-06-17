#!/usr/bin/env bash
# Aider polyglot — full flow (learning / smoke test)
#
#   conda activate py311
#   cd eval/aider-polyglot
#   ./run_one_polyglot.sh                       # default: Python first 5
#   ./run_one_polyglot.sh python poly-1         # language run_id
#
# Three steps: prepare -> run -> evaluate
set -euo pipefail

LANGUAGE="${1:-python}"
RUN_ID="${2:-poly-1}"
MODEL_NAME="${MODEL_NAME:-claude-opus-4.6}"
AGENT_URL="${AGENT_URL:-http://localhost:4567}"
LIMIT="${LIMIT:-5}"

echo
echo "=== [1/3] prepare: clone benchmark + copy exercises ==="
python run_polyglot_eval.py prepare --language "$LANGUAGE" --limit "$LIMIT"

echo
echo "=== [2/3] run: agent solves exercises ==="
python run_polyglot_eval.py run --agent-url "$AGENT_URL"

echo
echo "=== [3/3] evaluate: run tests, report pass rate ==="
python run_polyglot_eval.py evaluate --run-id "$RUN_ID" --model-name "$MODEL_NAME"

echo
echo "=== Done! ==="
echo "  Summary: $MODEL_NAME.$RUN_ID.json"
echo "  Logs:    logs/$RUN_ID/<id>.txt"
