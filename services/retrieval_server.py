from __future__ import annotations

import os
from collections import defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import psycopg
import torch
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from psycopg.rows import dict_row
from sentence_transformers import CrossEncoder, SentenceTransformer

DATABASE_URL = os.environ.get("DATABASE_URL")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
RERANKER_MODEL = os.getenv("RERANKER_MODEL", "Qwen/Qwen3-Reranker-0.6B")

QUERY_PROMPT = (
    "Instruct: Given a Hindi or English question about Uttar Pradesh government "
    "orders, retrieve relevant government-order passages that answer the question.\n"
    "Query:"
)

RERANK_INSTRUCTION = (
    "Given a Hindi or English question about Uttar Pradesh government orders, "
    "rank passages by how directly they help answer the question. Prefer the "
    "specific governing provision, rule, eligibility condition, procedure, "
    "date-sensitive instruction, or administrative requirement over merely "
    "topically related text."
)

RRF_K = 60
VECTOR_WEIGHT = 1.0
LEXICAL_WEIGHT = 1.2


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=5, ge=1, le=12)
    candidate_count: int = Field(default=50, ge=10, le=200)
    rerank_count: int = Field(default=24, ge=5, le=100)


class Evidence(BaseModel):
    label: str
    source_id: str
    page_number: int
    department: str | None
    go_number: str | None
    go_date: str | None
    source_url: str
    page_url: str
    selected_variant: str
    selected_canonical: bool
    numeric_conflict: bool
    rerank_score_raw: float
    fused_score: float
    matched_chunk_text: str
    selected_page_text: str
    canonical_page_text: str


class SearchResponse(BaseModel):
    query: str
    embedding_model: str
    reranker_model: str
    scores_are_raw_logits: bool
    evidence: list[Evidence]


@dataclass
class Hit:
    chunk_id: str
    variant_id: str
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
    lexical_score: float | None = None
    fused_score: float = 0.0
    rerank_score: float = 0.0


def choose_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def vector_literal(values: Any) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set.")

    device = choose_device()
    print(f"[retrieval] loading embedder: {EMBEDDING_MODEL} on {device}")
    app.state.embedder = SentenceTransformer(EMBEDDING_MODEL, device=device)

    print(f"[retrieval] loading reranker: {RERANKER_MODEL} on {device}")
    app.state.reranker = CrossEncoder(
        RERANKER_MODEL,
        device=device,
        prompts={"query": RERANK_INSTRUCTION},
        default_prompt_name="query",
    )
    app.state.device = device
    print("[retrieval] models ready")
    yield


