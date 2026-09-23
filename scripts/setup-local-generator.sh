#!/usr/bin/env bash
set -euo pipefail

MODEL="${LOCAL_LLM_MODEL:-mlx-community/Qwen3-8B-4bit}"

if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
  echo "This local setup is intended for Apple Silicon macOS."
  echo "For production/Linux GPU serving, keep using the OpenAI-compatible LLM_BASE_URL abstraction."
  exit 1
fi

if [[ ! -d .venv-generator ]]; then
  python3 -m venv .venv-generator
fi

.venv-generator/bin/python -m pip install --upgrade pip
.venv-generator/bin/python -m pip install --upgrade mlx-lm

echo
echo "Local generator environment ready."
echo "Default model: ${MODEL}"
echo "The model downloads on first server start."
