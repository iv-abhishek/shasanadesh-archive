#!/usr/bin/env bash
set -euo pipefail

MODEL="${LOCAL_LLM_MODEL:-mlx-community/Qwen3-8B-4bit}"
HOST="${LOCAL_LLM_HOST:-127.0.0.1}"
PORT="${LOCAL_LLM_PORT:-8791}"

SERVER_BIN=".venv-generator/bin/mlx_lm.server"

if [[ ! -x "${SERVER_BIN}" ]]; then
  echo "Missing ${SERVER_BIN}"
  echo "Run: npm run generator:setup"
  exit 1
fi

echo "Starting local MLX generator"
echo "  model: ${MODEL}"
echo "  url:   http://${HOST}:${PORT}/v1"
echo
echo "Local memory safeguards:"
echo "  - Qwen thinking disabled"
echo "  - prompt cache limited to 1 sequence"
echo "  - prefill step size 512"
echo

exec "${SERVER_BIN}" \
  --model "${MODEL}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --prefill-step-size 512 \
  --prompt-cache-size 1 \
  --max-tokens 900 \
  --chat-template-args '{"enable_thinking":false}'
