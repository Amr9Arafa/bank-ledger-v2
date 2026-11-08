import { test } from "node:test";
import assert from "node:assert/strict";
import { csvRows, parseCibCsv, parseCsvAmount, parseDmy } from "./cibCsv.ts";
import { enrichCibLine } from "./cib.ts";
import { parseStatementFile } from "./index.ts";
import { chequeSerial, type MatchRow, suggestMatches } from "./match.ts";
import type { ParsedStatement } from "./types.ts";

// A synthetic CIB export in the real layout; account, references and amounts are made up.
type Mv = [posting: string, value: string, ref: string, description: string, cheque: string, withdrawal: string, deposit: string, balance: string];
const q = (cells: string[]) => cells.map((c) => `" ${c} "`).join(",") + ",";
function cibCsv(movements: Mv[], opts: { from?: string; to?: string; ledger?: string; total?: [string, string] | null; eol?: string } = {}) {
  const eol = opts.eol ?? "\n";
  const lines = [
    "﻿",
    q(["Account No.", "Type", "Status", "Account Currency", "IBAN Number", "Date From", "Date To", "Ledger Balance", "Available Balance\t\t\t", " ", " "]),
    q(["123456789012", "Current Account", "Active", "EGP", "EG000000000000000123456789012", opts.from ?? "31/10/2026", opts.to ?? "07/11/2026", opts.ledger ?? "1,000.00", "1,000.00"]),
    '"",',
    q(["Posting Date", "Value Date", "BackOffice Reference", "Description", "Related Reference", "Cheque Number", "Withdrawal", "Deposit", "Balance"]),
    ...movements.map(([p, v, ref, d, chq, w, dep, bal]) => q([p, v, ref, `${ref} - ${d}`, " ", chq || " ", w || " ", dep || " ", bal])),
  ];
  if (opts.total !== null) {
    const [w, d] = opts.total ?? [
      movements.reduce((s, m) => s + Number(m[5].replace(/,/g, "") || 0), 0).toFixed(2),
      movements.reduce((s, m) => s + Number(m[6].replace(/,/g, "") || 0), 0).toFixed(2),
    ];
    lines.push(`" Total in Account Currency  ","","","","",""," ${w}  "," ${d === "0.00" ? "" : d} ",`);
  }
  return lines.join(eol) + eol;
}

// Opening 2,000.00; a salary debit, a deposit, a fee, a cheque.
const MOVES: Mv[] = [
  ["03/11/2026", "03/11/2026", "FT0001", "DD SALARY - Salary", "", "1,500.00", "", "500.00"],
  ["04/11/2026", "04/11/2026", "FT0002", "INCOMING TRANSFER - TEST CUSTOMER", "", "", "2,250.50", "2,750.50"],
  ["05/11/2026", "05/11/2026", "FT0003", "SERVICE CHARGES", "", "25.00", "", "2,725.50"],
  ["06/11/2026", "06/11/2026", "FT0004", "INWARD CLEARING", "0012345", "725.50", "", "2,000.00"],
];

function parseOne(text: string): ParsedStatement {
  const r = parseCibCsv(text);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.statements.length, 1);
  return r.statements[0];
}

test("CSV rows: quoted commas, padding, CRLF", () => {
  assert.deepEqual(csvRows('" a "," 1,250.00 ",\r\n"x ""y""",z'), [["a", "1,250.00", ""], ['x "y"', "z"]]);
});

test("amounts and dates", () => {
  assert.equal(parseCsvAmount(" 65,128.00 "), 6512800);
  assert.equal(parseCsvAmount("-1,250.5"), -125050);
  assert.equal(parseCsvAmount("  "), null);
  assert.equal(parseCsvAmount("1.234"), "bad");
  assert.equal(parseDmy(" 04/11/2026 "), "2026-11-04");
  assert.equal(parseDmy("31/02/2026"), null);
});

test("header block, opening worked out from the running balance, closing, lines", () => {
  const s = parseOne(cibCsv(MOVES));
  assert.equal(s.bank, "cib");
  assert.equal(s.format, "csv");
  assert.equal(s.accountNumber, "123456789012");
  assert.equal(s.currency, "EGP");
  // The balance before "Date From" (31/10) is the balance at the end of 30/10.
  assert.equal(s.openingDate, "2026-10-30");
  assert.equal(s.closingDate, "2026-11-07");
  assert.equal(s.openingBalanceMinor, 200000);
  assert.equal(s.closingBalanceMinor, 200000);
  assert.deepEqual(
    s.lines.map((l) => [l.lineNo, l.bookingDate, l.direction, l.amountMinor, l.bankRef, l.chequeRef]),
    [
      [1, "2026-11-03", "debit", 150000, "FT0001", null],
      [2, "2026-11-04", "credit", 225050, "FT0002", null],
      [3, "2026-11-05", "debit", 2500, "FT0003", null],
      [4, "2026-11-06", "debit", 72550, "FT0004", "0012345"],
    ],
  );
  assert.match(s.statementRef, /^CIB-2026-10-31-2026-11-07-[0-9a-f]{12}$/);
});

test("newest-first exports are put back in date order", () => {
  const s = parseOne(cibCsv([...MOVES].reverse()));
  assert.deepEqual(s.lines.map((l) => l.bankRef), ["FT0001", "FT0002", "FT0003", "FT0004"]);
  assert.equal(s.openingBalanceMinor, 200000);
});

test("CRLF line endings and no totals row", () => {
  const s = parseOne(cibCsv(MOVES, { eol: "\r\n", total: null }));
  assert.equal(s.lines.length, 4);
});

