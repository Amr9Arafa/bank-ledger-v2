// Statement import/delete rules and the matched-row guard (ledger checks + DB triggers).
// Runs against the database inside a transaction that is always rolled back; all data is synthetic.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { parseStatementFile } from "../../lib/statements/index.ts";
import { chequeSerial } from "../../lib/statements/match.ts";
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
  ...(await import("./balances.ts")),
  ...(await import("./bankAccounts.ts")),
  ...(await import("./statementChecks.ts")),
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

// The file text of each synthetic statement, stored as the import's raw text (the live
// continuity checks read it back).
const sourceText = new Map<string, string>();

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
  sourceText.set(ref, text);
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
    m.importStatement(user, { bankAccountId, fileName: "test.mt940", rawText: sourceText.get(s.statementRef) ?? "", statement: s }, tx);
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
    await assert.rejects(importIt({ ...A(), bank: "unknown" }), rejects("statementBankUnsupported"));
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
    // Dated a day after the bank booked it: suggested, but never a sure (bulk) match.
    assert.equal(s.unique, false);

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

// ---- Creating records from lines (M4) ----

// One line of each kind, on/after the start date. Balance at end of 11-01 = 1000.00.
const M4 = () =>
  statement(
    "M4",
    "C261101EGP1000,00",
    [
      ":61:2611021102DP50,00NCHKNONREF//R2", ":86:Cheque withdrawal--07800000208123",
      ":61:2611031103DP5,00NTRFNONREF//R3", ":86:Outgoing ACH transfer charges via internet banking- TO-Delta",
      ":61:2611031103CP0,25NINTNONREF//INT 1", ":86:Credit interest-1111",
      ":61:2611041103CP0,30NINTNONREF//INT 1", ":86:interest adjustment-1111",
      ":61:2611041104DP100,00NMSCNONREF//078FTNU1", ":86:Account to Account Transfer-From-US To-US TOO~PC1",
      ":61:2611051105CP20,00NTRFNONREF//078FTIC2", ":86:incoming transfer IPN network from GAMMA~P2",
      ":61:2611051105DP30,00NTRFNONREF//078OPDB3", ":86:outgoing ACH transfer through internet banking- TO-Delta",
    ],
    "C261105EGP835,55",
  );
// The other account's side of the internal transfer.
const OTHER_SIDE = () =>
  statement(
    "O1",
    "C261101EGP0,00",
    [":61:2611041104CP100,00NMSCNONREF//078FTNU1", ":86:Account to Account Transfer-From-US To-US TOO~PC1"],
    "C261104EGP100,00",
    "999",
  );

const rowOf = async (m: Awaited<ReturnType<typeof load>>, tx: Executor, id: string) =>
  (await tx.select().from(m.transactions).where(sql`${m.transactions.id} = ${id}`))[0];

