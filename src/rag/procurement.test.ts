import assert from "node:assert/strict";
import {
  PROCUREMENT_SOURCE_IDS,
  isProcurementQuestion,
  orderByAuthority,
  procurementBooksToCheck,
  procurementRank,
} from "./procurement.js";
import type { RetrievalEvidence, RetrievalResponse } from "./types.js";

for (const q of [
  "Are the PSU exempted from EMD as per GeM GTC",
  "bidders past experience criteria as per GFR rules",
  "limited tender enquiry value limit",
  "mobilisation advance for works",
  "जेम पर ईएमडी कितनी ली जाएगी",
  "निविदादाता का पूर्व अनुभव",
  "कोटेशन से क्रय की सीमा",
  "outsourcing manpower through GeM",
  "Payment terms guideline in GFR",
]) assert.ok(isProcurementQuestion(q), q);
for (const q of ["maternity leave for teachers", "DA rate from July 2025", "transfer policy 2025", "gift to officers"])
  assert.ok(!isProcurementQuestion(q), q);

assert.ok(PROCUREMENT_SOURCE_IDS.length <= 16, "fits the retrieval service source filter");
assert.equal(procurementRank("core-rules-up-gem-go-2025-03-11"), 1);
assert.equal(procurementRank("core-rules-up-procurement-manual-goods-2016"), 5);
assert.equal(procurementRank("12#3#2024"), 9);
assert.deepEqual(procurementBooksToCheck("tender turnover").map((b) => b.name), ["UP GeM orders"]);
assert.deepEqual(procurementBooksToCheck("EMD on GeM").map((b) => b.name), ["UP GeM orders", "GeM GTC"]);

const page = (source_id: string, page_number: number, role: "direct" | "neighbor" = "direct") =>
  ({ source_id, page_number, retrieval_role: role, label: "x" }) as unknown as RetrievalEvidence;
const ordered = orderByAuthority({
  evidence: [
    page("core-rules-manual-works-2025", 98),
    page("core-rules-up-procurement-manual-goods-2016", 107),
    page("core-rules-manual-works-2025", 99, "neighbor"),
    page("core-rules-gem-gtc-4-0", 19),
    page("core-rules-up-gem-go-2024-11-26", 14),
    page("core-rules-gfr-2017", 43),
  ],
} as RetrievalResponse);
assert.deepEqual(
  ordered.evidence.map((e) => `${e.label} ${e.source_id} ${e.page_number}`),
  [
    "S1 core-rules-up-gem-go-2024-11-26 14",
    "S2 core-rules-gem-gtc-4-0 19",
    "S3 core-rules-gfr-2017 43",
    "S4 core-rules-manual-works-2025 98",
    "S5 core-rules-manual-works-2025 99",
    "S6 core-rules-up-procurement-manual-goods-2016 107",
  ],
);
console.log("procurement tests passed");
