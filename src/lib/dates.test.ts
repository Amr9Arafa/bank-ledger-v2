import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInCairo } from "./dates.ts";

test("todayInCairo uses Cairo time, not the server's UTC date", () => {
  // 23:30 UTC on Oct 14 is already Oct 15 in Cairo (UTC+3 in summer time).
  assert.equal(todayInCairo(new Date("2026-10-14T23:30:00Z")), "2026-10-15");
  assert.equal(todayInCairo(new Date("2026-10-14T12:00:00Z")), "2026-10-14");
});
