#!/usr/bin/env bash
# One-time: a Python 3.12 environment with PaddleOCR for the Mac (CPU), in .venv-ocr.
# PaddlePaddle has no Python 3.14 build yet, so it cannot share .venv-embeddings.
set -euo pipefail
if command -v uv >/dev/null 2>&1; then
  uv venv .venv-ocr --python 3.12 --seed
elif command -v python3.12 >/dev/null 2>&1; then
  python3.12 -m venv .venv-ocr
else
  echo "Needs Python 3.12: brew install python@3.12  (or install uv: brew install uv)"; exit 1
fi
.venv-ocr/bin/pip install -q --upgrade pip
.venv-ocr/bin/pip install -q "paddlepaddle==3.2.1" "paddleocr>=3.4.0"
.venv-ocr/bin/python -c "import paddle, paddleocr; print('PaddlePaddle', paddle.__version__, '· PaddleOCR', paddleocr.__version__, '— ready')"
