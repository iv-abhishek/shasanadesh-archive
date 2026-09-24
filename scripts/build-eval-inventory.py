#!/usr/bin/env python3
# Build an evaluation-candidate inventory from the loaded corpus.
#
# This script deliberately does NOT create scored RAG cases. It surfaces
# document/page coverage and representative text so a human can verify
# source/page expectations before adding them to eval/rag-cases.json.

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row


DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    raise SystemExit(
        "DATABASE_URL is required. Example:\n"
        "export DATABASE_URL='postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh'"
    )


def verification_status(row: dict[str, Any]) -> str:
    if bool(row["numeric_conflict"]):
        return "conflict"

    has_native = bool(row["has_native"])
    has_ocr = bool(row["has_ocr"])

    if not has_native and has_ocr:
        return "ocr_only_unverified"

    if has_native and has_ocr:
        return "variants_agree"

    if has_native:
        return "native_primary"

    return "unverified"


def compact(text: str | None, limit: int = 320) -> str:
    if not text:
        return ""

    normalized = " ".join(text.split())

    if len(normalized) <= limit:
        return normalized

    return normalized[:limit].rstrip() + "…"


query = (
    "SELECT "
    "d.source_id, d.department, d.go_number, d.go_date, d.source_url, "
    "p.page_number, p.numeric_conflict, "
    "BOOL_OR(pv.variant_type = 'native') AS has_native, "
    "BOOL_OR(pv.variant_type = 'ocr') AS has_ocr, "
    "COALESCE("
    "MAX(pv.text_content) FILTER (WHERE pv.canonical = TRUE), "
    "MAX(pv.text_content)"
    ") AS page_text "
    "FROM documents d "
    "JOIN pages p ON p.source_id = d.source_id "
    "LEFT JOIN page_variants pv "
    "ON pv.source_id = p.source_id "
    "AND pv.page_number = p.page_number "
    "GROUP BY "
    "d.source_id, d.department, d.go_number, d.go_date, d.source_url, "
    "p.page_number, p.numeric_conflict "
    "ORDER BY d.department NULLS LAST, d.source_id, p.page_number"
)

with psycopg.connect(
    DATABASE_URL,
    row_factory=dict_row,
) as conn:
    rows = conn.execute(query).fetchall()

documents: dict[str, dict[str, Any]] = {}
status_samples: dict[str, list[dict[str, Any]]] = defaultdict(list)

for row in rows:
    status = verification_status(row)
    source_id = str(row["source_id"])

    document = documents.setdefault(
        source_id,
        {
            "sourceId": source_id,
            "department": row["department"],
            "goNumber": row["go_number"],
            "goDate": (
                str(row["go_date"])
                if row["go_date"] is not None
                else None
            ),
            "sourceUrl": row["source_url"],
            "pageCount": 0,
            "statusCounts": Counter(),
            "samples": [],
        },
    )

    document["pageCount"] += 1
    document["statusCounts"][status] += 1

    sample = {
        "sourceId": source_id,
        "department": row["department"],
        "pageNumber": int(row["page_number"]),
        "status": status,
        "text": compact(row["page_text"]),
    }

    if len(document["samples"]) < 3:
        document["samples"].append(sample)

    if len(status_samples[status]) < 12:
        status_samples[status].append(sample)

serializable_documents: list[dict[str, Any]] = []

for document in documents.values():
    serializable_documents.append(
        {
            **document,
            "statusCounts": dict(document["statusCounts"]),
        }
    )

output = {
    "documentCount": len(serializable_documents),
    "pageCount": len(rows),
    "documents": serializable_documents,
    "samplesByVerificationStatus": dict(status_samples),
}

output_dir = Path("data/eval")
output_dir.mkdir(parents=True, exist_ok=True)

json_path = output_dir / "corpus-inventory.json"
json_path.write_text(
    json.dumps(
        output,
        ensure_ascii=False,
        indent=2,
    )
    + "\n"
)

status_totals: Counter[str] = Counter()

for document in serializable_documents:
    status_totals.update(
        document["statusCounts"]
    )

lines = [
    "# Evaluation Corpus Inventory",
    "",
    f"Documents: {len(serializable_documents)}",
    f"Pages: {len(rows)}",
    "",
    "## Verification-status coverage",
    "",
]

for status, count in sorted(status_totals.items()):
    lines.append(
        f"- `{status}`: {count} page(s)"
    )

lines += [
    "",
    "## Documents",
    "",
    "| Source | Department | Date | Pages | Evidence-status counts |",
    "| --- | --- | --- | ---: | --- |",
]

for document in serializable_documents:
    counts = ", ".join(
        f"{key}={value}"
        for key, value in sorted(
            document["statusCounts"].items()
        )
    )

    lines.append(
        "| "
        + " | ".join(
            [
                f"`{document['sourceId']}`",
                str(document["department"] or "unknown").replace("|", "\\|"),
                str(document["goDate"] or "unknown"),
                str(document["pageCount"]),
                counts.replace("|", "\\|"),
            ]
        )
        + " |"
    )

lines += [
    "",
    "## Candidate page samples",
    "",
    "These are discovery aids only. Verify the original PDF page before promoting any",
    "candidate into the scored benchmark.",
    "",
]

for status in [
    "ocr_only_unverified",
    "conflict",
    "variants_agree",
    "native_primary",
    "unverified",
]:
    samples = status_samples.get(status, [])

    if not samples:
        continue

    lines += [
        f"### {status}",
        "",
    ]

    for sample in samples:
        lines += [
            f"- `{sample['sourceId']}` p.{sample['pageNumber']} — {sample['department'] or 'unknown'}",
            f"  - {sample['text'] or '(no text)'}",
        ]

    lines.append("")

md_path = output_dir / "corpus-inventory.md"
md_path.write_text(
    "\n".join(lines) + "\n"
)

print("Evaluation corpus inventory")
print("===========================")
print(f"Documents: {len(serializable_documents)}")
print(f"Pages:     {len(rows)}")

for status, count in sorted(status_totals.items()):
    print(f"{status:24} {count}")

print()
print(f"JSON: {json_path}")
print(f"Markdown: {md_path}")
