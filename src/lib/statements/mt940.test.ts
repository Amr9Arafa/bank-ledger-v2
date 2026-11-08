import { test } from "node:test";
import assert from "node:assert/strict";
import { inferEntryDate, parseMt940, parseMt940Amount, parseYymmdd } from "./mt940.ts";
import type { ParsedStatement } from "./types.ts";

// Synthetic statement in NBE's layout; every name, number and amount is made up.
const header = (ref: string) =>
  `{1:F01NBEGEGCX0001111111111}{2:I940XXXXXXXXXXXXN}{3:{108:${ref}}}{4:`;

const FIXTURE = [
  header("0000000000000000001"),
  ":20:0000000000000000001",
  ":25:1111222233334444555",
  ":28C:1/1",
  ":60F:C261031EGP1000,00",
  ":61:2610301101CP500,00NTRFNONREF//001FTIC000000001",
  ":86:incoming transfer IPN network from TEST SENDER~PNCR000000000001",
  ":61:2611021102DP200,50NCHKNONREF//001CQWL000000002",
  ":86:Cheque withdrawal corporate-00100000000123",
  ":61:2611081105CP1,25NINTNONREF//001CX02EGP 00002",
  ":86:Credit interest-1111222233334444555",
  ":61:2611051105DP15,00NTRFNONREF//001OPDB00000000A",
  ":86:Outgoing ACH transfer charges via internet banking- TO-Test Payee",
  ":61:2611051105DP300,00NTRFNONREF//001OPDB00000000A",
  ":86:outgoing ACH transfer through internet banking- TO-Test Payee",
  ":62F:C261107EGP985,75",
  "-}",
].join("\n");

function parseOne(text: string): ParsedStatement {
  const r = parseMt940(text);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.statements.length, 1);
  return r.statements[0];
}

test("parseMt940Amount reads comma decimals into piasters", () => {
  assert.equal(parseMt940Amount("5000,00"), 500000);
  assert.equal(parseMt940Amount("5000,"), 500000);
  assert.equal(parseMt940Amount("25,6"), 2560);
  assert.equal(parseMt940Amount("0,29"), 29);
  assert.equal(parseMt940Amount("1.250,00"), null);
  assert.equal(parseMt940Amount("1,234"), null);
  assert.equal(parseMt940Amount("5000"), null);
});

test("parseYymmdd validates real days", () => {
  assert.equal(parseYymmdd("261031"), "2026-10-31");
  assert.equal(parseYymmdd("270229"), null);
  assert.equal(parseYymmdd("26103"), null);
});

test("inferEntryDate takes the year from the statement period", () => {
  assert.equal(inferEntryDate("1105", "2026-10-31", "2026-11-07"), "2026-11-05");
  // Period spanning the new year.
  assert.equal(inferEntryDate("1231", "2026-12-28", "2027-01-04"), "2026-12-31");
  assert.equal(inferEntryDate("0102", "2026-12-28", "2027-01-04"), "2027-01-02");
  // Just outside the period: nearest year wins.
  assert.equal(inferEntryDate("0105", "2026-12-28", "2027-01-04"), "2027-01-05");
  assert.equal(inferEntryDate("1227", "2026-12-28", "2027-01-04"), "2026-12-27");
});

test("parses header, balances and period", () => {
  const s = parseOne(FIXTURE);
  assert.equal(s.bic, "NBEGEGCX");
  assert.equal(s.statementRef, "0000000000000000001");
  assert.equal(s.accountNumber, "1111222233334444555");
  assert.equal(s.sequence, "1/1");
  assert.equal(s.currency, "EGP");
  assert.equal(s.openingDate, "2026-10-31");
  assert.equal(s.openingBalanceMinor, 100000);
  assert.equal(s.closingDate, "2026-11-07");
  assert.equal(s.closingBalanceMinor, 98575);
  assert.equal(s.lines.length, 5);
});

test("parses :61: fields, using the entry date as booking date", () => {
  const [incoming, cheque, interest, fee] = parseOne(FIXTURE).lines;
  assert.deepEqual(
    {
      lineNo: incoming.lineNo,
      bookingDate: incoming.bookingDate,
      valueDate: incoming.valueDate,
      direction: incoming.direction,
      amountMinor: incoming.amountMinor,
      typeCode: incoming.typeCode,
      customerRef: incoming.customerRef,
      bankRef: incoming.bankRef,
    },
    {
      lineNo: 1,
      bookingDate: "2026-11-01",
      valueDate: "2026-10-30",
      direction: "credit",
      amountMinor: 50000,
      typeCode: "TRF",
      customerRef: "NONREF",
      bankRef: "001FTIC000000001",
    },
  );
  assert.equal(cheque.direction, "debit");
  assert.equal(cheque.amountMinor, 20050);
  // Value date after the entry date (and after the closing date) is kept as-is.
  assert.equal(interest.valueDate, "2026-11-08");
  assert.equal(interest.bookingDate, "2026-11-05");
  assert.equal(interest.bankRef, "001CX02EGP 00002");
  assert.equal(fee.description, "Outgoing ACH transfer charges via internet banking- TO-Test Payee");
});

