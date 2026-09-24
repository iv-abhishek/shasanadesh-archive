/**
 * Deterministic chat routing before retrieval.
 *
 * Very short social messages should not invoke retrieval or the generator.
 * Scope helpers preserve the precedence:
 *   explicit source/department -> active conversation -> user working scope -> global
 */

export type ConversationalKind =
  | "greeting"
  | "thanks"
  | "acknowledgement"
  | "farewell";

export interface ConversationIntent {
  intent:
    | "conversational"
    | "document_question";
  kind?:
    ConversationalKind;
}

function socialText(
  query: string,
): string {
  return query
    .trim()
    .toLocaleLowerCase("en")
    .replace(
      /\s*[:;][-^']?[)DdpP]+\s*$/gu,
      "",
    )
    .replace(
      /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]+$/gu,
      "",
    )
    .replace(
      /[!,.?\u0964\u2026]+$/gu,
      "",
    )
    .trim();
}

export function classifyConversationIntent(
  query: string,
): ConversationIntent {
  const text =
    socialText(query);

  if (
    !text ||
    text.length > 80
  ) {
    return {
      intent:
        "document_question",
    };
  }

  const greeting =
    /^(hi|hii+|hello|hey|hey there|hello there|hi there|good morning|good afternoon|good evening|namaste|namaskar|\u0928\u092e\u0938\u094d\u0924\u0947|\u0928\u092e\u0938\u094d\u0915\u093e\u0930|\u0938\u0941\u092a\u094d\u0930\u092d\u093e\u0924)$/iu;

  const thanks =
    /^(thanks|thank you|thankyou|thx|thanks a lot|many thanks|\u0927\u0928\u094d\u092f\u0935\u093e\u0926|\u0936\u0941\u0915\u094d\u0930\u093f\u092f\u093e|\u092c\u0939\u0941\u0924 \u0927\u0928\u094d\u092f\u0935\u093e\u0926|dhanyavaad|dhanyavad|shukriya)$/iu;

  const acknowledgement =
    /^(ok|okay|okey|sure|got it|understood|cool|great|fine|alright|all right|sounds good|\u0920\u0940\u0915 \u0939\u0948|\u0920\u0940\u0915|\u0905\u091a\u094d\u091b\u093e|\u0938\u092e\u091d \u0917\u092f\u093e|\u0938\u092e\u091d \u0917\u092f\u0940|\u0938\u092e\u091d \u0917\u0908|\u0913\u0915\u0947)$/iu;

  const farewell =
    /^(bye|goodbye|good bye|good night|see you|see you later|\u092b\u093f\u0930 \u092e\u093f\u0932\u0947\u0902\u0917\u0947|\u0905\u0932\u0935\u093f\u0926\u093e|\u0936\u0941\u092d \u0930\u093e\u0924\u094d\u0930\u093f)$/iu;

  if (greeting.test(text)) {
    return {
      intent:
        "conversational",
      kind:
        "greeting",
    };
  }

  if (thanks.test(text)) {
    return {
      intent:
        "conversational",
      kind:
        "thanks",
    };
  }

  if (
    acknowledgement.test(
      text,
    )
  ) {
    return {
      intent:
        "conversational",
      kind:
        "acknowledgement",
    };
  }

  if (farewell.test(text)) {
    return {
      intent:
        "conversational",
      kind:
        "farewell",
    };
  }

  return {
    intent:
      "document_question",
  };
}

export function buildConversationalReply(
  kind:
    ConversationalKind,
  language:
    "en" | "hi",
): string {
  if (language === "hi") {
    switch (kind) {
      case "greeting":
        return "\u0928\u092e\u0938\u094d\u0924\u0947! \u0906\u092a \u0915\u093f\u0938\u0940 \u0936\u093e\u0938\u0928\u093e\u0926\u0947\u0936, \u0928\u093f\u092f\u092e, \u0935\u093f\u092d\u093e\u0917 \u092f\u093e \u092a\u094d\u0930\u0936\u093e\u0938\u0928\u093f\u0915 \u092a\u094d\u0930\u093e\u0935\u0927\u093e\u0928 \u0915\u0947 \u092c\u093e\u0930\u0947 \u092e\u0947\u0902 \u092a\u0942\u091b \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964";
      case "thanks":
        return "\u0906\u092a\u0915\u093e \u0938\u094d\u0935\u093e\u0917\u0924 \u0939\u0948\u0964";
      case "acknowledgement":
        return "\u0920\u0940\u0915 \u0939\u0948\u0964";
      case "farewell":
        return "\u092b\u093f\u0930 \u092e\u093f\u0932\u0947\u0902\u0917\u0947\u0964";
    }
  }

  switch (kind) {
    case "greeting":
      return "Hi! Ask me about a Uttar Pradesh government order, rule, department, or administrative provision.";
    case "thanks":
      return "You're welcome.";
    case "acknowledgement":
      return "Sure.";
    case "farewell":
      return "See you.";
  }
}

export function extractExplicitSourceId(
  query: string,
): string | null {
  const match =
    query.match(
      /(?:^|\s)(\d+#\d+#\d+#\d{4})(?=\s|$|[.,;:!?\u0964])/u,
    );

  return match?.[1] ??
    null;
}

export function findExplicitDepartment(
  query: string,
  knownDepartments:
    string[],
): string | null {
  const haystack =
    query
      .toLocaleLowerCase(
        "en",
      )
      .replace(
        /\s+/g,
        " ",
      );

  const matches =
    knownDepartments
      .filter(
        (department) =>
          haystack.includes(
            department
              .toLocaleLowerCase(
                "en",
              )
              .replace(
                /\s+/g,
                " ",
              ),
          ),
      )
      .sort(
        (
          left,
          right,
        ) =>
          right.length -
          left.length,
      );

  return matches[0] ??
    null;
}

export function requestsGlobalScope(
  query: string,
): boolean {
  return (
    /\b(all departments|across departments|all government departments|global search|statewide)\b/iu.test(
      query,
    ) ||
    /(\u0938\u092d\u0940 \u0935\u093f\u092d\u093e\u0917|\u0938\u093e\u0930\u0947 \u0935\u093f\u092d\u093e\u0917|\u0938\u092e\u0938\u094d\u0924 \u0935\u093f\u092d\u093e\u0917|\u0938\u092d\u0940 \u0938\u0930\u0915\u093e\u0930\u0940 \u0935\u093f\u092d\u093e\u0917)/u.test(
      query,
    )
  );
}
