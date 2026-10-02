/**
 * Follow-up questions about the document the conversation is already on.
 *
 * Purpose:
 *   "क्या इस आदेश में बाद में कोई संशोधन हुआ है?" refers to the order cited in the
 *   previous answer. It must not be read as a new search for orders whose
 *   subject contains "संशोधन" (that listed ten unrelated orders, 2 Oct 2026).
 *   This module recognises such references and answers "was it changed
 *   later?" from the order links (document_relations, ADR-054) instead of
 *   asking the model to guess.
 *
 * Invariants:
 *   - only a reference to a document ("इस आदेश", "this order", "उक्त शासनादेश")
 *     counts; "इस विषय पर आदेश" is a new search
 *   - the later-changes answer states only what the archive's order links show
 *     and says so; it never claims an order is still in force
 */

import type { LaterChange } from "./later-changes.js";

const DOCUMENT_NOUN_HI = "(?:आदेश|शासनादेश|परिपत्र|अधिसूचना|नियमावली|नियम|अध्याय|दस्तावेज़?|पत्र|कार्यालय\\s+ज्ञाप)";
const REFERENCE_HI = new RegExp(
  `(?:^|\\s)(?:इस|उस|इसी|उसी|यह|वह|उक्त|उपरोक्त|उपर्युक्त|संदर्भित)\\s+${DOCUMENT_NOUN_HI}`,
  "u",
);
const REFERENCE_EN =
  /\b(?:this|that|the same|the above|above|said|aforesaid|cited)\s+(?:order|go|g\.o\.|circular|notification|rules?|chapter|document|office memorandum|om)\b|\b(?:it|its)\b.*\b(?:amend|change|supersed|cancel|revis|modif)/i;

/**
 * True when the question names a document from the conversation ("इस आदेश",
 * "the above GO"). Bare pronouns ("इसमें क्या शर्तें हैं?") are left to the
 * conversation planner: they need no special routing.
 */
export function refersToEarlierDocument(query: string): boolean {
  const text = query.replace(/[\u200c\u200d]/g, "");
  return REFERENCE_HI.test(text) || REFERENCE_EN.test(text);
}

const LATER_CHANGE_CUE =
  /\b(?:amend(?:ed|ment|ments)?|changed?|changes|supersed(?:ed|es)?|replaced|cancel(?:led|ed)?|withdrawn|rescinded|revised|modified|still (?:valid|in force|applicable)|current(?:ly)? (?:valid|applicable))\b|संशोधन|संशोधित|बदलाव|परिवर्तन|अतिक्रमित|अधिक्रमित|निरस्त|रद्द|वापस\s+लिया|अब\s+भी\s+(?:लागू|प्रभावी)|लागू\s+है|प्रभावी\s+है|शुद्धि/i;

/** True when the question asks whether a document was changed, replaced or cancelled later. */
export function asksAboutLaterChanges(query: string): boolean {
  return LATER_CHANGE_CUE.test(query.replace(/[\u200c\u200d]/g, ""));
}

export interface FollowedDocument {
  sourceId: string;
  title: string | null;
  goNumber: string | null;
  goDate: string | null;
}

export interface ChangingOrder {
  change: LaterChange;
  title: string | null;
}

function dayFirst(iso: string | null): string | null {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : null;
}

const KIND_TEXT: Record<LaterChange["kind"], { hi: string; en: string }> = {
  cancels: { hi: "निरस्त करता है", en: "cancels it" },
  supersedes: { hi: "अतिक्रमित करता है", en: "supersedes it" },
  amends: { hi: "संशोधित करता है", en: "amends it" },
  corrects: { hi: "शुद्धि करता है", en: "corrects it" },
};

/**
 * The answer to "was this changed later?": the document as S1, each changing
 * order as S2…; citations match the sources sent with it.
 */
export function buildLaterChangesAnswer(document: FollowedDocument, changes: ChangingOrder[], language: "hi" | "en"): string {
  const hi = language === "hi";
  const name =
    document.title ??
    (document.goNumber ? (hi ? `शासनादेश संख्या ${document.goNumber}` : `GO ${document.goNumber}`) : hi ? "यह दस्तावेज़" : "this document");
  const details: string[] = [];
  if (document.title && document.goNumber) details.push(hi ? `संख्या ${document.goNumber}` : `GO ${document.goNumber}`);
  const dated = dayFirst(document.goDate);
  if (dated) details.push(hi ? `दिनांक ${dated}` : `dated ${dated}`);
  const what = `${name}${details.length ? ` (${details.join(", ")})` : ""} [S1]`;

  if (!changes.length) {
    return hi
      ? `संग्रह में ${what} को बाद में संशोधित, अतिक्रमित या निरस्त करने वाला कोई आदेश नहीं मिला।\n\nयह जाँच केवल संग्रह के आदेशों के आपसी संदर्भों पर आधारित है। नवीनतम स्थिति के लिए विभाग और विषय से शासनादेश पोर्टल पर भी देख लें।`
      : `The archive has no later order that amends, supersedes or cancels ${what}.\n\nThis check covers only the references between orders in the archive. For the latest position, also search the Shasanadesh portal by department and subject.`;
  }

  const lines = changes.map((item, index) => {
    const label = `[S${index + 2}]`;
    const number = item.change.byGoNumber ? (hi ? `संख्या ${item.change.byGoNumber}` : `GO ${item.change.byGoNumber}`) : hi ? "संख्या अंकित नहीं" : "number not recorded";
    const date = dayFirst(item.change.byGoDate);
    const when = date ? (hi ? `दिनांक ${date}, ` : `dated ${date}, `) : "";
    const kind = KIND_TEXT[item.change.kind][hi ? "hi" : "en"];
    const subject = item.title ? ` — ${item.title}` : "";
    return `- ${when}${number}${subject}: ${kind} ${label}`;
  });
  return hi
    ? `${what} के बाद संग्रह में ये आदेश मिले जो इसे बदलते हैं:\n\n${lines.join("\n")}\n\nलागू प्रावधान जानने के लिए नवीनतम आदेश पढ़ें; पूछें तो मैं उसका सार बता सकता हूँ।`
    : `After ${what}, the archive has these orders that change it:\n\n${lines.join("\n")}\n\nRead the latest one for the provision now in force; ask and I can summarise it.`;
}
