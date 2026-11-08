// One normalized format for every bank statement, whatever the bank or file format.
// Parsers (MT940 now, CSV later) produce it; import and matching only ever see this.

export type Direction = "credit" | "debit";

export type LineKind =
  | "incoming_transfer"
  | "outgoing_transfer"
  | "account_transfer"
  | "cheque"
  | "fee"
  | "interest"
  | "other";

export type Bank = "nbe" | "cib" | "unknown";

export type StatementLine = {
  lineNo: number; // 1-based position in the statement
  bookingDate: string; // YYYY-MM-DD, the entry date: drives the balance
  valueDate: string; // YYYY-MM-DD, informational only
  direction: Direction; // effect on our balance (reversals already applied)
  amountMinor: number; // piasters, always > 0
  typeCode: string; // MT940 transaction type, e.g. "TRF", "CHK"
  customerRef: string; // often "NONREF"
  bankRef: string; // NOT unique: a fee and its transfer can share one
  description: string; // :86: text, bidi marks removed
  paymentRef: string | null; // bank-specific trailing reference (NBE: after "~")
  kind: LineKind;
  counterparty: string | null; // the other side, as the bank wrote it
  chequeRef: string | null; // digits only, for cheque lines
  lineKey: string; // stable identity across overlapping statements
};

export type ParsedStatement = {
  bank: Bank;
  format: "mt940" | "csv";
  bic: string | null;
  statementRef: string; // :20:
  accountNumber: string; // :25:
  sequence: string | null; // :28C:
  currency: string;
  openingDate: string; // :60F: date
  openingBalanceMinor: number; // signed
  closingDate: string; // :62F: date
  closingBalanceMinor: number; // signed
  lines: StatementLine[];
};

export type StatementError =
  | "empty"
  | "unknownFormat"
  | "badDate"
  | "missingColumn"
  | "missingTag"
  | "badBalance"
  | "badLine"
  | "badAmount"
  | "currencyMismatch"
  | "unbalanced";

export type ParseResult =
  | { ok: true; statements: ParsedStatement[] }
  | { ok: false; error: StatementError; detail?: string };
