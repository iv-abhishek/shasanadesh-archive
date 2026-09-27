#!/usr/bin/env python3
"""Stage user-saved Shasanadesh result pages through the loopback bridge.

This utility only reads local HTML files and talks to 127.0.0.1. It does not
open the portal, access browser state, or send cookies/session data anywhere.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlencode, urljoin, urlsplit

PORTAL_ROOT = "https://shasanadesh.up.gov.in/"
OFFICIAL_ORIGIN = "https://shasanadesh.up.gov.in"
PAGE_NAME = re.compile(r"(?:^|[^a-z0-9])(?:page|p)[-_ ]?(\d+)(?:[^0-9]|$)", re.I)
TOTAL_PATTERNS = (
    re.compile(r"कुल\s*प्राप्त\s*अभिलेख\s*[-:：]?\s*([\d,]+)", re.I),
    re.compile(r"(?:कुल|Total)[^\d]{0,50}([\d,]{1,9})", re.I),
)
HEADER_PATTERNS = {
    "department": re.compile(r"विभाग|Department", re.I),
    "section": re.compile(r"अनुभाग|Section", re.I),
    "goNumber": re.compile(r"संख्या|G\.?\s*O\.?\s*No|Number", re.I),
    "goDate": re.compile(r"तिथि|दिनांक|Date", re.I),
    "category": re.compile(r"श्रेणी|Category", re.I),
    "subject": re.compile(r"विषय|Subject", re.I),
}


class ResultPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict[str, object]]] = []
        self.visible: list[str] = []
        self.row: list[dict[str, object]] | None = None
        self.cell: dict[str, object] | None = None
        self.link: dict[str, object] | None = None
        self.skip_depth = 0
        self.skip_tags: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in ("script", "style"):
            self.skip_tags.append(tag)
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "tr":
            self._finish_row()
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self._finish_cell()
            self.cell = {"tag": tag, "parts": [], "links": []}
        elif tag == "a" and self.cell is not None:
            attributes = dict(attrs)
            self.link = {"href": attributes.get("href"), "parts": []}
        elif tag in ("br", "p", "div", "li") and self.cell is not None:
            self.cell["parts"].append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in ("script", "style") and self.skip_depth:
            self.skip_depth -= 1
            if self.skip_tags:
                self.skip_tags.pop()
            return
        if self.skip_depth:
            return
        if tag == "a" and self.link is not None:
            assert self.cell is not None
            self.link["text"] = "".join(self.link.pop("parts"))
            self.cell["links"].append(self.link)
            self.link = None
        elif tag in ("td", "th"):
            self._finish_cell()
        elif tag == "tr":
            self._finish_row()

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        self.visible.append(data)
        if self.cell is not None:
            self.cell["parts"].append(data)
        if self.link is not None:
            self.link["parts"].append(data)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def _finish_cell(self) -> None:
        if self.cell is None or self.row is None:
            return
        self.cell["text"] = "".join(self.cell.pop("parts"))
        self.row.append(self.cell)
        self.cell = None

    def _finish_row(self) -> None:
        self._finish_cell()
        if self.row:
            self.rows.append(self.row)
        self.row = None


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def page_number(path: Path, explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    match = PAGE_NAME.search(path.stem)
    if not match:
        raise ValueError(f"{path.name}: name the file page-N.html or pass --page N")
    return int(match.group(1))


def parse_total(text: str) -> int | None:
    for pattern in TOTAL_PATTERNS:
        match = pattern.search(text)
        if match:
            return int(match.group(1).replace(",", ""))
    return None


def header_for(rows: list[list[dict[str, object]]]) -> tuple[int, dict[str, int]]:
    for row_index, row in enumerate(rows):
        labels = [compact(cell.get("text")) for cell in row]
        mapping: dict[str, int] = {}
        for field, pattern in HEADER_PATTERNS.items():
            match_index = next((i for i, label in enumerate(labels) if pattern.search(label)), None)
            if match_index is not None:
                mapping[field] = match_index
        if len(mapping) >= 4 and not any(cell.get("links") for cell in row):
            return row_index, mapping
    raise ValueError("Could not identify the Shasanadesh results table headers in this HTML page")


def cell_text(row: list[dict[str, object]], index: int | None) -> str:
    if index is None or index >= len(row):
        return ""
    return str(row[index].get("text", ""))


def valid_official_link(href: object) -> tuple[str, str] | None:
    if not isinstance(href, str) or not href.strip():
        return None
    source_url = urljoin(PORTAL_ROOT, href.strip())
    parsed = urlsplit(source_url)
    if f"{parsed.scheme}://{parsed.netloc}" != OFFICIAL_ORIGIN or parsed.path != "/GO/ViewGOPDF_list_user.aspx":
        return None
    match = re.search(r"(?:^|&)id1=([^&]*)", parsed.query)
    encoded = unquote(match.group(1)) if match else None
    if not encoded:
        return None
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        source_id = base64.b64decode(padded, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    if not re.fullmatch(r"\d+#\d+#\d+#\d{4}", source_id):
        return None
    return source_url, source_id


def records_from_page(path: Path) -> tuple[int, int | None, list[dict[str, object]]]:
    raw = path.read_bytes()
    html_text = raw.decode("utf-8-sig", errors="replace")
    parser = ResultPageParser()
    parser.feed(html_text)
    parser.close()
    header_index, mapping = header_for(parser.rows)
    records: list[dict[str, object]] = []
    department_index = mapping.get("department")
    section_index = mapping.get("section")

    for row in parser.rows[header_index + 1:]:
        links = [valid_official_link(link.get("href")) for cell in row for link in cell.get("links", [])]
        official = next((entry for entry in links if entry is not None), None)
        if official is None:
            continue
        source_url, source_id = official
        department = cell_text(row, department_index)
        section = cell_text(row, section_index)
        if department_index is not None and department_index == section_index:
            lines = [compact(line) for line in department.splitlines() if compact(line)]
            department = lines[0] if lines else ""
            section = " ".join(lines[1:])
        anchor_text = next((
            compact(link.get("text")) for cell in row for link in cell.get("links", [])
            if valid_official_link(link.get("href")) is not None
        ), "")
        records.append({
            "sourceId": source_id,
            "sourceUrl": source_url,
            "department": compact(department) or None,
            "section": compact(section) or None,
            "goNumber": compact(cell_text(row, mapping.get("goNumber"))) or None,
            "goDate": compact(cell_text(row, mapping.get("goDate"))) or None,
            "category": compact(cell_text(row, mapping.get("category"))) or None,
            "subject": compact(cell_text(row, mapping.get("subject"))) or None,
            "linkText": anchor_text or None,
            "portalRow": len(records) + 1,
        })
    if not records:
        raise ValueError(f"{path.name}: no official Shasanadesh PDF links found")
    return len(records), parse_total(" ".join(parser.visible)), records


def files_for(input_path: Path, explicit_page: int | None) -> list[tuple[Path, int]]:
    if input_path.is_file():
        return [(input_path, page_number(input_path, explicit_page))]
    if not input_path.is_dir():
        raise ValueError(f"Input path does not exist: {input_path}")
    files = sorted((*input_path.glob("*.html"), *input_path.glob("*.htm")))
    if not files:
        raise ValueError(f"No .html or .htm pages found in {input_path}")
    return [(path, page_number(path, None)) for path in files]


def bridge_request(port: int, method: str, path: str, body: bytes | None = None,
                   headers: dict[str, str] | None = None) -> tuple[int, str]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read().decode("utf-8", errors="replace")
    finally:
        connection.close()


def bridge_token(port: int) -> str:
    status, body = bridge_request(port, "GET", "/")
    if status != 200:
        raise RuntimeError(f"Local bridge returned HTTP {status}")
    match = re.search(r'name="token"\s+value="([a-f0-9]{48})"', body, re.I)
    if not match:
        raise RuntimeError("Could not read a bridge token from http://127.0.0.1:%d; start npm run portal:bridge" % port)
    return match.group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Import locally saved Shasanadesh result pages through the loopback bridge.")
    parser.add_argument("--input", required=True, type=Path, help="one HTML file or a folder of page-N.html files")
    parser.add_argument("--department", required=True, help="exact department filter used for this portal search")
    parser.add_argument("--date-from", required=True, help="search start date as entered on the portal")
    parser.add_argument("--date-to", required=True, help="search end date as entered on the portal")
    parser.add_argument("--total", type=int, help="portal total; otherwise read from each saved page")
    parser.add_argument("--page-size", type=int, help="records-per-page selection; inferred from page 1 when possible")
    parser.add_argument("--page", type=int, help="page number when importing one file whose name has no page-N")
    parser.add_argument("--bridge-port", type=int, default=8799, help="local bridge port (default 8799)")
    parser.add_argument("--mark-complete", action="store_true", help="ask the bridge to verify and mark this listing complete after import")
    parser.add_argument("--dry-run", action="store_true", help="parse and summarize files without sending anything to the bridge")
    args = parser.parse_args()

    try:
        if not 1 <= args.bridge_port <= 65535:
            raise ValueError("Bridge port must be between 1 and 65535")
        pages = files_for(args.input, args.page)
        parsed_pages = []
        for path, number in pages:
            if number < 1:
                raise ValueError(f"{path.name}: page number must be positive")
            rows, detected_total, records = records_from_page(path)
            total = args.total or detected_total
            if not total or total < 1:
                raise ValueError(f"{path.name}: portal total not found; pass --total")
            parsed_pages.append({"path": path, "number": number, "rows": rows, "total": total, "records": records})

        totals = {page["total"] for page in parsed_pages}
        if len(totals) != 1:
            raise ValueError(f"Saved pages report inconsistent totals: {sorted(totals)}")
        parsed_pages.sort(key=lambda item: item["number"])
        numbers = [page["number"] for page in parsed_pages]
        if len(numbers) != len(set(numbers)):
            raise ValueError("The input contains more than one saved file for the same page number")
        inferred_size = next((page["rows"] for page in parsed_pages if page["number"] == 1), None)
        page_size = args.page_size or inferred_size
        if not page_size or page_size < 1:
            raise ValueError("Page size is unknown; include page 1 or pass --page-size")
        if any(page["rows"] > page_size for page in parsed_pages):
            raise ValueError("At least one saved page contains more rows than --page-size")

        print(f"Parsed {len(parsed_pages)} page(s), {sum(page['rows'] for page in parsed_pages)} rows; portal total {next(iter(totals))}; page size {page_size}.")
        if args.dry_run:
            for page in parsed_pages:
                print(f"  page {page['number']}: {page['rows']} rows from {page['path']}")
            return 0

        token = bridge_token(args.bridge_port)
        listing = {"department": args.department, "dateFrom": args.date_from, "dateTo": args.date_to}
        for page in parsed_pages:
            batch = {
                "listing": listing,
                "portalPage": page["number"],
                "reportedTotal": page["total"],
                "pageSize": page_size,
                "records": page["records"],
            }
            body = json.dumps(batch, ensure_ascii=False).encode("utf-8")
            status, response = bridge_request(args.bridge_port, "POST", "/api/batch", body, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(body)),
                "X-Bridge-Token": token,
            })
            result = json.loads(response)
            if status != 200 or not result.get("ok"):
                raise RuntimeError(f"Page {page['number']} rejected by local bridge: {result.get('message', response)}")
            print(result.get("message", f"Page {page['number']} imported."))

        if args.mark_complete:
            key = f"department={args.department.strip()} | dateFrom={args.date_from.strip()} | dateTo={args.date_to.strip()}"
            form = urlencode({"token": token, "listing": key}).encode("utf-8")
            status, response = bridge_request(args.bridge_port, "POST", "/complete", form, {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": str(len(form)),
            })
            if status != 200:
                raise RuntimeError(f"Bridge could not mark the listing complete (HTTP {status}); review its missing-page report.")
            print("Bridge marked the listing complete after checking its page ledger.")
        print("The running importer will pick up new inventory and store PDFs in B2 at its configured rate.")
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Saved-page import failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
