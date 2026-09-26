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

// No department at all is valid.
{
  const result = normalizeDepartmentNames(null, []);
  assert.equal(result.primaryDepartment, null);
  assert.deepEqual(result.departments, []);
  assert.deepEqual(result.additionalCharge, []);
}

// Only additional charges, no substantive department.
{
  const result = normalizeDepartmentNames(
    "",
    ["Finance", "Personnel"],
    ["personnel"],
  );
  assert.equal(result.primaryDepartment, null);
  assert.deepEqual(result.departments, ["Finance", "Personnel"]);
  assert.deepEqual(result.additionalCharge, ["Personnel"]);
}

// The substantive posting is never flagged as additional charge, and flags
// for unassigned departments are ignored.
{
  const result = normalizeDepartmentNames(
    "Medical and Health",
    ["AYUSH"],
    ["Medical and Health", "AYUSH", "Finance"],
  );
  assert.deepEqual(result.additionalCharge, ["AYUSH"]);
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
