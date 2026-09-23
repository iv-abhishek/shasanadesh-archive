#!/usr/bin/env bash
set -euo pipefail

QUERY="${*:-medical officer seniority}"

echo "Query: ${QUERY}"
echo

curl -N -sS \
  -X POST http://127.0.0.1:8787/api/chat \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg query "${QUERY}" \
    '{
      messages: [
        {
          role: "user",
          content: $query
        }
      ]
    }')"
