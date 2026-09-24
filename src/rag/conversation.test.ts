import assert from "node:assert/strict";

import {
  buildConversationQueryPlan,
  detectResponseLanguage,
  isLikelyFollowUp,
} from "./conversation.js";
import type {
  ChatMessage,
} from "./types.js";

assert.equal(
  isLikelyFollowUp(
    "What about officers appointed later?",
  ),
  true,
);

assert.equal(
  isLikelyFollowUp(
    "इसके बाद पदोन्नति का क्या होगा?",
  ),
  true,
);

assert.equal(
  isLikelyFollowUp(
    "pension rules",
  ),
  false,
);

{
  const messages:
    ChatMessage[] = [
      {
        role: "user",
        content:
          "What are the seniority rules for medical officers?",
      },
    ];

  const plan =
    buildConversationQueryPlan(
      messages,
      0,
    );

  assert.equal(
    plan.contextualized,
    false,
  );

  assert.equal(
    plan.retrievalQuery,
    messages[0].content,
  );
}

{
  const messages:
    ChatMessage[] = [
      {
        role: "user",
        content:
          "What are the seniority rules for medical officers?",
      },
      {
        role:
          "assistant",
        content:
          "Generated answer that must not become retrieval evidence.",
      },
      {
        role: "user",
        content:
          "What about those appointed through another recruitment batch?",
      },
    ];

  const plan =
    buildConversationQueryPlan(
      messages,
      2,
    );

  assert.equal(
    plan.contextualized,
    true,
  );

  assert.match(
    plan.retrievalQuery,
    /seniority rules for medical officers/i,
  );

  assert.match(
    plan.retrievalQuery,
    /another recruitment batch/i,
  );

  assert.doesNotMatch(
    plan.retrievalQuery,
    /Generated answer/,
  );
}

{
  const messages:
    ChatMessage[] = [
      {
        role: "user",
        content:
          "Explain 61#37#5#2023.",
      },
      {
        role: "user",
        content:
          "What about that order's implementation?",
      },
    ];

  const plan =
    buildConversationQueryPlan(
      messages,
      1,
    );

  assert.equal(
    plan.contextualized,
    true,
  );

  assert.match(
    plan.retrievalQuery,
    /61#37#5#2023/,
  );
}

{
  const messages:
    ChatMessage[] = [
      {
        role: "user",
        content:
          "medical officer seniority",
      },
      {
        role: "user",
        content:
          "pension rules",
      },
    ];

  const plan =
    buildConversationQueryPlan(
      messages,
      1,
    );

  assert.equal(
    plan.contextualized,
    false,
  );

  assert.equal(
    plan.retrievalQuery,
    "pension rules",
  );
}

console.log(
  "conversation-context tests passed",
);


assert.equal(
  detectResponseLanguage(
    "What are the seniority rules?",
  ),
  "en",
);

assert.equal(
  detectResponseLanguage(
    "इसके बाद उनकी वरिष्ठता कैसे तय होगी?",
  ),
  "hi",
);

assert.equal(
  detectResponseLanguage(
    "Rule 21 में seniority कैसे तय होगी?",
  ),
  "hi",
);
