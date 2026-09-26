#!/usr/bin/env bash
set -euo pipefail

VENV="${EMBEDDING_VENV:-.venv-embeddings}"
if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "ERROR: ${VENV} does not exist. Run: npm run embed:setup"
  exit 1
fi

"${VENV}/bin/python" -m pip install -r requirements/retrieval.txt

echo "Retrieval HTTP service dependencies ready."
