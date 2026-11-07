// Statement import/delete rules and the matched-row guard (ledger checks + DB triggers).
// Runs against the database inside a transaction that is always rolled back; all data is synthetic.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { parseStatementFile } from "../../lib/statements/index.ts";
import type { ParsedStatement } from "../../lib/statements/types.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: the tests below are skipped.
}
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

const load = async () => ({
  ...(await import("../db/client.ts")),
  ...(await import("../db/schema.ts")),
  ...(await import("./statements.ts")),
  ...(await import("./transactions.ts")),
  ...(await import("./cheques.ts")),
  ...(await import("./reconcile.ts")),
});

const ADMIN_ID = "4fe23c29-0ab0-43c0-9bfd-a5a296b58841";
const ACCOUNT_NO = "1111222233334444555";

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

// A synthetic NBE statement.
function statement(ref: string, open: string, lines: string[], close: string, account = ACCOUNT_NO): ParsedStatement {
  const text = [
    `{1:F01NBEGEGCX0001111111111}{2:I940XXXXXXXXXXXXN}{3:{108:${ref}}}{4:`,
    `:20:${ref}`,
    `:25:${account}`,
    ":28C:1/1",
    `:60F:${open}`,
    ...lines,
    `:62F:${close}`,
    "-}",
  ].join("\n");
  const r = parseStatementFile(text);
  assert.ok(r.ok, JSON.stringify(r));
  return r.statements[0];
}

const BEFORE_START = [":61:2611011101CP100,00NTRFNONREF//R1", ":86:incoming transfer IPN network from ALPHA~P1"];
const CHEQUE = [":61:2611021102DP50,00NCHKNONREF//R2", ":86:Cheque withdrawal corporate-00100000000123"];
const FEE = [":61:2611031103DP5,00NTRFNONREF//R3", ":86:Outgoing ACH transfer charges via internet banking- TO-Beta"];
const LATER = [":61:2611041104CP20,00NTRFNONREF//R4", ":86:incoming transfer IPN network from GAMMA~P2"];

// Opening balance 1000.00 on 2026-11-02 = the statement balance at the end of 2026-11-01.
const A = () => statement("A1", "C261031EGP900,00", [...BEFORE_START, ...CHEQUE, ...FEE], "C261103EGP945,00");
// Overlaps A on 11-03 (the fee), adds one new line.
const B = () => statement("B1", "C261102EGP950,00", [...FEE, ...LATER], "C261104EGP965,00");
// Leaves 11-05 uncovered.
const C = () => statement("C1", "C261106EGP965,00", [], "C261107EGP965,00");

async function setup(tx: Executor, openingBalanceMinor = 100000) {
  const m = await load();
  const orgId = crypto.randomUUID();
  const user = { id: ADMIN_ID, organizationId: orgId };
  await tx.insert(m.organizations).values({ id: orgId, name: "Statements test" });
  const [account, other] = await tx
    .insert(m.bankAccounts)
    .values([
      { organizationId: orgId, name: "NBE", bankName: "NBE", accountNumber: ACCOUNT_NO,
        openingBalanceMinor, openingDate: "2026-11-02", issuesCheques: true },
      { organizationId: orgId, name: "Other", bankName: "NBE", accountNumber: "999",
        openingBalanceMinor: 0, openingDate: "2026-11-02" },
    ])
    .returning();
  const importIt = (s: ParsedStatement, bankAccountId = account.id) =>
    m.importStatement(user, { bankAccountId, fileName: "test.mt940", rawText: "synthetic", statement: s }, tx);
  return { m, user, account, other, importIt };
}

const rejects = (code: string) => (e: unknown) => (e as { code?: string }).code === code;
// Drizzle wraps the Postgres error (raised by a trigger) in `cause`.
const dbRejects = (pattern: RegExp) => (e: unknown) => pattern.test(String((e as { cause?: Error }).cause?.message));

test("first import stores lines, marks pre-start lines and checks the opening balance", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    assert.equal(await m.findAccountForStatement(user.organizationId, `000${ACCOUNT_NO}`, tx), account.id);

    const { importId, preview } = await importIt(A());
    assert.deepEqual(preview.warnings, []);
    assert.equal(preview.lineCount, 3);
    assert.equal(preview.beforeStartCount, 1);

    const lines = await m.listStatementLines(user.organizationId, importId, null, tx);
    assert.deepEqual(lines.map((l) => [l.lineNo, l.status, l.kind]), [
      [1, "before_start", "incoming_transfer"],
      [2, "unmatched", "cheque"],
      [3, "unmatched", "fee"],
    ]);
    const [row] = await m.listStatementImports(user.organizationId, tx);
    assert.equal(row.unmatched, 2);
    assert.equal(row.before_start, 1);
    assert.equal(row.deletable, true);

    const audit = await tx.select().from(m.auditLog).where(sql`${m.auditLog.bankAccountId} = ${account.id}`);
    assert.deepEqual(audit.map((a) => a.action), ["statement_import"]);
  });
});

