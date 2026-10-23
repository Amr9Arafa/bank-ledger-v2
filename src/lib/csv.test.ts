import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv, UTF8_BOM } from "./csv.ts";

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
});

test("csvCell neutralises formulas in text but keeps negative numbers", () => {
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1+2"), "'-1+2");
  assert.equal(csvCell(-1250.5), "-1250.5");
  assert.equal(csvCell("-1250.50"), "-1250.50");
});

test("toCsv starts with a BOM and uses CRLF rows", () => {
  assert.equal(UTF8_BOM, "﻿");
  assert.equal(UTF8_BOM.length, 1);
  assert.equal(toCsv([["a", "ب"], [1, 2]]), `${UTF8_BOM}a,ب\r\n1,2\r\n`);
});
