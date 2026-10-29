// AI Inbox approval contract: approving creates the record and marks the entry in one
// transaction; a failure leaves the entry pending with nothing created.
// Runs against the dev database inside a transaction that is always rolled back.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Executor } from "../db/client.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (e.g. CI): the tests below are skipped.
}
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

// Imported after the env is loaded: client.ts reads DATABASE_URL on import.
const load = async () => ({
  ...(await import("drizzle-orm")),
  ...(await import("../db/client.ts")),
  ...(await import("../db/schema.ts")),
  ...(await import("./pendingEntries.ts")),
  ...(await import("./types.ts")),
});

// Any existing auth user can author rows; the test org isolates the data.
const ADMIN_ID = "4fe23c29-0ab0-43c0-9bfd-a5a296b58841";

class Rollback extends Error {}

async function inRollback(fn: (tx: Executor) => Promise<void>) {
  const { db } = await load();
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(async () => {
  if (!skip) await (await load()).closeDatabase();
});

// A test organization with one account that takes transfers and issues cheques.
async function setup(tx: Executor) {
  const m = await load();
  const orgId = crypto.randomUUID();
  const user = { id: ADMIN_ID, organizationId: orgId };
  await tx.insert(m.organizations).values({ id: orgId, name: "Inbox test" });
  const [account] = await tx
    .insert(m.bankAccounts)
    .values({ organizationId: orgId, name: "A", bankName: "Test", accountNumber: "1",
      openingBalanceMinor: 0, openingDate: "2026-01-01", issuesCheques: true })
    .returning();
  const entry = (type: "transaction" | "cheque", imagePath: string | null = null) =>
    m.createPendingEntry(
      user,
      { id: crypto.randomUUID(), type, source: "web", rawText: "test", imagePath,
        extracted: {}, warnings: [] },
      tx,
    );
  const movement = {
    type: "transaction" as const,
    movement: { type: "transfer_in" as const, bankAccountId: account.id,
      transactionDate: "2026-02-01", amountMinor: 1500000, partyName: "Al Nour",
      reference: null, notes: null },
  };
  const cheque = {
    type: "cheque" as const,
    cheque: { bankAccountId: account.id, chequeNumber: "000124", partyName: "Al Huda",
      transactionDate: "2026-02-01", dueDate: null, amountMinor: 320000, notes: null },
  };
  return { m, user, orgId, account, entry, movement, cheque };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const { LedgerError } = await load();
  await assert.rejects(promise, (e) => e instanceof LedgerError && e.code === code);
}

test("approve creates the movement, its audit row, and marks the entry", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, entry, movement } = await setup(tx);
    const e = await entry("transaction");
    const result = await m.approvePendingEntry(user, e.id, movement, {}, tx);
    assert.equal(result.status, "approved");
    if (result.status !== "approved") return;

    const [row] = await tx.select().from(m.transactions).where(m.eq(m.transactions.id, result.recordId));
    assert.equal(row.type, "transfer_in");
    assert.equal(row.status, "active");
    assert.equal(row.amountMinor, 1500000);

    const audit = await tx.select().from(m.auditLog).where(m.eq(m.auditLog.transactionId, row.id));
    assert.equal(audit.length, 1);

    const [after] = await tx.select().from(m.pendingEntries).where(m.eq(m.pendingEntries.id, e.id));
    assert.equal(after.status, "approved");
    assert.equal(after.reviewedBy, ADMIN_ID);
    assert.equal(after.resultingRecordId, row.id);

    // A second approve (e.g. a double click) creates nothing.
    await rejectsWith(m.approvePendingEntry(user, e.id, movement, {}, tx), "entryNotPending");
  });
});

test("approve creates an issued cheque", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, entry, cheque } = await setup(tx);
    const e = await entry("cheque");
    const result = await m.approvePendingEntry(user, e.id, cheque, {}, tx);
    assert.equal(result.status, "approved");
    if (result.status !== "approved") return;
    const [row] = await tx.select().from(m.transactions).where(m.eq(m.transactions.id, result.recordId));
    assert.equal(row.type, "cheque");
    assert.equal(row.status, "issued");
    assert.equal(row.chequeNumber, "000124");
  });
});

test("a failed approve leaves the entry pending and creates nothing", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, entry, cheque } = await setup(tx);
    const first = await entry("cheque");
    await m.approvePendingEntry(user, first.id, cheque, {}, tx);

    // Same cheque number on the same account: the ledger refuses it.
    const second = await entry("cheque");
    await rejectsWith(m.approvePendingEntry(user, second.id, cheque, {}, tx), "chequeNumberTaken");
    const [after] = await tx.select().from(m.pendingEntries).where(m.eq(m.pendingEntries.id, second.id));
    assert.equal(after.status, "pending");
    assert.equal(after.resultingRecordId, null);
    const cheques = await tx.select().from(m.transactions).where(m.eq(m.transactions.bankAccountId, account.id));
    assert.equal(cheques.length, 1);
  });
});

test("a likely duplicate waits for confirmation", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, entry, movement } = await setup(tx);
    await m.approvePendingEntry(user, (await entry("transaction")).id, movement, {}, tx);

    const e = await entry("transaction");
    const result = await m.approvePendingEntry(user, e.id, movement, {}, tx);
    assert.equal(result.status, "duplicate");
    const [still] = await tx.select().from(m.pendingEntries).where(m.eq(m.pendingEntries.id, e.id));
    assert.equal(still.status, "pending");

    const confirmed = await m.approvePendingEntry(user, e.id, movement, { allowDuplicate: true }, tx);
    assert.equal(confirmed.status, "approved");
  });
});

test("another organization, or the wrong kind, cannot approve the entry", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, entry, movement, cheque } = await setup(tx);
    const e = await entry("transaction");
    const stranger = { id: ADMIN_ID, organizationId: crypto.randomUUID() };
    await rejectsWith(m.approvePendingEntry(stranger, e.id, movement, {}, tx), "entryNotFound");
    await rejectsWith(m.approvePendingEntry(user, e.id, cheque, {}, tx), "entryNotFound");
  });
});

test("reject marks the entry, clears the photo path and returns it", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, orgId, entry, movement } = await setup(tx);
    const e = await entry("cheque", `${orgId}/photo.jpg`);
    const { imagePath } = await m.rejectPendingEntry(user, e.id, tx);
    assert.equal(imagePath, `${orgId}/photo.jpg`);

    const [after] = await tx.select().from(m.pendingEntries).where(m.eq(m.pendingEntries.id, e.id));
    assert.equal(after.status, "rejected");
    assert.equal(after.imageUrl, null);
    assert.equal(after.reviewedBy, ADMIN_ID);
    assert.equal(await m.countPendingEntries(orgId, tx), 0);

    await rejectsWith(m.rejectPendingEntry(user, e.id, tx), "entryNotPending");
    await rejectsWith(m.approvePendingEntry(user, e.id, movement, {}, tx), "entryNotPending");
  });
});
