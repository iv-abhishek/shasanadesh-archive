import assert from "node:assert/strict";

import {
  buildConversationalReply,
  classifyConversationIntent,
  extractExplicitSourceId,
  findExplicitDepartment,
  requestsGlobalScope,
} from "./intent-routing.js";

for (
  const text of [
    "hi",
    "hi :D",
    "Hello!",
    "namaste",
    "\u0928\u092e\u0938\u094d\u0924\u0947",
  ]
) {
  assert.equal(
    classifyConversationIntent(
      text,
    ).intent,
    "conversational",
  );
}

for (
  const text of [
    "thanks",
    "thank you!",
    "\u0927\u0928\u094d\u092f\u0935\u093e\u0926",
    "\u0936\u0941\u0915\u094d\u0930\u093f\u092f\u093e",
    "okay",
    "\u0920\u0940\u0915 \u0939\u0948",
    "got it",
  ]
) {
  assert.equal(
    classifyConversationIntent(
      text,
    ).intent,
    "conversational",
  );
}

for (
  const text of [
    "hi, explain the seniority rules",
    "thanks, but what about another recruitment batch?",
    "what are the pension rules?",
    "\u0920\u0940\u0915 \u0939\u0948, \u0905\u092c \u092a\u0947\u0902\u0936\u0928 \u0928\u093f\u092f\u092e \u092c\u0924\u093e\u0907\u090f",
  ]
) {
  assert.equal(
    classifyConversationIntent(
      text,
    ).intent,
    "document_question",
  );
}

assert.equal(
  extractExplicitSourceId(
    "Explain 61#37#5#2023.",
  ),
  "61#37#5#2023",
);

assert.equal(
  findExplicitDepartment(
    "Compare this with the Finance order.",
    [
      "Medical and Health",
      "Finance",
      "Personnel",
    ],
  ),
  "Finance",
);

assert.equal(
  requestsGlobalScope(
    "Search across departments for this rule",
  ),
  true,
);

assert.equal(
  requestsGlobalScope(
    "\u0938\u092d\u0940 \u0935\u093f\u092d\u093e\u0917 \u092e\u0947\u0902 \u092f\u0939 \u0928\u093f\u092f\u092e \u0916\u094b\u091c\u0947\u0902",
  ),
  true,
);

assert.match(
  buildConversationalReply(
    "greeting",
    "hi",
  ),
  /\u0928\u092e\u0938\u094d\u0924\u0947/u,
);

console.log(
  "intent-routing tests passed",
);
