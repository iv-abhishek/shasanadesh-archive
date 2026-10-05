from __future__ import annotations

import os
import threading
import time
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
from services.authority import authority_score, scores_are_probabilities
from services.lexical import or_tsquery_sql, search_terms
from services.neighbor_expansion import plan_neighbor_pages

DATABASE_URL = os.environ.get("DATABASE_URL")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
RERANKER_MODEL = os.getenv("RERANKER_MODEL", "Qwen/Qwen3-Reranker-0.6B")

# One model call at a time. FastAPI runs these endpoints in a thread pool, and
# two requests running the models together on Apple's GPU (MPS) crash Python
# ("Python quit unexpectedly", 5 Oct 2026, training-data search with 2 workers).
MODEL_LOCK = threading.Lock()


def locked_predict(model, pairs, **kwargs):
    with MODEL_LOCK:
        return model.predict(pairs, **kwargs)


def locked_encode(model, texts, **kwargs):
    with MODEL_LOCK:
        return model.encode(texts, **kwargs)

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
# Cross-encoder batch size. A trial at 12 was not faster than 4 on Apple
# Silicon (padding to the longest passage offsets the batching gain), so the
# measured default stays at 4; tune per machine.
RERANK_BATCH_SIZE = int(os.getenv("RERANK_BATCH_SIZE", "4"))
# Extra rerank passages allowed for a page's other text variant (native vs
# OCR), so a garbled native layer cannot hide a readable OCR alternate.
ALTERNATE_VARIANT_BUDGET = int(os.getenv("RAG_ALTERNATE_VARIANT_BUDGET", "8"))
# pgvector's HNSW scan returns at most hnsw.ef_search rows (default 40), and
# metadata filters are applied after the scan, so a filtered search could
# return far fewer than candidate_count rows. Widen the scan per query.
HNSW_EF_SEARCH_MIN = 100
HNSW_EF_SEARCH_MAX = 1000
VECTOR_WEIGHT = 1.0
LEXICAL_WEIGHT = 1.2
PAGES_PER_SOURCE = int(os.getenv("RAG_PAGES_PER_SOURCE", "2"))
# Keyword search gives up after this long; the vector half still answers (ADR-092).
LEXICAL_TIMEOUT_MS = int(os.getenv("RAG_LEXICAL_TIMEOUT_MS", "4000"))



class SearchFilters(BaseModel):
    department: str | None = Field(default=None, max_length=200)
    departments: list[str] | None = None
    # Shasanadesh department IDs (the registry resolves "basic education" to 50001);
    # independent of how a capture spelled the department name.
    department_ids: list[int] | None = Field(default=None, max_length=12)
    # ADR-064: "IN" (Government of India), "UP", … and topic codes (migration 011).
    jurisdiction_codes: list[str] | None = Field(default=None, max_length=10)
    topics: list[str] | None = Field(default=None, max_length=10)
    go_number: str | None = Field(default=None, max_length=200)
    source_id: str | None = Field(default=None, max_length=200)
    # Several orders (a suggested follow-up is answered from the orders the
    # previous answer cited, and only from them).
    source_ids: list[str] | None = Field(default=None, max_length=16)
    # Source collections (documents.provider), e.g. ["shasanadesh-up", "upgov"].
    providers: list[str] | None = None
    # Collections left out (crawled district sites for a headquarters question, ADR-103).
    exclude_providers: list[str] | None = Field(default=None, max_length=60)
    date_from: str | None = Field(default=None, max_length=10)
    date_to: str | None = Field(default=None, max_length=10)
    verification_status: str | None = Field(default=None, max_length=40)
    # Tier C ("routine or individual" orders: sanctions, releases, one person or
    # place) is left out of chat by default when the classifier is confident.
    # The internal Search console and explicit source-ID lookups include it.
    include_routine: bool = False


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    # Chat uses a handful of pages; the Search page asks for up to 24 so it can
    # group results by department. Pages come from the same reranked pool.
    top_k: int = Field(default=5, ge=1, le=24)
    candidate_count: int = Field(default=50, ge=10, le=200)
    rerank_count: int = Field(default=24, ge=5, le=100)
    filters: SearchFilters = Field(default_factory=SearchFilters)
    expand_neighbors: bool = False
    neighbor_radius: int = Field(default=1, ge=0, le=2)
    max_evidence_pages: int = Field(default=7, ge=1, le=16)
    # Chat sets this: rank rules and general orders above specific ones.
    prefer_authority: bool = False
    # The question in official wording (ADR-082): extra candidate searches.
    # Pages are still reranked against the question itself.
    expansions: list[str] = Field(default_factory=list, max_length=4)


