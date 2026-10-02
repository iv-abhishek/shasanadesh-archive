/**
 * Fixture tests for the UP Financial Handbook reader. Fixtures are copies of
 * budget.up.nic.in pages captured 2026-10-01 (windows-1252 bytes as served);
 * the Vol. II index is trimmed after its first six links.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HANDBOOK_VOLUMES,
  decodeHandbookHtml,
  handbookPageText,
  handbookVolume,
  parseHandbookIndex,
  splitHandbookText,
  volumeParts,
} from "./up-fhb.js";

const fixture = (name: string) => decodeHandbookHtml(readFileSync(path.join(__dirname, "fixtures", name)));

// Volumes: unique ids and source ids, all on the official host.
{
  assert.equal(new Set(HANDBOOK_VOLUMES.map((volume) => volume.sourceId)).size, HANDBOOK_VOLUMES.length);
  for (const volume of HANDBOOK_VOLUMES) {
    assert.match(volume.sourceId, /^up-fhb-[a-z0-9-]+$/);
    assert.equal(new URL(volume.indexUrl).hostname, "budget.up.nic.in");
  }
  assert.equal(handbookVolume("csr").sourceId, "up-fhb-csr");
  assert.throws(() => handbookVolume("vol1"), /Unknown handbook volume/);
}

// CSR index: one entry per chapter page, title and paragraph range merged,
// windows-1252 dashes decoded, navigation links outside the volume dropped.
{
  const csr = handbookVolume("csr");
  const { entries, skipped } = parseHandbookIndex(fixture("up-fhb-csr-index.html"), csr.indexUrl);
  assert.equal(entries.length, 11);
  assert.deepEqual(skipped, []);
  assert.deepEqual(entries[0], {
    url: "https://budget.up.nic.in/Fin_H_Book/CSR/01.html",
    label: "CHAPTER I—General Scope (paras 1—4–A)",
  });
  assert.equal(entries[2].label, "CHAPTER XV—General Rules (paras 348–A—357–C)");
  assert.ok(entries.every((entry) => entry.url.startsWith("https://budget.up.nic.in/Fin_H_Book/CSR/")));
}

// Vol. II index: labels are bare file numbers (ignored); the .doc chapter is
// reported, not read as a page.
{
  const vol2 = handbookVolume("vol2");
  const { entries, skipped } = parseHandbookIndex(fixture("up-fhb-vol2-index.html"), vol2.indexUrl);
  assert.deepEqual(entries.map((entry) => entry.url.split("/").pop()), ["01.html", "02.html", "03.html", "04.html", "05.html"]);
  assert.ok(entries.every((entry) => entry.label === ""));
  assert.deepEqual(skipped, [{ url: "https://budget.up.nic.in/Fin_H_Book/volume2/06.doc", label: "006", reason: "not an HTML page" }]);
}

// A chapter page: paragraphs on their own lines (source line wraps joined),
// entities decoded, heading = first short line.
{
  const { heading, text } = handbookPageText(fixture("up-fhb-vol5-part1-050.html"));
  assert.equal(heading, "Annual Returns");
  const lines = text.split("\n");
  assert.equal(lines[0], "Annual Returns");
  assert.match(lines[1], /^127\. An annual statement showing the numerical strength of each office as in Annexure "A" to this chapter/);
  assert.ok(lines.some((line) => line.startsWith("127-A. In the case of a person who first entered military employ")));
  assert.ok(text.includes("NOTE—The date of birth once determined may not be altered"));
  assert.ok(!/\s{2,}/.test(text));
}

// Splitting: parts stay under the limit, break between paragraphs, keep all text.
{
  const paragraph = (n: number) => `${n}. ` + "The officer shall keep the account. ".repeat(20).trim();
  const text = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join("\n");
  const parts = splitHandbookText(text, 2000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 2000));
  assert.equal(parts.join("\n"), text);
  assert.ok(parts.every((part) => /^\d+\. /.test(part)));

  const long = "A sentence about treasury balances. ".repeat(200).trim();
  const pieces = splitHandbookText(long, 1000);
  assert.ok(pieces.length >= 7 && pieces.every((piece) => piece.length <= 1000));
  assert.ok(pieces.every((piece) => piece.endsWith(".")));
  assert.deepEqual(splitHandbookText("", 1000), []);
}

// Volume parts: long chapters become several pages with the same official URL,
// each headed with the volume and chapter; chapter page ranges are recorded.
{
  const csr = handbookVolume("csr");
  const long = Array.from({ length: 30 }, (_, i) => `${400 + i}. ` + "Pension is regulated by the rules in force. ".repeat(8).trim()).join("\n");
  const chapters = [
    { url: "https://budget.up.nic.in/Fin_H_Book/CSR/01.html", label: "CHAPTER I—General Scope (paras 1—4–A)", heading: "Chapter I", text: "1. These regulations define pension.", rawSha256: "a", html: "" },
    { url: "https://budget.up.nic.in/Fin_H_Book/CSR/02.html", label: "", heading: "CHAPTER II—Definitions", text: long, rawSha256: "b", html: "" },
    { url: "https://budget.up.nic.in/Fin_H_Book/CSR/03.html", label: "Empty", heading: null, text: "", rawSha256: "c", html: "" },
  ];
  const { parts, entries } = volumeParts(csr, chapters, 2000);
  assert.equal(parts[0].text, `[${csr.title} — CHAPTER I—General Scope (paras 1—4–A)]\n1. These regulations define pension.`);
  assert.ok(parts.length > 3);
  assert.ok(parts.slice(1).every((part) => part.url.endsWith("/CSR/02.html") && part.chapter === "CHAPTER II—Definitions"));
  assert.match(parts[1].text, /^\[Civil Service Regulations .* — CHAPTER II—Definitions \(part 1 of \d+\)\]\n400\. /);
  assert.deepEqual(entries.map((entry) => [entry.firstPage, entry.lastPage]), [[1, 1], [2, parts.length]]);
}

// Government orders printed in Kruti Dev fonts are converted; the digits and
// English in other fonts stay; inline font tags do not split words.
{
  const html = `<BODY><FONT SIZE=6><P ALIGN="CENTER">APPENDIX XI</P></FONT><P>[</FONT><FONT FACE="Kruti Dev 020">foRr ¼lkekU;½ vuqHkkx&amp;</FONT><FONT SIZE=5>4</FONT><FONT FACE="Kruti Dev 020"> ds dk;kZy; Kki fnukWd</FONT><FONT> 9 </FONT><FONT FACE="Kruti Dev 020">vDrwcj] </FONT><FONT>1974</FONT></P><P>An English note.</P></BODY>`;
  const { text } = handbookPageText(html);
  assert.equal(text, "APPENDIX XI\n[वित्त (सामान्य) अनुभाग-4 के कार्यालय ज्ञाप दिनांक 9 अक्तूबर, 1974\nAn English note.");
}

console.log("up-fhb tests passed");
