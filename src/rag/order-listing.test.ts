import assert from "node:assert/strict";
import { buildListingAnswer, detectListingRequest, parseDateRange, type ListingOutcome } from "./order-listing.js";
import { findDepartmentMention } from "../departments/registry.js";

const TODAY = "2026-09-27"; // a Sunday
const list = (q: string) => detectListingRequest(q, TODAY);

// --- Which questions are order lists --------------------------------------
{
  const r = list("recent government order release in department of basic education");
  assert.equal(r?.department?.id, 50001);
  assert.equal(r?.dateFrom, undefined);
  assert.equal(r?.topic, null);

  assert.equal(list("बेसिक शिक्षा विभाग के नवीनतम शासनादेश")?.department?.id, 50001);
  assert.equal(list("latest orders of PWD")?.department?.id, 34);
  assert.equal(list("recent jail orders")?.department?.id, 15);
  assert.equal(list("latest order on solar pump subsidy")?.topic, "solar pump subsidy");

  // The department named twice is still the department, not a subject (27 Sept).
  for (const q of [
    "recent government orders released by Public Works Department or PWD",
    "recent orders of PWD (लोक निर्माण विभाग)",
    "लोक निर्माण विभाग / PWD के नवीनतम शासनादेश",
  ]) {
    const r = list(q);
    assert.equal(r?.department?.id, 34, q);
    assert.equal(r?.topic, null, q);
  }
  assert.equal(list("latest orders of कृषि विभाग / Agriculture")?.topic, null);
  {
    const r = list("Agriculture order released on 10th or 15th Sepetember");
    assert.equal(r?.department?.id, 37);
    assert.deepEqual(r?.dates, ["2026-09-10", "2026-09-15"]);
    assert.equal(r?.topic, null);
  }

  // Content questions stay with Ask.
  for (const q of [
    "what does the latest order on DA say",
    "सोलर पंप लगवाने हेतु क्या-क्या प्रक्रिया है",
    "What are the seniority rules for medical officers?",
    "may i know the leave rules",
    "latest DA rate", // no "order" word
  ]) assert.equal(list(q), null, q);
}

// --- Date ranges (IST calendar) ---------------------------------------------
{
  const range = (q: string) => {
    const r = parseDateRange(q, TODAY);
    return r ? `${r.from}..${r.to}` : null;
  };
  assert.equal(range("orders issued today"), "2026-09-27..2026-09-27");
  assert.equal(range("आज जारी शासनादेश"), "2026-09-27..2026-09-27");
  assert.equal(range("yesterday's orders"), "2026-09-26..2026-09-26");
  assert.equal(range("orders this week"), "2026-09-21..2026-09-27");
  assert.equal(range("पिछले सप्ताह के आदेश"), "2026-09-14..2026-09-20");
  assert.equal(range("this month"), "2026-09-01..2026-09-27");
  assert.equal(range("last month orders"), "2026-08-01..2026-08-31");
  assert.equal(range("last 10 days"), "2026-09-18..2026-09-27");
  assert.equal(range("21.09.2026 के शासनादेश"), "2026-09-21..2026-09-21");
  assert.equal(range("orders dated 21 Sept 2026"), "2026-09-21..2026-09-21");
  assert.equal(range("२१/०९/२०२६ के आदेश"), "2026-09-21..2026-09-21"); // Devanagari digits
  assert.equal(range("orders between 01/09/2026 and 15/09/2026"), "2026-09-01..2026-09-15");
  assert.equal(range("01.09.2026 से 10.09.2026 तक"), "2026-09-01..2026-09-10");
  assert.equal(range("since 15 September 2026"), "2026-09-15..2026-09-27");
  assert.equal(range("August 2026 orders"), "2026-08-01..2026-08-31");
  assert.equal(range("सितम्बर के शासनादेश"), "2026-09-01..2026-09-27"); // current month, to today
  assert.equal(range("december orders"), "2025-12-01..2025-12-31"); // last December
  assert.equal(range("orders of 2025"), "2025-01-01..2025-12-31");
  assert.equal(range("may i see orders"), null); // "may" alone is not a month
  assert.equal(range("recent orders"), null);

  // Days without a year, several days, misspelt months (27 Sept screenshot).
  const days = (q: string) => parseDateRange(q, TODAY)?.dates?.join(",") ?? range(q);
  assert.equal(days("Agriculture order released on 10th or 15th Sepetember"), "2026-09-10,2026-09-15");
  assert.equal(days("10 और 15 सितम्बर 2026 के आदेश"), "2026-09-10,2026-09-15");
  assert.equal(days("September 10, 15 orders"), "2026-09-10,2026-09-15");
  assert.equal(days("orders dated 10.09.2026 or 15.09.2026"), "2026-09-10,2026-09-15");
  assert.equal(range("orders of 15 sept"), "2026-09-15..2026-09-15");
  assert.equal(range("orders of 5th agust"), "2026-08-05..2026-08-05");
  assert.equal(range("orders of 30th December"), "2025-12-30..2025-12-30"); // no year: the last one that has passed
  assert.equal(range("10 marks orders"), null); // not a month
}

