// Entry point for statement files: parse, detect the bank, apply its enricher.
import { parseMt940 } from "./mt940.ts";
import { enrichNbeLine } from "./nbe.ts";
import type { Bank, LineKind, ParsedStatement, ParseResult, StatementLine } from "./types.ts";

export function bankFromBic(bic: string | null): Bank {
  if (bic?.startsWith("NBEG")) return "nbe";
  if (bic?.startsWith("CIBE")) return "cib";
  return "unknown";
}

// Fallback for banks without an enricher yet: the MT940 type code alone.
const GENERIC_KIND: Record<string, LineKind> = { INT: "interest", CHG: "fee", CHK: "cheque" };

function enrich(statement: ParsedStatement): ParsedStatement {
  const bank = bankFromBic(statement.bic);
  const lines: StatementLine[] = statement.lines.map((line) =>
    bank === "nbe"
      ? { ...line, ...enrichNbeLine(line) }
      : { ...line, kind: GENERIC_KIND[line.typeCode] ?? "other" },
  );
  return { ...statement, bank, lines };
}

export function parseStatementFile(text: string): ParseResult {
  const result = parseMt940(text);
  if (!result.ok) return result;
  return { ok: true, statements: result.statements.map(enrich) };
}

export type { Bank, Direction, LineKind, ParsedStatement, ParseResult, StatementLine } from "./types.ts";
