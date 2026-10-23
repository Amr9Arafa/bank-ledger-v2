import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInCairo } from "./dates.ts";

test("todayInCairo uses Cairo time, not the server's UTC date", () => {
  // 23:30 UTC on Oct 14 is already Oct 15 in Cairo (UTC+3 in summer time).
  assert.equal(todayInCairo(new Date("2026-10-14T23:30:00Z")), "2026-10-15");
  assert.equal(todayInCairo(new Date("2026-10-14T12:00:00Z")), "2026-10-14");
});

test("formatDay puts the day first and never shifts the date", async () => {
  const { formatDay } = await import("./dates.ts");
  assert.equal(formatDay("2026-10-05", "en"), "05/10/2026");
  assert.equal(formatDay("2026-01-01", "en"), "01/01/2026");
  assert.match(formatDay("2026-10-05", "ar"), /٠٥.*١٠.*٢٠٢٦/);
});

test("formatLongDay names the weekday and month", async () => {
  const { formatLongDay } = await import("./dates.ts");
  assert.equal(formatLongDay("2026-10-24", "en"), "Saturday, 24 October 2026");
  assert.match(formatLongDay("2026-10-24", "ar"), /السبت/);
});
