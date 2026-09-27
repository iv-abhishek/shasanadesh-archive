import assert from "node:assert/strict";
import { classifyOrder } from "../classify/rules.js";
import { coreRulesAdapter, loadCatalogue, toSourceDocument, validateCatalogue, type CoreRuleEntry } from "./core-rules.js";

async function main(): Promise<void> {
  // The real catalogue is valid and every host it uses is allowed.
  const entries = loadCatalogue();
  assert.ok(entries.length >= 10);
  const documents = await coreRulesAdapter.discover();
  assert.equal(documents.length, entries.length);
  for (const document of documents) {
    assert.match(document.sourceId, /^core-rules-[a-z0-9-]+$/);
    assert.ok(coreRulesAdapter.allowedHosts.includes(new URL(document.downloadUrl).hostname), document.downloadUrl);
    assert.ok(document.downloadUrl.startsWith("https://"));
  }

  // What a catalogue entry becomes.
  const gem = toSourceDocument(entries.find((entry) => entry.slug === "up-gem-go-2025-03-11")!);
  assert.equal(gem.sourceId, "core-rules-up-gem-go-2025-03-11");
  assert.equal(gem.goNumber, "03/2025/275/18-2-2025-97(ल0उ0)/2016");
  assert.equal(gem.goDate, "2025-03-11");
  assert.equal(gem.jurisdiction, "state");
  assert.deepEqual((gem.sourceRecord as { amends: string[] }).amends, ["up-gem-go-2024-11-26"]);
  assert.equal(gem.titles?.hi, "जेम क्रय विषयक शासनादेश में संशोधन"); // its own Hindi title

  // Bad entries fail loudly.
  const good = entries[0];
  const bad = (change: Partial<CoreRuleEntry>) => () => validateCatalogue([{ ...good, ...change }]);
  assert.throws(bad({ downloadUrl: "http://doe.gov.in/x.pdf" }), /HTTPS/);
  assert.throws(bad({ downloadUrl: "https://www.scribd.com/x.pdf" }), /gov\.in/);
  assert.throws(bad({ slug: "Bad Slug" }), /slug/);
  assert.throws(bad({ date: "05/08/2017" }), /YYYY-MM-DD/);
  assert.throws(bad({ amends: ["nope"] }), /unknown entry/);
  assert.throws(bad({ topics: ["financial"] }), /unknown topic/);
  assert.throws(() => validateCatalogue([good, good]), /duplicate/);

  // Curated core rules are tier A, typed from the catalogue.
  const tier = (documentType: string, title: string) => classifyOrder({ provider: "core-rules", category: documentType, subject: title });
  assert.deepEqual([tier("rules", "General Financial Rules, 2017").tier, tier("rules", "x").docType], ["A", "rules"]);
  assert.equal(tier("guideline", "Manual for Procurement of Goods").docType, "guideline");
  assert.equal(tier("something-else", "x").docType, "guideline");
  assert.equal(tier("general-instruction", "GeM").confidence, "high");

  console.log(`core rules tests passed (${entries.length} catalogue entries)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
