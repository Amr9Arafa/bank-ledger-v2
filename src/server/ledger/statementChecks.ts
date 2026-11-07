// Reconciliation checks, all computed (nothing stored): does each statement continue the
// previous one, does the app agree with the bank on the closing date, and up to which day is
// each account fully reconciled?
import { and, asc, eq, sql } from "drizzle-orm";
import { addDays } from "../../lib/cheques.ts";
import { parseStatementFile } from "../../lib/statements/index.ts";
import { db, type Executor } from "../db/client.ts";
import { bankAccounts, statementImports, statementLines } from "../db/schema.ts";
import { getBankBalanceAsOf } from "./balances.ts";
import { bankDate, countsAtBank, signedAmount } from "./sql.ts";
import { continuityWarnings, type ImportWarning, previousImport } from "./statements.ts";
import { LedgerError } from "./types.ts";

export type AppOnlyRow = {
  id: string;
  type: string;
  date: string;
  partyName: string | null;
  description: string | null;
  chequeNumber: string | null;
  signedMinor: number;
};

export type ClosingCheck = {
  date: string;
  bankMinor: number; // the statement's closing balance
  appMinor: number; // the app's bank balance at the end of `date`
  differenceMinor: number; // app - bank
  // Why they differ (all signed, as they move the balance):
  bankOnly: { count: number; totalMinor: number }; // unmatched lines: the app is missing them
  ignored: { count: number; totalMinor: number }; // lines marked as needing no record
  appOnly: { rows: AppOnlyRow[]; totalMinor: number }; // app records the bank has not shown
  timing: { count: number; totalMinor: number }; // matched pairs on different sides of `date`
  unexplainedMinor: number; // 0 when the statements form a continuous chain
  unmatchedInImport: number;
  // Every line of this statement is accounted for and nothing is unexplained.
  reconciled: boolean;
};

const lineSigned = sql`(case when l.direction = 'credit' then l.amount_minor else -l.amount_minor end)`;

// app balance - bank balance = app-only - bank-only - ignored + timing (+ unexplained).
// The unexplained part is non-zero only when the statements do not form a continuous chain
// from the opening balance (a gap, or an opening balance that does not match the bank).
export async function closingCheck(organizationId: string, importId: string, database: Executor = db): Promise<ClosingCheck> {
  const [imp] = await database
    .select({
      bankAccountId: statementImports.bankAccountId,
      closingDate: statementImports.closingDate,
      closingBalanceMinor: statementImports.closingBalanceMinor,
      openingDate: bankAccounts.openingDate,
    })
    .from(statementImports)
    .innerJoin(bankAccounts, eq(bankAccounts.id, statementImports.bankAccountId))
    .where(and(eq(statementImports.id, importId), eq(statementImports.organizationId, organizationId)));
  if (!imp) throw new LedgerError("importNotFound");
  const date = imp.closingDate;
  const start = imp.openingDate;
  const account = imp.bankAccountId;

  const appMinor = await getBankBalanceAsOf(organizationId, account, date, database);

  const [lineTotals] = await database.execute<{
    bank_only_count: string; bank_only_total: string; ignored_count: string; ignored_total: string; unmatched_in_import: string;
  }>(sql`
    select
      count(*) filter (where l.status = 'unmatched') as bank_only_count,
      coalesce(sum(${lineSigned}) filter (where l.status = 'unmatched'), 0) as bank_only_total,
      count(*) filter (where l.status = 'ignored') as ignored_count,
      coalesce(sum(${lineSigned}) filter (where l.status = 'ignored'), 0) as ignored_total,
      (select count(*) from statement_lines u where u.import_id = ${importId} and u.status = 'unmatched') as unmatched_in_import
    from statement_lines l
    where l.bank_account_id = ${account} and l.booking_date between ${start} and ${date}
  `);

  const appOnlyRows = await database.execute<{
    id: string; type: string; date: string; party_name: string | null; description: string | null; cheque_number: string | null; signed_minor: string;
  }>(sql`
    select t.id, t.type, ${bankDate}::text as date, t.party_name, t.description, t.cheque_number, ${signedAmount} as signed_minor
    from transactions t
    where t.bank_account_id = ${account} and ${countsAtBank}
      and ${bankDate} between ${start} and ${date}
      and not exists (select 1 from statement_matches m where m.transaction_id = t.id)
    order by 3, t.created_at
  `);
  const appOnly = appOnlyRows.map((r) => ({
    id: r.id,
    type: r.type,
    date: r.date,
    partyName: r.party_name,
    description: r.description,
    chequeNumber: r.cheque_number,
    signedMinor: Number(r.signed_minor),
  }));

  // A matched pair counts on the app side by the app's date and on the bank side by the
  // booking date; when only one of them is on or before `date`, it explains a difference.
  const [timing] = await database.execute<{ count: string; total: string }>(sql`
    select
      count(*) as count,
      coalesce(sum(case when ${bankDate} <= ${date} then ${signedAmount} else -${lineSigned} end), 0) as total
    from statement_matches m
    join statement_lines l on l.id = m.statement_line_id
    join transactions t on t.id = m.transaction_id
    where l.bank_account_id = ${account} and ((${bankDate} <= ${date}) <> (l.booking_date <= ${date}))
  `);

  const bankOnly = { count: Number(lineTotals.bank_only_count), totalMinor: Number(lineTotals.bank_only_total) };
  const ignored = { count: Number(lineTotals.ignored_count), totalMinor: Number(lineTotals.ignored_total) };
  const appOnlyTotal = appOnly.reduce((sum, r) => sum + r.signedMinor, 0);
  const timingTotal = { count: Number(timing.count), totalMinor: Number(timing.total) };
  const differenceMinor = appMinor - imp.closingBalanceMinor;
  const unexplainedMinor = differenceMinor - (appOnlyTotal - bankOnly.totalMinor - ignored.totalMinor + timingTotal.totalMinor);
  const unmatchedInImport = Number(lineTotals.unmatched_in_import);

  return {
    date,
    bankMinor: imp.closingBalanceMinor,
    appMinor,
    differenceMinor,
    bankOnly,
    ignored,
    appOnly: { rows: appOnly, totalMinor: appOnlyTotal },
    timing: timingTotal,
    unexplainedMinor,
    unmatchedInImport,
    reconciled: unmatchedInImport === 0 && unexplainedMinor === 0,
  };
}

