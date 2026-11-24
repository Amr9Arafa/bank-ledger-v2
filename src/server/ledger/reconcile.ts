// Reconciliation: suggest, confirm, undo and ignore matches between statement lines and
// ledger rows. A match never changes a ledger row except one thing: confirming a cheque
// line against an issued cheque clears it (on the booking date), and undoing un-clears it.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type LineSuggestion,
  MATCH_WINDOW_DAYS,
  type MatchRow,
  scoreCandidate,
  suggestMatches,
} from "../../lib/statements/match.ts";
import { addDays } from "../../lib/cheques.ts";
import { db, type Executor } from "../db/client.ts";
import { type STATEMENT_REVIEW_STATES, statementLines, statementMatches, transactions } from "../db/schema.ts";

type StatementReviewState = (typeof STATEMENT_REVIEW_STATES)[number];
import { writeAudit } from "./audit.ts";
import type { CreateFromLineInput } from "../../lib/validation.ts";
import { cancelCheque, clearCheque, createCheque, unclearCheque } from "./cheques.ts";
import { createInternalTransfer, createMovement, voidTransaction } from "./transactions.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

export type CandidateRow = MatchRow & {
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
  counterparty: statementLines.counterparty,
  description: statementLines.description,
  status: statementLines.status,
  reviewState: statementLines.reviewState,
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
        // "Not in the app": the reviewer says no record exists, so the line gets no
        // suggestions and cannot hold a record another line needs.
        sql`${statementLines.reviewState} is distinct from 'not_in_app'`,
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

  const suggestions = suggestMatches(lines, rows);
  // "Not the same": the reviewer doubts the suggestion, so it is never confirmed in bulk.
  for (const line of lines) {
    const s = suggestions.get(line.id);
    if (s && line.reviewState === "needs_decision") suggestions.set(line.id, { ...s, unique: false });
  }
  return { lines, suggestions, rows: new Map(rows.map((r) => [r.id, r])) };
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
  status: "unmatched" | "matched" | "created" | "ignored",
  ignoreReason: string | null = null,
) {
  // Any change of status clears the review state: a confirmed, created or ignored line has
  // no suggestions to judge, and an undone one starts fresh (the database enforces this).
  await tx
    .update(statementLines)
    .set({ status, ignoreReason, reviewState: null, updatedBy: user.id, updatedAt: sql`now()` })
    .where(eq(statementLines.id, lineId));
}

const REVIEW_AUDIT = {
  needs_decision: "statement_needs_decision",
  not_in_app: "statement_not_in_app",
} as const;

// The reviewer's call on an unmatched line's suggestions: "Not the same" (needs_decision),
// "Not in the app" (not_in_app), or "Back to suggestions" (null). Saves nothing else.
export async function setReviewState(
  user: LedgerUser,
  input: { lineId: string; state: StatementReviewState | null },
  database: Executor = db,
) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, input.lineId);
    if (line.status !== "unmatched") throw new LedgerError("lineNotUnmatched");
    if (line.reviewState === input.state) return;
    await tx
      .update(statementLines)
      .set({ reviewState: input.state, updatedBy: user.id, updatedAt: sql`now()` })
      .where(eq(statementLines.id, line.id));
    await writeAudit(tx, user, {
      action: input.state ? REVIEW_AUDIT[input.state] : "statement_back_to_suggestions",
      bankAccountId: line.bankAccountId,
      before: { lineId: line.id, reviewState: line.reviewState },
      after: { lineId: line.id, reviewState: input.state },
    });
  });
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

// Why a record created from a statement line was voided or cancelled when it was undone.
// Stored data (like any void reason), not a UI label.
const UNDO_REASON = "Undone from bank statement";

