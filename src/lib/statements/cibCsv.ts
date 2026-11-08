// CIB account statement export (CSV, UTF-8 with BOM). Layout seen in a real export (2026-11):
//   "Account No.","Type","Status","Account Currency","IBAN Number","Date From","Date To","Ledger Balance",...
//   <one account row>
//   ""
//   "Posting Date","Value Date","BackOffice Reference","Description","Related Reference","Cheque Number","Withdrawal","Deposit","Balance"
//   <one row per movement, with a running balance>
//   "Total in Account Currency",... <withdrawal total>, <deposit total>
// Cells are quoted and padded with spaces, amounts use "," thousands separators, dates are
// DD/MM/YYYY. There is no opening balance field: it is worked out from the first running
// balance, and every running balance and the totals row are checked.
// Columns are found by header name, not position, so an added column does not break it.
import { createHash } from "node:crypto";
import { lineKeyer } from "./lineKey.ts";
import { cleanText } from "./mt940.ts";
import type { Direction, ParsedStatement, ParseResult, StatementError, StatementLine } from "./types.ts";

type Fail = { ok: false; error: StatementError; detail?: string };
const fail = (error: StatementError, detail?: string): Fail => ({ ok: false, error, detail });

// RFC 4180 rows: quoted cells may contain commas, quotes are doubled. Cells are trimmed.
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

// "65,128.00" -> 6512800, "-1,250.5" -> -125050, "" -> null. Never through a float.
export function parseCsvAmount(input: string): number | null | "bad" {
  const s = input.replace(/[,\s]/g, "");
  if (s === "") return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return "bad";
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return "bad";
  return m[1] ? -minor : minor;
}

