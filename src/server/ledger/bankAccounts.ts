// FR-1/FR-2: bank accounts are added, edited and archived by admins, never deleted.
// Every change writes an audit row in the same DB transaction.
import { and, eq, min, sql } from "drizzle-orm";
import type { BankAccountInput } from "../../lib/validation.ts";
import { db, type Executor } from "../db/client.ts";
import { bankAccounts, transactions } from "../db/schema.ts";
import { writeAudit } from "./audit.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

async function loadAccount(tx: Executor, user: LedgerUser, accountId: string) {
  const [account] = await tx
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, accountId), eq(bankAccounts.organizationId, user.organizationId)),
    );
  if (!account) throw new LedgerError("accountNotFound");
  return account;
}

export async function getBankAccount(user: LedgerUser, accountId: string, database: Executor = db) {
  try {
    return await loadAccount(database, user, accountId);
  } catch {
    return null;
  }
}

export async function createBankAccount(
  user: LedgerUser,
  input: BankAccountInput,
  database: Executor = db,
): Promise<{ id: string }> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(bankAccounts)
      .values({ ...input, organizationId: user.organizationId })
      .returning();
    await writeAudit(tx, user, { action: "create", bankAccountId: row.id, before: null, after: row });
    return { id: row.id };
  });
}

export async function updateBankAccount(
  user: LedgerUser,
  accountId: string,
  input: BankAccountInput,
  database: Executor = db,
): Promise<{ id: string }> {
  return database.transaction(async (tx) => {
    const before = await loadAccount(tx, user, accountId);

    // Movements before the opening date are rejected, so the date cannot move past them.
    const [{ first }] = await tx
      .select({ first: min(transactions.transactionDate) })
      .from(transactions)
      .where(eq(transactions.bankAccountId, accountId));
    if (first && input.openingDate > first) {
      throw new LedgerError("openingAfterTransactions", "openingDate");
    }

    const [after] = await tx
      .update(bankAccounts)
      .set({ ...input, updatedAt: sql`now()` })
      .where(eq(bankAccounts.id, accountId))
      .returning();
    await writeAudit(tx, user, { action: "update", bankAccountId: accountId, before, after });
    return { id: accountId };
  });
}

// FR-2: archived accounts keep their history but leave the entry forms and dashboard.
export async function setBankAccountArchived(
  user: LedgerUser,
  accountId: string,
  archived: boolean,
  database: Executor = db,
): Promise<{ id: string }> {
  return database.transaction(async (tx) => {
    const before = await loadAccount(tx, user, accountId);
    if (archived) {
      // Outstanding cheques would vanish from the cheque actions while still owed.
      const [outstanding] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.bankAccountId, accountId),
            eq(transactions.type, "cheque"),
            eq(transactions.status, "issued"),
          ),
        )
        .limit(1);
      if (outstanding) throw new LedgerError("hasOutstandingCheques");
    }

    const [after] = await tx
      .update(bankAccounts)
      .set({ archivedAt: archived ? sql`now()` : null, updatedAt: sql`now()` })
      .where(eq(bankAccounts.id, accountId))
      .returning();
    await writeAudit(tx, user, {
      action: archived ? "archive" : "unarchive",
      bankAccountId: accountId,
      before,
      after,
    });
    return { id: accountId };
  });
}