// Removes one match row and puts its line back to unmatched. Nothing else changes.
async function removeMatch(tx: Executor, user: LedgerUser, match: typeof statementMatches.$inferSelect) {
  await tx.delete(statementMatches).where(eq(statementMatches.id, match.id));
  await setLineStatus(tx, user, match.statementLineId, "unmatched");
  await writeAudit(tx, user, {
    action: "statement_unmatch",
    transactionId: match.transactionId,
    before: { lineId: match.statementLineId, origin: match.origin, clearedCheque: match.clearedCheque },
    after: null,
  });
}

// Removes a line's match and reverses everything it did, leaving the ledger as before.
// Match rows go first: the database refuses to void, cancel or un-clear a matched row.
//   matched: a cheque cleared by the match is un-cleared.
//   created: the record made from the line is voided (an internal transfer: both halves,
//            after unmatching the other half too) or, for a cheque, un-cleared and cancelled.
export async function undoMatch(tx: Executor, user: LedgerUser, lineId: string) {
  const [match] = await tx.select().from(statementMatches).where(eq(statementMatches.statementLineId, lineId));
  if (!match) return;

  if (match.origin === "matched") {
    await removeMatch(tx, user, match);
    if (match.clearedCheque) await unclearCheque(user, match.transactionId, tx);
    return;
  }

  const [row] = await tx.select().from(transactions).where(eq(transactions.id, match.transactionId));
  const groupIds = row.transferGroupId
    ? (await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.transferGroupId, row.transferGroupId))).map((r) => r.id)
    : [row.id];
  for (const m of await tx.select().from(statementMatches).where(inArray(statementMatches.transactionId, groupIds))) {
    await removeMatch(tx, user, m);
  }
  if (row.type === "cheque") {
    if (row.status === "cleared") await unclearCheque(user, row.id, tx);
    await cancelCheque(user, { transactionId: row.id, reason: UNDO_REASON }, tx);
  } else {
    await voidTransaction(user, { transactionId: row.id, reason: UNDO_REASON }, tx);
  }
}

// Undo one line: a confirmed match is removed; a record created from the line is voided or
// cancelled (records are never deleted).
export async function unmatchLine(user: LedgerUser, lineId: string, database: Executor = db) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, lineId);
    if (line.status !== "matched" && line.status !== "created") throw new LedgerError("lineNotMatched");
    await undoMatch(tx, user, line.id);
  });
}

const ALLOWED: Record<"credit" | "debit", CreateFromLineInput["type"][]> = {
  credit: ["transfer_in", "interest", "internal"],
  debit: ["transfer_out", "fee", "cheque", "internal"],
};

// Creates the ledger record a statement line proves, through the normal ledger functions
// (same rules and audit rows as manual entry), and links it to the line. Amount, date and
// bank reference come from the line. An old cheque is issued and cleared on the booking date.
export async function createFromLine(user: LedgerUser, input: CreateFromLineInput, database: Executor = db) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, input.lineId);
    if (line.status !== "unmatched") throw new LedgerError("lineNotUnmatched");
    if (!ALLOWED[line.direction].includes(input.type)) throw new LedgerError("typeNotForLine");

    const common = {
      bankAccountId: line.bankAccountId,
      transactionDate: line.bookingDate,
      amountMinor: line.amountMinor,
      notes: input.notes,
    };
    let transactionId: string;
    switch (input.type) {
      case "transfer_in":
      case "transfer_out": {
        // The statement is the evidence, so no duplicate prompt: matching showed no candidate.
        const r = await createMovement(
          user,
          { ...common, type: input.type, partyName: input.partyName, reference: line.bankRef || null },
          { allowDuplicate: true },
          tx,
        );
        transactionId = r.status === "created" ? r.ids[0] : r.existingId;
        break;
      }
      case "fee":
      case "interest": {
        const r = await createMovement(user, { ...common, type: input.type, description: input.description }, {}, tx);
        transactionId = r.status === "created" ? r.ids[0] : r.existingId;
        break;
      }
      case "cheque": {
        const { id } = await createCheque(
          user,
          { ...common, chequeNumber: input.chequeNumber, partyName: input.partyName, dueDate: null },
          tx,
        );
        await clearCheque(user, { transactionId: id, clearedDate: line.bookingDate }, tx);
        transactionId = id;
        break;
      }
      case "internal": {
        const [fromAccountId, toAccountId] =
          line.direction === "debit" ? [line.bankAccountId, input.otherAccountId] : [input.otherAccountId, line.bankAccountId];
        const r = await createInternalTransfer(
          user,
          { fromAccountId, toAccountId, transactionDate: line.bookingDate, amountMinor: line.amountMinor, notes: input.notes },
          tx,
        );
        const [mine] = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              // Internal transfers never report a duplicate; the narrowing is for the type only.
              inArray(transactions.id, r.status === "created" ? r.ids : []),
              eq(transactions.bankAccountId, line.bankAccountId),
            ),
          );
        transactionId = mine.id;
        break;
      }
    }

    await tx.insert(statementMatches).values({
      organizationId: user.organizationId,
      statementLineId: line.id,
      transactionId,
      origin: "created",
      createdBy: user.id,
    });
    await setLineStatus(tx, user, line.id, "created");
    await writeAudit(tx, user, {
      action: "statement_match",
      transactionId,
      before: null,
      after: { lineId: line.id, importId: line.importId, origin: "created", bookingDate: line.bookingDate, amountMinor: line.amountMinor, bankRef: line.bankRef },
    });
    return { transactionId };
  });
}

