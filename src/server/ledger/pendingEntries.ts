// AI Inbox entries: what the model read, waiting for review. A pending entry touches no
// balance; approving one creates the real movement or cheque in the same DB transaction.
import { and, count, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Extraction, ExtractionWarning } from "../../lib/extraction.ts";
import type { ChequeInput, MovementInput } from "../../lib/validation.ts";
import { db, type Executor } from "../db/client.ts";
import { pendingEntries, transactions, users } from "../db/schema.ts";
import { createCheque } from "./cheques.ts";
import { createMovement } from "./transactions.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

export type NewPendingEntry = {
  // Chosen by the caller, so the photo's storage path can use it before the row exists.
  id: string;
  type: "transaction" | "cheque";
  source: "web" | "telegram";
  rawText: string | null;
  imagePath: string | null;
  extracted: unknown;
  warnings: unknown[];
  // Telegram: "<chat_id>:<message_id>" (message ids are only unique within a chat).
  externalMessageId?: string;
};

export async function createPendingEntry(
  user: LedgerUser,
  entry: NewPendingEntry,
  database: Executor = db,
) {
  const [row] = await database
    .insert(pendingEntries)
    .values({
      id: entry.id,
      organizationId: user.organizationId,
      type: entry.type,
      source: entry.source,
      rawText: entry.rawText,
      imageUrl: entry.imagePath,
      extracted: entry.extracted,
      warnings: entry.warnings,
      externalMessageId: entry.externalMessageId,
      createdBy: user.id,
    })
    .returning();
  return row;
}

export type PendingEntryStatus = "pending" | "approved" | "rejected";

const reviewer = alias(users, "reviewer");

// Newest first, so a just-sent entry appears right under the input form.
// Reviewed: the latest 50.
export async function listPendingEntries(
  organizationId: string,
  status: PendingEntryStatus,
  database: Executor = db,
) {
  const rows = await database
    .select({
      id: pendingEntries.id,
      type: pendingEntries.type,
      source: pendingEntries.source,
      rawText: pendingEntries.rawText,
      imagePath: pendingEntries.imageUrl,
      extracted: pendingEntries.extracted,
      warnings: pendingEntries.warnings,
      createdAt: pendingEntries.createdAt,
      createdByName: users.name,
      reviewedAt: pendingEntries.reviewedAt,
      reviewedByName: reviewer.name,
      resultingRecordId: pendingEntries.resultingRecordId,
      // What was actually saved, which may differ from what the model read.
      resultAccountId: transactions.bankAccountId,
      resultAmountMinor: transactions.amountMinor,
      resultPartyName: transactions.partyName,
      resultDate: transactions.transactionDate,
    })
    .from(pendingEntries)
    .innerJoin(users, eq(users.id, pendingEntries.createdBy))
    .leftJoin(reviewer, eq(reviewer.id, pendingEntries.reviewedBy))
    .leftJoin(transactions, eq(transactions.id, pendingEntries.resultingRecordId))
    .where(
      and(eq(pendingEntries.organizationId, organizationId), eq(pendingEntries.status, status)),
    )
    .orderBy(
      status === "pending" ? desc(pendingEntries.createdAt) : desc(pendingEntries.reviewedAt),
    )
    .limit(status === "pending" ? 200 : 50);

  // jsonb columns come back untyped; their shape is fixed by the extraction service.
  return rows.map((r) => ({
    ...r,
    extracted: r.extracted as Extraction,
    warnings: r.warnings as ExtractionWarning[],
  }));
}

export type PendingEntryRow = Awaited<ReturnType<typeof listPendingEntries>>[number];

export async function countPendingEntries(organizationId: string, database: Executor = db) {
  const [row] = await database
    .select({ n: count() })
    .from(pendingEntries)
    .where(
      and(eq(pendingEntries.organizationId, organizationId), eq(pendingEntries.status, "pending")),
    );
  return row.n;
}

// Locks the entry until the transaction ends: two people approving at once cannot both
// create a record. The second waits, then sees it is no longer pending.
async function lockPendingEntry(tx: Executor, user: LedgerUser, entryId: string) {
  const [entry] = await tx
    .select()
    .from(pendingEntries)
    .where(
      and(eq(pendingEntries.id, entryId), eq(pendingEntries.organizationId, user.organizationId)),
    )
    .for("update");
  if (!entry) throw new LedgerError("entryNotFound");
  if (entry.status !== "pending") throw new LedgerError("entryNotPending");
  return entry;
}

// The reviewed values, already validated by the same schemas as the manual forms.
export type ApprovalInput =
  | { type: "transaction"; movement: MovementInput }
  | { type: "cheque"; cheque: ChequeInput };

export type ApprovalResult =
  | { status: "approved"; recordId: string }
  // FR-4: a likely duplicate exists. Nothing changed; the user may confirm and approve anyway.
  | { status: "duplicate"; existingId: string };

// One DB transaction: create the movement or cheque (with its audit row) and mark the entry
// approved. createMovement / createCheque run as a nested transaction (a savepoint), so any
// failure in either step rolls back both.
export async function approvePendingEntry(
  user: LedgerUser,
  entryId: string,
  input: ApprovalInput,
  options: { allowDuplicate?: boolean } = {},
  database: Executor = db,
): Promise<ApprovalResult> {
  return database.transaction(async (tx) => {
    const entry = await lockPendingEntry(tx, user, entryId);
    // The form says which kind it reviewed; it must be the kind that was extracted.
    if (entry.type !== input.type) throw new LedgerError("entryNotFound");

    let recordId: string;
    if (input.type === "transaction") {
      const result = await createMovement(user, input.movement, options, tx);
      if (result.status === "duplicate") return result;
      recordId = result.ids[0];
    } else {
      recordId = (await createCheque(user, input.cheque, tx)).id;
    }

    await tx
      .update(pendingEntries)
      .set({
        status: "approved",
        reviewedBy: user.id,
        reviewedAt: sql`now()`,
        resultingRecordId: recordId,
      })
      .where(eq(pendingEntries.id, entryId));
    return { status: "approved", recordId };
  });
}

// Returns the photo's storage path (now cleared on the row) so the caller can delete the file.
export async function rejectPendingEntry(
  user: LedgerUser,
  entryId: string,
  database: Executor = db,
): Promise<{ imagePath: string | null }> {
  return database.transaction(async (tx) => {
    const entry = await lockPendingEntry(tx, user, entryId);
    await tx
      .update(pendingEntries)
      .set({ status: "rejected", reviewedBy: user.id, reviewedAt: sql`now()`, imageUrl: null })
      .where(eq(pendingEntries.id, entryId));
    return { imagePath: entry.imageUrl };
  });
}
