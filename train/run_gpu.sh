#!/usr/bin/env bash
# One command on the rented GPU (docs/GPU_RUNBOOK.md): mine wrong pages, train, package.
#   tar -xzf sandarbh-train.tgz && bash train/run_gpu.sh
# Optional: export OPENROUTER_API_KEY=... first, so DeepSeek checks near-miss pages.
set -euo pipefail
pip install -q -r train/requirements-gpu.txt
python train/mine_negatives.py --data data/train --pages data/corpus/retrieval-pages.jsonl
python train/finetune_reranker.py --data data/train --out out/sandarbh-reranker-v1
cp data/train/mining_summary.json out/sandarbh-reranker-v1/
tar -czf sandarbh-reranker-v1.tgz --exclude checkpoints -C out sandarbh-reranker-v1
echo "Download sandarbh-reranker-v1.tgz, then delete this instance."
