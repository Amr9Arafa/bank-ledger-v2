import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDIT_TYPES } from "../../server/db/schema.ts";
import { chequeNumberMatches, chequeSerial, sameName, type MatchLine, type MatchRow, scoreCandidate, suggestMatches } from "./match.ts";

const line = (over: Partial<MatchLine> = {}): MatchLine => ({
  id: "L1", bookingDate: "2026-11-05", direction: "credit", amountMinor: 700000,
  kind: "incoming_transfer", bankRef: "001FTIC0001", chequeRef: null, counterparty: null, ...over,
});
const row = (over: Partial<MatchRow> = {}): MatchRow => ({
  id: "T1", type: "transfer_in", status: "active", amountMinor: 700000, transactionDate: "2026-11-05",
  clearedDate: null, chequeNumber: null, reference: null, notes: null, partyName: null, ...over,
});

test("cheque numbers match on trailing digits, ignoring our leading zeros", () => {
  assert.equal(chequeNumberMatches("208006", "07817000208006"), true);
  assert.equal(chequeNumberMatches("00208006", "07817000208006"), true);
  assert.equal(chequeNumberMatches("07817000208006", "07817000208006"), true);
  assert.equal(chequeNumberMatches("208007", "07817000208006"), false);
  assert.equal(chequeNumberMatches("17000208006", "07817000208006"), true);
  assert.equal(chequeNumberMatches("006", "07817000208006"), null); // too short to decide
  assert.equal(chequeNumberMatches("A-208006", "07817000208006"), true);
});

test("the cheque serial is the trailing digits of the bank reference, and matches it", () => {
  assert.equal(chequeSerial("07817000208006"), "208006");
  assert.equal(chequeSerial("078-17000-208006"), "208006");
  assert.equal(chequeSerial("12345"), "12345");
  assert.equal(chequeNumberMatches(chequeSerial("07817000208006"), "07817000208006"), true);
});

test("amount, direction and kind must agree", () => {
  assert.ok(scoreCandidate(line(), row()));
  assert.equal(scoreCandidate(line(), row({ amountMinor: 700001 })), null);
  assert.equal(scoreCandidate(line({ direction: "debit" }), row()), null);
  assert.ok(scoreCandidate(line({ direction: "debit", kind: "fee" }), row({ type: "fee" })));
  assert.ok(scoreCandidate(line({ kind: "interest" }), row({ type: "interest" })));
  assert.ok(scoreCandidate(line({ kind: "account_transfer" }), row({ type: "internal_in" })));
  // A cheque line never matches a transfer, and a transfer line never matches a cheque.
  assert.equal(scoreCandidate(line({ direction: "debit", kind: "cheque" }), row({ type: "transfer_out" })), null);
  assert.equal(scoreCandidate(line({ direction: "debit", kind: "outgoing_transfer" }), row({ type: "cheque", status: "issued" })), null);
  assert.equal(scoreCandidate(line(), row({ status: "voided" })), null);
});

test("movements match within ±4 days of the booking date", () => {
  assert.equal(scoreCandidate(line(), row({ transactionDate: "2026-11-09" }))?.dayDiff, 4);
  assert.equal(scoreCandidate(line(), row({ transactionDate: "2026-11-01" }))?.dayDiff, -4);
  assert.equal(scoreCandidate(line(), row({ transactionDate: "2026-11-10" })), null);
  assert.equal(scoreCandidate(line(), row({ transactionDate: "2026-10-31" })), null);
  // Closer dates score higher.
  assert.ok(scoreCandidate(line(), row())!.score > scoreCandidate(line(), row({ transactionDate: "2026-11-07" }))!.score);
});

test("issued cheques match any time before clearing; cleared ones near their cleared date", () => {
  const cheque = line({ direction: "debit", kind: "cheque", amountMinor: 2000000, chequeRef: "07817000208006" });
  const issued = row({ type: "cheque", status: "issued", amountMinor: 2000000, transactionDate: "2026-09-01", chequeNumber: "208006" });
  const s = scoreCandidate(cheque, issued);
  assert.ok(s);
  assert.equal(s.chequeNumberMatch, true);
  assert.ok(s.score >= 1000);
  assert.ok(scoreCandidate(cheque, { ...issued, transactionDate: "2026-11-09" })); // within slack
  assert.equal(scoreCandidate(cheque, { ...issued, transactionDate: "2026-11-10" }), null);
  // Same amount but a different cheque number: not this cheque.
  assert.equal(scoreCandidate(cheque, { ...issued, chequeNumber: "208007" }), null);
  // No number on our side: amount-only candidate, weaker.
  assert.equal(scoreCandidate(cheque, { ...issued, chequeNumber: "1" })?.chequeNumberMatch, false);

  const cleared = { ...issued, status: "cleared", clearedDate: "2026-11-03" };
  assert.equal(scoreCandidate(cheque, cleared)?.dayDiff, -2);
  assert.equal(scoreCandidate(cheque, { ...cleared, clearedDate: "2026-10-30" }), null);
});

test("a bank reference found in our reference or notes is a strong signal", () => {
  const plain = scoreCandidate(line(), row())!.score;
  assert.equal(scoreCandidate(line(), row({ reference: "001FTIC0001" }))!.score, plain + 500);
  assert.equal(scoreCandidate(line(), row({ notes: "bank ref 001FTIC0001" }))!.score, plain + 500);
});

