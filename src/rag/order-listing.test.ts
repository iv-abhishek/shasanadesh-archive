import assert from "node:assert/strict";
import { asksWhatOrderSays, buildListingAnswer, detectListingRequest, jurisdictionsInQuery, parseDateRange, type ListingOutcome } from "./order-listing.js";
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

// --- Finding orders (ADR-058) ------------------------------------------------
{
  const find = (q: string) => detectListingRequest(q, TODAY);

  const byNumber = find("find GO 51/2026/918");
  assert.equal(byNumber?.mode, "find");
  assert.equal(byNumber?.goNumber, "51/2026/918");
  assert.deepEqual(byNumber?.words, []);
  assert.equal(find("शासनादेश संख्या 158 / 2026")?.goNumber, "158/2026");
  assert.equal(find("orders on 21/09/2026")?.goNumber, undefined); // a date, not a number

  const quoted = find('find "फार्मर रजिस्ट्री"');
  assert.deepEqual(quoted?.phrases, ["फार्मर रजिस्ट्री"]);
  assert.equal(quoted?.explicit, true);

  const wild = find("solar* orders of agriculture");
  assert.deepEqual(wild?.patterns, ["solar*"]);
  assert.equal(wild?.semanticText, "solar"); // English stem, matched by meaning against Hindi subjects
  assert.equal(wild?.department?.id, 37);
  assert.deepEqual(find("orders with *पंप*")?.patterns, ["*पंप*"]);
  assert.deepEqual(find("recent orders of PWD?")?.patterns, []); // a closing "?" is punctuation

  const bySection = find("orders released by कृषि अनुभाग-5");
  assert.equal(bySection?.department?.id, 37);
  assert.equal(bySection?.section, "कृषि अनुभाग-5");
  const hindiSection = find("लोक निर्माण अनुभाग-1 द्वारा जारी शासनादेश");
  assert.equal(hindiSection?.department?.id, 34);
  assert.equal(hindiSection?.section, "लोक निर्माण अनुभाग-1");
  const thisWeek = find("orders released by लोक निर्माण अनुभाग-1 this week");
  assert.equal(thisWeek?.section, "लोक निर्माण अनुभाग 1");
  assert.equal(thisWeek?.dateFrom, "2026-09-21");
  assert.equal(thisWeek?.explicit, true);
  const englishSection = find("orders issued by Public Works section 1 in September");
  assert.equal(englishSection?.section, "अनुभाग-1");
  assert.equal(englishSection?.dateFrom, "2026-09-01");

  assert.deepEqual(find("orders about farmer registry")?.words, ["farmer", "registry"]);
  assert.deepEqual(find("किसान सम्मान निधि से संबंधित शासनादेश")?.words, ["किसान", "सम्मान", "निधि"]);
  assert.equal(find("search metro rail order")?.explicit, true);

  // A one-word department name next to other words is a subject word.
  const home = find("is there any order on work from home?");
  assert.equal(home?.department, null);
  assert.deepEqual(home?.words, ["work", "home"]);
  assert.equal(find("recent orders of finance")?.department?.id, 162); // alone, it is the department

  // Questions about content still go to Ask.
  assert.equal(find("What is the DA rate in the latest order?"), null);
  assert.equal(find("what are the recent orders of PWD")?.mode, "recent");
}

// Answer text for a search: word matches numbered, meaning matches as a separate group.
{
  const request = detectListingRequest("orders about farmer registry", TODAY)!;
  const order = (id: string, match: "words" | "similar") => ({
    sourceId: id, department: "कृषि विभाग", goNumber: `${id}/2026`, goDate: "2026-09-21", subject: "फार्मर रजिस्ट्री हेतु विशेष अभियान", sourceUrl: "https://x", match,
  });
  const both = buildListingAnswer(request, { orders: [order("1", "words"), order("2", "similar")], total: 1, scope: { kind: "all" }, topicDropped: false, widened: false }, "en");
  assert.match(both, /^Orders matching “farmer registry” — all departments \(newest first; 1 of 1\):/);
  assert.match(both, /^1\. \*\*21\.09\.2026\*\* · GO 1\/2026 · कृषि विभाग — .* \[S1 p\.1\]$/m);
  assert.match(both, /Also close in meaning \(subject does not contain the words\):/);
  assert.match(both, /^- \*\*21\.09\.2026\*\* · GO 2\/2026 .* \[S2 p\.1\]$/m);
  const onlySimilar = buildListingAnswer(request, { orders: [order("2", "similar")], total: 0, scope: { kind: "all" }, topicDropped: false, widened: false }, "en");
  assert.match(onlySimilar, /^No order contains “farmer registry” word for word\. Orders whose subject is closest in meaning/);
  const nothing = buildListingAnswer(request, { orders: [], total: 0, scope: { kind: "all" }, topicDropped: false, widened: false, similarUnavailable: true }, "en");
  assert.match(nothing, /^No order matching “farmer registry” was found in the archive/);
}