test("create every kind of record from statement lines, then delete the import to undo all", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, other, importIt } = await setup(tx);
    const { importId } = await importIt(M4());
    const [cheque, feeL, int1, int2, internal, incoming, outgoing] = await m.listStatementLines(user.organizationId, importId, null, tx);

    const create = async (input: Parameters<typeof m.createFromLine>[1]) => (await m.createFromLine(user, input, tx)).transactionId;
    const ids = [
      await create({ lineId: cheque.id, type: "cheque", chequeNumber: chequeSerial(cheque.chequeRef!, "nbe"), partyName: "Old payee", notes: "issued before start date" }),
      await create({ lineId: feeL.id, type: "fee", description: feeL.description, notes: null }),
      await create({ lineId: int1.id, type: "interest", description: int1.description, notes: null }),
      await create({ lineId: internal.id, type: "internal", otherAccountId: other.id, notes: null }),
      await create({ lineId: incoming.id, type: "transfer_in", partyName: "Customer G", notes: null }),
      await create({ lineId: outgoing.id, type: "transfer_out", partyName: "Delta", notes: null }),
    ];
    const rows = await Promise.all(ids.map((id) => rowOf(m, tx, id)));
    assert.deepEqual(
      rows.map((r) => [r.type, r.status, r.amountMinor, r.transactionDate]),
      [
        ["cheque", "cleared", 5000, "2026-11-02"],
        ["fee", "active", 500, "2026-11-03"],
        ["interest", "active", 25, "2026-11-03"],
        ["internal_out", "active", 10000, "2026-11-04"],
        ["transfer_in", "active", 2000, "2026-11-05"],
        ["transfer_out", "active", 3000, "2026-11-05"],
      ],
    );
    assert.equal(rows[0].clearedDate, "2026-11-02");
    assert.equal(rows[0].chequeNumber, "208123"); // the serial, as printed on the cheque
    assert.equal(rows[4].reference, "078FTIC2");
    assert.equal(rows[2].description, "Credit interest-1111");
    // The internal transfer's other half is on the other account.
    const pair = await tx.select().from(m.transactions).where(sql`${m.transactions.transferGroupId} = ${rows[3].transferGroupId}`);
    assert.deepEqual(pair.map((r) => [r.type, r.bankAccountId]).sort(), [["internal_in", other.id], ["internal_out", account.id]]);

    // Interest counts as a credit: 1000 - 50 - 5 + 0.25 - 100 + 20 - 30 = 835.25.
    const balanceOf = async () => (await m.getAccountBalances(user.organizationId, tx)).find((b) => b.id === account.id)!;
    assert.equal((await balanceOf()).bankBalanceMinor, 83525);
    assert.equal(int2.status, "unmatched");
    assert.equal((await m.listStatementLines(user.organizationId, importId, "created", tx)).length, 6);

    // Deleting the import voids/cancels every created record; nothing is hard-deleted.
    await m.deleteImport(user, importId, tx);
    const after = await Promise.all([...ids, ...pair.map((p) => p.id)].map((id) => rowOf(m, tx, id)));
    assert.deepEqual(after.map((r) => r.status), ["cancelled", "voided", "voided", "voided", "voided", "voided", "voided", "voided"]);
    assert.equal(after[0].clearedDate, null);
    const back = await balanceOf();
    assert.equal(back.bankBalanceMinor, 100000);
    assert.equal(back.bookBalanceMinor, 100000);
  });
});

test("undoing an internal transfer created from one statement unmatches the other account's line", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, other, importIt } = await setup(tx);
    const { importId } = await importIt(M4());
    const internal = (await m.listStatementLines(user.organizationId, importId, null, tx))[4];
    const { transactionId } = await m.createFromLine(user, { lineId: internal.id, type: "internal", otherAccountId: other.id, notes: null }, tx);

    // The other account's statement: its line is suggested the internal_in half; confirm it.
    const otherImport = await importIt(OTHER_SIDE(), other.id);
    const [otherLine] = await m.listStatementLines(user.organizationId, otherImport.importId, null, tx);
    const { suggestions } = await m.getImportSuggestions(user.organizationId, otherImport.importId, tx);
    const half = suggestions.get(otherLine.id)!.suggested!.transactionId;
    await m.confirmMatch(user, { lineId: otherLine.id, transactionId: half }, tx);

    // Voiding the pair by hand is refused while matched...
    await assert.rejects(m.voidTransaction(user, { transactionId, reason: "x" }, tx), rejects("matchedToStatement"));
    // ...but undoing the created line unmatches the other side and voids both halves.
    await m.unmatchLine(user, internal.id, tx);
    assert.equal((await rowOf(m, tx, transactionId)).status, "voided");
    assert.equal((await rowOf(m, tx, half)).status, "voided");
    const [otherAfter] = await m.listStatementLines(user.organizationId, otherImport.importId, null, tx);
    assert.equal(otherAfter.status, "unmatched");
  });
});

