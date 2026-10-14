import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEGP, normalizeDigits, toMinor } from "./money.ts";

const minor = (input: string) => {
  const r = toMinor(input);
  assert.ok(r.ok, `expected ${JSON.stringify(input)} to parse, got ${JSON.stringify(r)}`);
  return r.minor;
};
const error = (input: string) => {
  const r = toMinor(input);
  assert.ok(!r.ok, `expected ${JSON.stringify(input)} to fail, got ${JSON.stringify(r)}`);
  return r.error;
};

test("toMinor parses whole and decimal amounts", () => {
  assert.equal(minor("1250"), 125000);
  assert.equal(minor("1250.5"), 125050);
  assert.equal(minor("1250.50"), 125050);
  assert.equal(minor("0.01"), 1);
  assert.equal(minor("0.1"), 10);
  assert.equal(minor("007"), 700);
});

test("toMinor has no floating point drift", () => {
  assert.equal(minor("0.29"), 29); // 0.29 * 100 = 28.999999999999996 as a float
  assert.equal(minor("1.15"), 115);
  assert.equal(minor("19.99"), 1999);
});

test("toMinor accepts thousands separators and spaces", () => {
  assert.equal(minor("1,250.50"), 125050);
  assert.equal(minor(" 1 250 000 "), 125000000);
});

test("toMinor accepts Arabic-Indic digits and separators", () => {
  assert.equal(minor("١٢٥٠٫٥"), 125050);
  assert.equal(minor("١٬٢٥٠٫٥٠"), 125050);
  assert.equal(minor("۱۲۵۰"), 125000);
});

test("toMinor rejects bad input", () => {
  assert.equal(error(""), "empty");
  assert.equal(error("   "), "empty");
  assert.equal(error("abc"), "invalid");
  assert.equal(error("12a"), "invalid");
  assert.equal(error("-5"), "invalid");
  assert.equal(error("1.2.3"), "invalid");
  assert.equal(error(".5"), "invalid");
  assert.equal(error("5."), "invalid");
  assert.equal(error("1e5"), "invalid");
  assert.equal(error("1.234"), "tooManyDecimals");
  assert.equal(error("0"), "notPositive");
  assert.equal(error("0.00"), "notPositive");
  assert.equal(error("99999999999999999"), "tooLarge");
});

test("normalizeDigits converts only digits and separators", () => {
  assert.equal(normalizeDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
  assert.equal(normalizeDigits("CIB-١٢"), "CIB-12");
});

// Intl puts a non-breaking space (U+00A0) after the currency code.
test("formatEGP formats English", () => {
  assert.equal(formatEGP(125050, "en"), "EGP 1,250.50");
  assert.equal(formatEGP(0, "en"), "EGP 0.00");
  assert.equal(formatEGP(5, "en"), "EGP 0.05");
  assert.equal(formatEGP(-125050, "en"), "-EGP 1,250.50");
  assert.equal(formatEGP(123456705, "en"), "EGP 1,234,567.05");
});

test("formatEGP formats Arabic with Arabic-Indic digits", () => {
  const ar = formatEGP(125050, "ar");
  assert.match(ar, /١٬٢٥٠٫٥٠/);
  assert.match(ar, /ج\.م\./);
  assert.match(formatEGP(-125050, "ar"), /-.*١٬٢٥٠٫٥٠/);
});
