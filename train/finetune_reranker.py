"""
Fine-tune Qwen3-Reranker-0.6B on Sandarbh's own question → page pairs (ADR-104).

Runs on a rented GPU (an A100 40GB is plenty; see docs/GPU_RUNBOOK.md):

    pip install -r train/requirements-gpu.txt
    python train/finetune_reranker.py --data data/train --out out/sandarbh-reranker-v1

Input (from `npm run train:export` on the Mac):
    data/train/reranker-train.jsonl   {"query", "positive", "negative_1".."negative_5"}
    data/train/reranker-dev.jsonl     {"query", "positive": [..], "negative": [..]}
    data/train/rerank_instruction.txt the instruction the retrieval service uses

It scores the dev set with the untrained model first, trains, scores again,
and writes both numbers to <out>/dev_scores.json. Use the new model only if
the dev MRR goes up; then check it end to end with `npm run eval:ask`.

The output folder loads exactly like the original model: set
RERANKER_MODEL=<path to the folder> in .env and restart the retrieval service.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch
from datasets import load_dataset
from sentence_transformers.cross_encoder import (
    CrossEncoder,
    CrossEncoderTrainer,
    CrossEncoderTrainingArguments,
)
from sentence_transformers.cross_encoder.evaluation import CrossEncoderRerankingEvaluator
from sentence_transformers.cross_encoder.losses import MultipleNegativesRankingLoss


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/train")
    parser.add_argument("--base", default="Qwen/Qwen3-Reranker-0.6B")
    parser.add_argument("--out", default="out/sandarbh-reranker-v1")
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--lr", type=float, default=1e-5)
    parser.add_argument("--batch", type=int, default=8, help="questions per step (each with 5 wrong pages)")
    parser.add_argument("--max-length", type=int, default=1024, help="tokens per question+page pair")
    parser.add_argument("--dev-limit", type=int, default=800)
    parser.add_argument("--max-steps", type=int, default=-1, help="smoke test only")
    args = parser.parse_args()

    data = Path(args.data)
    instruction = (data / "rerank_instruction.txt").read_text(encoding="utf-8").strip()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Same instruction the retrieval service passes (prompt_name="query"). Weights stay
    # float32 for training (bf16 autocast below); the service loads them as before.
    model = CrossEncoder(args.base, max_length=args.max_length, prompts={"query": instruction})

    dev = read_jsonl(data / "reranker-dev.jsonl")[: args.dev_limit]
    evaluator = CrossEncoderRerankingEvaluator(
        samples=[{"query": row["query"], "positive": row["positive"], "negative": row["negative"]} for row in dev],
        at_k=10,
        name="sandarbh-dev",
        prompt_name="query",
        batch_size=32,
    )
    before = evaluator(model)
    print("dev before:", json.dumps(before, indent=2))

    train = load_dataset("json", data_files=str(data / "reranker-train.jsonl"), split="train")
    columns = ["query", "positive"] + [f"negative_{index}" for index in range(1, 6)]
    train = train.select_columns(columns).shuffle(seed=13)
    print(f"training on {len(train)} questions")

    # The five mined wrong pages per question, plus other questions' pages in the batch.
    # Saves memory on long Hindi pages. Enabled on the inner Qwen model: the
    # trainer's own switch passes arguments this sentence-transformers model rejects.
    inner = model[0].model
    inner.config.use_cache = False
    inner.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})

    loss = MultipleNegativesRankingLoss(model, num_negatives=4)
    training_args = CrossEncoderTrainingArguments(
        output_dir=str(out / "checkpoints"),
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch,
        learning_rate=args.lr,
        warmup_steps=0.1,  # a float is a ratio in Transformers v5
        lr_scheduler_type="cosine",
        bf16=torch.cuda.is_available(),
        logging_steps=20,
        eval_strategy="no",
        save_strategy="no",
        report_to="none",
        prompts=instruction,
        seed=13,
    )
    trainer = CrossEncoderTrainer(model=model, args=training_args, train_dataset=train, loss=loss)
    trainer.train()

    after = evaluator(model)
    print("dev after:", json.dumps(after, indent=2))
    model.save_pretrained(str(out))
    (out / "dev_scores.json").write_text(
        json.dumps({"before": before, "after": after, "train_questions": len(train), "args": vars(args)}, indent=2),
        encoding="utf-8",
    )
    key = next((name for name in after if name.endswith("mrr@10") and "base_" not in name), None)
    if key:
        verdict = "better" if after[key] > before[key] else "NOT better — keep the original model"
        print(f"\nMRR@10 {before[key]:.3f} → {after[key]:.3f}: {verdict}")
    print(f"Saved to {out}. Zip it and copy it to the Mac (docs/GPU_RUNBOOK.md).")


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