class Evidence(BaseModel):
    label: str
    source_id: str
    document_title: str | None = None
    page_number: int
    department: str | None
    go_number: str | None
    go_date: str | None
    source_url: str
    page_url: str
    # The official page/PDF sets this text in a Kruti Dev font (converted here, ADR-070).
    legacy_font: bool = False
    # ADR-064: IN (Government of India) / UP / later other states; current / superseded / draft.
    jurisdiction_code: str | None = None
    status: str | None = None
    # ADR-046 tier (A general, B in context, C routine), the classifier's
    # document type, and the source collection (core-rules / up-fhb = rulebook).
    tier: str | None = None
    doc_type: str | None = None
    provider: str | None = None
    retrieval_role: str
    anchor_page_number: int | None
    selected_variant: str
    selected_canonical: bool
    numeric_conflict: bool
    rerank_score_raw: float
    fused_score: float
    matched_chunk_text: str
    selected_page_text: str
    canonical_page_text: str
    # Other extractions of the page (native/OCR) when its numbers conflict, so
    # the API can accept a figure that every extraction prints the same way.
    other_variant_texts: list[str] = []


class SearchResponse(BaseModel):
    query: str
    embedding_model: str
    reranker_model: str
    scores_are_raw_logits: bool
    evidence: list[Evidence]
    timings: dict[str, float] = Field(default_factory=dict)


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
    document_title: str | None = None
    jurisdiction_code: str | None = None
    status: str | None = None
    tier: str | None = None
    tier_confidence: str | None = None
    doc_type: str | None = None
    provider: str | None = None
    lexical_score: float | None = None
    fused_score: float = 0.0
    rerank_score: float = 0.0
    retrieval_role: str = "direct"
    anchor_page_number: int | None = None


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
        document_title=row.get("document_title"),
        jurisdiction_code=row.get("jurisdiction_code"),
        status=row.get("status"),
        tier=row.get("tier"),
        tier_confidence=row.get("tier_confidence"),
        doc_type=row.get("doc_type"),
        provider=row.get("provider"),
    )
    if lexical:
        hit.lexical_score = float(row["score"])
    return hit


# Zero-width non-joiner and joiner; stripped before comparing department names.
INVISIBLE_JOINERS = "\u200c\u200d"

# Curated core rules (GFR, procurement manuals, GeM terms, UP Budget Manual …,
# ADR-062) apply to every department, so department filters never hide them.
# Rulebooks apply to every department: the curated core rules and the UP
# Financial Handbook (ADR-069). A department scope always includes them.
CORE_RULES_SQL = "d.provider IN ('core-rules', 'up-fhb')"