test("opening balance mismatch is a warning, never a fix", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx, 99999);
    const preview = await m.previewStatementImport(user, { bankAccountId: account.id, statement: A() }, tx);
    assert.deepEqual(preview.warnings, [
      { code: "openingBalanceMismatch", date: "2026-11-01", appMinor: 99999, statementMinor: 100000 },
    ]);
    await importIt(A());
    const [after] = await tx.select().from(m.bankAccounts).where(sql`${m.bankAccounts.id} = ${account.id}`);
    assert.equal(after.openingBalanceMinor, 99999);
  });
});

test("overlapping statements skip known lines; gaps and repeats are caught", { skip }, async () => {
  await inRollback(async (tx) => {
    const { user, account, importIt, m } = await setup(tx);
    await importIt(A());
    const b = await importIt(B());
    assert.deepEqual(b.preview.warnings, []);
    assert.equal(b.preview.skippedLineCount, 1);
    assert.equal(b.preview.newLineCount, 1);
    const bLines = await m.listStatementLines(user.organizationId, b.importId, null, tx);
    assert.deepEqual(bLines.map((l) => l.lineNo), [2]);

    const c = await importIt(C());
    assert.deepEqual(c.preview.warnings, [{ code: "gap", from: "2026-11-04", to: "2026-11-06" }]);

    // A statement whose balance disagrees with the previous closing balance.
    const bad = statement("D1", "C261103EGP940,00", [...LATER], "C261104EGP960,00");
    const preview = await m.previewStatementImport(user, { bankAccountId: account.id, statement: bad }, tx);
    assert.ok(preview.warnings.some((w) => w.code === "previousBalanceMismatch"));

    await assert.rejects(importIt(A()), rejects("statementAlreadyImported"));
  });
});

test("wrong account, unsupported bank and foreign currency are rejected", { skip }, async () => {
  await inRollback(async (tx) => {
    const { other, importIt } = await setup(tx);
    await assert.rejects(importIt(A(), other.id), rejects("statementAccountMismatch"));
    await assert.rejects(importIt({ ...A(), bank: "cib" }), rejects("statementBankUnsupported"));
    await assert.rejects(importIt({ ...A(), currency: "USD" }), rejects("statementCurrency"));
  });
});

test("imports are deleted newest first, with an audit row", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const a = await importIt(A());
    const b = await importIt(B());
    await assert.rejects(m.deleteImport(user, a.importId, tx), rejects("notLatestImport"));
    await m.deleteImport(user, b.importId, tx);
    await m.deleteImport(user, a.importId, tx);
    assert.deepEqual(await m.listStatementImports(user.organizationId, tx), []);
    const audit = await tx.select().from(m.auditLog).where(sql`${m.auditLog.bankAccountId} = ${account.id}`);
    assert.equal(audit.filter((x) => x.action === "statement_delete").length, 2);
    // Its lines are gone, so the same statement can be imported again.
    await importIt(A());
  });
});