// --- Department names --------------------------------------------------------
{
  const mention = (q: string) => {
    const m = findDepartmentMention(q);
    return m ? `${m.department.id}/${m.strength}` : null;
  };
  assert.equal(mention("orders of basic education"), "50001/strong");
  assert.equal(mention("कारागार विभाग के आदेश"), "15/strong"); // Devanagari boundary
  assert.equal(mention("finance department circulars"), "162/strong");
  assert.equal(mention("finance rules"), "162/weak"); // not enough to scope Ask
  assert.equal(mention("solar energy subsidy"), "1/weak");
  assert.equal(mention("कृ‍षि विभाग"), "37/strong"); // zero-width joiner in the name
  assert.equal(mention("agricultural education and research orders"), "39/strong"); // longest wins
  assert.equal(mention("how do I apply for leave"), null);
}

// --- Answer text -------------------------------------------------------------
{
  const request = list("recent orders of basic education")!;
  const outcome: ListingOutcome = {
    orders: [
      { sourceId: "158#50001#1#2026", department: "बेसिक शिक्षा विभाग", goNumber: "158/2026", goDate: "2026-09-23", subject: "विद्यालय निर्माण हेतु स्वीकृति", sourceUrl: "https://x" },
      { sourceId: "6#50001#2#2026", department: "बेसिक शिक्षा विभाग", goNumber: null, goDate: "2026-09-17", subject: "क ".repeat(200), sourceUrl: "https://y" },
    ],
    total: 14,
    scope: { kind: "department", name: "Basic Education (बेसिक शिक्षा विभाग)" },
    topicDropped: false,
    widened: false,
  };
  const en = buildListingAnswer(request, outcome, "en");
  assert.match(en, /^Latest orders for \*\*Basic Education \(बेसिक शिक्षा विभाग\)\*\*, newest first \(2 of 14\):/);
  assert.match(en, /^1\. \*\*23\.09\.2026\*\* · GO 158\/2026 — विद्यालय निर्माण हेतु स्वीकृति \[S1 p\.1\]$/m);
  assert.match(en, /^2\. \*\*17\.09\.2026\*\* · number not recorded — (क )+…? ?… \[S2 p\.1\]$|^2\. .* … \[S2 p\.1\]$/m);
  const hi = buildListingAnswer({ ...request, rangeLabel: { en: "dated 21 Sept 2026", hi: "दिनांक 21.09.2026" } }, outcome, "hi");
  assert.match(hi, /दिनांक 21\.09\.2026 के शासनादेश/);
  const someEmpty = buildListingAnswer(request, { ...outcome, emptyDates: ["2026-09-10"] }, "en");
  assert.match(someEmpty, /No orders dated 10\.09\.2026 were found in the archive\./);
  const none = buildListingAnswer(request, { ...outcome, orders: [], total: 0 }, "en");
  assert.match(none, /^No orders were found for Basic Education/);
  assert.doesNotMatch(none, /\[S\d/);
}

console.log("order listing tests passed");
