// Parses the real statements in sample/ (git-ignored) when the folder exists. Asserts only
// structural facts, never real values, so nothing sensitive ends up in the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseStatementFile } from "./index.ts";

const dir = new URL("../../../sample/", import.meta.url);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mt940|sta|txt|csv)$/i.test(f)) : [];

test("real sample statements parse and balance", { skip: files.length === 0 && "no sample/ folder" }, () => {
  for (const file of files) {
    const r = parseStatementFile(readFileSync(new URL(file, dir), "utf8"));
    assert.ok(r.ok, `${file}: ${JSON.stringify(r)}`); // includes the opening + lines = closing check
    for (const s of r.statements) {
      assert.notEqual(s.bank, "unknown", file);
      for (const line of s.lines) {
        assert.ok(line.bookingDate >= s.openingDate && line.bookingDate <= s.closingDate, `${file} line ${line.lineNo}: booking date outside period`);
        if (line.kind === "cheque") assert.ok(line.chequeRef, `${file} line ${line.lineNo}: cheque without number`);
      }
      assert.equal(new Set(s.lines.map((l) => l.lineKey)).size, s.lines.length, `${file}: duplicate line keys`);
    }
  }
});
