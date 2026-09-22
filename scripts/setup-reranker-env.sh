#!/usr/bin/env bash
set -euo pipefail

VENV="${EMBEDDING_VENV:-.venv-embeddings}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "ERROR: ${VENV} does not exist."
  echo "Run: npm run embed:setup"
  exit 1
fi

"${VENV}/bin/python" -m pip install --upgrade \
  "sentence-transformers>=5.4.0" \
  "transformers>=4.51.0"

echo
echo "Reranker dependencies ready."
echo "Model weights download on first reranked search."
