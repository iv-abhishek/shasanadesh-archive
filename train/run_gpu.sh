#!/usr/bin/env bash
# One command on the rented GPU (docs/GPU_RUNBOOK.md): mine wrong pages, train, package.
#   tar -xzf sandarbh-train.tgz && bash train/run_gpu.sh
# Required: export OPENROUTER_API_KEY=... first (DeepSeek checks near-miss pages; ~$2-4).
# Expect ~10 min reading pages, ~45-75 min finding wrong pages, ~60-90 min training on an A100-80GB.
set -euo pipefail
export PYTHONUNBUFFERED=1   # progress lines reach run.log as they happen
pip install -q -r train/requirements-gpu.txt
python train/mine_negatives.py --data data/train --pages data/corpus/retrieval-pages.jsonl
python train/finetune_reranker.py --data data/train --out out/sandarbh-reranker-v2
cp data/train/mining_summary.json out/sandarbh-reranker-v2/
gzip -kf data/train/candidates.jsonl   # keep: lets the wrong pages be re-filtered without the GPU
tar -czf sandarbh-reranker-v2.tgz --exclude checkpoints -C out sandarbh-reranker-v2
echo "Download sandarbh-reranker-v2.tgz, then delete this instance."
