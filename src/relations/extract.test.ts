import assert from "node:assert/strict";
import { extractReferences, goKey, parseReferenceDate } from "./extract.js";

assert.equal(goKey("42/2026/77-1002-2-2021/001-467"), "42/2026");
assert.equal(goKey("१/२०१९/४/१"), "1/2019");
assert.equal(goKey("160/दस-2012-216/79"), "160/2012");
assert.equal(goKey("118/2026/।/1474969/2026/71-1002(002)/15/2026"), "118/2026");
assert.equal(goKey("G-2-160/दस-2012"), null);
assert.equal(parseReferenceDate("21.07.2026"), "2026-07-21");
assert.equal(parseReferenceDate("15 सितम्बर, 2023"), "2023-09-15");
assert.equal(parseReferenceDate("02 िसत बर, 2026"), "2026-09-02");
assert.equal(parseReferenceDate("31.02.2026"), null);

// Portal subject of a corrigendum (43#182#1#2026).
{
  const refs = extractReferences("शासनादेश संख्या- 42/2026/77-1002-2-2021/001-467, दिनांक 21.07.2026 का शुद्धि-पत्र।");
  assert.equal(refs.length, 1);
  assert.deepEqual([refs[0].kind, refs[0].goKey, refs[0].goDate], ["corrects", "42/2026", "2026-07-21"]);
}

// Amendment sentence.
{
  const refs = extractReferences("3- उक्त शासनादेश संख्या- 42/2026/77-1002-2-2021/001-467, दिनांक 21.07.2026 को उपर्युक्त सीमा तक संशोधित समझा जाये।");
  assert.equal(refs[0].kind, "amends");
}

// Supersession, clean and with a broken native layer; the order's own header is skipped.
{
  const clean = extractReferences("इस विषयक शासनादेश संख्या-5/2019/3(2)2007/का-1-2019, दिनांक 27.09.2019 के अतिक्रमण में यह आदेश जारी किया जाता है।");
  assert.equal(clean[0].kind, "supersedes");
  const broken = [
    "उ तर दे श शासन व त (सामा य) अनुभाग-2 सं या-7/2026/जी-2-132/दस-2026-216/79 लखनऊ : दनांक : 02 िसत बर, 2026",
    "शासनादे श सं या-G-2-160/दस-2012-216/79, दनांक 27.08.2012 के अ त मण म यह व था क जाती है",
  ].join("\n");
  const refs = extractReferences(broken, { goNumber: "7/2026/जी-2-132/दस-2026-216/79", goDate: "2026-09-02" });
  assert.equal(refs.length, 0, "G-2-160 has no leading digit, and the own header is skipped");
  const refs2 = extractReferences(broken.replace("G-2-160", "160"), { goNumber: "7/2026/जी-2-132", goDate: "2026-09-02" });
  assert.equal(refs2.length, 1);
  assert.deepEqual([refs2[0].kind, refs2[0].goKey, refs2[0].goDate], ["supersedes", "160/2012", "2012-08-27"]);
}

// A plain reference stays "refers"; duplicates collapse to the strongest relation.
{
  const refs = extractReferences(
    "शासनादेश संख्या 789/2024/70, दिनांक 04.07.2024 के क्रम में … पुनः शासनादेश संख्या 789/2024/70, दिनांक 04.07.2024 को संशोधित किया जाता है।",
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "amends");
  assert.equal(extractReferences("शासनादेश संख्या 789/2024/70, दिनांक 04.07.2024 के क्रम में सूचित करना है")[0].kind, "refers");
}

console.log("relation extraction tests passed");
