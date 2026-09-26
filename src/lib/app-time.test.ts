import assert from "node:assert/strict";
import { APP_TIME_ZONE, formatAppTimestamp } from "./app-time.js";

assert.equal(APP_TIME_ZONE, process.env.APP_TIME_ZONE?.trim() || "Asia/Kolkata");

if (APP_TIME_ZONE === "Asia/Kolkata") {
  // 20:00 UTC is 01:30 the next day in IST.
  assert.equal(formatAppTimestamp("2026-09-25T20:00:00Z"), "2026-09-26 01:30");
  assert.equal(formatAppTimestamp(new Date("2026-01-01T00:00:00Z")), "2026-01-01 05:30");
}

console.log("app-time tests passed");