test("bulk creates fees and interest only for lines with no possible record", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    const { importId } = await importIt(M4());
    // A fee already in the app for the fee line: bulk must leave that line for review.
    await fee(m, user, account.id, tx, "2026-11-03");
    assert.deepEqual(await m.createAllFromImport(user, { importId, kind: "fee" }, tx), { created: 0 });
    assert.deepEqual(await m.createAllFromImport(user, { importId, kind: "interest" }, tx), { created: 2 });
    const created = await m.listStatementLines(user.organizationId, importId, "created", tx);
    assert.deepEqual(created.map((l) => [l.kind, l.matchedType]), [["interest", "interest"], ["interest", "interest"]]);
    assert.deepEqual(await m.createAllFromImport(user, { importId, kind: "interest" }, tx), { created: 0 });
  });
});

test("a record type must fit the line's direction", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, importIt } = await setup(tx);
    const { importId } = await importIt(M4());
    const [cheque, , int1] = await m.listStatementLines(user.organizationId, importId, null, tx);
    await assert.rejects(m.createFromLine(user, { lineId: int1.id, type: "fee", description: "x", notes: null }, tx), rejects("typeNotForLine"));
    await assert.rejects(m.createFromLine(user, { lineId: cheque.id, type: "transfer_in", partyName: "x", notes: null }, tx), rejects("typeNotForLine"));
  });
});

test("an old cheque can be created again after its import was deleted and re-imported", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, importIt } = await setup(tx);
    const createOldCheque = async () => {
      const { importId } = await importIt(M4());
      const [cheque] = await m.listStatementLines(user.organizationId, importId, null, tx);
      await m.createFromLine(user, { lineId: cheque.id, type: "cheque", chequeNumber: chequeSerial(cheque.chequeRef!, "nbe"), partyName: "P", notes: null }, tx);
      return importId;
    };
    await m.deleteImport(user, await createOldCheque(), tx);
    await createOldCheque(); // the first cheque is cancelled; its number must be usable again
  });
});

// ---- Continuity and reconciliation (M5) ----

// Creates the default record for every unmatched line of an import.
async function createAll(m: Awaited<ReturnType<typeof load>>, user: { id: string; organizationId: string }, importId: string, tx: Executor, otherAccountId: string) {
  for (const l of await m.listStatementLines(user.organizationId, importId, "unmatched", tx)) {
    const input =
      l.kind === "cheque" ? { lineId: l.id, type: "cheque" as const, chequeNumber: chequeSerial(l.chequeRef!, "nbe"), partyName: "P", notes: null }
      : l.kind === "fee" || l.kind === "interest" ? { lineId: l.id, type: l.kind, description: l.description, notes: null }
      : l.kind === "account_transfer" ? { lineId: l.id, type: "internal" as const, otherAccountId, notes: null }
      : { lineId: l.id, type: l.direction === "credit" ? ("transfer_in" as const) : ("transfer_out" as const), partyName: "X", notes: null };
    await m.createFromLine(user, input, tx);
  }
}

test("bank balance on a date counts cheques on the day they cleared", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account } = await setup(tx);
    await fee(m, user, account.id, tx, "2026-11-03");
    const cheque = await m.createCheque(user, { bankAccountId: account.id, chequeNumber: "208001", partyName: "P", transactionDate: "2026-11-02", dueDate: null, amountMinor: 5000, notes: null }, tx);
    await m.clearCheque(user, { transactionId: cheque.id, clearedDate: "2026-11-05" }, tx);
    const voided = await m.createMovement(user, { type: "transfer_in", bankAccountId: account.id, transactionDate: "2026-11-04", amountMinor: 9999, partyName: "V", reference: null, notes: null }, {}, tx);
    await m.voidTransaction(user, { transactionId: voided.status === "created" ? voided.ids[0] : "", reason: "x" }, tx);
    const asOf = (d: string) => m.getBankBalanceAsOf(user.organizationId, account.id, d, tx);
    assert.deepEqual([await asOf("2026-11-01"), await asOf("2026-11-03"), await asOf("2026-11-04"), await asOf("2026-11-05")], [100000, 99500, 99500, 94500]);
  });
});