// "04/11/2026" -> "2026-11-04", or null when it is not a real day.
export function parseDmy(input: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

const previousDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Index of each wanted column in a header row, by name.
function columns<T extends string>(header: string[], wanted: Record<T, string>): Record<T, number> | Fail {
  const names = header.map(norm);
  const result = {} as Record<T, number>;
  for (const [key, name] of Object.entries(wanted) as [T, string][]) {
    const i = names.indexOf(norm(name));
    if (i < 0) return fail("missingColumn", name);
    result[key] = i;
  }
  return result;
}

export function looksLikeCibCsv(text: string): boolean {
  return /account no\./i.test(text) && /posting date/i.test(text);
}

type Row = { bookingDate: string; valueDate: string; direction: Direction; amountMinor: number; balanceMinor: number; cells: string[] };

export function parseCibCsv(input: string): ParseResult {
  const text = input.replace(/^﻿/, "");
  if (text.trim() === "") return fail("empty");
  const rows = csvRows(text);

  // Account block: the row after the "Account No." header.
  const accountHeaderAt = rows.findIndex((r) => r.some((c) => norm(c) === "account no."));
  const movementHeaderAt = rows.findIndex((r) => r.some((c) => norm(c) === "posting date"));
  if (accountHeaderAt < 0 || movementHeaderAt < 0) return fail("unknownFormat");
  const ac = columns(rows[accountHeaderAt], {
    account: "Account No.",
    currency: "Account Currency",
    from: "Date From",
    to: "Date To",
    ledger: "Ledger Balance",
  });
  if ("ok" in ac) return ac;
  const accountRow = rows[accountHeaderAt + 1] ?? [];
  const accountNumber = (accountRow[ac.account] ?? "").replace(/\s/g, "");
  const currency = (accountRow[ac.currency] ?? "").toUpperCase();
  const dateFrom = parseDmy(accountRow[ac.from] ?? "");
  const dateTo = parseDmy(accountRow[ac.to] ?? "");
  const ledger = parseCsvAmount(accountRow[ac.ledger] ?? "");
  if (!accountNumber) return fail("missingColumn", "Account No.");
  if (!currency) return fail("missingColumn", "Account Currency");
  if (!dateFrom || !dateTo) return fail("badDate", "Date From / Date To");

  const mc = columns(rows[movementHeaderAt], {
    posting: "Posting Date",
    value: "Value Date",
    ref: "BackOffice Reference",
    description: "Description",
    related: "Related Reference",
    cheque: "Cheque Number",
    withdrawal: "Withdrawal",
    deposit: "Deposit",
    balance: "Balance",
  });
  if ("ok" in mc) return mc;

  const movements: Row[] = [];
  let totals: { withdrawal: number | null; deposit: number | null } | null = null;
  for (let i = movementHeaderAt + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every((c) => c === "")) continue;
    if (/^total/i.test(cells[0] ?? "")) {
      const w = parseCsvAmount(cells[mc.withdrawal] ?? "");
      const d = parseCsvAmount(cells[mc.deposit] ?? "");
      if (w === "bad" || d === "bad") return fail("badAmount", "total");
      totals = { withdrawal: w, deposit: d };
      continue;
    }
    const n = movements.length + 1;
    const bookingDate = parseDmy(cells[mc.posting] ?? "");
    const valueDate = parseDmy(cells[mc.value] ?? "") ?? bookingDate;
    if (!bookingDate || !valueDate) return fail("badDate", `line ${n}`);
    const w = parseCsvAmount(cells[mc.withdrawal] ?? "");
    const d = parseCsvAmount(cells[mc.deposit] ?? "");
    const b = parseCsvAmount(cells[mc.balance] ?? "");
    if (w === "bad" || d === "bad" || b === "bad" || b === null) return fail("badAmount", `line ${n}`);
    // Exactly one of withdrawal and deposit, and positive.
    if ((w === null) === (d === null) || (w ?? d)! <= 0) return fail("badLine", `line ${n}`);
    movements.push({
      bookingDate,
      valueDate,
      direction: d !== null ? "credit" : "debit",
      amountMinor: (w ?? d)!,
      balanceMinor: b,
      cells,
    });
  }

  // The export may list oldest or newest first: the running balances tell which.
  const signed = (r: Row) => (r.direction === "credit" ? r.amountMinor : -r.amountMinor);
  const chains = (list: Row[]) => list.every((r, i) => i === 0 || r.balanceMinor === list[i - 1].balanceMinor + signed(r));
  let ordered = movements;
  if (!chains(movements)) {
    ordered = [...movements].reverse();
    if (!chains(ordered)) return fail("unbalanced", "running balances do not add up");
  }

  if (totals) {
    const sum = (dir: Direction) => movements.filter((r) => r.direction === dir).reduce((s, r) => s + r.amountMinor, 0);
    if ((totals.withdrawal ?? 0) !== sum("debit") || (totals.deposit ?? 0) !== sum("credit")) {
      return fail("unbalanced", "totals row does not match the lines");
    }
  }

  // Opening: the balance before the first movement, at the end of the day before "Date From".
  // With no movements, the ledger balance is the only balance the file gives.
  let openingBalanceMinor: number;
  let closingBalanceMinor: number;
  if (ordered.length > 0) {
    openingBalanceMinor = ordered[0].balanceMinor - signed(ordered[0]);
    closingBalanceMinor = ordered[ordered.length - 1].balanceMinor;
  } else {
    if (ledger === null || ledger === "bad") return fail("badBalance", "Ledger Balance");
    openingBalanceMinor = closingBalanceMinor = ledger;
  }

  const keyOf = lineKeyer(accountNumber);
  const lines: StatementLine[] = ordered.map((r, i) => {
    const bankRef = r.cells[mc.ref] ?? "";
    const description = cleanText(r.cells[mc.description] ?? "");
    const chequeDigits = (r.cells[mc.cheque] ?? "").replace(/\D/g, "");
    const base = { bookingDate: r.bookingDate, valueDate: r.valueDate, direction: r.direction, amountMinor: r.amountMinor, typeCode: "", bankRef, description };
    return {
      ...base,
      lineNo: i + 1,
      customerRef: r.cells[mc.related] ?? "",
      paymentRef: null,
      kind: "other",
      counterparty: null,
      chequeRef: chequeDigits === "" ? null : chequeDigits,
      lineKey: keyOf(base),
    };
  });

  // No statement number in the file: the period plus a hash of the content identifies it, so
  // the same file twice is "already imported" while a longer re-export is a new statement.
  const hash = createHash("sha256")
    .update([accountNumber, dateFrom, dateTo, openingBalanceMinor, closingBalanceMinor, ...lines.map((l) => l.lineKey)].join("|"))
    .digest("hex")
    .slice(0, 12);

  const statement: ParsedStatement = {
    bank: "cib",
    format: "csv",
    bic: null,
    statementRef: `CIB-${dateFrom}-${dateTo}-${hash}`,
    accountNumber,
    sequence: null,
    currency,
    openingDate: previousDay(dateFrom),
    openingBalanceMinor,
    closingDate: dateTo,
    closingBalanceMinor,
    lines,
  };
  return { ok: true, statements: [statement] };
}
