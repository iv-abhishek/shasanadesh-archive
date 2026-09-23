#!/usr/bin/env bash
set -euo pipefail

export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8791/v1}"
export LLM_MODEL="${LLM_MODEL:-mlx-community/Qwen3-8B-4bit}"
export LLM_API_KEY="${LLM_API_KEY:-local-development}"
export RAG_TOP_K="${RAG_TOP_K:-4}"
export LOCAL_GPU_SERIALIZE="${LOCAL_GPU_SERIALIZE:-1}"
export LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-600}"
export LLM_REPAIR_MAX_TOKENS="${LLM_REPAIR_MAX_TOKENS:-450}"
export LLM_TEMPERATURE="${LLM_TEMPERATURE:-0.1}"
export LLM_REQUEST_TIMEOUT_MS="${LLM_REQUEST_TIMEOUT_MS:-1200000}"

echo "Starting Shasanadesh API with local generator:"
echo "  LLM_BASE_URL=${LLM_BASE_URL}"
echo "  LLM_MODEL=${LLM_MODEL}"
echo "  RAG_TOP_K=${RAG_TOP_K}"
echo

exec npm run api:dev
