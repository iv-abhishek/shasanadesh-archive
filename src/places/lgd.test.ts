/** LGD place resolution against datasets/lgd/lgd-states-districts.json. */

import assert from "node:assert/strict";
import { loadLgdStates, profilePlace, resolveDistrict, resolveState } from "./lgd.js";

const states = loadLgdStates();
assert.ok(states.length >= 30, "states loaded");
const up = resolveState("uttar  pradesh");
assert.equal(up?.code, 9);
assert.equal(up?.districts.length, 75);
assert.ok(up?.districts.every((district) => district.hi), "every UP district has a Hindi name");
assert.equal(resolveState("Jammu and Kashmir")?.name, "Jammu and Kashmir");

// Former names, Hindi names and spellings resolve to the LGD district.
assert.equal(resolveDistrict(up, "Allahabad")?.name, "Prayagraj");
assert.equal(resolveDistrict(up, "इलाहाबाद")?.code, 120);
assert.equal(resolveDistrict(up, "Faizabad")?.name, "Ayodhya");
assert.equal(resolveDistrict(up, "लखनऊ")?.name, "Lucknow");
assert.equal(resolveDistrict(up, "Barabanki")?.name, "Bara Banki");
assert.equal(resolveDistrict(up, "Lakhimpur Kheri")?.name, "Kheri");
assert.equal(resolveDistrict(up, "Noida")?.name, "Gautam Buddha Nagar");
assert.equal(resolveDistrict(up, "Dehradun"), undefined);

// Stored profile place: LGD names + codes, or the text as entered.
assert.deepEqual(profilePlace("Uttar Pradesh", "Allahabad"), {
  stateName: "Uttar Pradesh",
  stateCode: 9,
  district: "Prayagraj",
  districtCode: 120,
});
assert.deepEqual(profilePlace("Central Government / Other", ""), {
  stateName: "Central Government / Other",
  stateCode: null,
  district: null,
  districtCode: null,
});
assert.equal(profilePlace("Uttar Pradesh", "Somewhere").districtCode, null);

console.log("LGD place tests passed");