test("a matched row cannot be voided, cancelled or un-cleared, by the ledger or the database", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, other, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    const [, chequeLine, feeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);

    const fee = await m.createMovement(
      user,
      { type: "fee", bankAccountId: account.id, transactionDate: "2026-11-03", amountMinor: 500, description: "Fee", notes: null },
      {},
      tx,
    );
    assert.equal(fee.status, "created");
    const feeId = fee.status === "created" ? fee.ids[0] : "";
    const match = (statementLineId: string, transactionId: string) =>
      tx.insert(m.statementMatches).values({
        organizationId: user.organizationId, statementLineId, transactionId, origin: "matched", createdBy: user.id,
      });
    await match(feeLine.id, feeId);

    await assert.rejects(m.voidTransaction(user, { transactionId: feeId, reason: "x" }, tx), rejects("matchedToStatement"));
    // Bypassing the ledger: the trigger refuses too (savepoint keeps the outer transaction usable).
    await assert.rejects(
      tx.transaction((sp) => sp.update(m.transactions).set({ status: "voided" }).where(sql`${m.transactions.id} = ${feeId}`)),
      dbRejects(/matched to a bank statement line/),
    );
    await assert.rejects(
      tx.transaction((sp) => sp.update(m.transactions).set({ amountMinor: 501 }).where(sql`${m.transactions.id} = ${feeId}`)),
      dbRejects(/matched to a bank statement line/),
    );

    // Cheque: matching an issued cheque may clear it; un-clearing or cancelling is blocked.
    const cheque = await m.createCheque(
      user,
      { bankAccountId: account.id, chequeNumber: "123", partyName: "Payee", transactionDate: "2026-11-02",
        dueDate: null, amountMinor: 5000, notes: null },
      tx,
    );
    await match(chequeLine.id, cheque.id);
    await assert.rejects(m.cancelCheque(user, { transactionId: cheque.id, reason: "x" }, tx), rejects("matchedToStatement"));
    await m.clearCheque(user, { transactionId: cheque.id, clearedDate: "2026-11-02" }, tx);
    await assert.rejects(m.unclearCheque(user, cheque.id, tx), rejects("matchedToStatement"));

    // The trigger refuses matches to voided rows and to rows of another account.
    const voided = await m.createMovement(
      user,
      { type: "fee", bankAccountId: account.id, transactionDate: "2026-11-03", amountMinor: 700, description: "Other", notes: null },
      {},
      tx,
    );
    const voidedId = voided.status === "created" ? voided.ids[0] : "";
    await m.voidTransaction(user, { transactionId: voidedId, reason: "x" }, tx);
    const unmatched = await tx.insert(m.statementLines).values({
      organizationId: user.organizationId, importId, bankAccountId: account.id, lineNo: 99, bookingDate: "2026-11-03",
      valueDate: "2026-11-03", direction: "debit", amountMinor: 700, typeCode: "TRF", customerRef: "NONREF", bankRef: "X",
      description: "x", kind: "fee", lineKey: "test#1", status: "unmatched",
    }).returning();
    await assert.rejects(tx.transaction((sp) => sp.insert(m.statementMatches).values({
      organizationId: user.organizationId, statementLineId: unmatched[0].id, transactionId: voidedId, origin: "matched", createdBy: user.id,
    })), dbRejects(/cannot match a voided transaction/));

    const elsewhere = await m.createMovement(
      user,
      { type: "fee", bankAccountId: other.id, transactionDate: "2026-11-03", amountMinor: 700, description: "Elsewhere", notes: null },
      {},
      tx,
    );
    const elsewhereId = elsewhere.status === "created" ? elsewhere.ids[0] : "";
    await assert.rejects(tx.transaction((sp) => sp.insert(m.statementMatches).values({
      organizationId: user.organizationId, statementLineId: unmatched[0].id, transactionId: elsewhereId, origin: "matched", createdBy: user.id,
    })), dbRejects(/same account/));
  });
});

// ---- Matching (M3) ----

const fee = (m: Awaited<ReturnType<typeof load>>, user: { id: string; organizationId: string }, accountId: string, tx: Executor, date: string, amountMinor = 500) =>
  m.createMovement(user, { type: "fee", bankAccountId: accountId, transactionDate: date, amountMinor, description: "Fee", notes: null }, {}, tx)
    .then((r) => (r.status === "created" ? r.ids[0] : ""));

test("suggest, confirm and unmatch a movement, with audit rows", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    const feeId = await fee(m, user, account.id, tx, "2026-11-04"); // statement says 11-03: 1 day apart
    const [, , feeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);

    const { suggestions } = await m.getImportSuggestions(user.organizationId, importId, tx);
    const s = suggestions.get(feeLine.id)!;
    assert.equal(s.suggested?.transactionId, feeId);
    assert.equal(s.suggested?.dayDiff, 1);
    assert.equal(s.unique, true);

    await m.confirmMatch(user, { lineId: feeLine.id, transactionId: feeId }, tx);
    let [, , after] = await m.listStatementLines(user.organizationId, importId, null, tx);
    assert.equal(after.status, "matched");
    assert.equal(after.matchedId, feeId);
    assert.equal(after.matchOrigin, "matched");
    await assert.rejects(m.confirmMatch(user, { lineId: feeLine.id, transactionId: feeId }, tx), rejects("lineNotUnmatched"));

    await m.unmatchLine(user, feeLine.id, tx);
    [, , after] = await m.listStatementLines(user.organizationId, importId, null, tx);
    assert.equal(after.status, "unmatched");
    assert.equal(after.matchedId, null);
    // The fee can be voided again once unmatched.
    await m.voidTransaction(user, { transactionId: feeId, reason: "x" }, tx);

    const audit = await tx.select().from(m.auditLog).where(sql`${m.auditLog.transactionId} = ${feeId}`);
    assert.deepEqual(audit.map((a) => a.action).sort(), ["create", "statement_match", "statement_unmatch", "void"]);
  });
});