test("assignment is one-to-one and pairs equal amounts in date order", () => {
  // Two identical outgoing transfers on the statement, two in the ledger 3 days later.
  const lines = [
    line({ id: "L1", direction: "debit", kind: "outgoing_transfer", amountMinor: 6000000 }),
    line({ id: "L2", direction: "debit", kind: "outgoing_transfer", amountMinor: 6000000 }),
  ];
  const rows = [
    row({ id: "T2", type: "transfer_out", amountMinor: 6000000, transactionDate: "2026-11-08" }),
    row({ id: "T1", type: "transfer_out", amountMinor: 6000000, transactionDate: "2026-11-08" }),
  ];
  const s = suggestMatches(lines, rows);
  assert.equal(s.get("L1")!.suggested!.transactionId, "T1");
  assert.equal(s.get("L2")!.suggested!.transactionId, "T2");
  // Each line has two candidates, so neither is "unique".
  assert.equal(s.get("L1")!.unique, false);
  assert.equal(s.get("L1")!.candidates.length, 2);
});

test("the closer date wins a contested row; the other line stays unmatched", () => {
  const lines = [line({ id: "FAR", bookingDate: "2026-11-02" }), line({ id: "NEAR", bookingDate: "2026-11-05" })];
  const s = suggestMatches(lines, [row({ transactionDate: "2026-11-05" })]);
  assert.equal(s.get("NEAR")!.suggested!.transactionId, "T1");
  assert.equal(s.get("FAR")!.suggested, null);
  assert.equal(s.get("FAR")!.candidates.length, 1); // still offered as an alternative
  assert.equal(s.get("NEAR")!.unique, false); // two lines want T1
});

test("a cheque number match beats a closer date", () => {
  const lines = [line({ id: "C", direction: "debit", kind: "cheque", amountMinor: 2000000, chequeRef: "07817000208004" })];
  const rows = [
    row({ id: "NUMBERED", type: "cheque", status: "issued", amountMinor: 2000000, transactionDate: "2026-10-01", chequeNumber: "208004" }),
    row({ id: "OTHER", type: "cheque", status: "cleared", amountMinor: 2000000, transactionDate: "2026-11-05", clearedDate: "2026-11-05", chequeNumber: "1" }),
  ];
  assert.equal(suggestMatches(lines, rows).get("C")!.suggested!.transactionId, "NUMBERED");
});

test("unique: one candidate that no other line wants", () => {
  const s = suggestMatches([line()], [row()]);
  assert.equal(s.get("L1")!.unique, true);
  assert.equal(suggestMatches([line()], []).get("L1")!.suggested, null);
});

test("a record dated after the bank's booking date is never a sure match", () => {
  const later = suggestMatches([line()], [row({ transactionDate: "2026-11-08" })]).get("L1")!;
  assert.equal(later.suggested?.transactionId, "T1"); // still suggested, to confirm by hand
  assert.equal(later.unique, false);
  assert.equal(suggestMatches([line()], [row({ transactionDate: "2026-11-03" })]).get("L1")!.unique, true);
  // A cheque cleared by hand after the booking date: same rule.
  const cheque = line({ direction: "debit", kind: "cheque", chequeRef: "07817000208006" });
  const cleared = row({ type: "cheque", status: "cleared", transactionDate: "2026-11-01", clearedDate: "2026-11-06", chequeNumber: "208006" });
  assert.equal(suggestMatches([cheque], [cleared]).get("L1")!.unique, false);
});

test("an identical name pairs equal amounts correctly, whatever the row order", () => {
  // The bank's two 60,000 transfers on one day; our two records dated alike.
  const lines = [
    line({ id: "TO-Z", direction: "debit", kind: "outgoing_transfer", amountMinor: 6000000, counterparty: "zelal sham" }),
    line({ id: "TO-R", direction: "debit", kind: "outgoing_transfer", amountMinor: 6000000, counterparty: "Renad el Sham" }),
  ];
  const rows = [
    row({ id: "A-RENAD", type: "transfer_out", amountMinor: 6000000, transactionDate: "2026-11-08", partyName: "Renad el Sham" }),
    row({ id: "B-ZELAL", type: "transfer_out", amountMinor: 6000000, transactionDate: "2026-11-08", partyName: "Zelal  Sham" }),
  ];
  const s = suggestMatches(lines, rows);
  assert.equal(s.get("TO-Z")!.suggested!.transactionId, "B-ZELAL");
  assert.equal(s.get("TO-R")!.suggested!.transactionId, "A-RENAD");
  assert.equal(s.get("TO-Z")!.suggested!.nameMatch, true);
  // Names never rule a candidate out: a different name is still a (weaker) candidate.
  assert.equal(s.get("TO-Z")!.candidates.length, 2);
});

test("names compare loosely but not too loosely", () => {
  assert.equal(sameName("zelal sham", "Zelal  Sham"), true);
  assert.equal(sameName("‏محمد احمد‏", "محمد احمد"), true);
  assert.equal(sameName("MOHAMED MAHMOUD ALY ELSAYED", "Mohamed Mahmoud Aly"), true); // one contains the other
  assert.equal(sameName("Ali", "Ali Hassan"), false); // too short to trust containment
  assert.equal(sameName(null, "x"), false);
});

test("the matcher's credit types are the schema's credit types", async () => {
  const debit = line({ direction: "debit" });
  for (const type of CREDIT_TYPES) {
    assert.equal(scoreCandidate(debit, row({ type })), null, `${type} must not match a debit`);
  }
});