console.log("order finder tests passed");

// Jurisdiction and topic filters (ADR-064).
{
  const find = (q: string) => detectListingRequest(q, "2026-09-27");
  assert.deepEqual([find("GeM guidelines")?.topics, find("GeM guidelines")?.words], [["gem"], []]);
  assert.deepEqual(find("central government procurement rules")?.jurisdictions, ["IN"]);
  assert.deepEqual(find("UP GeM orders")?.jurisdictions, ["UP"]);
  assert.deepEqual(find("पेंशन से संबंधित शासनादेश")?.topics, ["pension"]);
  assert.deepEqual(find("सूचना का अधिकार नियम")?.topics, ["rti"]);
  // केन्द्रीय कारागार is a central jail, not the central government.
  assert.deepEqual(find("केन्द्रीय कारागार में बन्दी की समयपूर्व रिहाई के आदेश")?.jurisdictions, []);
  assert.equal(find("What are the GeM guidelines for direct purchase?"), null); // content → Ask
  assert.deepEqual(jurisdictionsInQuery("rules of the up government and भारत सरकार").codes.sort(), ["IN", "UP"]);
  assert.deepEqual(jurisdictionsInQuery("look up the order").codes, []); // "up" in lowercase is a word
}
console.log("jurisdiction/topic filter tests passed");

// --- Questions that are not order searches; GO-number content questions ----
{
  // A "?" typed after a question is punctuation, not a wildcard (2 Oct 2026).
  assert.equal(list('राजपत्रित अधिकारी के अधिकृत होने के लिए कौन सा प्रमाणपत्र आवश्यक है?",?'), null);
  assert.deepEqual(list("क?षि विभाग के आदेश")?.patterns, ["क?षि"]);
  // A GO number with a content question: found by number, words not used as subject.
  const byNumber = list("शासनादेश संख्या 3/2024/बी-4-590/दस-2024-10(4)/2006 दिनांक 30.09.2024 में क्या निर्देश है?");
  assert.equal(byNumber?.goNumber, "3/2024/बी-4-590/दस-2024-10(4)/2006");
  assert.equal(byNumber?.dateFrom, "2024-09-30");
  assert.ok(!byNumber?.words.includes("दिनांक"));
  assert.equal(asksWhatOrderSays("शासनादेश संख्या 3/2024/बी-4 दिनांक 30.09.2024 में क्या निर्देश है?"), true);
  assert.equal(asksWhatOrderSays("What does GO 12/2025/KA-2 say?"), true);
  assert.equal(asksWhatOrderSays("शासनादेश संख्या 12/2025 दिखाइए"), false);
  console.log("GO-number and punctuation routing tests passed");
}

// 2 Oct 2026 conversation (ADR-074).
{
  const list = (query: string) => detectListingRequest(query, "2026-10-02");
  // A person as issuer: not a search word, not a section.
  const person = list("there is another order release by ravi ranjan");
  assert.equal(person?.personIssuer, "ravi ranjan");
  assert.deepEqual(person?.words, []);
  assert.equal(person?.section, undefined);
  assert.match(buildListingAnswer(person!, { orders: [], total: 0, scope: { kind: "all" }, topicDropped: false, widened: false }, "en"), /does not record which officer/);
  // "उत्तर प्रदेश शासन द्वारा जारी": the government, and the subject stays.
  const government = list("सोलर पंप के लिए उत्तर प्रदेश शासन द्वारा जारी किए गए शासनादेश");
  assert.equal(government?.section, undefined);
  assert.deepEqual(government?.words, ["सोलर", "पंप"]);
  // English words also mean their Hindi spellings for meaning search.
  assert.match(list("Solar pump up GO")?.semanticText ?? "", /सोलर/);
  // Department + date alone lists that day's orders.
  const day = list("Agriculture, 15.09.2023");
  assert.equal(day?.department?.en, "Agriculture");
  assert.equal(day?.dateFrom, "2023-09-15");
  // English department name in a section → the Hindi section name.
  assert.equal(list("Agriculture अनुभाग 5 शासनादेश,")?.section, "कृषि अनुभाग 5");
  // A starred phrase with a space is one pattern.
  assert.deepEqual(list("*Solar पम्प*")?.patterns, ["*solar पम्प*"]);
  console.log("2 Oct conversation finder tests passed");
}
