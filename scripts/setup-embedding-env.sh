#!/usr/bin/env bash
set -euo pipefail

VENV="${EMBEDDING_VENV:-.venv-embeddings}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is not installed."
  exit 1
fi

echo "Python: $(python3 --version)"
echo "Creating/updating embedding environment: ${VENV}"

if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi

"${VENV}/bin/python" -m pip install --upgrade pip
"${VENV}/bin/python" -m pip install \
  "sentence-transformers>=2.7.0" \
  "transformers>=4.51.0" \
  "psycopg[binary]>=3.2"

echo
echo "Embedding environment ready."
echo "Model weights will be downloaded on first embedding/search run."
echo
echo "Activate with:"
echo "  source ${VENV}/bin/activate"
