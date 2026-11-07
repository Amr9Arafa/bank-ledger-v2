// Reconciliation: suggest, confirm, undo and ignore matches between statement lines and
// ledger rows. A match never changes a ledger row except one thing: confirming a cheque
// line against an issued cheque clears it (on the booking date), and undoing un-clears it.
import { and, eq, sql } from "drizzle-orm";
import {
  type LineSuggestion,
  MATCH_WINDOW_DAYS,
  type MatchRow,
  scoreCandidate,
  suggestMatches,
} from "../../lib/statements/match.ts";
import { addDays } from "../../lib/cheques.ts";
import { db, type Executor } from "../db/client.ts";
import { statementLines, statementMatches, transactions } from "../db/schema.ts";
import { writeAudit } from "./audit.ts";
import { clearCheque, unclearCheque } from "./cheques.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

export type CandidateRow = MatchRow & {
  partyName: string | null;
  description: string | null;
};

const lineColumns = {
  id: statementLines.id,
  importId: statementLines.importId,
  bankAccountId: statementLines.bankAccountId,
  bookingDate: statementLines.bookingDate,
  direction: statementLines.direction,
  amountMinor: statementLines.amountMinor,
  kind: statementLines.kind,
  bankRef: statementLines.bankRef,
  chequeRef: statementLines.chequeRef,
  status: statementLines.status,
};

// Suggestions for every unmatched line of one account, across all its imports, so two
// imports never get the same ledger row suggested.
async function suggestionsForAccount(organizationId: string, bankAccountId: string, database: Executor) {
  const lines = await database
    .select(lineColumns)
    .from(statementLines)
    .where(
      and(
        eq(statementLines.organizationId, organizationId),
        eq(statementLines.bankAccountId, bankAccountId),
        eq(statementLines.status, "unmatched"),
      ),
    );
  if (lines.length === 0) return { lines, suggestions: new Map<string, LineSuggestion>(), rows: new Map<string, CandidateRow>() };

  const dates = lines.map((l) => l.bookingDate).sort();
  const from = addDays(dates[0], -MATCH_WINDOW_DAYS);
  const to = addDays(dates[dates.length - 1], MATCH_WINDOW_DAYS);
  // Live rows not matched yet, in reach of some line: movements and cleared cheques by
  // date, issued cheques of any age.
  const rows: CandidateRow[] = await database
    .select({
      id: transactions.id,
      type: transactions.type,
      status: transactions.status,
      amountMinor: transactions.amountMinor,
      transactionDate: transactions.transactionDate,
      clearedDate: transactions.clearedDate,
      chequeNumber: transactions.chequeNumber,
      reference: transactions.reference,
      notes: transactions.notes,
      partyName: transactions.partyName,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.bankAccountId, bankAccountId),
        sql`${transactions.status} in ('active', 'issued', 'cleared')`,
        sql`not exists (select 1 from ${statementMatches} m where m.transaction_id = ${transactions.id})`,
        sql`(
          (${transactions.type} <> 'cheque' and ${transactions.transactionDate} between ${from} and ${to})
          or (${transactions.status} = 'issued' and ${transactions.transactionDate} <= ${to})
          or (${transactions.status} = 'cleared' and ${transactions.clearedDate} between ${from} and ${to})
        )`,
      ),
    );

  return { lines, suggestions: suggestMatches(lines, rows), rows: new Map(rows.map((r) => [r.id, r])) };
}

// Suggestions for the unmatched lines of one import, plus the candidate rows to show.
export async function getImportSuggestions(organizationId: string, importId: string, database: Executor = db) {
  const [first] = await database
    .select({ bankAccountId: statementLines.bankAccountId })
    .from(statementLines)
    .where(and(eq(statementLines.organizationId, organizationId), eq(statementLines.importId, importId)))
    .limit(1);
  const empty = { suggestions: new Map<string, LineSuggestion>(), rows: new Map<string, CandidateRow>() };
  if (!first) return empty;
  const all = await suggestionsForAccount(organizationId, first.bankAccountId, database);
  const mine = new Set(all.lines.filter((l) => l.importId === importId).map((l) => l.id));
  return {
    suggestions: new Map([...all.suggestions].filter(([lineId]) => mine.has(lineId))),
    rows: all.rows,
  };
}

async function lockLine(tx: Executor, user: LedgerUser, lineId: string) {
  const [line] = await tx
    .select(lineColumns)
    .from(statementLines)
    .where(and(eq(statementLines.id, lineId), eq(statementLines.organizationId, user.organizationId)))
    .for("update");
  if (!line) throw new LedgerError("lineNotFound");
  return line;
}

async function setLineStatus(
  tx: Executor,
  user: LedgerUser,
  lineId: string,
  status: "unmatched" | "matched" | "ignored",
  ignoreReason: string | null = null,
) {
  await tx
    .update(statementLines)
    .set({ status, ignoreReason, updatedBy: user.id, updatedAt: sql`now()` })
    .where(eq(statementLines.id, lineId));
}

