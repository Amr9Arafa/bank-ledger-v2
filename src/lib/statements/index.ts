// Entry point for statement files: detect the format, parse, apply the bank's line reader.
//   NBE: MT940 (bank detected from the BIC in the SWIFT header).
//   CIB: CSV account statement (its MT940 export comes out empty).
import { enrichCibLine } from "./cib.ts";
import { looksLikeCibCsv, parseCibCsv } from "./cibCsv.ts";
import { parseMt940 } from "./mt940.ts";
import { enrichNbeLine } from "./nbe.ts";
import type { Bank, LineKind, ParsedStatement, ParseResult, StatementLine } from "./types.ts";

export function bankFromBic(bic: string | null): Bank {
  if (bic?.startsWith("NBEG")) return "nbe";
  if (bic?.startsWith("CIBE")) return "cib";
  return "unknown";
}

// Fallback for MT940 from banks without a line reader: the type code alone.
const GENERIC_KIND: Record<string, LineKind> = { INT: "interest", CHG: "fee", CHK: "cheque" };

function enrichMt940(statement: ParsedStatement): ParsedStatement {
  const bank = bankFromBic(statement.bic);
  const lines: StatementLine[] = statement.lines.map((line) =>
    bank === "nbe"
      ? { ...line, ...enrichNbeLine(line) }
      : { ...line, kind: GENERIC_KIND[line.typeCode] ?? "other" },
  );
  return { ...statement, bank, lines };
}

const enrichCib = (statement: ParsedStatement): ParsedStatement => ({
  ...statement,
  lines: statement.lines.map((line) => ({ ...line, ...enrichCibLine(line) })),
});

export function parseStatementFile(text: string): ParseResult {
  if (looksLikeCibCsv(text)) {
    const result = parseCibCsv(text);
    return result.ok ? { ok: true, statements: result.statements.map(enrichCib) } : result;
  }
  const result = parseMt940(text);
  return result.ok ? { ok: true, statements: result.statements.map(enrichMt940) } : result;
}

export type { Bank, Direction, LineKind, ParsedStatement, ParseResult, StatementLine } from "./types.ts";
