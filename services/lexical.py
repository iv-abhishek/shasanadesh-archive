"""Words for the keyword half of hybrid search (ADR-092).

The keyword search used to require every word of the question (plainto_tsquery
ANDs them, so "what are the ... as per GFR rules" rarely matched anything) and
then fell back to trigram similarity over every chunk, which cannot use an
index: a full scan of seconds per query. Now the question is cut to its
meaningful words, and a chunk matching ANY of them is found through the GIN
full-text index; ts_rank_cd ranks chunks that match more of them, closer
together, higher.
"""
from __future__ import annotations

import re
import unicodedata

MAX_TERMS = 12

# Question words and glue, English and Hindi (after nukta removal). Domain
# words (rule, order, leave, tender…) are kept on purpose, except "rule(s)"
# and "as per", which appear in every question and every rulebook page.
STOPWORDS = frozenset(
    """
    a about above after again all also am an and any are as at be been being below between both
    but by can could did do does doing down during each few for from further get give given had
    has have having he her here how i if in into is it its just kindly know let me more most my
    no nor not now of off on once only or other our out over own please per regarding related
    rule rules same she should so some such tell than that the their them then there these they
    this those through to too under until up upon very was we were what when where which while
    who whom why will with would you your yes regards sir madam
    का की के को में मे से पर और या एवं तथा व है हैं था थी थे हो होगा होगी होंगे होता होती होते
    क्या कैसे कितना कितनी कितने कब कौन कौनसा किस किसे किसको कहाँ कहां क्यों
    लिए लिये हेतु द्वारा जाता जाती जाते जाए जाये जाएगा जाएगी जायेगा जायेगी करें करे करना करने
    किया किये गया गयी गई गए यह वह ये वे इस उस इन उन कि भी तो ही ने एक अनुसार संबंध सम्बन्ध
    बारे बताएं बताइए बताये बताओ मुझे हमें अपने अपना अपनी नियम नियमों
    """.split()
)

_WORD = re.compile(r"[0-9A-Za-zऀ-ॣ०-ॿ]+")


def _clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    # Zero-width joiners split Hindi words in some PDFs; nukta spellings vary.
    return text.replace("‌", "").replace("‍", "").replace("़", "")


def search_terms(query: str) -> list[str]:
    """Meaningful words of the question, in order, without duplicates."""
    terms: list[str] = []
    seen: set[str] = set()
    for raw in _WORD.findall(_clean(query)):
        word = raw.lower()
        if word in STOPWORDS or word in seen:
            continue
        # Single Latin letters and lone digits say nothing.
        if len(word) < 2 and not ("ऀ" <= word <= "ॿ"):
            continue
        seen.add(word)
        terms.append(word)
        if len(terms) >= MAX_TERMS:
            break
    return terms


def or_tsquery_sql(count: int) -> str:
    """SQL for an OR of plainto_tsquery('simple', %s) over `count` words.

    Each word goes through the same parser as the indexed text, so Hindi
    words split the same way on both sides; values are bound, never inlined.
    """
    if count < 1:
        raise ValueError("no search terms")
    return "(" + " || ".join(["plainto_tsquery('simple', %s)"] * count) + ")"
