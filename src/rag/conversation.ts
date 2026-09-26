/**
 * Conversation-aware retrieval planning.
 *
 * The planner deliberately uses prior USER questions only. Previous assistant answers
 * are generated text, not authoritative evidence, and must not become retrieval truth.
 *
 * Phase-1 behavior is deterministic:
 * - standalone questions retrieve exactly as written;
 * - likely follow-up questions are enriched with recent user-question context;
 * - exact identifiers/numbers are preserved verbatim because no model rewrites them.
 *
 * A later query-planner model can replace this heuristic behind the same interface once
 * we have a multi-turn evaluation baseline.
 */

import type {
  ChatMessage,
} from "./types.js";

export interface ConversationQueryPlan {
  currentQuery: string;
  retrievalQuery: string;
  contextualized: boolean;
  priorUserQuestions: string[];
}

// Referential words that usually point back to an earlier question. Plain
// "that" is excluded because it is mostly a conjunction ("a rule that ...");
// it only counts when it clearly refers to a document or provision.
const ENGLISH_FOLLOW_UP =
  /\b(this|these|those|it|they|them|same|previous|earlier|above|former|latter|such)\b|\bthat (?:order|orders|rule|rules|go|document|case|circular|notification|provision|one|section|clause|policy|scheme)\b/i;

const ENGLISH_FOLLOW_UP_START =
  /^(and|also|but|so|then|what about|how about|what if|and if|in that case)\b/i;

// Hindi demonstratives that refer back ("इसके", "उसी", ...) count anywhere.
const HINDI_FOLLOW_UP =
  /(^|\s)(इस|उस|इसी|उसी|इसके|उसके|इसमें|उसमें|इनके|उनके|इन्हें|उन्हें|इन|उन|यही|वही)(\s|$|[?,।])/u;

// "यह/वह" count only when they point at a document or provision.
const HINDI_FOLLOW_UP_DEMONSTRATIVE =
  /(^|\s)(यह|वह|ये|वे)\s+(आदेश|नियम|शासनादेश|मामला|मामले|प्रावधान|परिपत्र|अधिसूचना|योजना)/u;

// Conjunctions such as "और", "तो", "लेकिन" are ordinary words mid-sentence;
// they only signal a follow-up when the question starts with them.
const HINDI_FOLLOW_UP_START =
  /^(और|तो|लेकिन|पर|फिर|अगर|यदि|तब)(\s|,|$)/u;

const HINDI_FOLLOW_UP_PHRASE =
  /(क्या होगा|क्या होगा अगर|इसके बारे में|उस स्थिति|उसी मामले|वही नियम)/u;

function compact(
  text: string,
  maxChars = 500,
): string {
  const normalized =
    text
      .replace(/\s+/g, " ")
      .trim();

  if (
    normalized.length <=
    maxChars
  ) {
    return normalized;
  }

  return (
    normalized
      .slice(0, maxChars)
      .trimEnd() +
    "…"
  );
}

export function isLikelyFollowUp(
  query: string,
): boolean {
  const normalized =
    query.trim();

  if (!normalized) {
    return false;
  }

  return (
    ENGLISH_FOLLOW_UP.test(
      normalized,
    ) ||
    ENGLISH_FOLLOW_UP_START.test(
      normalized,
    ) ||
    HINDI_FOLLOW_UP.test(
      normalized,
    ) ||
    HINDI_FOLLOW_UP_DEMONSTRATIVE.test(
      normalized,
    ) ||
    HINDI_FOLLOW_UP_START.test(
      normalized,
    ) ||
    HINDI_FOLLOW_UP_PHRASE.test(
      normalized,
    )
  );
}

export function buildConversationQueryPlan(
  messages: ChatMessage[],
  lastUserIndex: number,
): ConversationQueryPlan {
  if (
    lastUserIndex < 0 ||
    lastUserIndex >=
      messages.length
  ) {
    throw new Error(
      "Invalid last user message index.",
    );
  }

  const current =
    messages[
      lastUserIndex
    ];

  if (
    current.role !== "user"
  ) {
    throw new Error(
      "lastUserIndex must point to a user message.",
    );
  }

  const currentQuery =
    current.content.trim();

  const priorUserQuestions =
    messages
      .slice(
        0,
        lastUserIndex,
      )
      .filter(
        (
          message,
        ): message is ChatMessage & {
          role: "user";
        } =>
          message.role ===
          "user",
      )
      .map((message) =>
        compact(
          message.content,
        ),
      )
      .filter(Boolean)
      .slice(-2);

  const contextualized =
    priorUserQuestions.length >
      0 &&
    isLikelyFollowUp(
      currentQuery,
    );

  if (!contextualized) {
    return {
      currentQuery,
      retrievalQuery:
        currentQuery,
      contextualized:
        false,
      priorUserQuestions,
    };
  }

  const context =
    priorUserQuestions
      .map(
        (
          question,
          index,
        ) =>
          `Previous user question ${index + 1}: ${question}`,
      )
      .join("\n");

  return {
    currentQuery,
    retrievalQuery: [
      `Current question: ${currentQuery}`,
      context,
    ].join("\n"),
    contextualized:
      true,
    priorUserQuestions,
  };
}


export type ResponseLanguage =
  | "en"
  | "hi";

export function detectResponseLanguage(
  query: string,
): ResponseLanguage {
  const devanagariCount =
    (
      query.match(
        /[\u0900-\u097F]/gu,
      ) ?? []
    ).length;

  const latinCount =
    (
      query.match(
        /[A-Za-z]/g,
      ) ?? []
    ).length;

  if (devanagariCount === 0) {
    return "en";
  }

  if (latinCount === 0) {
    return "hi";
  }

  return devanagariCount >=
    latinCount
    ? "hi"
    : "en";
}
