# GPU runbook — reranker training and PaddleOCR-VL (ADR-104)

Rent only when the Mac-side files are ready. Recommended: **Jarvislabs** (India region, INR,
per-minute billing). Pick a PyTorch template (CUDA 12.x, Python 3.10–3.12).

| Job | GPU | Expected time | Cost (approx.) |
|---|---|---|---|
| Reranker fine-tune (~15k questions) | A100 40GB | 2–4 h | ₹250–400 |
| PaddleOCR-VL, 1,000 scanned pages | L4 24GB or A100 | 1–2 h | ₹50–200 |

Delete the instance when done (storage bills while paused). Nothing here needs your API keys.

## 1. Reranker

On the Mac (services running for step b):

```
npm run train:questions -- --pages 5000      # ~1–2 h, ~$1–3 of DeepSeek; resumable
npm run train:negatives                       # needs the retrieval service; ~3–5 h; resumable
npm run train:export                          # writes data/train/*.jsonl + summary.json
tar -czf train-data.tgz data/train/reranker-train.jsonl data/train/reranker-dev.jsonl \
    data/train/rerank_instruction.txt train/finetune_reranker.py train/requirements-gpu.txt
```

On the GPU (upload `train-data.tgz` through the Jarvislabs file browser or `scp`):

```
tar -xzf train-data.tgz
pip install -r train/requirements-gpu.txt
python train/finetune_reranker.py --data data/train --out out/sandarbh-reranker-v1
# prints "MRR@10 before → after"; continue only if it says "better"
tar -czf sandarbh-reranker-v1.tgz -C out sandarbh-reranker-v1
```

Back on the Mac:

```
mkdir -p models && tar -xzf sandarbh-reranker-v1.tgz -C models
# .env:  RERANKER_MODEL=models/sandarbh-reranker-v1   (to undo: delete the line)
npm run dev:all -- --restart=all
npm run eval:ask -- --label reranker-v1      # compare with the last eval
```

## 2. PaddleOCR-VL

On the Mac:

```
npm run ocr:export -- --limit 20 --name ocr-trial     # 20 scanned documents first
tar -czf ocr-trial.tgz -C data/ocr-batch ocr-trial
```

On the GPU:

```
python -m pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
python -m pip install -U "paddleocr[doc-parser]>=3.4.0"
apt-get install -y poppler-utils
tar -xzf ocr-trial.tgz
python ocr_paddle.py --batch ocr-trial          # copy train/ocr_paddle.py up as well
tar -czf ocr-trial-out.tgz ocr-trial/out
```

Back on the Mac:

```
tar -xzf ocr-trial-out.tgz -C data/ocr-batch
npm run ocr:import -- data/ocr-batch/ocr-trial   # writes compare.md: Tesseract vs PaddleOCR-VL
# read compare.md; if worse: npm run ocr:rollback -- data/ocr-batch/ocr-trial
npm run sync:daily                               # rebuild pages and search for those documents
```

If the trial is clearly better, export the backlog (`--limit 2000 --name ocr-batch-1`) and repeat.
