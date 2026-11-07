// National Bank of Egypt (BIC NBEGEGCX): reads the :86: text of each MT940 line into a kind,
// the counterparty and the cheque reference. Formats seen in real exports (2026-11):
//   incoming transfer IPN network from <NAME>~<payment ref>
//   outgoing ACH transfer through internet banking- TO-<NAME>
//   Outgoing ACH transfer charges via internet banking- TO-<NAME>   (fee, same bank ref)
//   Account to Account Transfer-From-<NAME> To-<NAME>~<payment ref>
//   Cheque withdrawal corporate-<digits> / Cheque withdrawal--<digits> / Inward cheque clearing-<digits>
//   Credit interest-<account> / interest adjustment-<account>
//   Minimum Balance Charge
import type { LineKind, StatementLine } from "./types.ts";

type Enrichment = Pick<StatementLine, "description" | "paymentRef" | "kind" | "counterparty" | "chequeRef">;

const trimName = (s: string | undefined) => {
  const name = (s ?? "").replace(/^[\s.\-]+|[\s.\-]+$/g, "");
  return name === "" ? null : name;
};

function kindOf(typeCode: string, text: string, isCredit: boolean): LineKind {
  if (typeCode === "CHG" || /\bcharges?\b/i.test(text)) return "fee";
  if (typeCode === "INT" || /\binterest\b/i.test(text)) return "interest";
  if (typeCode === "CHK" || /\bcheque\b/i.test(text)) return "cheque";
  if (/^account to account transfer/i.test(text)) return "account_transfer";
  if (/^incoming transfer/i.test(text)) return "incoming_transfer";
  if (/^outgoing .*transfer/i.test(text)) return "outgoing_transfer";
  if (typeCode === "TRF") return isCredit ? "incoming_transfer" : "outgoing_transfer";
  return "other";
}

export function enrichNbeLine(line: Pick<StatementLine, "typeCode" | "direction" | "description">): Enrichment {
  // "<text>~<payment ref>": the part after the last "~" is the bank's payment reference.
  const tilde = line.description.lastIndexOf("~");
  const text = (tilde >= 0 ? line.description.slice(0, tilde) : line.description).trim();
  const paymentRef = tilde >= 0 ? line.description.slice(tilde + 1).trim() || null : null;
  const isCredit = line.direction === "credit";
  const kind = kindOf(line.typeCode, text, isCredit);

  let counterparty: string | null = null;
  let chequeRef: string | null = null;
  if (kind === "cheque") {
    chequeRef = /(\d{4,})\s*$/.exec(text)?.[1] ?? null;
  } else if (kind === "account_transfer") {
    const m = /From-(.*?)\s+To-(.*)$/i.exec(text);
    counterparty = trimName(isCredit ? m?.[1] : m?.[2]);
  } else if (kind === "incoming_transfer") {
    counterparty = trimName(/\bfrom\s+(.*)$/i.exec(text)?.[1]);
  } else if (kind === "outgoing_transfer" || kind === "fee") {
    // Fees keep the transfer's recipient so the UI can show which transfer they belong to.
    counterparty = trimName(/\bTO-\s*(.*)$/i.exec(text)?.[1]);
  }

  return { description: text, paymentRef, kind, counterparty, chequeRef };
}
