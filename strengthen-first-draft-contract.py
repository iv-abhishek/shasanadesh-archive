#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

root = Path.cwd()
prompt = root / "src/rag/prompt.ts"

if not (root / "package.json").exists() or not prompt.exists():
    print("Run this from the shasanadesh project root.")
    sys.exit(1)

text = prompt.read_text()

marker = "FIRST-DRAFT OUTPUT CONTRACT"
if marker in text:
    print("First-draft output contract already installed.")
else:
    start = text.find("export const RAG_SYSTEM_PROMPT")
    if start == -1:
        raise SystemExit("Could not locate RAG_SYSTEM_PROMPT.")

    end = text.find("`.trim();", start)
    if end == -1:
        raise SystemExit("Could not locate the end of RAG_SYSTEM_PROMPT.")

    contract = """

FIRST-DRAFT OUTPUT CONTRACT
- Return the final answer itself. Do not expose planning, validation notes, masking tokens, or internal placeholders.
- Never output UNVERIFIED_NUMERIC. If that token appears in evidence, treat the numeric value as absent.
- Never guess, reconstruct, or infer a masked numeric value from context.
- When evidence is numerically risky, state only qualitative propositions that remain true without the masked values.
- Every factual sentence or bullet must end with at least one exact evidence citation such as [S2 p.19].
- A factual answer with no valid [S# p.#] citation is invalid.
- Numeric characters from risky evidence may appear only as part of citation syntax, not as factual claims.
- Prefer 1-3 concise cited bullets over an uncited narrative.
- Before returning the answer, silently check: no UNVERIFIED_NUMERIC token; no unsupported numeric claim; every factual unit has a valid citation.
"""

    backup = prompt.with_suffix(".ts.pre-first-draft-contract")
    if not backup.exists():
        backup.write_text(prompt.read_text())

    text = text[:end] + contract + text[end:]
    prompt.write_text(text)

    print("Installed first-draft output contract.")
    print(f"Backup: {backup}")

print()
print("Running safety tests...")
subprocess.run(["npm", "run", "test:rag-safety"], check=True)

print()
print("Running TypeScript checks...")
subprocess.run(["npx", "tsc", "--noEmit"], check=True)
subprocess.run(["npm", "run", "web:typecheck"], check=True)

print()
print("Patch passed.")
