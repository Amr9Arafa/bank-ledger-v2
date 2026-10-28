// All writes to money movements. Every write runs in one DB transaction with its audit row.
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  InternalTransferInput,
  MovementInput,
  VoidInput,
} from "../../lib/validation.ts";
import { db, type Executor } from "../db/client.ts";
import { bankAccounts, transactions } from "../db/schema.ts";
import { writeAudit } from "./audit.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

export type CreateResult =
  | { status: "created"; ids: string[] }
  // FR-4: a likely duplicate exists; the user may confirm and save anyway.
  | { status: "duplicate"; existingId: string };

// An active account of the user's organization, valid for a movement on `date`.
async function loadAccountFor(
  tx: Executor,
  user: LedgerUser,
  accountId: string,
  date: string,
  field: string,
) {
  const [account] = await tx
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, accountId),
        eq(bankAccounts.organizationId, user.organizationId),
      ),
    );
  if (!account) throw new LedgerError("accountNotFound", field);
  if (account.archivedAt) throw new LedgerError("accountArchived", field);
  // "YYYY-MM-DD" strings compare correctly as text.
  if (date < account.openingDate) {
    throw new LedgerError("beforeOpeningDate", "transactionDate");
  }
  return account;
}

// Incoming transfer, outgoing transfer or bank fee.
export async function createMovement(
  user: LedgerUser,
  input: MovementInput,
  options: { allowDuplicate?: boolean } = {},
  database: Executor = db,
): Promise<CreateResult> {
  return database.transaction(async (tx) => {
    const account = await loadAccountFor(
      tx,
      user,
      input.bankAccountId,
      input.transactionDate,
      "bankAccountId",
    );

    if (input.type === "transfer_in" && !account.receivesTransfers) {
      throw new LedgerError("accountNoTransfers", "bankAccountId");
    }

    // FR-4: same account, direction, amount, date and reference is likely a duplicate.
    if (input.type !== "fee" && !options.allowDuplicate) {
      const [existing] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, user.organizationId),
            eq(transactions.bankAccountId, input.bankAccountId),
            eq(transactions.type, input.type),
            eq(transactions.status, "active"),
            eq(transactions.amountMinor, input.amountMinor),
            eq(transactions.transactionDate, input.transactionDate),
            // "is not distinct from" treats two empty references as equal.
            sql`${transactions.reference} is not distinct from ${input.reference}`,
          ),
        )
        .limit(1);
      if (existing) return { status: "duplicate", existingId: existing.id };
    }

    const [row] = await tx
      .insert(transactions)
      .values({
        organizationId: user.organizationId,
        bankAccountId: input.bankAccountId,
        type: input.type,
        amountMinor: input.amountMinor,
        transactionDate: input.transactionDate,
        status: "active",
        notes: input.notes,
        ...(input.type === "fee"
          ? { description: input.description }
          : { partyName: input.partyName, reference: input.reference }),
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
    return { status: "created", ids: [row.id] };
  });
}

// Money moved between two of our own accounts: one debit and one credit, always together.
export async function createInternalTransfer(
  user: LedgerUser,
  input: InternalTransferInput,
  database: Executor = db,
): Promise<CreateResult> {
  return database.transaction(async (tx) => {
    await loadAccountFor(tx, user, input.fromAccountId, input.transactionDate, "fromAccountId");
    await loadAccountFor(tx, user, input.toAccountId, input.transactionDate, "toAccountId");

    const common = {
      organizationId: user.organizationId,
      amountMinor: input.amountMinor,
      transactionDate: input.transactionDate,
      status: "active" as const,
      transferGroupId: crypto.randomUUID(),
      notes: input.notes,
      createdBy: user.id,
      updatedBy: user.id,
    };
    const rows = await tx
      .insert(transactions)
      .values([
        { ...common, bankAccountId: input.fromAccountId, type: "internal_out" },
        { ...common, bankAccountId: input.toAccountId, type: "internal_in" },
      ])
      .returning();

    for (const row of rows) {
      await writeAudit(tx, user, {
        action: "create",
        transactionId: row.id,
        before: null,
        after: row,
      });
    }
    return { status: "created", ids: rows.map((r) => r.id) };
  });
}

// Records are never deleted: a mistake is voided. Voiding one half of an
// internal transfer voids both. Cheques are cancelled instead (M3).
export async function voidTransaction(
  user: LedgerUser,
  input: VoidInput,
  database: Executor = db,
): Promise<{ voidedIds: string[] }> {
  return database.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, input.transactionId),
          eq(transactions.organizationId, user.organizationId),
        ),
      );
    if (!target) throw new LedgerError("transactionNotFound");
    if (target.type === "cheque") throw new LedgerError("chequeUseCancel");

    const before = target.transferGroupId
      ? await tx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.transferGroupId, target.transferGroupId),
              eq(transactions.organizationId, user.organizationId),
            ),
          )
      : [target];

    // Only active rows change: a concurrent second void updates nothing.
    const after = await tx
      .update(transactions)
      .set({
        status: "voided",
        statusReason: input.reason,
        updatedBy: user.id,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(
            transactions.id,
            before.map((r) => r.id),
          ),
          eq(transactions.status, "active"),
        ),
      )
      .returning();
    if (after.length !== before.length) throw new LedgerError("notActive");

    for (const row of after) {
      await writeAudit(tx, user, {
        action: "void",
        transactionId: row.id,
        before: before.find((b) => b.id === row.id),
        after: row,
      });
    }
    return { voidedIds: after.map((r) => r.id) };
  });
}

// Names already used as sender, beneficiary or payee, most recently used first.
// Stands in for a counterparties table until one exists.
export async function listCounterparties(
  organizationId: string,
  limit = 200,
  database: Executor = db,
): Promise<string[]> {
  const rows = await database.execute<{ party_name: string }>(sql`
    select party_name from transactions
    where organization_id = ${organizationId} and party_name is not null
    group by party_name
    order by max(created_at) desc
    limit ${limit}
  `);
  return rows.map((r) => r.party_name);
}