def build_filter_clause(filters: SearchFilters) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    # Department names are not unique across languages: older captures say
    # "Agriculture", portal captures say "कृषि विभाग" (sometimes with zero-width
    # joiners). Shasanadesh IDs carry a numeric department ID that is the same
    # for both, so a name match is widened to every document sharing that ID.
    if filters.department:
        name = filters.department.strip().replace("\u200c", "").replace("\u200d", "")
        pattern = f"%{name}%"
        clauses.append(
            "(translate(d.department, %s, '') ILIKE %s "
            "OR d.department_id IN ("
            "SELECT DISTINCT dd.department_id FROM documents dd "
            "WHERE dd.department_id IS NOT NULL "
            "AND translate(dd.department, %s, '') ILIKE %s) "
            f"OR {CORE_RULES_SQL})"
        )
        params.extend([INVISIBLE_JOINERS, pattern, INVISIBLE_JOINERS, pattern])

    if filters.departments:
        departments = [
            item.strip().replace("\u200c", "").replace("\u200d", "")
            for item in filters.departments
            if item.strip()
        ]

        if departments:
            clauses.append(
                "(translate(d.department, %s, '') = ANY(%s) "
                "OR d.department_id IN ("
                "SELECT DISTINCT dd.department_id FROM documents dd "
                "WHERE dd.department_id IS NOT NULL "
                "AND translate(dd.department, %s, '') = ANY(%s)) "
                "OR d.jurisdiction_code = 'IN' OR d.metadata->>'jurisdiction' = 'central' "
                f"OR {CORE_RULES_SQL})"
            )
            params.extend([INVISIBLE_JOINERS, departments, INVISIBLE_JOINERS, departments])

    if filters.department_ids:
        clauses.append(f"(d.department_id = ANY(%s) OR {CORE_RULES_SQL})")
        params.append([int(value) for value in filters.department_ids])

    if filters.jurisdiction_codes:
        clauses.append("d.jurisdiction_code = ANY(%s)")
        params.append([code.upper() for code in filters.jurisdiction_codes])

    if filters.topics:
        clauses.append("d.topics && %s::text[]")
        params.append(list(filters.topics))

    # Rulebook §2: documents from non-government sources are flagged and never used.
    clauses.append("d.provenance_ok")

    if not filters.include_routine and not filters.source_id and not filters.source_ids:
        clauses.append(
            "(d.tier IS DISTINCT FROM 'C' "
            "OR COALESCE(d.classification->>'confidence', 'low') <> 'high')"
        )

    if filters.go_number:
        clauses.append("d.go_number ILIKE %s")
        params.append(f"%{filters.go_number.strip()}%")

    if filters.source_id:
        clauses.append("d.source_id = %s")
        params.append(filters.source_id.strip())

    if filters.source_ids:
        ids = [item.strip() for item in filters.source_ids if item.strip()]
        if ids:
            clauses.append("d.source_id = ANY(%s)")
            params.append(ids)

    if filters.providers:
        providers = [item.strip() for item in filters.providers if item.strip()]
        if providers:
            clauses.append("d.provider = ANY(%s)")
            params.append(providers)

    if filters.exclude_providers:
        excluded = [item.strip() for item in filters.exclude_providers if item.strip()]
        if excluded:
            clauses.append("NOT (d.provider = ANY(%s))")
            params.append(excluded)

    if filters.date_from:
        clauses.append("d.go_date >= %s::date")
        params.append(filters.date_from)

    if filters.date_to:
        clauses.append("d.go_date <= %s::date")
        params.append(filters.date_to)

    status = filters.verification_status

    if status == "conflict":
        clauses.append("p.numeric_conflict = TRUE")
    elif status == "ocr_only_unverified":
        clauses.append(
            "("
            "p.numeric_conflict = FALSE "
            "AND NOT EXISTS ("
            "SELECT 1 FROM page_variants pv_native "
            "WHERE pv_native.source_id = c.source_id "
            "AND pv_native.page_number = c.page_number "
            "AND pv_native.variant_type = 'native'"
            ") "
            "AND EXISTS ("
            "SELECT 1 FROM page_variants pv_ocr "
            "WHERE pv_ocr.source_id = c.source_id "
            "AND pv_ocr.page_number = c.page_number "
            "AND pv_ocr.variant_type = 'ocr'"
            ")"
            ")"
        )
    elif status == "variants_agree":
        clauses.append(
            "("
            "p.numeric_conflict = FALSE "
            "AND EXISTS ("
            "SELECT 1 FROM page_variants pv_native "
            "WHERE pv_native.source_id = c.source_id "
            "AND pv_native.page_number = c.page_number "
            "AND pv_native.variant_type = 'native'"
            ") "
            "AND EXISTS ("
            "SELECT 1 FROM page_variants pv_ocr "
            "WHERE pv_ocr.source_id = c.source_id "
            "AND pv_ocr.page_number = c.page_number "
            "AND pv_ocr.variant_type = 'ocr'"
            ")"
            ")"
        )
    elif status == "native_primary":
        clauses.append(
            "("
            "p.numeric_conflict = FALSE "
            "AND EXISTS ("
            "SELECT 1 FROM page_variants pv_native "
            "WHERE pv_native.source_id = c.source_id "
            "AND pv_native.page_number = c.page_number "
            "AND pv_native.variant_type = 'native'"
            ") "
            "AND NOT EXISTS ("
            "SELECT 1 FROM page_variants pv_ocr "
            "WHERE pv_ocr.source_id = c.source_id "
            "AND pv_ocr.page_number = c.page_number "
            "AND pv_ocr.variant_type = 'ocr'"
            ")"
            ")"
        )
    elif status == "unverified":
        clauses.append(
            "("
            "p.numeric_conflict = FALSE "
            "AND NOT EXISTS ("
            "SELECT 1 FROM page_variants pv_any "
            "WHERE pv_any.source_id = c.source_id "
            "AND pv_any.page_number = c.page_number "
            "AND pv_any.variant_type IN ('native', 'ocr')"
            ")"
            ")"
        )
    elif status:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported verification_status: {status}",
        )

    if not clauses:
        return "", []

    return " AND " + " AND ".join(clauses), params


_ITERATIVE_SCAN: bool | None = None


def pgvector_supports_iterative_scan(conn: psycopg.Connection) -> bool:
    """True when the installed pgvector (>= 0.8.0) has hnsw.iterative_scan."""
    global _ITERATIVE_SCAN
    if _ITERATIVE_SCAN is None:
        row = conn.execute(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
        ).fetchone()
        version = str((row or {}).get("extversion") or "0")
        parts = [int(part) for part in version.split(".")[:2] if part.isdigit()]
        _ITERATIVE_SCAN = tuple(parts + [0, 0])[:2] >= (0, 8)
    return _ITERATIVE_SCAN


_chunk_terms_ready = False


def has_chunk_terms(conn: psycopg.Connection[Any]) -> bool:
    """Whether migration 015 (stored chunk words) has run; checked until it has."""
    global _chunk_terms_ready
    if not _chunk_terms_ready:
        row = conn.execute("SELECT to_regclass('public.chunk_terms') IS NOT NULL AS ready").fetchone()
        _chunk_terms_ready = bool(row and row["ready"])
    return _chunk_terms_ready


