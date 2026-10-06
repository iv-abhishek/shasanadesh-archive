# GPU runbook — reranker training and PaddleOCR-VL (ADR-104)

Rent only when the Mac-side files are ready. Recommended: **Jarvislabs** (India region, INR,
per-minute billing). Pick a PyTorch template (CUDA 12.x, Python 3.10–3.12).

| Job | GPU | Expected time | Cost (approx.) |
|---|---|---|---|
| Reranker fine-tune (~12k questions) | A100-80GB (40GB if free) | 2–3 h (v1 took 8 h at full page length) | ₹300–450 |
| PaddleOCR-VL, 1,000 scanned pages | L4 24GB or A100 | 1–2 h | ₹50–200 |

Delete the instance when done (storage bills while paused). Nothing here needs your API keys.

## 1. Reranker

On the Mac (questions are already written; nothing else needs the search service):

```
npm run train:pack            # → sandarbh-train.tgz (questions, searchable pages, scripts; ~40 MB)
```

On the GPU (upload `sandarbh-train.tgz` with the Jarvislabs file browser or `scp`):

```
tar -xzf sandarbh-train.tgz
export OPENROUTER_API_KEY=...   # required: DeepSeek checks near-miss pages (~$2–4)
bash train/run_gpu.sh           # mines wrong pages on the GPU, trains, prints "MRR@10 before → after"
```

Continue only if it says "better". Download `sandarbh-reranker-v2.tgz` (≈1.2 GB), then delete the instance.

Back on the Mac:

```
mkdir -p models && tar -xzf sandarbh-reranker-v2.tgz -C models
# .env:  RERANKER_MODEL=models/sandarbh-reranker-v2   (to undo: delete the line)
npm run dev:all -- --restart=all
npm run eval:ask -- --pipeline hybrid --label reranker-v1   # compare with the last hybrid eval
```

(`npm run train:negatives` + `train:export` still work on the Mac but take 3–5 hours with the
search service running; the GPU does the same search in minutes.)

## 2. OCR

Cheapest first: PP-OCRv5 Hindi on the Mac, no GPU (`npm run ocr:setup` once, then
`npm run ocr:local -- --batch data/ocr-batch/ocr-trial` and
`npm run ocr:import -- data/ocr-batch/ocr-trial --engine ppocr`). PaddleOCR-VL below needs the GPU to
itself (it hung when sharing it with training on 6 Oct); test one document first with `--limit 1`.

### PaddleOCR-VL

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
