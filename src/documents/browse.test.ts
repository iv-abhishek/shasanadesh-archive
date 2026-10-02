import assert from "node:assert/strict";
import { buildBrowseWhere, sectionRegex, wildcardToLike } from "./browse.js";

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

// Tiers: known values only; "none" means not classified yet.
{
  const { sql, params } = buildBrowseWhere({ tiers: ["A", "none", "X"] });
  assert.match(sql, /d\.tier = ANY\(\$1\) OR d\.tier IS NULL/);
  assert.deepEqual(params, [["A"]]);
}

console.log("browse filter tests passed");

// Finder filters (ADR-058).
{
  const { sql, params } = buildBrowseWhere({ phrases: ["फार्मर रजिस्ट्री"], patterns: ["solar*", "क?षि"], goNumberPrefix: "51 / 2026", sectionLike: "कृषि अनुभाग-5" });
  assert.ok(params.includes("%फार्मर रजिस्ट्री%"));
  assert.ok(params.includes("%solar%%"));
  assert.ok(params.includes("%क_षि%"));
  assert.ok(params.includes("51/2026%"));
  assert.match(sql, /translate\(replace\(d\.go_number, ' ', ''\), \$\d+, ''\) ILIKE/);
  assert.match(sql, /~\*/);
  assert.equal(wildcardToLike("100%_*"), "100\\%\\_%");
  // Section numbers: spacing and dash style do not matter, the number does.
  const re = new RegExp(sectionRegex("कृषि अनुभाग-5"), "i");
  assert.ok(re.test("कृषि अनुभाग-5"));
  assert.ok(re.test("कृषि अनुभाग - 5"));
  assert.ok(re.test("कृषि अनुभाग–5"));
  assert.ok(!re.test("कृषि अनुभाग-15"));
  assert.ok(!re.test("कृषि अनुभाग-51"));
  // Only listed IDs.
  assert.match(buildBrowseWhere({ sourceIds: ["a", "b"] }).sql, /d\.source_id = ANY/);
}
console.log("browse finder filter tests passed");