// The continuity warnings of an existing import, as they stand now: its stored file is read
// again and compared with the import before it (or the account's opening balance).
export async function importWarnings(organizationId: string, importId: string, database: Executor = db): Promise<ImportWarning[]> {
  const [imp] = await database
    .select({
      id: statementImports.id,
      createdAt: statementImports.createdAt,
      statementRef: statementImports.statementRef,
      rawText: statementImports.rawText,
      closingDate: statementImports.closingDate,
      bankAccountId: statementImports.bankAccountId,
      openingDate: bankAccounts.openingDate,
      openingBalanceMinor: bankAccounts.openingBalanceMinor,
    })
    .from(statementImports)
    .innerJoin(bankAccounts, eq(bankAccounts.id, statementImports.bankAccountId))
    .where(and(eq(statementImports.id, importId), eq(statementImports.organizationId, organizationId)));
  if (!imp) throw new LedgerError("importNotFound");
  const parsed = parseStatementFile(imp.rawText);
  const statement = parsed.ok ? parsed.statements.find((s) => s.statementRef === imp.statementRef) : undefined;
  if (!statement) return [];
  const previous = await previousImport(database, imp.bankAccountId, imp.closingDate, imp);
  return continuityWarnings(imp, statement, previous);
}

export type AccountReconciliation = {
  accountId: string;
  accountName: string;
  openingDate: string;
  // Last day the app and the bank fully agree (null: not reconciled yet).
  reconciledUntil: string | null;
  // Last day covered by imported statements (null: none imported).
  coveredUntil: string | null;
  gaps: { from: string; to: string }[];
  unmatchedLines: number;
  latest: { importId: string; closingDate: string; check: ClosingCheck } | null;
};

// Per active account: walks its statements from the start date, in date order, listing any
// days no statement covers. "Reconciled until" stops at the first gap or the first statement
// that is not fully reconciled.
export async function accountReconciliation(organizationId: string, database: Executor = db): Promise<AccountReconciliation[]> {
  const accounts = await database
    .select({ id: bankAccounts.id, name: bankAccounts.name, openingDate: bankAccounts.openingDate })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.organizationId, organizationId), sql`${bankAccounts.archivedAt} is null`))
    .orderBy(asc(bankAccounts.name));
  const imports = await database
    .select({
      id: statementImports.id,
      bankAccountId: statementImports.bankAccountId,
      openingDate: statementImports.openingDate,
      closingDate: statementImports.closingDate,
    })
    .from(statementImports)
    .where(eq(statementImports.organizationId, organizationId))
    .orderBy(asc(statementImports.openingDate), asc(statementImports.closingDate), asc(statementImports.createdAt));
  const unmatched = await database
    .select({ bankAccountId: statementLines.bankAccountId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(statementLines)
    .where(and(eq(statementLines.organizationId, organizationId), eq(statementLines.status, "unmatched")))
    .groupBy(statementLines.bankAccountId);

  const result: AccountReconciliation[] = [];
  for (const account of accounts) {
    const mine = imports.filter((i) => i.bankAccountId === account.id);
    const dayBefore = addDays(account.openingDate, -1);
    let covered = dayBefore;
    let reconciledUntil = dayBefore;
    let reconciling = true;
    const gaps: { from: string; to: string }[] = [];
    let latest: AccountReconciliation["latest"] = null;

    for (const imp of mine) {
      const check = await closingCheck(organizationId, imp.id, database);
      if (imp.openingDate > covered) {
        gaps.push({ from: covered, to: imp.openingDate });
        reconciling = false;
      }
      if (imp.closingDate > covered) covered = imp.closingDate;
      if (reconciling) {
        if (check.reconciled) {
          if (imp.closingDate > reconciledUntil) reconciledUntil = imp.closingDate;
        } else {
          reconciling = false;
        }
      }
      if (!latest || imp.closingDate >= latest.closingDate) latest = { importId: imp.id, closingDate: imp.closingDate, check };
    }

    result.push({
      accountId: account.id,
      accountName: account.name,
      openingDate: account.openingDate,
      reconciledUntil: reconciledUntil > dayBefore ? reconciledUntil : null,
      coveredUntil: mine.length > 0 ? covered : null,
      gaps,
      unmatchedLines: unmatched.find((u) => u.bankAccountId === account.id)?.count ?? 0,
      latest,
    });
  }
  return result;
}
