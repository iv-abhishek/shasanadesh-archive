"""
Hybrid retrieval + Qwen3 reranking.

Stages:
  1. Qwen3-Embedding query embedding
  2. pgvector cosine candidates
  3. PostgreSQL lexical/trigram candidates
  4. weighted reciprocal-rank fusion
  5. Qwen3-Reranker scoring of fused chunks
  6. final deduplication by logical PDF page

Important:
- reranking is about relevance, NOT factual correctness
- alternate OCR may still contain corrupted numbers/dates
- NUMERIC-CONFLICT pages must be verified against canonical/source evidence
  before critical numeric claims are generated
"""

from __future__ import annotations

import argparse
import os
from collections import defaultdict
from dataclasses import dataclass

import psycopg
import torch
from sentence_transformers import CrossEncoder, SentenceTransformer

DATABASE_URL = os.environ.get("DATABASE_URL")

EMBEDDING_MODEL = os.getenv(
    "EMBEDDING_MODEL",
    "Qwen/Qwen3-Embedding-0.6B",
)

RERANKER_MODEL = os.getenv(
    "RERANKER_MODEL",
    "Qwen/Qwen3-Reranker-0.6B",
)

QUERY_PROMPT = (
    "Instruct: Given a Hindi or English question about Uttar Pradesh government "
    "orders, retrieve relevant government-order passages that answer the question.\n"
    "Query:"
)

RRF_K = 60
VECTOR_WEIGHT = 1.0
LEXICAL_WEIGHT = 1.2


@dataclass
class Hit:
    chunk_id: str
    logical_page_id: str
    source_id: str
    page_number: int
    variant_type: str
    canonical: bool
    text: str
    numeric_conflict: bool
    department: str | None
    go_number: str | None
    go_date: str | None
    source_url: str
    vector_score: float | None = None
    lexical_score: float | None = None
    fused_score: float = 0.0
    rerank_score: float = 0.0


def choose_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def vector_literal(values) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("--candidates", type=int, default=50)
    parser.add_argument("--rerank", type=int, default=24)
    parser.add_argument("--limit", type=int, default=10)
    return parser.parse_args()


def row_to_hit(row, *, vector=False, lexical=False) -> Hit:
    hit = Hit(
        chunk_id=row[0],
        logical_page_id=row[1],
        source_id=row[2],
        page_number=row[3],
        variant_type=row[4],
        canonical=row[5],
        text=row[6],
        numeric_conflict=row[7],
        department=row[8],
        go_number=row[9],
        go_date=str(row[10]) if row[10] is not None else None,
        source_url=row[11],
    )

    if vector:
        hit.vector_score = float(row[12])

    if lexical:
        hit.lexical_score = float(row[12])

    return hit