def retrieve_hybrid(
    query: str,
    query_vector: str,
    candidate_count: int,
    filters: SearchFilters,
    lexical: bool = True,
) -> list[Hit]:
    assert DATABASE_URL is not None

    base_select = (
        "SELECT c.variant_chunk_id, c.variant_id, c.logical_page_id, c.source_id, "
        "c.page_number, c.variant_type, c.canonical, c.text_content, "
        "p.numeric_conflict, d.department, d.go_number, d.go_date, d.source_url, "
        "d.jurisdiction_code, d.status, d.tier, d.doc_type, d.provider, "
        "d.classification->>'confidence' AS tier_confidence, "
        "COALESCE(NULLIF(d.metadata->>'title', ''), NULLIF(d.metadata->'portal'->>'subject', '')) AS document_title, "
    )

    filter_sql, filter_params = build_filter_clause(filters)

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        ef_search = candidate_count * (4 if filter_sql else 2)
        ef_search = max(HNSW_EF_SEARCH_MIN, min(HNSW_EF_SEARCH_MAX, ef_search))
        # is_local=true scopes the setting to this transaction only.
        conn.execute(
            "SELECT set_config('hnsw.ef_search', %s, true)",
            (str(ef_search),),
        )
        # Filters (e.g. leaving out routine orders) are applied after the HNSW
        # scan; with most rows filtered out, a single scan can return too few.
        # pgvector >= 0.8 can keep scanning until LIMIT rows pass the filter.
        if filter_sql and pgvector_supports_iterative_scan(conn):
            conn.execute(
                "SELECT set_config('hnsw.iterative_scan', 'strict_order', true)"
            )

        vector_sql = (
            base_select
            + "1 - (c.embedding <=> %s::vector(1024)) AS score "
            + "FROM chunks c "
            + "JOIN pages p ON p.source_id = c.source_id "
            + "AND p.page_number = c.page_number "
            + "JOIN documents d ON d.source_id = c.source_id "
            + "WHERE c.embedding IS NOT NULL "
            + filter_sql
            + " ORDER BY c.embedding <=> %s::vector(1024) "
            + "LIMIT %s"
        )

        vector_params: list[Any] = [
            query_vector,
            *filter_params,
            query_vector,
            candidate_count,
        ]

        vector_rows = conn.execute(
            vector_sql,
            vector_params,
        ).fetchall()

        # Keyword half (ADR-092): chunks containing ANY meaningful word of the
        # question, found through a GIN full-text index (chunk_terms_idx, or chunks_fts_idx
        # before migration 015) and
        # ranked by how many of the words they hold, how close together.
        terms = search_terms(query) if lexical else []
        lexical_rows: list[dict[str, Any]] = []
        if terms:
            tsquery = or_tsquery_sql(len(terms))
            # Stored words (migration 015) when present; otherwise parse each
            # matching chunk again (same index for finding, slower ranking).
            if has_chunk_terms(conn):
                words_sql = "t.terms"
                from_sql = "FROM chunk_terms t JOIN chunks c ON c.variant_chunk_id = t.variant_chunk_id "
            else:
                words_sql = "to_tsvector('simple', c.text_content)"
                from_sql = "FROM chunks c "
            lexical_sql = (
                base_select
                + "ts_rank_cd(" + words_sql + ", " + tsquery + ", 1) AS score "
                + from_sql
                + "JOIN pages p ON p.source_id = c.source_id "
                + "AND p.page_number = c.page_number "
                + "JOIN documents d ON d.source_id = c.source_id "
                + "WHERE " + words_sql + " @@ " + tsquery + " "
                + filter_sql
                + " ORDER BY score DESC "
                + "LIMIT %s"
            )
            lexical_params: list[Any] = [*terms, *terms, *filter_params, candidate_count]
            try:
                conn.execute(
                    "SELECT set_config('statement_timeout', %s, true)",
                    (str(LEXICAL_TIMEOUT_MS),),
                )
                lexical_rows = conn.execute(lexical_sql, lexical_params).fetchall()
            except psycopg.errors.QueryCanceled:
                # Too slow (very common words): answer from the vector half.
                conn.rollback()
                print(f"[retrieval] keyword search over {LEXICAL_TIMEOUT_MS} ms skipped: {terms}", flush=True)
                lexical_rows = []

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


