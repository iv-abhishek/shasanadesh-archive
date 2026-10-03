import assert from "node:assert/strict";
import { mergeNamedPages, missingNamedSources, namedSources } from "./named-sources.js";
import type { RetrievalEvidence, RetrievalResponse } from "./types.js";

const names = (q: string) => namedSources(q).map((s) => s.name);
assert.deepEqual(names("Are the PSU exempted from EMD as per GeM GTC"), ["GeM GTC"]);
assert.deepEqual(names("bidders past experience criteria as per GFR rules"), ["GFR 2017"]);
assert.deepEqual(names("जीएफआर के अनुसार बिड सिक्योरिटी"), ["GFR 2017"]);
assert.deepEqual(names("mobilisation advance in works manual"), ["Manual for Procurement of Works"]);
assert.deepEqual(names("non-consultancy manual turnover"), ["Manual for Procurement of Non-Consultancy Services"]);
assert.deepEqual(names("consultancy manual QCBS"), ["Manual for Procurement of Consultancy Services"]);
assert.deepEqual(names("UP procurement manual EMD exemption"), ["UP Procurement Manual (Goods) 2016"]);
assert.deepEqual(names("goods manual LTE"), ["Manual for Procurement of Goods"]);
assert.deepEqual(names("as per UP GeM GO what is EMD"), ["UP GeM orders"]);
assert.deepEqual(names("जेम संबंधी शासनादेश में ईपीबीजी"), ["UP GeM orders"]);
assert.deepEqual(names("maternity leave for teachers"), []);
assert.deepEqual(names("gift to officers"), [], "no false match on 'gift'");

const page = (source_id: string, page_number: number, label: string) =>
  ({ source_id, page_number, label }) as unknown as RetrievalEvidence;
const retrieval = { evidence: [page("a", 1, "S1"), page("b", 2, "S2"), page("c", 3, "S3")] } as RetrievalResponse;
const [gtc] = namedSources("as per GeM GTC");
assert.equal(missingNamedSources([gtc], retrieval.evidence).length, 1);
assert.equal(missingNamedSources([gtc], [page("core-rules-gem-gtc-4-0", 19, "S1")]).length, 0);

const merged = mergeNamedPages(retrieval, [page("core-rules-gem-gtc-4-0", 19, "S1"), page("b", 2, "S9")], 3);
assert.deepEqual(
  merged.evidence.map((e) => `${e.label}:${e.source_id}:${e.page_number}`),
  ["S1:core-rules-gem-gtc-4-0:19", "S2:b:2", "S3:a:1"],
);
console.log("named source tests passed");