test("a statement with no movements uses the ledger balance", () => {
  const s = parseOne(cibCsv([], { ledger: "9,999.99", total: null }));
  assert.equal(s.openingBalanceMinor, 999999);
  assert.equal(s.closingBalanceMinor, 999999);
});

test("same file -> same statement reference; a longer export -> new reference, same line keys", () => {
  const a = parseOne(cibCsv(MOVES.slice(0, 2), { to: "05/11/2026" }));
  const again = parseOne(cibCsv(MOVES.slice(0, 2), { to: "05/11/2026" }));
  const longer = parseOne(cibCsv(MOVES));
  assert.equal(again.statementRef, a.statementRef);
  assert.notEqual(longer.statementRef, a.statementRef);
  assert.deepEqual(longer.lines.slice(0, 2).map((l) => l.lineKey), a.lines.map((l) => l.lineKey));
});

test("rejects files that do not add up or cannot be read", () => {
  const errorOf = (text: string) => {
    const r = parseCibCsv(text);
    assert.ok(!r.ok, text);
    return r.error;
  };
  const broken = MOVES.map((m) => [...m] as Mv);
  broken[2][7] = "2,725.51"; // a running balance that does not follow
  assert.equal(errorOf(cibCsv(broken)), "unbalanced");
  assert.equal(errorOf(cibCsv(MOVES, { total: ["1.00", "2,250.50"] })), "unbalanced");
  const both = MOVES.map((m) => [...m] as Mv);
  both[0][6] = "1.00"; // withdrawal and deposit on one line
  assert.equal(errorOf(cibCsv(both)), "badLine");
  const badDate = MOVES.map((m) => [...m] as Mv);
  badDate[1][0] = "32/11/2026";
  assert.equal(errorOf(cibCsv(badDate)), "badDate");
  assert.equal(errorOf(cibCsv(MOVES).replace("Withdrawal", "Debit")), "missingColumn");
  assert.equal(errorOf("  "), "empty");
});

test("CIB line reader: kinds by keywords, fallback by direction", () => {
  const read = (description: string, direction: "credit" | "debit", chequeRef: string | null = null) =>
    enrichCibLine({ description: `FT9 - ${description}`, bankRef: "FT9", direction, chequeRef });
  assert.deepEqual(read("DD SALARY - Salary", "debit"), { description: "DD SALARY - Salary", kind: "outgoing_transfer", counterparty: null, chequeRef: null });
  assert.equal(read("SOMETHING NEW", "credit").kind, "incoming_transfer");
  assert.equal(read("SERVICE CHARGES", "debit").kind, "fee");
  assert.equal(read("عمولة تحويل", "debit").kind, "fee");
  assert.equal(read("CREDIT INTEREST", "credit").kind, "interest");
  assert.equal(read("ANY TEXT", "debit", "0012345").kind, "cheque");
  assert.equal(read("INWARD CLEARING", "debit").kind, "cheque");
  assert.equal(read("OWN ACCOUNT TRANSFER", "debit").kind, "account_transfer");
  // A description that does not start with the reference is kept whole.
  assert.equal(enrichCibLine({ description: "PLAIN", bankRef: "FT9", direction: "debit", chequeRef: null }).description, "PLAIN");
});

test("a filled Cheque Number column makes the line a cheque, whatever the description says", () => {
  const read = (description: string, direction: "credit" | "debit", chequeRef: string | null) =>
    enrichCibLine({ description, bankRef: "FT9", direction, chequeRef });
  // Descriptions that would otherwise be a fee, interest, a transfer or the fallback.
  for (const description of ["SERVICE CHARGES", "CREDIT INTEREST", "OWN ACCOUNT TRANSFER", "DD SALARY - Salary", ""]) {
    assert.equal(read(description, "debit", "0012345").kind, "cheque", description);
    assert.equal(read(description, "debit", "0012345").chequeRef, "0012345");
    assert.notEqual(read(description, "debit", null).kind, "cheque", description);
  }
  assert.equal(read("RETURNED", "credit", "0012345").kind, "cheque");

  // Through the whole parser: the column alone is enough, and the line matches a cheque.
  const moves: Mv[] = [["03/11/2026", "03/11/2026", "FT0005", "SERVICE CHARGES", "0054321", "300.00", "", "1,700.00"]];
  const r = parseStatementFile(cibCsv(moves));
  assert.ok(r.ok);
  const [line] = r.statements[0].lines;
  assert.deepEqual([line.kind, line.chequeRef], ["cheque", "0054321"]);
  const issued: MatchRow = {
    id: "C1", type: "cheque", status: "issued", amountMinor: 30000, transactionDate: "2026-10-20", clearedDate: null,
    chequeNumber: chequeSerial("0054321", "cib"), reference: null, notes: null, partyName: "Payee",
  };
  const s = suggestMatches([{ ...line, id: "L1" }], [issued]).get("L1")!;
  assert.equal(s.suggested?.transactionId, "C1");
  assert.equal(s.suggested?.chequeNumberMatch, true);
});

test("format detection: CIB CSV, NBE MT940, anything else", () => {
  const cib = parseStatementFile(cibCsv(MOVES));
  assert.ok(cib.ok);
  assert.equal(cib.statements[0].bank, "cib");
  assert.equal(cib.statements[0].lines[0].kind, "outgoing_transfer");
  assert.equal(cib.statements[0].lines[3].kind, "cheque");
  const other = parseStatementFile("Date,Amount\n2026-11-02,5\n");
  assert.ok(!other.ok);
  assert.equal(other.error, "unknownFormat");
});

test("cheque serials are per bank", () => {
  assert.equal(chequeSerial("07817000208006", "nbe"), "208006");
  assert.equal(chequeSerial("0012345", "cib"), "0012345"); // CIB: the Cheque Number column as given
});