def load_neighbor_hits(
    selected: list[Hit],
    *,
    radius: int,
    max_total_pages: int,
) -> list[Hit]:
    assert DATABASE_URL is not None

    plan = plan_neighbor_pages(
        [(hit.source_id, hit.page_number) for hit in selected],
        radius=radius,
        max_total_pages=max_total_pages,
    )

    if not plan:
        return []

    hits: list[Hit] = []

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        for neighbor in plan:
            row = conn.execute(
                """
                SELECT
                  pv.variant_id,
                  p.source_id,
                  p.page_number,
                  pv.variant_type,
                  pv.canonical,
                  pv.text_content,
                  p.numeric_conflict,
                  d.department,
                  d.go_number,
                  d.go_date,
                  d.source_url,
                  d.jurisdiction_code,
                  d.status,
                  d.tier,
                  d.doc_type,
                  d.provider,
                  -- Portal captures carry the order's subject instead of a title.
                  COALESCE(
                    NULLIF(d.metadata->>'title', ''),
                    NULLIF(d.metadata->'portal'->>'subject', '')
                  ) AS document_title
                FROM pages p
                JOIN documents d
                  ON d.source_id = p.source_id
                JOIN LATERAL (
                  SELECT
                    variant_id,
                    variant_type,
                    canonical,
                    text_content
                  FROM page_variants
                  WHERE
                    source_id = p.source_id
                    AND page_number = p.page_number
                  ORDER BY
                    canonical DESC,
                    CASE
                      WHEN variant_type = 'native' THEN 0
                      ELSE 1
                    END,
                    variant_id
                  LIMIT 1
                ) pv ON TRUE
                WHERE
                  p.source_id = %s
                  AND p.page_number = %s
                LIMIT 1
                """,
                (neighbor.source_id, neighbor.page_number),
            ).fetchone()

            if row is None:
                continue

            hits.append(
                Hit(
                    chunk_id=(
                        "neighbor::"
                        f"{row['source_id']}::"
                        f"{row['page_number']}"
                    ),
                    variant_id=row["variant_id"],
                    logical_page_id=(
                        f"{row['source_id']}#"
                        f"{row['page_number']}"
                    ),
                    source_id=row["source_id"],
                    page_number=row["page_number"],
                    variant_type=row["variant_type"],
                    canonical=bool(row["canonical"]),
                    text=row["text_content"],
                    numeric_conflict=bool(row["numeric_conflict"]),
                    jurisdiction_code=row.get("jurisdiction_code"),
                    status=row.get("status"),
                    tier=row.get("tier"),
                    doc_type=row.get("doc_type"),
                    provider=row.get("provider"),
                    department=row["department"],
                    go_number=row["go_number"],
                    go_date=(
                        str(row["go_date"])
                        if row["go_date"] is not None
                        else None
                    ),
                    source_url=row["source_url"],
                    document_title=row["document_title"],
                    fused_score=0.0,
                    rerank_score=0.0,
                    retrieval_role="neighbor",
                    anchor_page_number=neighbor.anchor_page_number,
                )
            )

    return hits


def hydrate(conn: psycopg.Connection, hit: Hit, label: str) -> Evidence:
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
    other_texts: list[str] = []
    if hit.numeric_conflict:
        other_texts = [
            row["text_content"]
            for row in conn.execute(
                "SELECT text_content FROM page_variants "
                "WHERE source_id=%s AND page_number=%s AND variant_id<>%s",
                (hit.source_id, hit.page_number, hit.variant_id),
            ).fetchall()
            if row["text_content"] and row["text_content"] not in (selected_text, canonical_text)
        ]

    # HTML sources (UP Financial Handbook) keep one official URL per page in
    # documents.metadata.pageUrls; PDFs link to the page with #page=N.
    page_link = conn.execute(
        "SELECT metadata->'pageUrls'->>%s AS url, "
        "COALESCE(metadata->'html'->'legacyFontPages', '[]'::jsonb) @> to_jsonb(%s::int) "
        "OR COALESCE((metadata->'pageCorpus'->>'krutiDevPages')::int, 0) > 0 AS legacy_font "
        "FROM documents WHERE source_id=%s",
        (hit.page_number - 1, hit.page_number, hit.source_id),
    ).fetchone()
    page_url = (
        page_link["url"]
        if page_link and page_link["url"]
        else f"{hit.source_url}#page={hit.page_number}"
    )

    return Evidence(
        label=label,
        source_id=hit.source_id,
        document_title=hit.document_title,
        page_number=hit.page_number,
        department=hit.department,
        go_number=hit.go_number,
        go_date=hit.go_date,
        source_url=hit.source_url,
        page_url=page_url,
        legacy_font=bool(page_link and page_link["legacy_font"]),
        jurisdiction_code=hit.jurisdiction_code,
        status=hit.status,
        tier=hit.tier,
        doc_type=hit.doc_type,
        provider=hit.provider,
        retrieval_role=hit.retrieval_role,
        anchor_page_number=hit.anchor_page_number,
        selected_variant=hit.variant_type,
        selected_canonical=hit.canonical,
        numeric_conflict=hit.numeric_conflict,
        rerank_score_raw=hit.rerank_score,
        fused_score=hit.fused_score,
        matched_chunk_text=hit.text,
        selected_page_text=selected_text,
        canonical_page_text=canonical_text,
        other_variant_texts=other_texts,
    )


