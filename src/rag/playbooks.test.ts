/**
 * Playbooks (ADR-091): every file parses, every page exists in the corpus,
 * and common questions reach the right playbook (and others reach none).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPlaybooks, matchPlaybook, parsePlaybook } from "./playbooks.js";

const books = loadPlaybooks();
assert.ok(books.length >= 10, `expected the playbooks, found ${books.length}`);

// Unique ids, file name = id, related ids exist.
const ids = new Set(books.map((book) => book.id));
assert.equal(ids.size, books.length, "playbook ids are unique");
for (const book of books) {
  assert.ok(existsSync(path.join("datasets/playbooks", `${book.id}.md`)), `${book.id}.md is named after its id`);
  for (const related of book.related) assert.ok(ids.has(related), `${book.id}: related "${related}" exists`);
  assert.ok(book.guidance.includes("## How to answer"), `${book.id}: has a How to answer section`);
}

// Every pinned page is in the corpus with text (when the corpus is present).
if (existsSync("data/documents")) {
  for (const book of books) {
    for (const page of book.pages) {
      const file = path.join("data/documents", page.sourceId, "pages.jsonl");
      assert.ok(existsSync(file), `${book.id}: ${page.sourceId} is in the corpus`);
      const found = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pageNumber: number; text: string })
        .find((row) => row.pageNumber === page.pageNumber);
      assert.ok(found && found.text.trim().length > 100, `${book.id}: ${page.sourceId} p.${page.pageNumber} has text`);
    }
  }
}

const cases: Array<[string, string | null]> = [
  ["Are the PSU exempted from EMD as per GeM GTC", "bid-security-emd"],
  ["bid security amount as per GFR", "bid-security-emd"],
  ["जेम पर ईएमडी कितनी ली जाएगी", "bid-security-emd"],
  ["performance security percentage on GeM for UP departments", "performance-security"],
  ["ePBG kab lena hai", "performance-security"],
  ["bidders past experience criteria as per GFR rules", "bidder-experience-criteria"],
  ["what is the similar work experience criteria for contractors", "bidder-experience-criteria"],
  ["निविदादाता का पूर्व अनुभव क्या होना चाहिए", "bidder-experience-criteria"],
  ["minimum average annual turnover required for bidders", "bidder-turnover-criteria"],
  ["Prior experience relaxation for startups in tenders", "startup-mse-relaxations"],
  ["Is EMD exemption available to MSEs?", "startup-mse-relaxations"],
  ["mobilisation advance for works contract", "mobilisation-advance"],
  ["Mobilization advance payment interest", "mobilisation-advance"],
  ["advance payment to private firms under GFR", "advance-payment-to-suppliers"],
  ["limit for direct purchase on GeM", "gem-procurement"],
  ["limited tender enquiry value limit", "limited-tender-enquiry"],
  ["when can single tender be used, PAC format", "single-tender-proprietary"],
  ["only one bid received in GeM bid, can we accept it", "single-bid-received"],
  // Not procurement topics: no playbook.
  ["past experience required for promotion to section officer", null],
  ["turnover limit for GST registration", null],
  ["festival advance to employees", null],
  ["maternity leave rules for state employees", null],
  // Startup policy questions are not procurement relaxations (4 Oct eval).
  ["what support is given to deeptech startups under the startup policy", null],
  ["incentives for incubators under UP startup policy 2026", null],
  ["EMD exemption for startups", "startup-mse-relaxations"],
];
for (const [question, expected] of cases) {
  const match = matchPlaybook(question, books);
  assert.equal(match?.playbook.id ?? null, expected, `"${question}" → ${match?.playbook.id ?? "none"} (matched ${match?.matched.join(", ") ?? "-"})`);
}

// Parser rejects bad files.
assert.throws(() => parsePlaybook("no front matter"), /front matter/);
assert.throws(() => parsePlaybook("---\nid: Bad Id\ntriggers:\n  - x\npages:\n  - a p.1\n---\n"), /lowercase/);
assert.throws(() => parsePlaybook("---\nid: ok\ntriggers:\n  - x\npages:\n  - page one\n---\n"), /source-id p\.12/);
const minimal = parsePlaybook("---\nid: ok\ntriggers:\n  - x\npages:\n  - doc-a p.3\nboost: 2\n---\nbody");
assert.deepEqual(minimal.pages, [{ sourceId: "doc-a", pageNumber: 3 }]);
assert.equal(minimal.boost, 2);
assert.equal(minimal.reviewed, false);

console.log(`playbook tests passed (${books.length} playbooks, ${cases.length} questions)`);
