import assert from "node:assert/strict";
import { buildBrowseWhere } from "./browse.js";

// No filters: no WHERE clause at all (list everything).
assert.deepEqual(buildBrowseWhere({}), { sql: "", params: [] });

// Department keys: Shasanadesh IDs and plain names are both accepted.
{
  const { sql, params } = buildBrowseWhere({ departmentKeys: ["id:37", "name:कृषि‍ विभाग", "id:x"] });
  assert.match(sql, /d\.department_id = ANY\(\$1\)/);
  assert.deepEqual(params[0], [37]); // "id:x" is ignored
  assert.deepEqual(params[2], ["कृषि विभाग"]); // zero-width joiner removed
}

// Subject words: one clause per word, LIKE wildcards escaped.
{
  const { sql, params } = buildBrowseWhere({ text: "100% solar_pump" });
  assert.equal((sql.match(/ILIKE/g) ?? []).length, 2);
  assert.ok(params.includes("%100\\%%"));
  assert.ok(params.includes("%solar\\_pump%"));
}

// Dates must be ISO; anything else is ignored rather than sent to SQL.
{
  const { sql, params } = buildBrowseWhere({ dateFrom: "2026-09-01", dateTo: "01/09/2026" });
  assert.match(sql, /go_date >= \$1::date/);
  assert.doesNotMatch(sql, /go_date <=/);
  assert.deepEqual(params, ["2026-09-01"]);
}

// Every value is a bound parameter; placeholders are numbered in order.
{
  const { sql, params } = buildBrowseWhere({
    providers: ["shasanadesh-up"],
    scopeDepartments: ["Agriculture"],
    section: "कृषि अनुभाग-5",
    category: "नीति",
    goNumber: "61/2023",
  });
  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(Math.max(...placeholders), params.length);
  assert.doesNotMatch(sql, /Agriculture|कृषि|61\/2023/);
}

console.log("browse filter tests passed");