// Confirms that `transactionId` is the ledger row for this line. The pairing is checked
// again here (amount, direction, dates, cheque number), whatever the page suggested.
export async function confirmMatch(
  user: LedgerUser,
  input: { lineId: string; transactionId: string },
  database: Executor = db,
) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, input.lineId);
    if (line.status !== "unmatched") throw new LedgerError("lineNotUnmatched");

    const [row] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, input.transactionId),
          eq(transactions.organizationId, user.organizationId),
          eq(transactions.bankAccountId, line.bankAccountId),
        ),
      )
      .for("update");
    if (!row || !scoreCandidate(line, row)) throw new LedgerError("notACandidate");
    const [taken] = await tx
      .select({ id: statementMatches.id })
      .from(statementMatches)
      .where(eq(statementMatches.transactionId, row.id));
    if (taken) throw new LedgerError("notACandidate");

    // The statement proves the cheque was cashed on the booking date.
    const clearedCheque = row.type === "cheque" && row.status === "issued";
    if (clearedCheque) await clearCheque(user, { transactionId: row.id, clearedDate: line.bookingDate }, tx);

    await tx.insert(statementMatches).values({
      organizationId: user.organizationId,
      statementLineId: line.id,
      transactionId: row.id,
      origin: "matched",
      clearedCheque,
      createdBy: user.id,
    });
    await setLineStatus(tx, user, line.id, "matched");
    await writeAudit(tx, user, {
      action: "statement_match",
      transactionId: row.id,
      before: null,
      after: { lineId: line.id, importId: line.importId, bookingDate: line.bookingDate, amountMinor: line.amountMinor, bankRef: line.bankRef, clearedCheque },
    });
    return { transactionId: row.id, clearedCheque };
  });
}

// Removes a line's match and reverses what confirming it did. The match row goes first:
// the database refuses to un-clear a cheque while it is matched.
// Lines whose record was created from the statement are undone in M4 (void/cancel).
export async function undoMatch(tx: Executor, user: LedgerUser, lineId: string) {
  const [match] = await tx.select().from(statementMatches).where(eq(statementMatches.statementLineId, lineId));
  if (!match) return;
  if (match.origin === "created") throw new LedgerError("importHasMatches");

  await tx.delete(statementMatches).where(eq(statementMatches.id, match.id));
  if (match.clearedCheque) await unclearCheque(user, match.transactionId, tx);
  await setLineStatus(tx, user, lineId, "unmatched");
  await writeAudit(tx, user, {
    action: "statement_unmatch",
    transactionId: match.transactionId,
    before: { lineId, clearedCheque: match.clearedCheque },
    after: null,
  });
}

export async function unmatchLine(user: LedgerUser, lineId: string, database: Executor = db) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, lineId);
    if (line.status !== "matched") throw new LedgerError("lineNotMatched");
    await undoMatch(tx, user, line.id);
  });
}

// A line that needs no ledger row (e.g. a bank correction that is reversed the same day).
export async function ignoreLine(user: LedgerUser, input: { lineId: string; reason: string }, database: Executor = db) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, input.lineId);
    if (line.status !== "unmatched") throw new LedgerError("lineNotUnmatched");
    await setLineStatus(tx, user, line.id, "ignored", input.reason);
    await writeAudit(tx, user, {
      action: "statement_ignore",
      bankAccountId: line.bankAccountId,
      before: null,
      after: { lineId: line.id, importId: line.importId, bookingDate: line.bookingDate, amountMinor: line.amountMinor, reason: input.reason },
    });
  });
}

export async function unignoreLine(user: LedgerUser, lineId: string, database: Executor = db) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, lineId);
    if (line.status !== "ignored") throw new LedgerError("lineNotIgnored");
    await setLineStatus(tx, user, line.id, "unmatched");
    await writeAudit(tx, user, {
      action: "statement_unignore",
      bankAccountId: line.bankAccountId,
      before: { lineId: line.id },
      after: null,
    });
  });
}

// Confirms every suggestion of an import that has exactly one candidate which no other
// line wants. All or nothing.
export async function confirmUniqueSuggestions(user: LedgerUser, importId: string, database: Executor = db) {
  return database.transaction(async (tx) => {
    const { suggestions } = await getImportSuggestions(user.organizationId, importId, tx);
    let confirmed = 0;
    for (const [lineId, s] of suggestions) {
      if (!s.unique || !s.suggested) continue;
      await confirmMatch(user, { lineId, transactionId: s.suggested.transactionId }, tx);
      confirmed++;
    }
    return { confirmed };
  });
}

// Lines of an import that have a match row, for deleteImport. Found by the match rows
// themselves (not the line status), so no match can be missed.
export async function matchedLineIds(tx: Executor, importId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: statementLines.id })
    .from(statementLines)
    .innerJoin(statementMatches, eq(statementMatches.statementLineId, statementLines.id))
    .where(eq(statementLines.importId, importId));
  return rows.map((r) => r.id);
}
