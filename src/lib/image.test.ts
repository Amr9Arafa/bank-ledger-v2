import { test } from "node:test";
import assert from "node:assert/strict";
import { fitWithin, formatBytes } from "./image.ts";

test("fitWithin shrinks the longer side to the limit and keeps the shape", () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(1600, 900), { width: 1600, height: 900 });
});

test("fitWithin never enlarges a small photo", () => {
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
});

test("formatBytes", () => {
  assert.equal(formatBytes(3_400_000), "3.2 MB");
  assert.equal(formatBytes(240_000), "234 KB");
  assert.equal(formatBytes(10), "1 KB");
});
