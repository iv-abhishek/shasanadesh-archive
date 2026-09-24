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

start_marker = '''      // A placeholder-only failure is already safe to handle deterministically:
'''
end_marker = '''      if (!finalValidation.ok) {
        repaired = true;
'''

start = text.find(start_marker)
end = text.find(end_marker, start if start != -1 else 0)

if start == -1 or end == -1:
    if "const preRepairSalvage =" in text and "Try deterministic qualitative salvage before LLM repair" in text:
        print("General pre-repair salvage fast path already installed.")
    else:
        print("Could not locate the existing placeholder-only fast path.")
        print("No files were changed.")
        sys.exit(2)
else:
    replacement = '''      // Try deterministic qualitative salvage before LLM repair.
      //
      // The salvage function can only keep citation-valid, non-numeric,
      // non-placeholder claim units, and the result must pass the same final
      // validator. If salvage cannot produce a valid answer, fall through to
      // the existing LLM repair path unchanged.
      if (!finalValidation.ok) {
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

'''
    backup = server.with_suffix(".ts.pre-general-salvage-fastpath")
    if not backup.exists():
        backup.write_text(text)

    text = text[:start] + replacement + text[end:]
    server.write_text(text)

    print("Installed general deterministic pre-repair salvage fast path.")
    print(f"Backup: {backup}")

print()
print("Running RAG safety tests...")
subprocess.run(["npm", "run", "test:rag-safety"], check=True)

print()
print("Running conversation/routing/workspace tests...")
subprocess.run(["npm", "run", "test:rag-conversation"], check=True)
subprocess.run(["npm", "run", "test:rag-routing"], check=True)
subprocess.run(["npm", "run", "test:workspace-model"], check=True)
subprocess.run(["npm", "run", "test:session-cookie"], check=True)
subprocess.run(["npm", "run", "test:neighbor-expansion"], check=True)

print()
print("Running TypeScript checks...")
subprocess.run(["npm", "run", "web:typecheck"], check=True)
subprocess.run(["npx", "tsc", "--noEmit"], check=True)

print()
print("Patch passed.")
print()
print("Restart API on :8787 and rerun the same medical-officer query.")
