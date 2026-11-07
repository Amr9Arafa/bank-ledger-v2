import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichNbeLine } from "./nbe.ts";
import { bankFromBic, parseStatementFile } from "./index.ts";
import type { Direction } from "./types.ts";

// Made-up names and numbers in NBE's :86: formats.
const enrich = (typeCode: string, direction: Direction, description: string) =>
  enrichNbeLine({ typeCode, direction, description });

test("incoming instant transfer", () => {
  assert.deepEqual(enrich("TRF", "credit", "incoming transfer IPN network from TEST SENDER~PNCR0000AB"), {
    description: "incoming transfer IPN network from TEST SENDER",
    paymentRef: "PNCR0000AB",
    kind: "incoming_transfer",
    counterparty: "TEST SENDER",
    chequeRef: null,
  });
  // Leading punctuation the bank sometimes adds before a name.
  assert.equal(enrich("TRF", "credit", "incoming transfer IPN network from . اسم تجريبي~X").counterparty, "اسم تجريبي");
});

test("account to account transfer: counterparty is the other side", () => {
  const text = "Account to Account Transfer-From-COMPANY A  To-PERSON B~PC0001";
  assert.equal(enrich("MSC", "credit", text).counterparty, "COMPANY A");
  assert.equal(enrich("MSC", "debit", text).counterparty, "PERSON B");
  assert.equal(enrich("MSC", "debit", text).kind, "account_transfer");
});

test("outgoing ACH transfer and its fee", () => {
  const out = enrich("TRF", "debit", "outgoing ACH transfer through internet banking- TO-Test Payee");
  assert.equal(out.kind, "outgoing_transfer");
  assert.equal(out.counterparty, "Test Payee");
  const fee = enrich("TRF", "debit", "Outgoing ACH transfer charges via internet banking- TO-Test Payee");
  assert.equal(fee.kind, "fee");
  assert.equal(fee.counterparty, "Test Payee");
  assert.equal(enrich("CHG", "debit", "Minimum Balance Charge").kind, "fee");
});

test("cheques in all three wordings", () => {
  for (const text of [
    "Cheque withdrawal corporate-00100000000123",
    "Cheque withdrawal--00100000000124",
    "Inward cheque clearing-00100000000125",
  ]) {
    const r = enrich("CHK", "debit", text);
    assert.equal(r.kind, "cheque", text);
    assert.match(r.chequeRef ?? "", /^0010000000012[345]$/);
  }
});

test("interest", () => {
  assert.equal(enrich("INT", "credit", "Credit interest-1111").kind, "interest");
  assert.equal(enrich("INT", "credit", "interest adjustment-1111").kind, "interest");
  assert.equal(enrich("INT", "credit", "interest adjustment-1111").counterparty, null);
});

test("unknown text falls back on the type code", () => {
  assert.equal(enrich("TRF", "credit", "something new").kind, "incoming_transfer");
  assert.equal(enrich("MSC", "debit", "something new").kind, "other");
});

test("bank detection from BIC", () => {
  assert.equal(bankFromBic("NBEGEGCX"), "nbe");
  assert.equal(bankFromBic("CIBEEGCX"), "cib");
  assert.equal(bankFromBic(null), "unknown");
});

test("parseStatementFile enriches NBE lines and keeps lineKey from the raw text", () => {
  const text = [
    "{1:F01NBEGEGCX0001111111111}{2:I940XXXXXXXXXXXXN}{4:",
    ":20:1",
    ":25:1111",
    ":60F:C261101EGP0,00",
    ":61:2611021102CP5,00NTRFNONREF//A",
    ":86:incoming transfer IPN network from TEST~P1",
    ":62F:C261102EGP5,00",
    "-}",
  ].join("\n");
  const r = parseStatementFile(text);
  assert.ok(r.ok);
  const [s] = r.statements;
  assert.equal(s.bank, "nbe");
  assert.equal(s.lines[0].kind, "incoming_transfer");
  assert.equal(s.lines[0].paymentRef, "P1");
  // Without an NBE header, only the type code is used.
  const generic = parseStatementFile(text.replace("NBEGEGCX", "XXXXXXXX"));
  assert.ok(generic.ok);
  assert.equal(generic.statements[0].bank, "unknown");
  assert.equal(generic.statements[0].lines[0].kind, "other");
  assert.equal(generic.statements[0].lines[0].lineKey, s.lines[0].lineKey);
});
