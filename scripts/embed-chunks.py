"""
Embed retrieval chunks into PostgreSQL with Qwen3-Embedding-0.6B.

Important:
- document/passages are embedded WITHOUT a query instruction, matching Qwen's
  recommended retrieval usage;
- vectors are L2-normalized before storage;
- embedding_input_sha256 records exactly which chunk text was embedded;
- rerunning is incremental: unchanged chunks already embedded with this model
  are skipped.
"""

from __future__ import annotations

import os
from typing import Iterable

import numpy as np
import psycopg
import torch
from sentence_transformers import SentenceTransformer

MODEL_ID = os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1024"))
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "8"))
DATABASE_URL = os.environ.get("DATABASE_URL")


def vector_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def choose_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main() -> None:
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL is not set.")

    device = choose_device()
    print(f"Embedding model: {MODEL_ID}")
    print(f"Device:          {device}")
    print(f"Dimensions:      {DIMENSIONS}")
    print(f"Batch size:      {BATCH_SIZE}")

    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            SELECT
              variant_chunk_id,
              text_content,
              text_sha256
            FROM chunks
            WHERE
              embedding IS NULL
              OR embedding_model IS DISTINCT FROM %s
              OR embedding_dimensions IS DISTINCT FROM %s
              OR embedding_input_sha256 IS DISTINCT FROM text_sha256
            ORDER BY variant_chunk_id
            """,
            (MODEL_ID, DIMENSIONS),
        ).fetchall()

        if not rows:
            print("All chunks are already embedded and current.")
            return

        print(f"Chunks to embed: {len(rows)}")
        print("Loading model (first run may download ~1.2 GB)...")

        model = SentenceTransformer(MODEL_ID, device=device)

        texts = [row[1] for row in rows]

        embeddings = model.encode(
            texts,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            show_progress_bar=True,
            convert_to_numpy=True,
        )

        if embeddings.ndim != 2:
            raise RuntimeError(f"Unexpected embedding shape: {embeddings.shape}")

        if embeddings.shape[1] != DIMENSIONS:
            raise RuntimeError(
                f"Model returned {embeddings.shape[1]} dimensions; "
                f"database expects {DIMENSIONS}."
            )

        updates = []
        for row, embedding in zip(rows, embeddings, strict=True):
            chunk_id, _text, text_sha256 = row
            updates.append(
                (
                    vector_literal(np.asarray(embedding)),
                    MODEL_ID,
                    DIMENSIONS,
                    text_sha256,
                    chunk_id,
                )
            )

        with conn.cursor() as cur:
            cur.executemany(
                """
                UPDATE chunks
                SET
                  embedding = %s::vector(1024),
                  embedding_model = %s,
                  embedding_dimensions = %s,
                  embedding_input_sha256 = %s,
                  embedded_at = NOW()
                WHERE variant_chunk_id = %s
                """,
                updates,
            )

        conn.commit()

        count = conn.execute(
            """
            SELECT COUNT(*)
            FROM chunks
            WHERE
              embedding IS NOT NULL
              AND embedding_model = %s
              AND embedding_dimensions = %s
            """,
            (MODEL_ID, DIMENSIONS),
        ).fetchone()[0]

        print(f"Embedded chunks now stored: {count}")


if __name__ == "__main__":
    main()