test("closing check explains the difference and is zero once every line is accounted for", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, other, account, importIt } = await setup(tx);
    const { importId } = await importIt(M4());

    // Nothing in the app yet: the whole difference is lines the app is missing.
    let c = await m.closingCheck(user.organizationId, importId, tx);
    assert.deepEqual([c.bankMinor, c.appMinor, c.differenceMinor], [83555, 100000, 16445]);
    assert.deepEqual(c.bankOnly, { count: 7, totalMinor: -16445 });
    assert.equal(c.unexplainedMinor, 0);
    assert.equal(c.reconciled, false);

    await createAll(m, user, importId, tx, other.id);
    c = await m.closingCheck(user.organizationId, importId, tx);
    assert.deepEqual([c.differenceMinor, c.unexplainedMinor, c.unmatchedInImport, c.reconciled], [0, 0, 0, true]);

    // A payment in the app that the bank has not booked yet: explained, still reconciled.
    await fee(m, user, account.id, tx, "2026-11-05", 700);
    c = await m.closingCheck(user.organizationId, importId, tx);
    assert.equal(c.differenceMinor, -700);
    assert.equal(c.appOnly.totalMinor, -700);
    assert.equal(c.appOnly.rows.length, 1);
    assert.equal(c.reconciled, true);
  });
});

test("timing: a match whose app date is after the closing date", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, other, importIt } = await setup(tx);
    const a = await importIt(A());
    await createAll(m, user, a.importId, tx, other.id);
    const b = await importIt(B()); // closes 11-04; its only new line is the 20.00 booked 11-04
    // The app recorded that transfer on 11-06, after the statement's closing date.
    const r = await m.createMovement(user, { type: "transfer_in", bankAccountId: account.id, transactionDate: "2026-11-06", amountMinor: 2000, partyName: "GAMMA", reference: null, notes: null }, {}, tx);
    const [line] = await m.listStatementLines(user.organizationId, b.importId, null, tx);
    await m.confirmMatch(user, { lineId: line.id, transactionId: r.status === "created" ? r.ids[0] : "" }, tx);

    const c = await m.closingCheck(user.organizationId, b.importId, tx);
    assert.deepEqual([c.bankMinor, c.appMinor, c.differenceMinor], [96500, 94500, -2000]);
    assert.deepEqual(c.timing, { count: 1, totalMinor: -2000 });
    assert.equal(c.unexplainedMinor, 0);
    assert.equal(c.reconciled, true);
  });
});

test("a wrong opening balance or a gap shows as unexplained and stops 'reconciled until'", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, other, account, importIt } = await setup(tx);
    const a = await importIt(A());
    await createAll(m, user, a.importId, tx, other.id);
    let [rec] = (await m.accountReconciliation(user.organizationId, tx)).filter((r) => r.accountId === account.id);
    assert.equal(rec.reconciledUntil, "2026-11-03");
    assert.equal(rec.coveredUntil, "2026-11-03");
    assert.deepEqual(rec.gaps, []);

    const c = await importIt(C()); // starts 11-06: 11-04 and 11-05 are not covered
    assert.deepEqual(await m.importWarnings(user.organizationId, c.importId, tx), [{ code: "gap", from: "2026-11-03", to: "2026-11-06" }]);
    assert.deepEqual(await m.importWarnings(user.organizationId, a.importId, tx), []);
    [rec] = (await m.accountReconciliation(user.organizationId, tx)).filter((r) => r.accountId === account.id);
    assert.deepEqual(rec.gaps, [{ from: "2026-11-03", to: "2026-11-06" }]);
    assert.equal(rec.reconciledUntil, "2026-11-03");
    assert.equal(rec.coveredUntil, "2026-11-07");
    const check = await m.closingCheck(user.organizationId, c.importId, tx);
    assert.notEqual(check.unexplainedMinor, 0); // the 11-04 line is on no imported statement
    assert.equal(check.reconciled, false);
  });
});

test("an opening balance that differs from the bank stays unexplained, so nothing is reconciled", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, other, account, importIt } = await setup(tx, 99999); // bank says 1000.00
    const a = await importIt(A());
    await createAll(m, user, a.importId, tx, other.id);
    const c = await m.closingCheck(user.organizationId, a.importId, tx);
    assert.deepEqual([c.differenceMinor, c.unexplainedMinor, c.reconciled], [-1, -1, false]);
    const [rec] = (await m.accountReconciliation(user.organizationId, tx)).filter((r) => r.accountId === account.id);
    assert.equal(rec.reconciledUntil, null);
  });
});

