import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, nextChequeNumber } from "./cheques.ts";

test("nextChequeNumber keeps leading zeros and handles no history", () => {
  assert.equal(nextChequeNumber("000123"), "000124");
  assert.equal(nextChequeNumber("000999"), "001000");
  assert.equal(nextChequeNumber("999"), "1000");
  assert.equal(nextChequeNumber("12345678901234567890"), "12345678901234567891");
  assert.equal(nextChequeNumber(null), "");
  assert.equal(nextChequeNumber("A-12"), "");
});

test("addDays crosses month and year ends", () => {
  assert.equal(addDays("2026-10-28", 7), "2026-11-04");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});

test("daysBetween counts calendar days, negative for the past", async () => {
  const { daysBetween } = await import("./cheques.ts");
  assert.equal(daysBetween("2026-10-24", "2026-10-25"), 1);
  assert.equal(daysBetween("2026-10-24", "2026-11-15"), 22);
  assert.equal(daysBetween("2026-10-24", "2026-10-24"), 0);
  assert.equal(daysBetween("2026-10-24", "2026-10-20"), -4);
  assert.equal(daysBetween("2026-10-24", "2026-10-31"), 7); // across Egypt's DST change
});
