// Balance contract test: known movements in, exact balances out.
// Runs against the dev database inside a transaction that is always rolled back.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Executor } from "../db/client.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (e.g. CI): the test below is skipped.
}
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

// Imported after the env is loaded: client.ts reads DATABASE_URL on import.
const load = async () => ({
  ...(await import("../db/client.ts")),
  ...(await import("../db/schema.ts")),
  ...(await import("./balances.ts")),
  ...(await import("./ledger.ts")),
  ...(await import("./transactions.ts")),
});

// Any existing auth user can author rows; the test org isolates the data.
const ADMIN_ID = "4fe23c29-0ab0-43c0-9bfd-a5a296b58841";

class Rollback extends Error {}

// Runs fn inside a transaction that is rolled back afterwards, whatever happens.
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

test("book and bank balances and every running balance are exact", { skip }, async () => {
  const m = await load();
  await inRollback(async (tx) => {
    const orgId = crypto.randomUUID();
    const user = { id: ADMIN_ID, organizationId: orgId };
    await tx.insert(m.organizations).values({ id: orgId, name: "Contract test" });
    const [a, b] = await tx
      .insert(m.bankAccounts)
      .values([
        { organizationId: orgId, name: "A", bankName: "Test", accountNumber: "1",
          openingBalanceMinor: 100000, openingDate: "2026-01-01", issuesCheques: true },
        { organizationId: orgId, name: "B", bankName: "Test", accountNumber: "2",
          openingBalanceMinor: 0, openingDate: "2026-01-01" },
      ])
      .returning();

    const move = (type: "transfer_in" | "deposit" | "fee", date: string, amountMinor: number) =>
      m.createMovement(
        user,
        type === "transfer_in"
          ? { type, bankAccountId: a.id, transactionDate: date, amountMinor,
              partyName: "P", reference: date, notes: null }
          : { type, bankAccountId: a.id, transactionDate: date, amountMinor,
              description: "D", notes: null },
        {},
        tx,
      );
    await move("transfer_in", "2026-01-05", 50000); //   +500.00
    await move("fee", "2026-01-06", 2550); //            -25.50
    const deposit = await move("deposit", "2026-01-07", 100000); // voided below
    await m.createInternalTransfer(
      user,
      { fromAccountId: a.id, toAccountId: b.id, transactionDate: "2026-01-08",
        amountMinor: 20000, notes: null },
      tx,
    ); //                                                 -200.00 on A, +200.00 on B
    await move("transfer_in", "2026-01-09", 1); //        +0.01
    assert.equal(deposit.status, "created");
    if (deposit.status === "created") {
      await m.voidTransaction(user, { transactionId: deposit.ids[0], reason: "test" }, tx);
    }

    // Cheques (written directly until M3): issued counts in book only,
    // cleared counts in both, cancelled counts in neither.
    const cheque = { organizationId: orgId, bankAccountId: a.id, type: "cheque" as const,
      createdBy: ADMIN_ID, updatedBy: ADMIN_ID };
    await tx.insert(m.transactions).values([
      { ...cheque, chequeNumber: "1", amountMinor: 30000, transactionDate: "2026-01-10",
        status: "issued" },
      { ...cheque, chequeNumber: "2", amountMinor: 10000, transactionDate: "2026-01-11",
        status: "cleared", clearedDate: "2026-01-15" },
      { ...cheque, chequeNumber: "3", amountMinor: 99900, transactionDate: "2026-01-12",
        status: "cancelled" },
    ]);

    const balances = await m.getAccountBalances(orgId, tx);
    const balA = balances.find((x) => x.id === a.id)!;
    const balB = balances.find((x) => x.id === b.id)!;
    // 1000.00 + 500.00 - 25.50 - 200.00 + 0.01 - 300.00 (issued) - 100.00 (cleared)
    assert.equal(balA.bookBalanceMinor, 87451);
    // Same, without the issued cheque.
    assert.equal(balA.bankBalanceMinor, 117451);
    assert.equal(balB.bookBalanceMinor, 20000);
    assert.equal(balB.bankBalanceMinor, 20000);

    // Newest first; voided and cancelled rows keep the previous balance.
    const ledger = await m.getAccountLedger(orgId, a.id, tx);
    assert.deepEqual(
      ledger.map((r) => [r.transactionDate, r.type, r.status, r.runningBalanceMinor]),
      [
        ["2026-01-12", "cheque", "cancelled", 87451],
        ["2026-01-11", "cheque", "cleared", 87451],
        ["2026-01-10", "cheque", "issued", 97451],
        ["2026-01-09", "transfer_in", "active", 127451],
        ["2026-01-08", "internal_out", "active", 127450],
        ["2026-01-07", "deposit", "voided", 147450],
        ["2026-01-06", "fee", "active", 147450],
        ["2026-01-05", "transfer_in", "active", 150000],
      ],
    );
    assert.equal(ledger.find((r) => r.type === "internal_out")?.counterpartName, "B");
  });
});

