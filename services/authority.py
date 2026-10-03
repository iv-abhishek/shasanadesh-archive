"""Authority order for chat retrieval (ADR-078).

Chat ranks rulebooks and generally applicable orders (tier A) above orders
useful only in context (B), and routine orders the classifier was unsure about
(C, low confidence; confident C never reaches chat) last. The bonus is added to
the reranker score in logit space, so it settles near-ties; a clearly more
relevant page still wins. The raw reranker score is reported unchanged, so the
relevance gate is not affected.
"""

from __future__ import annotations

import math
import os

AUTHORITY_BONUS_A = float(os.getenv("RAG_AUTHORITY_BONUS_A", "1.0"))
AUTHORITY_PENALTY_C = float(os.getenv("RAG_AUTHORITY_PENALTY_C", "1.0"))
SUPERSEDED_PENALTY = float(os.getenv("RAG_SUPERSEDED_PENALTY", "2.0"))
RULEBOOK_PROVIDERS = ("core-rules", "up-fhb")


def scores_are_probabilities(scores: list[float]) -> bool:
    """Decided per batch: a raw logit of 0.7 is not a probability."""
    return bool(scores) and all(0.0 <= score <= 1.0 for score in scores)


def as_logit(score: float, is_probability: bool = True) -> float:
    """Reranker scores may be probabilities (0-1) or raw logits; compare as logits."""
    if is_probability:
        p = min(max(score, 1e-6), 1 - 1e-6)
        return math.log(p / (1 - p))
    return score


def authority_bonus(tier: str | None, provider: str | None, status: str | None) -> float:
    bonus = 0.0
    if provider in RULEBOOK_PROVIDERS or tier == "A":
        bonus += AUTHORITY_BONUS_A
    elif tier == "C":
        bonus -= AUTHORITY_PENALTY_C
    if status == "superseded":
        bonus -= SUPERSEDED_PENALTY
    return bonus


def authority_score(
    rerank_score: float,
    tier: str | None,
    provider: str | None,
    status: str | None,
    is_probability: bool = True,
) -> float:
    return as_logit(rerank_score, is_probability) + authority_bonus(tier, provider, status)