class PageRef(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, le=10000)


class PagesRequest(BaseModel):
    # The question, to score each page (shown as "Best match"; never filters).
    query: str = Field(min_length=1, max_length=4000)
    pages: list[PageRef] = Field(min_length=1, max_length=12)


@app.post("/pages", response_model=SearchResponse)
def pages(body: PagesRequest, request: Request):
    """
    Exact pages named by a playbook (ADR-091), in the playbook's order, as
    evidence S1..Sn. No search: the pages were chosen and checked by a person.
    Pages that do not exist (renumbered, not loaded yet) are skipped.
    """
    started_at = time.perf_counter()
    assert DATABASE_URL is not None
    hits: list[Hit] = []
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        for ref in body.pages:
            row = conn.execute(
                """
                SELECT pv.variant_id, p.source_id, p.page_number, pv.variant_type, pv.canonical,
                       pv.text_content, p.numeric_conflict, d.department, d.go_number, d.go_date,
                       d.source_url, d.jurisdiction_code, d.status, d.tier, d.doc_type, d.provider,
                       COALESCE(NULLIF(d.metadata->>'title', ''), NULLIF(d.metadata->'portal'->>'subject', '')) AS document_title
                FROM pages p
                JOIN documents d ON d.source_id = p.source_id
                JOIN LATERAL (
                  SELECT variant_id, variant_type, canonical, text_content
                  FROM page_variants
                  WHERE source_id = p.source_id AND page_number = p.page_number
                  -- The longest readable text: a blank native page loses to its OCR.
                  ORDER BY length(text_content) DESC, canonical DESC, variant_id
                  LIMIT 1
                ) pv ON TRUE
                WHERE p.source_id = %s AND p.page_number = %s
                """,
                (ref.source_id, ref.page_number),
            ).fetchone()
            if row is None:
                continue
            hits.append(
                Hit(
                    chunk_id=f"playbook::{row['source_id']}::{row['page_number']}",
                    variant_id=row["variant_id"],
                    logical_page_id=f"{row['source_id']}#{row['page_number']}",
                    source_id=row["source_id"],
                    page_number=row["page_number"],
                    variant_type=row["variant_type"],
                    canonical=bool(row["canonical"]),
                    text=row["text_content"],
                    numeric_conflict=bool(row["numeric_conflict"]),
                    department=row["department"],
                    go_number=row["go_number"],
                    go_date=str(row["go_date"]) if row["go_date"] is not None else None,
                    source_url=row["source_url"],
                    document_title=row["document_title"],
                    jurisdiction_code=row.get("jurisdiction_code"),
                    status=row.get("status"),
                    tier=row.get("tier"),
                    doc_type=row.get("doc_type"),
                    provider=row.get("provider"),
                )
            )
        rerank_started_at = time.perf_counter()
        if hits:
            reranker: CrossEncoder = request.app.state.reranker
            scores = locked_predict(reranker,
                [(body.query, hit.text[:4000]) for hit in hits],
                batch_size=RERANK_BATCH_SIZE,
                show_progress_bar=False,
                prompt_name="query",
            )
            for hit, score in zip(hits, scores, strict=True):
                hit.rerank_score = float(score)
        rerank_ms = (time.perf_counter() - rerank_started_at) * 1000.0
        evidence = [hydrate(conn, hit, f"S{index}") for index, hit in enumerate(hits, start=1)]
    return SearchResponse(
        query=body.query,
        embedding_model=EMBEDDING_MODEL,
        reranker_model=RERANKER_MODEL,
        scores_are_raw_logits=True,
        evidence=evidence,
        timings={"rerank_ms": rerank_ms, "total_ms": (time.perf_counter() - started_at) * 1000.0},
    )