test("voiding one half of an internal transfer voids both and restores balances", { skip }, async () => {
  const m = await load();
  await inRollback(async (tx) => {
    const orgId = crypto.randomUUID();
    const user = { id: ADMIN_ID, organizationId: orgId };
    await tx.insert(m.organizations).values({ id: orgId, name: "Contract test" });
    const [a, b] = await tx
      .insert(m.bankAccounts)
      .values([
        { organizationId: orgId, name: "A", bankName: "T", accountNumber: "1",
          openingBalanceMinor: 5000, openingDate: "2026-01-01" },
        { organizationId: orgId, name: "B", bankName: "T", accountNumber: "2",
          openingBalanceMinor: 0, openingDate: "2026-01-01" },
      ])
      .returning();
    const pair = await m.createInternalTransfer(
      user,
      { fromAccountId: a.id, toAccountId: b.id, transactionDate: "2026-01-02",
        amountMinor: 1500, notes: null },
      tx,
    );
    assert.equal(pair.status, "created");
    if (pair.status !== "created") return;

    // Void the incoming half: the outgoing half goes with it.
    const voided = await m.voidTransaction(user, { transactionId: pair.ids[1], reason: "x" }, tx);
    assert.equal(voided.voidedIds.length, 2);

    const balances = await m.getAccountBalances(orgId, tx);
    assert.equal(balances.find((x) => x.id === a.id)!.bookBalanceMinor, 5000);
    assert.equal(balances.find((x) => x.id === b.id)!.bookBalanceMinor, 0);
  });
});

test("cheque lifecycle: issue, number rules, clear, cancel, undo clear", { skip }, async () => {
  const m = await load();
  const c = await import("./cheques.ts");
  await inRollback(async (tx) => {
    const orgId = crypto.randomUUID();
    const user = { id: ADMIN_ID, organizationId: orgId };
    await tx.insert(m.organizations).values({ id: orgId, name: "Contract test" });
    const [a, noCheques] = await tx
      .insert(m.bankAccounts)
      .values([
        { organizationId: orgId, name: "A", bankName: "T", accountNumber: "1",
          openingBalanceMinor: 100000, openingDate: "2026-01-01", issuesCheques: true },
        { organizationId: orgId, name: "N", bankName: "T", accountNumber: "2",
          openingBalanceMinor: 0, openingDate: "2026-01-01", issuesCheques: false },
      ])
      .returning();
    const cheque = (chequeNumber: string, amountMinor: number, bankAccountId = a.id) =>
      c.createCheque(
        user,
        { bankAccountId, chequeNumber, partyName: "Supplier", transactionDate: "2026-02-01",
          dueDate: "2026-02-15", amountMinor, notes: null },
        tx,
      );
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "no error";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };

    const first = await cheque("000123", 30000);
    const second = await cheque("000124", 20000);
    assert.equal(await code(() => cheque("000124", 1)), "chequeNumberTaken");
    assert.equal(await code(() => cheque("9", 1, noCheques.id)), "accountNoCheques");
    assert.deepEqual(await c.suggestChequeNumbers(orgId, tx), { [a.id]: "000125" });

    let bal = (await m.getAccountBalances(orgId, tx)).find((x) => x.id === a.id)!;
    assert.equal(bal.bookBalanceMinor, 50000); // 1000 - 300 - 200
    assert.equal(bal.bankBalanceMinor, 100000); // nothing cashed yet
    assert.equal(bal.outstandingChequesMinor, 50000);

    assert.equal(
      await code(() => c.clearCheque(user, { transactionId: first.id, clearedDate: "2026-01-31" }, tx)),
      "clearedBeforeIssue",
    );
    await c.clearCheque(user, { transactionId: first.id, clearedDate: "2026-02-20" }, tx);
    assert.equal(
      await code(() => c.cancelCheque(user, { transactionId: first.id, reason: "x" }, tx)),
      "notIssued",
    );
    await c.cancelCheque(user, { transactionId: second.id, reason: "Wrong payee" }, tx);

    bal = (await m.getAccountBalances(orgId, tx)).find((x) => x.id === a.id)!;
    assert.equal(bal.bookBalanceMinor, 70000); // cancelled counts nowhere
    assert.equal(bal.bankBalanceMinor, 70000); // cleared counts in both
    assert.equal(bal.outstandingChequesMinor, 0);

    assert.deepEqual(
      (await c.listCheques(orgId, "cleared", tx)).map((r) => [r.chequeNumber, r.clearedDate]),
      [["000123", "2026-02-20"]],
    );

    await c.unclearCheque(user, first.id, tx);
    bal = (await m.getAccountBalances(orgId, tx)).find((x) => x.id === a.id)!;
    assert.equal(bal.bankBalanceMinor, 100000);
    assert.equal(bal.outstandingChequesMinor, 30000);
    assert.equal(
      (await c.listCheques(orgId, "issued", tx))[0].dueDate,
      "2026-02-15",
    );
  });
});
