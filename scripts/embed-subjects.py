"""
Embed each order's subject line for meaning-based finding (ADR-058).

Input per order: subject (portal subject or adapter title), then department,
section and category, e.g.
  "एग्रीस्टैक ... फार्मर रजिस्ट्री ... विशेष अभियान।
   कृषि विभाग · कृषि अनुभाग-5 · सामान्य"
Stored as passages (no instruction), L2-normalised, like the chunk vectors, in
document_subject_embeddings. Incremental: an order is re-embedded only when this
input text or the model changes. Every order is included, routine ones too: a
subject line is tiny, and finding an order is not the same as answering from it.
"""

from __future__ import annotations

import hashlib
import os

import numpy as np
import psycopg
import torch
from sentence_transformers import SentenceTransformer

MODEL_ID = os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1024"))
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "16"))
DATABASE_URL = os.environ.get("DATABASE_URL")
JOINERS = "‌‍"

SUBJECT_INPUT_SQL = """
SELECT
  d.source_id,
  COALESCE(NULLIF(d.metadata->>'title', ''), NULLIF(d.metadata->'portal'->>'subject', '')) AS subject,
  d.department,
  NULLIF(d.metadata->'portal'->>'section', '') AS section,
  NULLIF(d.metadata->'portal'->>'category', '') AS category,
  e.input_sha256,
  e.embedding_model
FROM documents d
LEFT JOIN document_subject_embeddings e ON e.source_id = d.source_id
"""


def vector_literal(values) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


def choose_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def input_text(subject, department, section, category) -> str | None:
    subject = (subject or "").translate({ord(c): None for c in JOINERS}).strip()
    if not subject:
        return None
    context = " · ".join(part.strip() for part in (department, section, category) if part and part.strip())
    return f"{subject}\n{context}" if context else subject


def main() -> None:
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL is not set.")

    with psycopg.connect(DATABASE_URL) as conn:
        pending = []
        without_subject = 0
        for source_id, subject, department, section, category, old_sha, old_model in conn.execute(SUBJECT_INPUT_SQL):
            text = input_text(subject, department, section, category)
            if text is None:
                without_subject += 1
                continue
            sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if sha != old_sha or old_model != MODEL_ID:
                pending.append((source_id, text, sha))

        print(f"Orders without a subject (skipped): {without_subject}")
        if not pending:
            print("All order subjects are already embedded and current.")
            return

        device = choose_device()
        print(f"Subjects to embed: {len(pending)} with {MODEL_ID} on {device}")
        model = SentenceTransformer(MODEL_ID, device=device)
        embeddings = model.encode(
            [text for _, text, _ in pending],
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            show_progress_bar=True,
            convert_to_numpy=True,
        )
        if embeddings.ndim != 2 or embeddings.shape[1] != DIMENSIONS:
            raise RuntimeError(f"Unexpected embedding shape {embeddings.shape}; expected (*, {DIMENSIONS}).")

        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO document_subject_embeddings (source_id, input_sha256, embedding, embedding_model, embedded_at)
                VALUES (%s, %s, %s::vector(1024), %s, NOW())
                ON CONFLICT (source_id) DO UPDATE
                SET input_sha256 = EXCLUDED.input_sha256,
                    embedding = EXCLUDED.embedding,
                    embedding_model = EXCLUDED.embedding_model,
                    embedded_at = NOW()
                """,
                [
                    (source_id, sha, vector_literal(np.asarray(embedding)), MODEL_ID)
                    for (source_id, _text, sha), embedding in zip(pending, embeddings, strict=True)
                ],
            )
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM document_subject_embeddings").fetchone()[0]
        print(f"Order subjects embedded: {total}")


if __name__ == "__main__":
    main()