test("an account's opening balance and date are locked once it has statements", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, account, importIt } = await setup(tx);
    await importIt(A());
    const { name, bankName, accountNumber, openingDate, openingBalanceMinor, receivesTransfers, issuesCheques } = account;
    const base = { name, bankName, accountNumber, openingDate, openingBalanceMinor, receivesTransfers, issuesCheques };
    await assert.rejects(m.updateBankAccount(user, account.id, { ...base, openingBalanceMinor: 1 }, tx), rejects("accountHasStatements"));
    await assert.rejects(m.updateBankAccount(user, account.id, { ...base, openingDate: "2026-11-01" }, tx), rejects("accountHasStatements"));
    await m.updateBankAccount(user, account.id, { ...base, name: "Renamed" }, tx);
  });
});

// ---- CIB (M6) ----

// A synthetic CIB CSV export for the "other" account (number 999, opening balance 0).
function cibStatement(rows: string[][]): ParsedStatement {
  const q = (cells: string[]) => cells.map((c) => `" ${c} "`).join(",") + ",";
  const text = [
    "﻿",
    q(["Account No.", "Type", "Status", "Account Currency", "IBAN Number", "Date From", "Date To", "Ledger Balance", "Available Balance"]),
    q(["999", "Current Account", "Active", "EGP", "EG00", "01/11/2026", "05/11/2026", "0.00", "0.00"]),
    '"",',
    q(["Posting Date", "Value Date", "BackOffice Reference", "Description", "Related Reference", "Cheque Number", "Withdrawal", "Deposit", "Balance"]),
    ...rows.map(q),
  ].join("\n");
  const r = parseStatementFile(text);
  assert.ok(r.ok, JSON.stringify(r));
  sourceText.set(r.statements[0].statementRef, text);
  return r.statements[0];
}

test("an internal transfer between NBE and CIB: each bank's line matches its own half", { skip }, async () => {
  await inRollback(async (tx) => {
    const { m, user, other, importIt } = await setup(tx);
    // NBE: the 100.00 account-to-account debit on 11-04 becomes an internal transfer to CIB.
    const nbe = await importIt(M4());
    const nbeLine = (await m.listStatementLines(user.organizationId, nbe.importId, null, tx))[4];
    const { transactionId: outHalf } = await m.createFromLine(user, { lineId: nbeLine.id, type: "internal", otherAccountId: other.id, notes: null }, tx);

    // CIB: the same 100.00 arrives on 11-04, described in CIB's own words.
    const cib = await importIt(
      cibStatement([["04/11/2026", "04/11/2026", "FT0009", "FT0009 - TRANSFER FROM OWN ACCOUNT", " ", " ", " ", "100.00", "100.00"]]),
      other.id,
    );
    const [cibLine] = await m.listStatementLines(user.organizationId, cib.importId, null, tx);
    assert.equal(cibLine.direction, "credit");
    const { suggestions, rows } = await m.getImportSuggestions(user.organizationId, cib.importId, tx);
    const s = suggestions.get(cibLine.id)!;
    assert.equal(rows.get(s.suggested!.transactionId)!.type, "internal_in");
    assert.equal(s.unique, true);
    await m.confirmMatch(user, { lineId: cibLine.id, transactionId: s.suggested!.transactionId }, tx);

    // The CIB statement now reconciles: its opening (0.00) matches and every line is accounted for.
    assert.deepEqual(await m.importWarnings(user.organizationId, cib.importId, tx), []);
    const check = await m.closingCheck(user.organizationId, cib.importId, tx);
    assert.deepEqual([check.differenceMinor, check.unexplainedMinor, check.reconciled], [0, 0, true]);
    // Both halves are matched, each by its own bank's line.
    const matched = await tx.select().from(m.statementMatches);
    const halves = matched.filter((x) => [outHalf, s.suggested!.transactionId].includes(x.transactionId));
    assert.equal(halves.length, 2);
  });
});
