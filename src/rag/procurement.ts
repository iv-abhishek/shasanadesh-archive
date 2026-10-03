/**
 * Procurement questions are answered from the procurement rule books, in the
 * order of authority an Uttar Pradesh buyer follows (ADR-093):
 *
 *   1. UP GeM orders (consolidated GO 26.11.2024 and its amendments)
 *   2. GeM General Terms and Conditions (GTC)
 *   3. General Financial Rules 2017 (and amendments)
 *   4. Ministry of Finance procurement manuals (goods, services, works)
 *   5. UP Procurement Manual (Goods) 2016
 *
 * The search runs inside these books only; the pages found are put in this
 * order and the prompt tells the model to lead with the highest book that
 * answers and add what the others add or change.
 */
import type { RetrievalEvidence, RetrievalResponse } from "./types.js";
import type { NamedSource } from "./named-sources.js";

export const PROCUREMENT_RULEBOOKS_ENABLED = process.env.RAG_PROCUREMENT_RULEBOOKS !== "0";

export interface ProcurementTier {
  rank: number;
  name: string;
  sourceIds: string[];
}

export const PROCUREMENT_TIERS: ProcurementTier[] = [
  {
    rank: 1,
    name: "UP GeM orders",
    sourceIds: [
      "core-rules-up-gem-go-2024-11-26",
      "core-rules-up-gem-go-2025-03-11",
      "core-rules-up-gem-go-2025-07-21",
      "core-rules-up-mse-startup-performance-security-relaxation-2021",
    ],
  },
  { rank: 2, name: "GeM GTC", sourceIds: ["core-rules-gem-gtc-4-0"] },
  { rank: 3, name: "GFR 2017", sourceIds: ["core-rules-gfr-2017", "core-rules-gfr-rule-151-amendment-2026"] },
  {
    rank: 4,
    name: "Procurement manuals",
    sourceIds: [
      "core-rules-manual-goods-2024",
      "core-rules-manual-non-consultancy-2025",
      "core-rules-manual-consultancy-2025",
      "core-rules-manual-works-2025",
    ],
  },
  { rank: 5, name: "UP Procurement Manual 2016", sourceIds: ["core-rules-up-procurement-manual-goods-2016"] },
];

export const PROCUREMENT_SOURCE_IDS = PROCUREMENT_TIERS.flatMap((tier) => tier.sourceIds);

const RANK = new Map(PROCUREMENT_TIERS.flatMap((tier) => tier.sourceIds.map((id) => [id, tier.rank] as const)));

/** 1 (UP GeM orders) … 5 (UP manual 2016); 9 for anything else. */
export function procurementRank(sourceId: string): number {
  return RANK.get(sourceId) ?? 9;
}

const PROCUREMENT_WORDS = new RegExp(
  [
    String.raw`\b(e[\s-]?)?tender(s|ing|er|ers)?\b`,
    String.raw`\bbid(s|der|ders|ding)?\b`,
    String.raw`\bprocur(e|ed|ing|ement)\b`,
    String.raw`\bpurchas(e|es|ed|ing)\b`,
    String.raw`\bgem\b`,
    String.raw`\be[\s-]?marketplace\b`,
    String.raw`\bemd\b`,
    String.raw`\bearnest money\b`,
    String.raw`\b(bid|performance) security\b`,
    String.raw`\be?pbg\b`,
    String.raw`\bl[\s-]?1\b`,
    String.raw`\breverse auction\b`,
    String.raw`\bforward auction\b`,
    String.raw`\bquotation(s)?\b`,
    String.raw`\brate contract\b`,
    String.raw`\b(supplier|vendor|seller)s?\b`,
    String.raw`\bempanel(ment|led)?\b`,
    String.raw`\bproprietary\b`,
    String.raw`\bmobili[sz]ation advance\b`,
    String.raw`\bgtc\b`,
    String.raw`\boutsourc(e|ing)\b`,
    "निविदा",
    "टेंडर",
    "बिड",
    "बोलीदाता",
    "क्रय",
    "खरीद",
    "जेम",
    "आपूर्ति",
    "ठेकेदार",
    "कोटेशन",
    "ईएमडी",
    "ई0एम0डी0",
    "अर्नेस्ट मनी",
    "परफॉ[रर्]मेंस सिक्योरिटी",
    "आउटसोर्सिंग",
  ].join("|"),
  "iu",
);

export function isProcurementQuestion(question: string): boolean {
  return PROCUREMENT_WORDS.test(question.normalize("NFC"));
}

/**
 * Books to search on their own when the main search found none of their
 * pages: the UP GeM orders always (short, and their scanned Hindi text ranks
 * poorly against the long manuals), GeM GTC when the question is about GeM.
 */
export function procurementBooksToCheck(question: string): NamedSource[] {
  const books: NamedSource[] = [{ name: "UP GeM orders", sourceIds: PROCUREMENT_TIERS[0].sourceIds }];
  if (/\bgem\b|जेम|e[\s-]?marketplace/iu.test(question)) {
    books.push({ name: "GeM GTC", sourceIds: PROCUREMENT_TIERS[1].sourceIds });
  }
  return books;
}

/**
 * Pages grouped by document (a neighbour stays with its page), documents in
 * order of authority, ties kept in search order; labels renumbered S1..Sn.
 */
export function orderByAuthority(retrieval: RetrievalResponse): RetrievalResponse {
  const firstSeen = new Map<string, number>();
  retrieval.evidence.forEach((item, index) => {
    if (!firstSeen.has(item.source_id)) firstSeen.set(item.source_id, index);
  });
  const evidence = retrieval.evidence
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        procurementRank(a.item.source_id) - procurementRank(b.item.source_id) ||
        firstSeen.get(a.item.source_id)! - firstSeen.get(b.item.source_id)! ||
        a.index - b.index,
    )
    .map(({ item }, index): RetrievalEvidence => ({ ...item, label: `S${index + 1}` }));
  return { ...retrieval, evidence };
}

export const PROCUREMENT_PROMPT = [
  "PROCUREMENT ORDER OF AUTHORITY (Uttar Pradesh buyer), highest first:",
  "1. UP GeM orders (consolidated GO dated 26.11.2024 and later amending GOs)",
  "2. GeM General Terms and Conditions (GTC)",
  "3. General Financial Rules (GFR) 2017 and its amendments",
  "4. Ministry of Finance Manuals for Procurement of Goods, Non-Consultancy/Consultancy Services and Works",
  "5. UP Procurement Manual (Procurement of Goods) 2016",
  "Lead with the highest book among the pages that answers the point and cite it. Then add, citing each, what the other books on the pages add, and say clearly where one differs from another. For purchases on GeM the UP GeM orders and the GTC prevail over the manuals and the UP Procurement Manual 2016. Do not leave out a book whose page answers the question.",
].join("\n");
