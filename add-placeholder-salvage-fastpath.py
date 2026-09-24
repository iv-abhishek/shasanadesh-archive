#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

root = Path.cwd()
server = root / "src/api/server.ts"

if not (root / "package.json").exists() or not server.exists():
    print("Run this from the shasanadesh project root.")
    sys.exit(1)

text = server.read_text()

old = '''      let repairValidationIssues:
        string[] = [];

      if (!firstValidation.ok) {
        repaired = true;
'''

new = '''      let repairValidationIssues:
        string[] = [];

      // A placeholder-only failure is already safe to handle deterministically:
      // buildQualitativeSalvage removes placeholder/numeric claim units and keeps
      // only citation-valid qualitative material. Try that before paying for a
      // second generator pass. Any failure still falls through to the existing
      // LLM repair path unchanged.
      const placeholderOnlyFailure =
        !firstValidation.ok &&
        firstValidation.issues.length > 0 &&
        firstValidation.issues.every(
          (issue) =>
            issue.code ===
            "internal_placeholder",
        );

      if (placeholderOnlyFailure) {
        const preRepairSalvage =
          buildQualitativeSalvage(
            firstDraft,
            retrieval.evidence,
          );

        if (preRepairSalvage) {
          const salvageValidation =
            validateCurrentAnswer(
              preRepairSalvage,
            );

          if (salvageValidation.ok) {
            usedQualitativeSalvage =
              true;
            finalAnswer =
              preRepairSalvage;
            finalValidation =
              salvageValidation;
          }
        }
      }

      if (!finalValidation.ok) {
        repaired = true;
'''

if new in text:
    print("Patch already installed.")
elif old not in text:
    print("Could not find the expected repair block in src/api/server.ts.")
    print("No files were changed.")
    sys.exit(2)
else:
    backup = server.with_suffix(".ts.pre-placeholder-fastpath")
    if not backup.exists():
        backup.write_text(text)
    server.write_text(text.replace(old, new, 1))
    print("Installed placeholder-only deterministic salvage fast path.")
    print(f"Backup: {backup}")

print()
print("Running RAG safety tests...")
subprocess.run(["npm", "run", "test:rag-safety"], check=True)

print()
print("Running root TypeScript check...")
subprocess.run(["npx", "tsc", "--noEmit"], check=True)

print()
print("Patch passed.")
