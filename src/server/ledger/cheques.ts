// Cheques: issued -> cleared (cashed) or cancelled (voided before cashing).
// Every write runs in one DB transaction with its audit row.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nextChequeNumber } from "../../lib/cheques.ts";
import type {
  CancelChequeInput,
  ChequeInput,
  ClearChequeInput,
} from "../../lib/validation.ts";
import { db, type Executor, isUniqueViolation } from "../db/client.ts";
import { bankAccounts, transactions } from "../db/schema.ts";
import { writeAudit } from "./audit.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

export async function createCheque(
  user: LedgerUser,
  input: ChequeInput,
  database: Executor = db,
): Promise<{ id: string }> {
  try {
    return await database.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.id, input.bankAccountId),
            eq(bankAccounts.organizationId, user.organizationId),
          ),
        );
      if (!account) throw new LedgerError("accountNotFound", "bankAccountId");
      if (account.archivedAt) throw new LedgerError("accountArchived", "bankAccountId");
      if (!account.issuesCheques) throw new LedgerError("accountNoCheques", "bankAccountId");
      if (input.transactionDate < account.openingDate) {
        throw new LedgerError("beforeOpeningDate", "transactionDate");
      }

      // FR-6: unique per account. The unique index also guards against two saves at once.
      const [taken] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.bankAccountId, input.bankAccountId),
            eq(transactions.type, "cheque"),
            eq(transactions.chequeNumber, input.chequeNumber),
          ),
        );
      if (taken) throw new LedgerError("chequeNumberTaken", "chequeNumber");

      const [row] = await tx
        .insert(transactions)
        .values({
          organizationId: user.organizationId,
          bankAccountId: input.bankAccountId,
          type: "cheque",
          chequeNumber: input.chequeNumber,
          partyName: input.partyName,
          amountMinor: input.amountMinor,
          transactionDate: input.transactionDate,
          dueDate: input.dueDate,
          status: "issued",
          notes: input.notes,
          createdBy: user.id,
          updatedBy: user.id,
        })
        .returning();
      await writeAudit(tx, user, {
        action: "create",
        transactionId: row.id,
        before: null,
        after: row,
      });
      return { id: row.id };
    });
  } catch (error) {
    if (!(error instanceof LedgerError) && isUniqueViolation(error)) {
      throw new LedgerError("chequeNumberTaken", "chequeNumber");
    }
    throw error;
  }
}

// Changes one cheque's status, only if it is currently `from`.
async function changeChequeStatus(
  user: LedgerUser,
  transactionId: string,
  from: "issued" | "cleared",
  change: { status: "cleared" | "cancelled" | "issued"; clearedDate?: string | null; statusReason?: string | null },
  action: "clear" | "cancel" | "unclear",
  database: Executor,
) {
  return database.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, transactionId),
          eq(transactions.organizationId, user.organizationId),
          eq(transactions.type, "cheque"),
        ),
      );
    if (!before) throw new LedgerError("transactionNotFound");
    if (before.status !== from) {
      throw new LedgerError(from === "issued" ? "notIssued" : "notCleared");
    }
    if (change.clearedDate && change.clearedDate < before.transactionDate) {
      throw new LedgerError("clearedBeforeIssue", "clearedDate");
    }

    const [after] = await tx
      .update(transactions)
      .set({ ...change, updatedBy: user.id, updatedAt: sql`now()` })
      // Status in the WHERE: a concurrent second click changes nothing.
      .where(and(eq(transactions.id, transactionId), eq(transactions.status, from)))
      .returning();
    if (!after) throw new LedgerError(from === "issued" ? "notIssued" : "notCleared");

    await writeAudit(tx, user, { action, transactionId, before, after });
    return { id: after.id };
  });
}

// FR-7: the payee cashed the cheque.
export function clearCheque(user: LedgerUser, input: ClearChequeInput, database: Executor = db) {
  return changeChequeStatus(
    user,
    input.transactionId,
    "issued",
    { status: "cleared", clearedDate: input.clearedDate },
    "clear",
    database,
  );
}

// FR-7: voided before cashing. Stays in the history, counts in no balance.
export function cancelCheque(user: LedgerUser, input: CancelChequeInput, database: Executor = db) {
  return changeChequeStatus(
    user,
    input.transactionId,
    "issued",
    { status: "cancelled", statusReason: input.reason },
    "cancel",
    database,
  );
}

// Admin correction: a cheque was marked cleared by mistake. The action checks the admin role.
export function unclearCheque(user: LedgerUser, transactionId: string, database: Executor = db) {
  return changeChequeStatus(
    user,
    transactionId,
    "cleared",
    { status: "issued", clearedDate: null },
    "unclear",
    database,
  );
}

// FR-6: suggested next number per account that issues cheques.
export async function suggestChequeNumbers(
  organizationId: string,
  database: Executor = db,
): Promise<Record<string, string>> {
  const rows = await database.execute<{ bank_account_id: string; cheque_number: string }>(sql`
    select distinct on (bank_account_id) bank_account_id, cheque_number
    from transactions
    where organization_id = ${organizationId}
      and type = 'cheque' and cheque_number ~ '^[0-9]+$'
    order by bank_account_id, cheque_number::numeric desc
  `);
  return Object.fromEntries(rows.map((r) => [r.bank_account_id, nextChequeNumber(r.cheque_number)]));
}

export type ChequeStatus = "issued" | "cleared" | "cancelled";

export type ChequeRow = {
  id: string;
  accountId: string;
  accountName: string;
  chequeNumber: string;
  partyName: string | null;
  amountMinor: number;
  transactionDate: string;
  // Due date, or the issue date when none was given.
  dueDate: string;
  clearedDate: string | null;
  statusReason: string | null;
};

// FR-8: outstanding cheques sorted by due date; cleared and cancelled newest first.
export async function listCheques(
  organizationId: string,
  status: ChequeStatus,
  database: Executor = db,
): Promise<ChequeRow[]> {
  const due = sql<string>`coalesce(${transactions.dueDate}, ${transactions.transactionDate})::text`;
  const order =
    status === "issued"
      ? [asc(due), asc(transactions.chequeNumber)]
      : status === "cleared"
        ? [desc(transactions.clearedDate), desc(transactions.chequeNumber)]
        : [desc(transactions.updatedAt)];

  const rows = await database
    .select({
      id: transactions.id,
      accountId: bankAccounts.id,
      accountName: bankAccounts.name,
      chequeNumber: transactions.chequeNumber,
      partyName: transactions.partyName,
      amountMinor: transactions.amountMinor,
      transactionDate: transactions.transactionDate,
      dueDate: due,
      clearedDate: transactions.clearedDate,
      statusReason: transactions.statusReason,
    })
    .from(transactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, transactions.bankAccountId))
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.type, "cheque"),
        eq(transactions.status, status),
      ),
    )
    .orderBy(...order);

  return rows.map((r) => ({ ...r, chequeNumber: r.chequeNumber ?? "" }));
}