// Lines that "create all fees / interest" would create records for: unmatched lines of that
// kind with no possible record in the app (anything that might match is left for review).
export async function bulkCandidates(
  organizationId: string,
  importId: string,
  kind: "fee" | "interest",
  database: Executor = db,
) {
  const { suggestions } = await getImportSuggestions(organizationId, importId, database);
  const lines = await database
    .select({ id: statementLines.id, description: statementLines.description })
    .from(statementLines)
    .where(
      and(
        eq(statementLines.organizationId, organizationId),
        eq(statementLines.importId, importId),
        eq(statementLines.status, "unmatched"),
        eq(statementLines.kind, kind),
        eq(statementLines.direction, kind === "fee" ? "debit" : "credit"),
      ),
    );
  return lines.filter((l) => (suggestions.get(l.id)?.candidates.length ?? 0) === 0);
}

// Bulk: one fee (or interest) record per line from bulkCandidates. All or nothing.
export async function createAllFromImport(
  user: LedgerUser,
  input: { importId: string; kind: "fee" | "interest" },
  database: Executor = db,
) {
  return database.transaction(async (tx) => {
    const lines = await bulkCandidates(user.organizationId, input.importId, input.kind, tx);
    for (const line of lines) {
      await createFromLine(user, { lineId: line.id, type: input.kind, description: line.description.slice(0, 200), notes: null }, tx);
    }
    return { created: lines.length };
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

// ---- Records entered on the wrong account or in the wrong direction ----

// Only plain movements can be "the wrong record": cheques are cancelled, not voided, and each
// half of an internal transfer legitimately carries the same bank reference as the other
// account's line.
const FIXABLE_TYPES = ["transfer_in", "transfer_out", "fee", "interest", "deposit"] as const;
// Shorter references (e.g. "INT 1") are too common to identify one movement.
const MIN_REF_LENGTH = 6;

export type CrossEntrySuggestion = {
  transactionId: string;
  bankAccountId: string;
  type: string;
  date: string;
  signedMinor: number;
  name: string | null;
  wrongAccount: boolean;
  wrongDirection: boolean;
};

const crossConditions = (lineAccount: string, lineDirection: "credit" | "debit", ref: string, amountMinor: number) => sql`
  t.amount_minor = ${amountMinor}
  and t.status = 'active'
  and t.type in (${sql.raw(FIXABLE_TYPES.map((x) => `'${x}'`).join(", "))})
  and strpos(coalesce(t.notes, '') || ' ' || coalesce(t.reference, ''), ${ref}) > 0
  and not exists (select 1 from statement_matches m where m.transaction_id = t.id)
  and (t.bank_account_id <> ${lineAccount}
       or (t.type in ('transfer_in', 'deposit', 'interest')) <> (${lineDirection} = 'credit'))`;

// For each open line of an import: unmatched records whose notes or reference contain the
// line's exact bank reference, with the same amount, but on another account or in the other
// direction. Shown as "possibly entered on the wrong account / direction"; never applied
// automatically.
export async function crossEntrySuggestions(organizationId: string, importId: string, database: Executor = db) {
  const lines = await database
    .select(lineColumns)
    .from(statementLines)
    .where(and(eq(statementLines.organizationId, organizationId), eq(statementLines.importId, importId), eq(statementLines.status, "unmatched")));
  const result = new Map<string, CrossEntrySuggestion[]>();
  for (const line of lines) {
    if (line.bankRef.trim().length < MIN_REF_LENGTH) continue;
    const rows = await database.execute<{ id: string; bank_account_id: string; type: string; d: string; amount_minor: string; name: string | null }>(sql`
      select t.id, t.bank_account_id, t.type, t.transaction_date::text d, t.amount_minor, coalesce(t.party_name, t.description) name
      from transactions t
      where t.organization_id = ${organizationId} and ${crossConditions(line.bankAccountId, line.direction, line.bankRef.trim(), line.amountMinor)}`);
    if (rows.length === 0) continue;
    result.set(
      line.id,
      rows.map((r) => {
        const credit = r.type === "transfer_in" || r.type === "deposit" || r.type === "interest";
        return {
          transactionId: r.id,
          bankAccountId: r.bank_account_id,
          type: r.type,
          date: r.d,
          signedMinor: credit ? Number(r.amount_minor) : -Number(r.amount_minor),
          name: r.name,
          wrongAccount: r.bank_account_id !== line.bankAccountId,
          wrongDirection: credit !== (line.direction === "credit"),
        };
      }),
    );
  }
  return result;
}

// The one-click fix for a cross-entry suggestion: void the wrong record and create the right
// one from the statement line (linked to it), in one transaction. The pairing is checked
// again here, whatever the page sent.
export async function fixWrongEntry(
  user: LedgerUser,
  input: { lineId: string; transactionId: string },
  database: Executor = db,
) {
  return database.transaction(async (tx) => {
    const line = await lockLine(tx, user, input.lineId);
    if (line.status !== "unmatched") throw new LedgerError("lineNotUnmatched");
    const ref = line.bankRef.trim();
    if (ref.length < MIN_REF_LENGTH) throw new LedgerError("notACandidate");
    const [row] = await tx.execute<{ id: string; party_name: string | null; description: string | null; notes: string | null }>(sql`
      select t.id, t.party_name, t.description, t.notes from transactions t
      where t.id = ${input.transactionId} and t.organization_id = ${user.organizationId}
        and ${crossConditions(line.bankAccountId, line.direction, ref, line.amountMinor)}
      for update`);
    if (!row) throw new LedgerError("notACandidate");

    await voidTransaction(
      user,
      { transactionId: row.id, reason: `Entered on the wrong account or direction: replaced from statement line (bank ref ${ref})` },
      tx,
    );
    const common = { lineId: line.id, notes: row.notes };
    const record: CreateFromLineInput =
      line.kind === "fee" && line.direction === "debit"
        ? { ...common, type: "fee", description: (row.description ?? row.party_name ?? line.description).slice(0, 200) }
        : line.kind === "interest" && line.direction === "credit"
          ? { ...common, type: "interest", description: (row.description ?? row.party_name ?? line.description).slice(0, 200) }
          : {
              ...common,
              type: line.direction === "credit" ? "transfer_in" : "transfer_out",
              partyName: (row.party_name ?? line.counterparty ?? row.description ?? line.description).slice(0, 200),
            };
    const { transactionId } = await createFromLine(user, record, tx);
    return { voidedId: row.id, transactionId };
  });
}