test("rows that do not fit the line are refused, whatever the page sent", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, other, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    const [beforeStart, , feeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);
    const wrongAmount = await fee(m, user, account.id, tx, "2026-11-03", 501);
    const tooLate = await fee(m, user, account.id, tx, "2026-11-08");
    const otherAccount = await fee(m, user, other.id, tx, "2026-11-03");
    for (const transactionId of [wrongAmount, tooLate, otherAccount]) {
      await assert.rejects(m.confirmMatch(user, { lineId: feeLine.id, transactionId }, tx), rejects("notACandidate"));
    }
    // Lines before the start date are not matchable.
    await assert.rejects(m.confirmMatch(user, { lineId: beforeStart.id, transactionId: wrongAmount }, tx), rejects("lineNotUnmatched"));
  });
});

test("matching an issued cheque clears it; deleting the import un-clears it", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    // Our number is the trailing part of the bank's 00100000000123.
    const cheque = await m.createCheque(
      user,
      { bankAccountId: account.id, chequeNumber: "100000000123", partyName: "Payee", transactionDate: "2026-11-02",
        dueDate: null, amountMinor: 5000, notes: null },
      tx,
    );
    const [, chequeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);
    const { suggestions } = await m.getImportSuggestions(user.organizationId, importId, tx);
    assert.equal(suggestions.get(chequeLine.id)?.suggested?.chequeNumberMatch, true);

    const result = await m.confirmMatch(user, { lineId: chequeLine.id, transactionId: cheque.id }, tx);
    assert.equal(result.clearedCheque, true);
    const [cleared] = await tx.select().from(m.transactions).where(sql`${m.transactions.id} = ${cheque.id}`);
    assert.equal(cleared.status, "cleared");
    assert.equal(cleared.clearedDate, "2026-11-02");

    await m.deleteImport(user, importId, tx);
    const [restored] = await tx.select().from(m.transactions).where(sql`${m.transactions.id} = ${cheque.id}`);
    assert.equal(restored.status, "issued");
    assert.equal(restored.clearedDate, null);
    assert.equal((await tx.select().from(m.statementMatches)).filter((x) => x.transactionId === cheque.id).length, 0);
    const actions = (await tx.select().from(m.auditLog).where(sql`${m.auditLog.transactionId} = ${cheque.id}`)).map((a) => a.action);
    assert.deepEqual(actions.sort(), ["clear", "create", "statement_match", "statement_unmatch", "unclear"]);
  });
});

test("a cheque already cleared by hand is matched without changing it", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    const cheque = await m.createCheque(
      user,
      { bankAccountId: account.id, chequeNumber: "100000000123", partyName: "Payee", transactionDate: "2026-11-02",
        dueDate: null, amountMinor: 5000, notes: null },
      tx,
    );
    await m.clearCheque(user, { transactionId: cheque.id, clearedDate: "2026-11-03" }, tx);
    const [, chequeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);
    const result = await m.confirmMatch(user, { lineId: chequeLine.id, transactionId: cheque.id }, tx);
    assert.equal(result.clearedCheque, false);
    await m.unmatchLine(user, chequeLine.id, tx);
    const [still] = await tx.select().from(m.transactions).where(sql`${m.transactions.id} = ${cheque.id}`);
    assert.equal(still.status, "cleared"); // it was cleared by hand, so undo leaves it cleared
  });
});

test("ignore and restore a line; bulk-confirm only sure matches", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const { importId } = await importIt(A());
    const [, chequeLine, feeLine] = await m.listStatementLines(user.organizationId, importId, null, tx);

    await m.ignoreLine(user, { lineId: chequeLine.id, reason: "bank correction" }, tx);
    let lines = await m.listStatementLines(user.organizationId, importId, "ignored", tx);
    assert.deepEqual(lines.map((l) => [l.id, l.ignoreReason]), [[chequeLine.id, "bank correction"]]);
    await m.unignoreLine(user, chequeLine.id, tx);
    await assert.rejects(m.unignoreLine(user, chequeLine.id, tx), rejects("lineNotIgnored"));

    // Two equal fees in the ledger for one fee line: not sure, so not bulk-confirmed.
    await fee(m, user, account.id, tx, "2026-11-03");
    await fee(m, user, account.id, tx, "2026-11-04");
    assert.deepEqual(await m.confirmUniqueSuggestions(user, importId, tx), { confirmed: 0 });
    lines = await m.listStatementLines(user.organizationId, importId, "unmatched", tx);
    assert.ok(lines.some((l) => l.id === feeLine.id));
  });
});
