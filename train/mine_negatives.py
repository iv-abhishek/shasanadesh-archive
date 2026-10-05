"""
Find the look-alike wrong pages for each training question — on the GPU (ADR-104).

Replaces `npm run train:negatives` (3–5 h on the Mac, and the Mac's search service
must stay up). Here the whole searchable corpus is embedded once on the GPU and every
question is searched the way the retrieval service does it: meaning (Qwen3 embedding)
plus words (TF-IDF), then the current reranker scores the candidates.

    python train/mine_negatives.py --data data/train --pages data/corpus/retrieval-pages.jsonl

Writes data/train/reranker-train.jsonl and reranker-dev.jsonl (the same files
`npm run train:export` writes) and data/train/mining_summary.json.

A wrong page that scores close to the right one may in fact also answer. With
OPENROUTER_API_KEY set, DeepSeek checks those (yes/no) and they are dropped when they
answer; without it, only pages scoring below 95% of the right page are used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer

QUERY_PROMPT = (
    "Instruct: Given a Hindi or English question about Uttar Pradesh government "
    "orders, retrieve relevant government-order passages that answer the question.\n"
    "Query:"
)
MAX_TEXT = 4000
JUDGE = """Question: {q}

Passage:
{p}

Does this passage itself answer the question (state the rule, figure, condition or procedure asked about)? Reply with one word: yes or no."""


def letters_ratio(text: str) -> float:
    letters = len(re.findall(r"[\wऀ-ॿ]", text)) - len(re.findall(r"[\d_]", text))
    return letters / max(1, len(text))


def clean(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def is_dev(source_id: str) -> bool:
    # Same split as src/train/reranker-data.ts: a document goes to one side only.
    digest = hashlib.sha256(f"dev|{source_id}".encode()).hexdigest()[:8]
    return int(digest, 16) % 100 < 8


def words(text: str) -> set[str]:
    return {word for word in re.split(r"[^\wऀ-ॿ]+", text.lower()) if len(word) >= 3}


def shared(a: str, b: str) -> float:
    left, right = words(a), words(b)
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def judge(question: str, passage: str, key: str, model: str) -> bool:
    """True when the model says the passage also answers the question."""
    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": JUDGE.format(q=question, p=passage[:2500])}],
            "max_tokens": 3,
            "temperature": 0,
            "reasoning": {"enabled": False},
        },
        timeout=60,
    )
    response.raise_for_status()
    reply = response.json()["choices"][0]["message"].get("content") or ""
    return reply.strip().lower().startswith("yes")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/train")
    parser.add_argument("--pages", default="data/corpus/retrieval-pages.jsonl")
    parser.add_argument("--embedder", default="Qwen/Qwen3-Embedding-0.6B")
    parser.add_argument("--reranker", default="Qwen/Qwen3-Reranker-0.6B")
    parser.add_argument("--dense", type=int, default=30)
    parser.add_argument("--keyword", type=int, default=20)
    parser.add_argument("--negatives", type=int, default=5)
    parser.add_argument("--max-tokens", type=int, default=1024, help="tokens per page for embedding (the reranker reads 2x)")
    parser.add_argument("--limit-pages", type=int, default=0, help="smoke test only")
    parser.add_argument("--limit-questions", type=int, default=0, help="smoke test only")
    parser.add_argument("--judge-model", default=os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash"))
    args = parser.parse_args()
    data = Path(args.data)
    started = time.time()
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # Searchable pages (canonical variant), as the training questions were made from.
    keys: list[tuple[str, int]] = []
    texts: list[str] = []
    with open(args.pages, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("canonical") is False:
                continue
            text = clean(row.get("text") or "")
            if len(text) < 400 or letters_ratio(text) < 0.45:
                continue
            keys.append((row["sourceId"], int(row["pageNumber"])))
            texts.append(text[:MAX_TEXT])
    if args.limit_pages:
        # Smoke test: the pages the first questions ask about, plus a few others.
        needed = set()
        with open(data / "questions.jsonl", encoding="utf-8") as handle:
            for line in list(handle)[: max(1, args.limit_questions)]:
                row = json.loads(line)
                needed.add((row["sourceId"], int(row["pageNumber"])))
        keep = [i for i, key in enumerate(keys) if key in needed or i < args.limit_pages]
        keys, texts = [keys[i] for i in keep], [texts[i] for i in keep]
    index = {key: position for position, key in enumerate(keys)}
    print(f"{len(texts)} pages")

    questions = []
    with open(data / "questions.jsonl", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if row.get("skip"):
                continue
            position = index.get((row["sourceId"], int(row["pageNumber"])))
            if position is None:
                continue
            for item in row["questions"]:
                questions.append({"q": item["q"], "lang": item.get("lang"), "style": item.get("style"), "pos": position})
    if args.limit_questions:
        questions = questions[: args.limit_questions]
    print(f"{len(questions)} questions")

    embedder = SentenceTransformer(args.embedder, device=device, model_kwargs={"dtype": torch.float16} if device == "cuda" else {})
    embedder.max_seq_length = args.max_tokens
    page_vectors = embedder.encode(texts, batch_size=64, normalize_embeddings=True, convert_to_tensor=True, show_progress_bar=True)
    query_vectors = embedder.encode([item["q"] for item in questions], prompt=QUERY_PROMPT, batch_size=128, normalize_embeddings=True, convert_to_tensor=True, show_progress_bar=True)
    dense = torch.topk(query_vectors @ page_vectors.T, k=min(args.dense, len(texts)), dim=1).indices.cpu().numpy()
    del embedder
    torch.cuda.empty_cache()

    tfidf = TfidfVectorizer(token_pattern=r"[\wऀ-ॿ]{2,}", sublinear_tf=True, min_df=2, max_df=0.3)
    page_matrix = tfidf.fit_transform(texts)
    query_matrix = tfidf.transform([item["q"] for item in questions])
    keyword_scores = (query_matrix @ page_matrix.T).tocsr()

    instruction = (data / "rerank_instruction.txt").read_text(encoding="utf-8").strip()
    reranker = CrossEncoder(
        args.reranker,
        device=device,
        max_length=2 * args.max_tokens,
        prompts={"query": instruction},
        model_kwargs={"dtype": torch.float16} if device == "cuda" else {},
    )

    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    pool = ThreadPoolExecutor(max_workers=16) if key else None
    train_rows: list[str] = []
    dev_rows: list[str] = []
    positive_ranks: list[int] = []
    judged = dropped = 0

    batch = 64
    for start in range(0, len(questions), batch):
        chunk = questions[start : start + batch]
        candidate_lists = []
        pairs = []
        for offset, item in enumerate(chunk):
            row = keyword_scores[start + offset]
            keyword_top = row.indices[np.argsort(-row.data)[: args.keyword]] if row.nnz else []
            positive_source = keys[item["pos"]][0]
            candidates = [item["pos"]] + [
                int(position)
                for position in dict.fromkeys([*dense[start + offset].tolist(), *list(keyword_top)])
                if keys[int(position)][0] != positive_source
            ]
            candidate_lists.append(candidates)
            pairs.extend((item["q"], texts[position]) for position in candidates)
        scores = reranker.predict(pairs, batch_size=32, prompt_name="query", show_progress_bar=False)
        cursor = 0
        checks = []
        for item, candidates in zip(chunk, candidate_lists):
            item_scores = scores[cursor : cursor + len(candidates)]
            cursor += len(candidates)
            positive_score = float(item_scores[0])
            ranked = sorted(zip(candidates[1:], item_scores[1:]), key=lambda pair: -pair[1])
            positive_ranks.append(1 + sum(1 for _, score in ranked if score > positive_score))
            chosen, uncertain = [], []
            for position, score in ranked:
                if shared(texts[position], texts[item["pos"]]) >= 0.6:
                    continue  # another copy of the same order
                if score >= 0.95 * positive_score:
                    uncertain.append(position)
                else:
                    chosen.append(position)
            item["chosen"], item["uncertain"] = chosen, uncertain[:3] if pool else []
            for position in item["uncertain"]:
                checks.append((item, position, pool.submit(judge, item["q"], texts[position], key, args.judge_model)))
        for item, position, future in checks:
            judged += 1
            try:
                if future.result():
                    dropped += 1
                    continue
            except Exception:
                continue
            item.setdefault("confirmed", []).append(position)
        for item in chunk:
            negatives = (item.get("confirmed", []) + item["chosen"])[: args.negatives]
            if len(negatives) < 2:
                continue
            source_id = keys[item["pos"]][0]
            positive = texts[item["pos"]]
            negative_texts = [texts[position] for position in negatives]
            if is_dev(source_id):
                dev_rows.append(json.dumps({"query": item["q"], "positive": [positive], "negative": negative_texts, "lang": item["lang"], "style": item["style"]}, ensure_ascii=False))
            elif not any(is_dev(keys[position][0]) for position in negatives):
                record = {"query": item["q"], "positive": positive}
                for number in range(args.negatives):
                    record[f"negative_{number + 1}"] = negative_texts[number % len(negative_texts)]
                train_rows.append(json.dumps(record, ensure_ascii=False))
        if (start // batch) % 20 == 0:
            print(f"{start + len(chunk)}/{len(questions)} questions · {judged} checked · {dropped} also answered")

    (data / "reranker-train.jsonl").write_text("\n".join(train_rows) + "\n", encoding="utf-8")
    (data / "reranker-dev.jsonl").write_text("\n".join(dev_rows) + "\n", encoding="utf-8")
    ranks = np.array(positive_ranks)
    summary = {
        "pages": len(texts),
        "questions": len(questions),
        "train": len(train_rows),
        "dev": len(dev_rows),
        "currentRerankerOnCandidates": {
            "rightPageFirst": round(float((ranks == 1).mean()), 3),
            "rightPageInTop4": round(float((ranks <= 4).mean()), 3),
        },
        "falseNegativeChecks": judged,
        "droppedAsAlsoAnswering": dropped,
        "minutes": round((time.time() - started) / 60, 1),
    }
    (data / "mining_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