app = FastAPI(title="Shasanadesh Retrieval Service", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health(request: Request):
    return {
        "ok": True,
        "embeddingModel": EMBEDDING_MODEL,
        "rerankerModel": RERANKER_MODEL,
        "device": request.app.state.device,
    }


def make_hit(row: dict[str, Any], lexical: bool = False) -> Hit:
    hit = Hit(
        chunk_id=row["variant_chunk_id"],
        variant_id=row["variant_id"],
        logical_page_id=row["logical_page_id"],
        source_id=row["source_id"],
        page_number=row["page_number"],
        variant_type=row["variant_type"],
        canonical=row["canonical"],
        text=row["text_content"],
        numeric_conflict=row["numeric_conflict"],
        department=row["department"],
        go_number=row["go_number"],
        go_date=str(row["go_date"]) if row["go_date"] is not None else None,
        source_url=row["source_url"],
    )
    if lexical:
        hit.lexical_score = float(row["score"])
    return hit


def retrieve_hybrid(query: str, query_vector: str, candidate_count: int) -> list[Hit]:
    assert DATABASE_URL is not None
    base_select = """
      SELECT c.variant_chunk_id, c.variant_id, c.logical_page_id, c.source_id,
             c.page_number, c.variant_type, c.canonical, c.text_content,
             p.numeric_conflict, d.department, d.go_number, d.go_date, d.source_url,
    """

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        vector_rows = conn.execute(
            base_select + """
              1 - (c.embedding <=> %s::vector(1024)) AS score
            FROM chunks c
            JOIN pages p ON p.source_id=c.source_id AND p.page_number=c.page_number
            JOIN documents d ON d.source_id=c.source_id
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> %s::vector(1024)
            LIMIT %s
            """,
            (query_vector, query_vector, candidate_count),
        ).fetchall()

        lexical_rows = conn.execute(
            base_select + """
              (CASE WHEN to_tsvector('simple', c.text_content)
                         @@ plainto_tsquery('simple', %s)
                THEN ts_rank_cd(to_tsvector('simple', c.text_content),
                                plainto_tsquery('simple', %s))
                ELSE 0 END
               + similarity(c.text_content, %s) * 0.25) AS score
            FROM chunks c
            JOIN pages p ON p.source_id=c.source_id AND p.page_number=c.page_number
            JOIN documents d ON d.source_id=c.source_id
            WHERE to_tsvector('simple', c.text_content) @@ plainto_tsquery('simple', %s)
               OR similarity(c.text_content, %s) > 0.01
            ORDER BY score DESC
            LIMIT %s
            """,
            (query, query, query, query, query, candidate_count),
        ).fetchall()

    vector_hits = [make_hit(row) for row in vector_rows]
    lexical_hits = [make_hit(row, lexical=True) for row in lexical_rows]

    fused: dict[str, float] = defaultdict(float)
    hits: dict[str, Hit] = {}

    for rank, hit in enumerate(vector_hits, start=1):
        fused[hit.chunk_id] += VECTOR_WEIGHT / (RRF_K + rank)
        hits[hit.chunk_id] = hit

    for rank, hit in enumerate(lexical_hits, start=1):
        fused[hit.chunk_id] += LEXICAL_WEIGHT / (RRF_K + rank)
        if hit.chunk_id in hits:
            hits[hit.chunk_id].lexical_score = hit.lexical_score
        else:
            hits[hit.chunk_id] = hit

    result: list[Hit] = []
    for chunk_id in sorted(fused, key=fused.get, reverse=True):
        hit = hits[chunk_id]
        hit.fused_score = fused[chunk_id]
        result.append(hit)
    return result


def hydrate(hit: Hit, label: str) -> Evidence:
    assert DATABASE_URL is not None
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        selected = conn.execute(
            "SELECT text_content FROM page_variants WHERE variant_id=%s",
            (hit.variant_id,),
        ).fetchone()
        canonical = conn.execute(
            """
            SELECT text_content FROM page_variants
            WHERE source_id=%s AND page_number=%s AND canonical=TRUE
            ORDER BY variant_id LIMIT 1
            """,
            (hit.source_id, hit.page_number),
        ).fetchone()

    selected_text = selected["text_content"] if selected else hit.text
    canonical_text = canonical["text_content"] if canonical else selected_text

    return Evidence(
        label=label,
        source_id=hit.source_id,
        page_number=hit.page_number,
        department=hit.department,
        go_number=hit.go_number,
        go_date=hit.go_date,
        source_url=hit.source_url,
        page_url=f"{hit.source_url}#page={hit.page_number}",
        selected_variant=hit.variant_type,
        selected_canonical=hit.canonical,
        numeric_conflict=hit.numeric_conflict,
        rerank_score_raw=hit.rerank_score,
        fused_score=hit.fused_score,
        matched_chunk_text=hit.text,
        selected_page_text=selected_text,
        canonical_page_text=canonical_text,
    )


@app.post("/search", response_model=SearchResponse)
def search(body: SearchRequest, request: Request):
    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is empty")

    embedder: SentenceTransformer = request.app.state.embedder
    reranker: CrossEncoder = request.app.state.reranker

    query_embedding = embedder.encode(
        [query],
        prompt=QUERY_PROMPT,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )[0]

    fused_hits = retrieve_hybrid(query, vector_literal(query_embedding), body.candidate_count)
    pool = fused_hits[: body.rerank_count]

    if not pool:
        return SearchResponse(
            query=query,
            embedding_model=EMBEDDING_MODEL,
            reranker_model=RERANKER_MODEL,
            scores_are_raw_logits=True,
            evidence=[],
        )

    scores = reranker.predict(
        [(query, hit.text) for hit in pool],
        batch_size=4,
        show_progress_bar=False,
        prompt_name="query",
    )

    for hit, score in zip(pool, scores, strict=True):
        hit.rerank_score = float(score)

    pool.sort(key=lambda hit: hit.rerank_score, reverse=True)

    selected: list[Hit] = []
    seen_pages: set[str] = set()
    for hit in pool:
        if hit.logical_page_id in seen_pages:
            continue
        seen_pages.add(hit.logical_page_id)
        selected.append(hit)
        if len(selected) >= body.top_k:
            break

    return SearchResponse(
        query=query,
        embedding_model=EMBEDDING_MODEL,
        reranker_model=RERANKER_MODEL,
        scores_are_raw_logits=True,
        evidence=[hydrate(hit, f"S{i}") for i, hit in enumerate(selected, start=1)],
    )
