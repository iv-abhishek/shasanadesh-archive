import assert from "node:assert/strict";

import {
  defaultConversationTitle,
  normalizeDepartmentNames,
} from "./model.js";

{
  const result =
    normalizeDepartmentNames(
      "Medical and Health",
      [
        "AYUSH",
        "Medical and Health",
        " ayush ",
      ],
    );

  assert.equal(
    result.primaryDepartment,
    "Medical and Health",
  );

  assert.deepEqual(
    result.departments,
    [
      "Medical and Health",
      "AYUSH",
    ],
  );
}

assert.equal(
  defaultConversationTitle(
    "  Medical   officer seniority  ",
  ),
  "Medical officer seniority",
);

assert.equal(
  defaultConversationTitle(
    "",
  ),
  "New conversation",
);

console.log(
  "workspace-model tests passed",
);
