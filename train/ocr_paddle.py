"""
OCR a batch of scanned GOs with PaddleOCR-VL on a rented GPU (ADR-104).

    # once per machine (CUDA 12.6 wheels; see docs/GPU_RUNBOOK.md)
    python -m pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
    python -m pip install -U "paddleocr[doc-parser]>=3.4.0"
    apt-get install -y poppler-utils

    python train/ocr_paddle.py --batch batch-2026-10-05

Reads <batch>/manifest.jsonl and <batch>/pdfs/<dir>.pdf (from `npm run ocr:export`),
writes <batch>/out/<dir>.txt in the archive's page format ("===== PAGE n =====")
and <batch>/out/summary.json. Already finished documents are skipped, so the run
can be stopped and resumed.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path


def page_images(pdf: Path, folder: Path, dpi: int) -> list[Path]:
    subprocess.run(["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(folder / "page")], check=True, capture_output=True)
    return sorted(folder.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))


def markdown_of(result, scratch: Path) -> str:
    """Text of one page result, via the documented save_to_markdown()."""
    for old in scratch.glob("*.md"):
        old.unlink()
    result.save_to_markdown(save_path=str(scratch))
    files = sorted(scratch.glob("*.md"))
    return "\n".join(path.read_text(encoding="utf-8") for path in files).strip()


class PageTimeout(Exception):
    pass


def _alarm(_signum, _frame):
    raise PageTimeout()


def text_of(result) -> str:
    """Plain lines from a PP-OCRv5 page result (rec_texts), whichever way this version exposes them."""
    for getter in (lambda r: r["rec_texts"], lambda r: r.json["res"]["rec_texts"], lambda r: r.json["rec_texts"]):
        try:
            texts = getter(result)
            if isinstance(texts, list):
                return "\n".join(str(text) for text in texts)
        except Exception:
            continue
    return ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", required=True)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--pipeline-version", default=None, help='e.g. "v1"; default: the library\'s current model')
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--engine", choices=["vl", "ppocr"], default="vl", help="vl = PaddleOCR-VL (best, GPU); ppocr = PP-OCRv5 Hindi text reader (light, CPU ok)")
    parser.add_argument("--page-timeout", type=int, default=240, help="seconds per page before giving up (6 Oct: the VL worker hung silently)")
    args = parser.parse_args()

    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    signal.signal(signal.SIGALRM, _alarm)

    batch = Path(args.batch)
    rows = [json.loads(line) for line in (batch / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit:
        rows = rows[: args.limit]

    # Imported here so --help works without the GPU stack.
    if args.engine == "vl":
        from paddleocr import PaddleOCRVL

        pipeline = PaddleOCRVL(pipeline_version=args.pipeline_version) if args.pipeline_version else PaddleOCRVL()
    else:
        from paddleocr import PaddleOCR

        pipeline = PaddleOCR(lang="hi", use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
    out = batch / ("out" if args.engine == "vl" else "out-ppocr")
    out.mkdir(exist_ok=True)
    done = failed = pages_done = timeouts_in_a_row = 0
    started = time.time()
    for row in rows:
        target = out / f"{row['dir']}.txt"
        if target.exists():
            continue
        pdf = batch / "pdfs" / f"{row['dir']}.pdf"
        try:
            with tempfile.TemporaryDirectory() as temp:
                temp_path = Path(temp)
                scratch = temp_path / "md"
                scratch.mkdir()
                blocks = []
                for number, image in enumerate(page_images(pdf, temp_path, args.dpi), start=1):
                    page_started = time.time()
                    signal.alarm(args.page_timeout)
                    try:
                        results = list(pipeline.predict(str(image)))
                    finally:
                        signal.alarm(0)
                    texts = [markdown_of(result, scratch) if args.engine == "vl" else text_of(result) for result in results]
                    blocks.append(f"\n\n===== PAGE {number} =====\n\n" + "\n".join(texts).strip() + "\n")
                    pages_done += 1
                    print(f"  {row['dir']} page {number}: {time.time() - page_started:.1f}s, {sum(len(t) for t in texts)} characters", flush=True)
            target.write_text("".join(blocks), encoding="utf-8")
            done += 1
            timeouts_in_a_row = 0
        except PageTimeout:
            failed += 1
            timeouts_in_a_row += 1
            print(f"TIMEOUT {row['dir']}: a page took more than {args.page_timeout}s", flush=True)
            if timeouts_in_a_row >= 2:
                print("Stopping: two documents in a row timed out. Try --engine ppocr, or run with the GPU to itself.", flush=True)
                break
        except Exception as error:  # one bad scan must not stop the batch
            failed += 1
            print(f"FAILED {row['dir']}: {error}", flush=True)
        if (done + failed) % 10 == 0:
            rate = pages_done / max(1.0, time.time() - started)
            print(f"{done + failed}/{len(rows)} documents · {pages_done} pages · {rate:.2f} pages/s")

    summary = {"documents": done, "failed": failed, "pages": pages_done, "seconds": round(time.time() - started)}
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"Copy {out} back into data/ocr-batch/{batch.name}/out on the Mac (rename out-ppocr to out for the PP-OCR run), then: npm run ocr:import -- data/ocr-batch/{batch.name}")


if __name__ == "__main__":
    main()
