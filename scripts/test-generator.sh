#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8791/v1}"
MODEL="${LLM_MODEL:-mlx-community/Qwen3-8B-4bit}"

curl -sS "${BASE_URL}/chat/completions" \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg model "${MODEL}" \
    '{
      model: $model,
      messages: [
        {
          role: "user",
          content: "Reply with exactly: generator-ready"
        }
      ],
      temperature: 0,
      max_tokens: 64,
      stream: false
    }')" \
  | jq '{
      model,
      finish_reason: .choices[0].finish_reason,
      content: .choices[0].message.content,
      reasoning_present: (.choices[0].message.reasoning != null),
      usage
    }'
