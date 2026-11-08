// CIB: reads each CSV line's description into a kind. Only salary direct debits
// ("<ref> - DD SALARY - Salary") have been seen in a real export so far (2026-11), so this
// works by keywords and falls back on the direction: anything unrecognised becomes an
// incoming or outgoing transfer, never an error. Cheques are recognised by CIB's own
// "Cheque Number" column. CIB descriptions name no counterparty in the sample, so none is
// guessed; the reviewer picks it when creating a record.
import type { LineKind, StatementLine } from "./types.ts";

type Enrichment = Pick<StatementLine, "description" | "kind" | "counterparty" | "chequeRef">;

function kindOf(text: string, direction: StatementLine["direction"], hasChequeNumber: boolean): LineKind {
  const isCredit = direction === "credit";
  if (!isCredit && (hasChequeNumber || /\b(cheque|chq|clearing)\b|شيك/i.test(text))) return "cheque";
  if (/\b(fees?|charges?|commission|comm)\b|عمول|مصاريف|رسوم/i.test(text)) return "fee";
  if (/\binterest\b|فائد|فوائد/i.test(text)) return "interest";
  if (/\b(own account|between accounts|internal transfer)\b/i.test(text)) return "account_transfer";
  return isCredit ? "incoming_transfer" : "outgoing_transfer";
}

export function enrichCibLine(
  line: Pick<StatementLine, "direction" | "description" | "bankRef" | "chequeRef">,
): Enrichment {
  // "FT26308SQW5K - DD SALARY - Salary": the leading reference repeats the bank reference.
  const prefix = `${line.bankRef} - `;
  const description = line.bankRef && line.description.startsWith(prefix) ? line.description.slice(prefix.length) : line.description;
  return {
    description,
    kind: kindOf(description, line.direction, line.chequeRef !== null),
    counterparty: null,
    chequeRef: line.chequeRef,
  };
}