def retrieve(query: str, query_vector: str, candidate_count: int) -> list[Hit]:
    with psycopg.connect(DATABASE_URL) as conn:
        vector_rows = conn.execute(
            """
            SELECT
              c.variant_chunk_id,
              c.logical_page_id,
              c.source_id,
              c.page_number,
              c.variant_type,
              c.canonical,
              c.text_content,
              p.numeric_conflict,
              d.department,
              d.go_number,
              d.go_date,
              d.source_url,
              1 - (c.embedding <=> %s::vector(1024)) AS score
            FROM chunks c
            JOIN pages p
              ON p.source_id = c.source_id
             AND p.page_number = c.page_number
            JOIN documents d
              ON d.source_id = c.source_id
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> %s::vector(1024)
            LIMIT %s
            """,
            (query_vector, query_vector, candidate_count),
        ).fetchall()

        lexical_rows = conn.execute(
            """
            SELECT
              c.variant_chunk_id,
              c.logical_page_id,
              c.source_id,
              c.page_number,
              c.variant_type,
              c.canonical,
              c.text_content,
              p.numeric_conflict,
              d.department,
              d.go_number,
              d.go_date,
              d.source_url,
              (
                CASE
                  WHEN to_tsvector('simple', c.text_content)
                       @@ plainto_tsquery('simple', %s)
                  THEN ts_rank_cd(
                    to_tsvector('simple', c.text_content),
                    plainto_tsquery('simple', %s)
                  )
                  ELSE 0
                END
                + similarity(c.text_content, %s) * 0.25
              ) AS score
            FROM chunks c
            JOIN pages p
              ON p.source_id = c.source_id
             AND p.page_number = c.page_number
            JOIN documents d
              ON d.source_id = c.source_id
            WHERE
              to_tsvector('simple', c.text_content)
                @@ plainto_tsquery('simple', %s)
              OR similarity(c.text_content, %s) > 0.01
            ORDER BY score DESC
            LIMIT %s
            """,
            (
                query,
                query,
                query,
                query,
                query,
                candidate_count,
            ),
        ).fetchall()

    vector_hits = [row_to_hit(row, vector=True) for row in vector_rows]
    lexical_hits = [row_to_hit(row, lexical=True) for row in lexical_rows]

    fused_scores: dict[str, float] = defaultdict(float)
    hits: dict[str, Hit] = {}

    for rank, hit in enumerate(vector_hits, start=1):
        fused_scores[hit.chunk_id] += VECTOR_WEIGHT / (RRF_K + rank)
        hits[hit.chunk_id] = hit

    for rank, hit in enumerate(lexical_hits, start=1):
        fused_scores[hit.chunk_id] += LEXICAL_WEIGHT / (RRF_K + rank)

        existing = hits.get(hit.chunk_id)
        if existing:
            existing.lexical_score = hit.lexical_score
        else:
            hits[hit.chunk_id] = hit

    ranked_ids = sorted(
        fused_scores,
        key=lambda chunk_id: fused_scores[chunk_id],
        reverse=True,
    )

    result: list[Hit] = []

    for chunk_id in ranked_ids:
        hit = hits[chunk_id]
        hit.fused_score = fused_scores[chunk_id]
        result.append(hit)

    return result


def main() -> None:
    args = parse_args()

    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL is not set.")

    device = choose_device()

    print(f"Embedding model: {EMBEDDING_MODEL}")
    print(f"Reranker model:  {RERANKER_MODEL}")
    print(f"Device:          {device}")
    print()

    embedder = SentenceTransformer(
        EMBEDDING_MODEL,
        device=device,
    )

    query_embedding = embedder.encode(
        [args.query],
        prompt=QUERY_PROMPT,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )[0]

    fused_hits = retrieve(
        args.query,
        vector_literal(query_embedding),
        args.candidates,
    )

    rerank_pool = fused_hits[: args.rerank]

    if not rerank_pool:
        print("No retrieval candidates.")
        return

    print(
        f"Hybrid candidates={len(fused_hits)} | "
        f"reranking top={len(rerank_pool)}"
    )
    print("Loading reranker (first run may download model weights)...")

    reranker = CrossEncoder(
        RERANKER_MODEL,
        device=device,
    )

    pairs = [
        (args.query, hit.text)
        for hit in rerank_pool
    ]

    scores = reranker.predict(
        pairs,
        batch_size=4,
        show_progress_bar=True,
    )

    for hit, score in zip(rerank_pool, scores, strict=True):
        hit.rerank_score = float(score)

    rerank_pool.sort(
        key=lambda hit: hit.rerank_score,
        reverse=True,
    )

    # Final results are logical pages, not extraction variants/chunks.
    selected: list[Hit] = []
    seen_pages: set[str] = set()

    for hit in rerank_pool:
        if hit.logical_page_id in seen_pages:
            continue

        seen_pages.add(hit.logical_page_id)
        selected.append(hit)

        if len(selected) >= args.limit:
            break

    print()
    print(f"Query: {args.query}")
    print()

    for index, hit in enumerate(selected, start=1):
        conflict = (
            " NUMERIC-CONFLICT"
            if hit.numeric_conflict
            else ""
        )

        provenance = (
            f"{hit.variant_type}/"
            f"{'canonical' if hit.canonical else 'alternate'}"
        )

        print("=" * 78)
        print(
            f"#{index} rerank={hit.rerank_score:.6f} "
            f"fused={hit.fused_score:.6f} | "
            f"{hit.source_id} | page {hit.page_number} | "
            f"{provenance}{conflict}"
        )
        print(f"Department: {hit.department or '(unknown)'}")
        print(
            f"GO: {hit.go_number or '(unknown)'} | "
            f"Date: {hit.go_date or '(unknown)'}"
        )
        print(f"Source: {hit.source_url}")
        print()
        print(" ".join(hit.text.split())[:800])
        print()


if __name__ == "__main__":
    main()