@app.post("/search", response_model=SearchResponse)
def search(body: SearchRequest, request: Request):
    query = body.query.strip()
    search_started_at = time.perf_counter()
    if not query:
        raise HTTPException(status_code=400, detail="query is empty")

    embedder: SentenceTransformer = request.app.state.embedder
    reranker: CrossEncoder = request.app.state.reranker

    embedding_started_at = time.perf_counter()
    expansions = [text.strip()[:700] for text in body.expansions if text and text.strip()][:4]
    query_embeddings = locked_encode(embedder,
        [query, *expansions],
        prompt=QUERY_PROMPT,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    query_embedding = query_embeddings[0]

    embedding_ms = (
        time.perf_counter()
        - embedding_started_at
    ) * 1000.0

    hybrid_started_at = time.perf_counter()
    fused_hits = retrieve_hybrid(
        query,
        vector_literal(query_embedding),
        body.candidate_count,
        body.filters,
    )
    if expansions:
        # Merge the candidate lists: a page found by several wordings rises.
        merged: dict[str, Hit] = {hit.chunk_id: hit for hit in fused_hits}
        for text, vector in zip(expansions, query_embeddings[1:]):
            for hit in retrieve_hybrid(text, vector_literal(vector), body.candidate_count, body.filters, lexical=False):
                if hit.chunk_id in merged:
                    merged[hit.chunk_id].fused_score += hit.fused_score
                else:
                    merged[hit.chunk_id] = hit
        fused_hits = sorted(merged.values(), key=lambda hit: hit.fused_score, reverse=True)
    hybrid_search_ms = (
        time.perf_counter()
        - hybrid_started_at
    ) * 1000.0

    raw_pool = fused_hits[: body.rerank_count]

    # Avoid reranking duplicate chunks/variants from the same logical page.
    # If deduplication leaves fewer candidates than requested results, scan
    # lower-ranked fused hits until top_k unique pages are available or the
    # configured rerank budget is exhausted.
    pool: list[Hit] = []
    seen_pool_pages: set[str] = set()

    for hit in raw_pool:
        if hit.logical_page_id in seen_pool_pages:
            continue

        seen_pool_pages.add(hit.logical_page_id)
        pool.append(hit)

    raw_pool_unique_pages = len(pool)
    pool_duplicate_hits = len(raw_pool) - raw_pool_unique_pages
    backfilled_unique_pages = 0
    minimum_pool_size = min(
        body.top_k,
        body.rerank_count,
    )

    if len(pool) < minimum_pool_size:
        for hit in fused_hits[len(raw_pool) :]:
            if hit.logical_page_id in seen_pool_pages:
                continue

            seen_pool_pages.add(hit.logical_page_id)
            pool.append(hit)
            backfilled_unique_pages += 1

            if len(pool) >= minimum_pool_size:
                break

    pool_unique_pages = len(pool)

    # A page can have a native and an OCR variant. The first variant fused for
    # a page is not necessarily the readable one: a legacy-font native layer
    # (garbled Hindi) can win on vector similarity while its OCR alternate is
    # the text a reader and the model can use. Rerank the best alternate
    # variant of each pooled page as well; after reranking only the higher-
    # scoring variant of each page is kept. Bounded so rerank cost grows by at
    # most ALTERNATE_VARIANT_BUDGET extra passages.
    alternates_added = 0
    pooled_variant_by_page = {hit.logical_page_id: hit.variant_id for hit in pool}
    seen_alternate_pages: set[str] = set()
    for hit in fused_hits:
        if alternates_added >= ALTERNATE_VARIANT_BUDGET:
            break
        pooled_variant = pooled_variant_by_page.get(hit.logical_page_id)
        if (
            pooled_variant is None
            or hit.variant_id == pooled_variant
            or hit.logical_page_id in seen_alternate_pages
        ):
            continue
        seen_alternate_pages.add(hit.logical_page_id)
        pool.append(hit)
        alternates_added += 1

    if not pool:
        return SearchResponse(
            query=query,
            embedding_model=EMBEDDING_MODEL,
            reranker_model=RERANKER_MODEL,
            scores_are_raw_logits=True,
            evidence=[],
        )

    rerank_started_at = time.perf_counter()
    scores = locked_predict(reranker,
        [(query, hit.text) for hit in pool],
        batch_size=RERANK_BATCH_SIZE,
        show_progress_bar=False,
        prompt_name="query",
    )

    rerank_ms = (
        time.perf_counter()
        - rerank_started_at
    ) * 1000.0

    print(
        "[retrieval-diag] "
        f"fused={len(fused_hits)} "
        f"raw_pool={len(raw_pool)} "
        f"raw_unique_pages={raw_pool_unique_pages} "
        f"backfilled_unique_pages={backfilled_unique_pages} "
        f"rerank_pool={pool_unique_pages} "
        f"duplicates_removed={pool_duplicate_hits} "
        f"alternate_variants={alternates_added} "
        f"rerank_ms={rerank_ms:.1f}"
    )

    for hit, score in zip(pool, scores, strict=True):
        hit.rerank_score = float(score)

    if body.prefer_authority:
        # Rules and general orders first among near-ties (ADR-078).
        probabilities = scores_are_probabilities([hit.rerank_score for hit in pool])
        pool.sort(
            key=lambda hit: authority_score(
                hit.rerank_score, hit.tier, hit.provider, hit.status, probabilities, hit.tier_confidence
            ),
            reverse=True,
        )
    else:
        pool.sort(key=lambda hit: hit.rerank_score, reverse=True)

    selected: list[Hit] = []
    seen_pages: set[str] = set()
    # Chat: at most PAGES_PER_SOURCE direct pages from one document in the
    # first pass, so a general question ("bidder's turnover condition") sees
    # the Goods, Works and Services manuals rather than three pages of one
    # (ADR-087). Neighbour pages still extend the chosen pages; a second pass
    # fills any free places.
    per_source: dict[str, int] = defaultdict(int)
    cap = PAGES_PER_SOURCE if body.prefer_authority else body.top_k
    for second_pass in (False, True):
        for hit in pool:
            if len(selected) >= body.top_k:
                break
            if hit.logical_page_id in seen_pages:
                continue
            if not second_pass and per_source[hit.source_id] >= cap:
                continue
            seen_pages.add(hit.logical_page_id)
            per_source[hit.source_id] += 1
            selected.append(hit)
    selected.sort(key=lambda hit: pool.index(hit))

    final_hits = selected

    if (
        body.expand_neighbors
        and body.neighbor_radius > 0
        and body.max_evidence_pages > len(selected)
    ):
        final_hits = [
            *selected,
            *load_neighbor_hits(
                selected,
                radius=body.neighbor_radius,
                max_total_pages=body.max_evidence_pages,
            ),
        ]

    hydration_started_at = time.perf_counter()

    assert DATABASE_URL is not None
    # One connection for all evidence pages instead of one per page.
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        hydrated_evidence = [
            hydrate(
                conn,
                hit,
                f"S{i}",
            )
            for i, hit in enumerate(
                final_hits,
                start=1,
            )
        ]

    hydration_ms = (
        time.perf_counter()
        - hydration_started_at
    ) * 1000.0

    retrieval_total_ms = (
        time.perf_counter()
        - search_started_at
    ) * 1000.0

    return SearchResponse(
        query=query,
        embedding_model=EMBEDDING_MODEL,
        reranker_model=RERANKER_MODEL,
        scores_are_raw_logits=True,
        evidence=hydrated_evidence,
        timings={
            "embedding_ms": embedding_ms,
            "hybrid_search_ms": hybrid_search_ms,
            "rerank_ms": rerank_ms,
            "hydration_ms": hydration_ms,
            "total_ms": retrieval_total_ms,
        },
    )


# ---------------------------------------------------------------------------
# Order finding by subject meaning (ADR-058)
# ---------------------------------------------------------------------------

SUBJECT_QUERY_PROMPT = (
    "Instruct: Given a Hindi or English description of an Uttar Pradesh government "
    "order (its topic, scheme, place, person or purpose), retrieve orders whose "
    "subject line matches it.\n"
    "Query:"
)


class SubjectSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=30, ge=1, le=100)
    department_ids: list[int] | None = Field(default=None, max_length=12)
    date_from: str | None = Field(default=None, max_length=10)
    date_to: str | None = Field(default=None, max_length=10)


