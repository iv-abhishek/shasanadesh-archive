#!/usr/bin/env bash
set -euo pipefail

VENV="${EMBEDDING_VENV:-.venv-embeddings}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "ERROR: ${VENV} does not exist."
  echo "Run: npm run embed:setup"
  exit 1
fi

"${VENV}/bin/python" -m pip install -r requirements/retrieval.txt

echo
echo "Reranker dependencies ready."
echo "Model weights download on first reranked search."