test("handles CRLF, a BOM, multi-line :86: and no SWIFT header", () => {
  const text =
    "﻿" +
    [
      ":20:REF2",
      ":25:999",
      ":60F:C261101EGP0,00",
      ":61:2611021102CP10,00NTRFNONREF//X1",
      ":86:incoming transfer IPN netw",
      "ork from SOMEONE",
      ":62F:C261102EGP10,00",
    ].join("\r\n");
  const s = parseOne(text);
  assert.equal(s.bic, null);
  assert.equal(s.lines[0].description, "incoming transfer IPN network from SOMEONE");
});

test("strips bidi marks and extra spaces from :86:", () => {
  const text = FIXTURE.replace("TEST SENDER", "‏اسم‏  ‏تجريبي‏");
  assert.equal(parseOne(text).lines[0].description, "incoming transfer IPN network from اسم تجريبي~PNCR000000000001");
});

test("reversals flip the direction", () => {
  const text = [
    ":20:R",
    ":25:1",
    ":60F:C261101EGP100,00",
    ":61:2611021102RCP40,00NTRFNONREF//A",
    ":61:2611021102RDP15,00NTRFNONREF//B",
    ":62F:C261102EGP75,00",
  ].join("\n");
  const [rc, rd] = parseOne(text).lines;
  assert.equal(rc.direction, "debit");
  assert.equal(rd.direction, "credit");
});

test("negative balances and lines without an entry date", () => {
  const text = [":20:N", ":25:1", ":60F:D261101EGP50,00", ":61:261102C80,00NTRFNONREF//A", ":62F:C261102EGP30,00"].join("\n");
  const s = parseOne(text);
  assert.equal(s.openingBalanceMinor, -5000);
  assert.equal(s.lines[0].bookingDate, "2026-11-02");
});

test("several statements in one file", () => {
  const second = FIXTURE.replaceAll("0000000000000000001", "0000000000000000002");
  const r = parseMt940(`${FIXTURE}\n${second}`);
  assert.ok(r.ok);
  assert.deepEqual(r.statements.map((s) => s.statementRef), ["0000000000000000001", "0000000000000000002"]);
});

test("lineKey is stable across files and distinct for identical lines", () => {
  const twin = [
    ":20:T",
    ":25:1",
    ":60F:C261101EGP0,00",
    ":61:2611021102CP5,00NTRFNONREF//SAME",
    ":86:same",
    ":61:2611021102CP5,00NTRFNONREF//SAME",
    ":86:same",
    ":62F:C261102EGP10,00",
  ].join("\n");
  const [a, b] = parseOne(twin).lines;
  assert.notEqual(a.lineKey, b.lineKey);
  assert.match(a.lineKey, /#1$/);
  assert.match(b.lineKey, /#2$/);
  // Same line in another statement (different :20:, same account) -> same key.
  const again = parseOne(twin.replace(":20:T", ":20:U")).lines;
  assert.equal(again[0].lineKey, a.lineKey);
});

test("two identical fees in one statement are both kept, and dedupe across overlapping statements", () => {
  const fee = [":61:2611051105DP60,00NTRFNONREF//001OPDB0000000X", ":86:Outgoing ACH transfer charges via internet banking- TO-Test Payee"];
  const first = parseOne(
    [":20:A", ":25:1", ":60F:C261104EGP1000,00", ...fee, ...fee, ":62F:C261105EGP880,00"].join("\n"),
  );
  assert.equal(first.lines.length, 2);
  const [k1, k2] = first.lines.map((l) => l.lineKey);
  assert.notEqual(k1, k2);
  assert.equal(k1.split("#")[0], k2.split("#")[0]); // same content, different occurrence

  // A later statement that overlaps 11-05 repeats both fees, then adds a new line.
  const overlap = parseOne(
    [
      ":20:B",
      ":25:1",
      ":60F:C261104EGP1000,00",
      ...fee,
      ...fee,
      ":61:2611061106CP5,00NTRFNONREF//NEW",
      ":62F:C261106EGP885,00",
    ].join("\n"),
  );
  const keys = overlap.lines.map((l) => l.lineKey);
  assert.deepEqual(keys.slice(0, 2), [k1, k2]);
  const alreadyImported = new Set([k1, k2]);
  assert.deepEqual(overlap.lines.filter((l) => !alreadyImported.has(l.lineKey)).map((l) => l.bankRef), ["NEW"]);
});

test("rejects files whose lines do not add up", () => {
  const r = parseMt940(FIXTURE.replace(":62F:C261107EGP985,75", ":62F:C261107EGP985,76"));
  assert.ok(!r.ok);
  assert.equal(r.error, "unbalanced");
});

test("rejects bad input", () => {
  const errorOf = (text: string) => {
    const r = parseMt940(text);
    assert.ok(!r.ok, text);
    return r.error;
  };
  assert.equal(errorOf("  "), "empty");
  assert.equal(errorOf("Date,Amount\n2026-11-02,5"), "unknownFormat");
  assert.equal(errorOf(FIXTURE.replace(/:25:.*\n/, "")), "missingTag");
  assert.equal(errorOf(FIXTURE.replace(":60F:C261031EGP1000,00", ":60F:C261031EGP1000.00")), "badBalance");
  assert.equal(errorOf(FIXTURE.replace(":62F:C261107EGP", ":62F:C261107USD")), "currencyMismatch");
  assert.equal(errorOf(FIXTURE.replace(":61:2611021102DP200,50", ":61:26110X1102DP200,50")), "badLine");
});