class SubjectHit(BaseModel):
    source_id: str
    similarity: float


@app.post("/subjects/search", response_model=list[SubjectHit])
def subject_search(body: SubjectSearchRequest, request: Request):
    """Orders whose subject line is closest in meaning to the query (cosine similarity)."""
    embedder: SentenceTransformer = request.app.state.embedder
    query_vector = locked_encode(embedder,
        [body.query.strip()],
        prompt=SUBJECT_QUERY_PROMPT,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )[0]

    clauses: list[str] = ["d.provenance_ok"]  # Rulebook §2
    vector = vector_literal(query_vector)
    params: list[Any] = [vector]
    if body.department_ids:
        clauses.append("d.department_id = ANY(%s)")
        params.append([int(value) for value in body.department_ids])
    if body.date_from:
        clauses.append("d.go_date >= %s::date")
        params.append(body.date_from)
    if body.date_to:
        clauses.append("d.go_date <= %s::date")
        params.append(body.date_to)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.extend([vector, body.limit])

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        # Filters apply after the HNSW scan; widen it so filtered searches still fill the limit.
        conn.execute(
            "SELECT set_config('hnsw.ef_search', %s, true)",
            (str(max(HNSW_EF_SEARCH_MIN, min(HNSW_EF_SEARCH_MAX, body.limit * (8 if len(clauses) > 1 else 2)))),),
        )
        if pgvector_supports_iterative_scan(conn):
            conn.execute("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)")
        rows = conn.execute(
            f"""
            SELECT e.source_id, 1 - (e.embedding <=> %s::vector(1024)) AS similarity
            FROM document_subject_embeddings e
            JOIN documents d ON d.source_id = e.source_id
            {where}
            ORDER BY e.embedding <=> %s::vector(1024)  -- index order (cosine distance)
            LIMIT %s
            """,
            params,
        ).fetchall()

    return [SubjectHit(source_id=row["source_id"], similarity=float(row["similarity"])) for row in rows]
