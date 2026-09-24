#!/usr/bin/env python3
from pathlib import Path
import shutil
import subprocess
import sys

root = Path.cwd()
safety = root / "src/rag/generation-safety.ts"
safety_test = root / "src/rag/generation-safety.test.ts"
prompt = root / "src/rag/prompt.ts"

required = [root / "package.json", safety, safety_test, prompt]
missing = [str(p) for p in required if not p.exists()]
if missing:
    print("Run this from the shasanadesh project root.")
    for p in missing:
        print(f"Missing: {p}")
    sys.exit(1)

marker = "Generator-facing risky evidence must not contain the legacy placeholder token."

def backup(path: Path) -> None:
    b = path.with_name(path.name + ".pre-redacted-numerics")
    if not b.exists():
        shutil.copy2(path, b)

# ---------------------------------------------------------------------
# 1. Remove the literal placeholder token from generator-facing evidence.
#    Keep UNVERIFIED_NUMERIC exported for backwards compatibility and for
#    validator/repair tests, but never inject it into evidence text.
# ---------------------------------------------------------------------
text = safety.read_text()

if marker not in text:
    backup(safety)

    old_re = '''const NUMERIC_RE =
  /[0-9०-९]+(?:[.,:/-][0-9०-९]+)*/gu;
'''
    new_re = '''const NUMERIC_RE =
  /[0-9०-९]+(?:[.,:/-][0-9०-९]+)*(?:\\s*%)?/gu;
'''
    if old_re in text:
        text = text.replace(old_re, new_re, 1)

    old_fn = '''export function prepareEvidenceTextForGeneration(
  text: string,
  status: NumericVerificationStatus,
): string {
  if (!isRiskyNumericStatus(status)) {
    return text;
  }

  return text.replace(
    NUMERIC_RE,
    UNVERIFIED_NUMERIC,
  );
}
'''
    new_fn = '''export function prepareEvidenceTextForGeneration(
  text: string,
  status: NumericVerificationStatus,
): string {
  if (!isRiskyNumericStatus(status)) {
    return text;
  }

  // Generator-facing risky evidence must not contain the legacy placeholder token.
  // Remove exact numeric spans instead of replacing them with a copyable sentinel.
  // The model can still use surrounding qualitative text, while deterministic
  // validation remains responsible for blocking unsafe numeric claims.
  return text
    .replace(NUMERIC_RE, "")
    .replace(/\\s+%/gu, "")
    .replace(/[ \\t]{2,}/gu, " ")
    .replace(/\\n[ \\t]+/gu, "\\n")
    .trim();
}
'''
    if old_fn not in text:
        raise SystemExit(
            "generation-safety.ts no longer matches the expected risky-text function. "
            "No partial patch was written."
        )
    text = text.replace(old_fn, new_fn, 1)
    safety.write_text(text)
    print("Patched src/rag/generation-safety.ts.")
else:
    print("Generator-facing numeric redaction already installed.")

# ---------------------------------------------------------------------
# 2. Update tests: risky evidence must contain no exact numerics AND no
#    UNVERIFIED_NUMERIC token.
# ---------------------------------------------------------------------
text = safety_test.read_text()
old_assert = '''assert.equal(
  risky.includes(UNVERIFIED_NUMERIC),
  true,
);
'''
new_assert = '''assert.equal(
  risky.includes(UNVERIFIED_NUMERIC),
  false,
);
'''
if old_assert in text:
    backup(safety_test)
    text = text.replace(old_assert, new_assert, 1)
    safety_test.write_text(text)
    print("Updated generation-safety test.")
elif new_assert in text:
    print("Generation-safety test already expects no placeholder token.")
else:
    raise SystemExit(
        "Could not locate the UNVERIFIED_NUMERIC assertion in generation-safety.test.ts."
    )

# ---------------------------------------------------------------------
# 3. Update prompt wording so it describes numeric removal, not a visible
#    placeholder token. Keep the instruction not to reconstruct numerics.
# ---------------------------------------------------------------------
text = prompt.read_text()
replacements = [
    (
        "- Risky evidence may contain an UNVERIFIED_NUMERIC placeholder. Never reconstruct or guess the hidden value.",
        "- Exact numeric values are removed from risky generator-facing evidence. Never reconstruct or guess a removed value.",
    ),
    (
        "- Never output UNVERIFIED_NUMERIC. If that token appears in evidence, treat the numeric value as absent.",
        "- Exact numeric values may be absent from risky evidence because they were removed before generation.",
    ),
    (
        "- Before returning the answer, silently check: no UNVERIFIED_NUMERIC token; no unsupported numeric claim; every factual unit has a valid citation.",
        "- Before returning the answer, silently check: no unsupported numeric claim; every factual unit has a valid citation.",
    ),
]

changed = False
for old, new in replacements:
    if old in text:
        if not changed:
            backup(prompt)
        text = text.replace(old, new)
        changed = True

if changed:
    prompt.write_text(text)
    print("Updated src/rag/prompt.ts wording.")
else:
    print("Prompt wording already compatible with redacted numerics.")

print()
print("Running safety tests...")
subprocess.run(["npm", "run", "test:rag-safety"], check=True)

print()
print("Running TypeScript checks...")
subprocess.run(["npx", "tsc", "--noEmit"], check=True)
subprocess.run(["npm", "run", "web:typecheck"], check=True)

print()
print("Patch passed.")
print("Restart API and benchmark the medical-officer case twice.")
