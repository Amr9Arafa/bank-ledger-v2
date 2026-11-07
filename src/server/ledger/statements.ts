// Bank statement imports: validation, continuity warnings, import and newest-first delete.
// Parsing happens before this (src/lib/statements); this layer owns the business rules.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { addDays } from "../../lib/cheques.ts";
import type { ParsedStatement } from "../../lib/statements/types.ts";
import { db, type Executor } from "../db/client.ts";
import {
  bankAccounts,
  STATEMENT_LINE_STATUSES,
  statementImports,
  statementLines,
  statementMatches,
} from "../db/schema.ts";
import { writeAudit } from "./audit.ts";
import { LedgerError, type LedgerUser } from "./types.ts";

// Not errors: the import is allowed, but the user should look before confirming.
export type ImportWarning =
  // First statement of the account does not reach back to the day before the start date.
  | { code: "startsAfterOpening"; accountOpeningDate: string; statementOpeningDate: string }
  // First statement: its balance on the day before the start date differs from the
  // account's opening balance. Never fixed automatically.
  | { code: "openingBalanceMismatch"; date: string; appMinor: number; statementMinor: number }
  // Days between the previous statement and this one are not covered.
  | { code: "gap"; from: string; to: string }
  // This statement's balance on the previous statement's closing date differs from it.
  | { code: "previousBalanceMismatch"; date: string; previousMinor: number; statementMinor: number }
  // Every line is already in an earlier import.
  | { code: "nothingNew" };

export type ImportPreview = {
  bankAccountId: string;
  accountName: string;
  statementRef: string;
  openingDate: string;
  openingBalanceMinor: number;
  closingDate: string;
  closingBalanceMinor: number;
  lineCount: number;
  newLineCount: number;
  skippedLineCount: number;
  beforeStartCount: number;
  warnings: ImportWarning[];
};

// Account numbers compared without spaces, dashes or leading zeros.
const normalizeAccountNumber = (s: string) =>
  s.replace(/[^0-9A-Za-z]/g, "").replace(/^0+/, "").toUpperCase();

// The active account a statement belongs to, by its account number (:25:), if any.
export async function findAccountForStatement(
  organizationId: string,
  accountNumber: string,
  database: Executor = db,
): Promise<string | null> {
  const accounts = await database
    .select({ id: bankAccounts.id, accountNumber: bankAccounts.accountNumber })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.organizationId, organizationId), sql`${bankAccounts.archivedAt} is null`));
  const wanted = normalizeAccountNumber(accountNumber);
  const found = accounts.filter((a) => normalizeAccountNumber(a.accountNumber) === wanted);
  return found.length === 1 ? found[0].id : null;
}

const signed = (l: { direction: string; amountMinor: number }) =>
  l.direction === "credit" ? l.amountMinor : -l.amountMinor;

// Balance at the end of `date` according to the statement (date >= its opening date).
function statementBalanceAt(statement: ParsedStatement, date: string): number {
  return statement.lines
    .filter((l) => l.bookingDate <= date)
    .reduce((sum, l) => sum + signed(l), statement.openingBalanceMinor);
}

// All checks shared by preview and import. Throws on errors, returns warnings and counts.
async function analyze(tx: Executor, user: LedgerUser, bankAccountId: string, statement: ParsedStatement) {
  const [account] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.organizationId, user.organizationId)));
  if (!account) throw new LedgerError("accountNotFound", "bankAccountId");
  if (account.archivedAt) throw new LedgerError("accountArchived", "bankAccountId");
  // Only NBE has a line reader so far; CIB comes with its own samples (M6).
  if (statement.bank !== "nbe") throw new LedgerError("statementBankUnsupported");
  if (statement.currency !== "EGP") throw new LedgerError("statementCurrency");
  if (normalizeAccountNumber(statement.accountNumber) !== normalizeAccountNumber(account.accountNumber)) {
    throw new LedgerError("statementAccountMismatch", "bankAccountId");
  }

  const [already] = await tx
    .select({ id: statementImports.id })
    .from(statementImports)
    .where(and(eq(statementImports.bankAccountId, account.id), eq(statementImports.statementRef, statement.statementRef)));
  if (already) throw new LedgerError("statementAlreadyImported");

  // Lines an earlier (overlapping) import already holds are skipped, not stored twice.
  const keys = statement.lines.map((l) => l.lineKey);
  const existing = new Set(
    keys.length === 0
      ? []
      : (
          await tx
            .select({ lineKey: statementLines.lineKey })
            .from(statementLines)
            .where(and(eq(statementLines.bankAccountId, account.id), inArray(statementLines.lineKey, keys)))
        ).map((r) => r.lineKey),
  );
  const newLines = statement.lines.filter((l) => !existing.has(l.lineKey));

  const warnings: ImportWarning[] = [];
  // The latest earlier statement this one continues from (by closing date).
  const [previous] = await tx
    .select()
    .from(statementImports)
    .where(and(eq(statementImports.bankAccountId, account.id), sql`${statementImports.closingDate} <= ${statement.closingDate}`))
    .orderBy(desc(statementImports.closingDate), desc(statementImports.createdAt))
    .limit(1);

  if (!previous) {
    // The opening balance is the balance at the end of the day before the start date.
    const dayBefore = addDays(account.openingDate, -1);
    if (statement.openingDate > dayBefore) {
      warnings.push({ code: "startsAfterOpening", accountOpeningDate: account.openingDate, statementOpeningDate: statement.openingDate });
    } else {
      const statementMinor = statementBalanceAt(statement, dayBefore);
      if (statementMinor !== account.openingBalanceMinor) {
        warnings.push({ code: "openingBalanceMismatch", date: dayBefore, appMinor: account.openingBalanceMinor, statementMinor });
      }
    }
  } else if (statement.openingDate > previous.closingDate) {
    warnings.push({ code: "gap", from: previous.closingDate, to: statement.openingDate });
  } else {
    const statementMinor = statementBalanceAt(statement, previous.closingDate);
    if (statementMinor !== previous.closingBalanceMinor) {
      warnings.push({ code: "previousBalanceMismatch", date: previous.closingDate, previousMinor: previous.closingBalanceMinor, statementMinor });
    }
  }
  if (statement.lines.length > 0 && newLines.length === 0) warnings.push({ code: "nothingNew" });

  const preview: ImportPreview = {
    bankAccountId: account.id,
    accountName: account.name,
    statementRef: statement.statementRef,
    openingDate: statement.openingDate,
    openingBalanceMinor: statement.openingBalanceMinor,
    closingDate: statement.closingDate,
    closingBalanceMinor: statement.closingBalanceMinor,
    lineCount: statement.lines.length,
    newLineCount: newLines.length,
    skippedLineCount: statement.lines.length - newLines.length,
    beforeStartCount: newLines.filter((l) => l.bookingDate < account.openingDate).length,
    warnings,
  };
  return { account, newLines, preview };
}

// Read-only: what importing this statement would do.
export async function previewStatementImport(
  user: LedgerUser,
  input: { bankAccountId: string; statement: ParsedStatement },
  database: Executor = db,
): Promise<ImportPreview> {
  return (await analyze(database, user, input.bankAccountId, input.statement)).preview;
}

export async function importStatement(
  user: LedgerUser,
  input: { bankAccountId: string; fileName: string; rawText: string; statement: ParsedStatement },
  database: Executor = db,
): Promise<{ importId: string; preview: ImportPreview }> {
  return database.transaction(async (tx) => {
    // Lock the account: two imports (or an import and a delete) for one account run one at a time.
    await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.organizationId, user.organizationId)))
      .for("update");
    const { account, newLines, preview } = await analyze(tx, user, input.bankAccountId, input.statement);
    const s = input.statement;

    const [created] = await tx
      .insert(statementImports)
      .values({
        organizationId: user.organizationId,
        bankAccountId: account.id,
        bank: "nbe",
        format: s.format,
        fileName: input.fileName,
        statementRef: s.statementRef,
        rawText: input.rawText,
        openingDate: s.openingDate,
        openingBalanceMinor: s.openingBalanceMinor,
        closingDate: s.closingDate,
        closingBalanceMinor: s.closingBalanceMinor,
        lineCount: preview.lineCount,
        skippedLineCount: preview.skippedLineCount,
        createdBy: user.id,
        // Wall-clock time, not now() (= transaction start): "newest import" must be strictly ordered.
        createdAt: sql`clock_timestamp()`,
      })
      .returning({ id: statementImports.id });

    if (newLines.length > 0) {
      await tx.insert(statementLines).values(
        newLines.map((l) => ({
          organizationId: user.organizationId,
          importId: created.id,
          bankAccountId: account.id,
          lineNo: l.lineNo,
          bookingDate: l.bookingDate,
          valueDate: l.valueDate,
          direction: l.direction,
          amountMinor: l.amountMinor,
          typeCode: l.typeCode,
          customerRef: l.customerRef,
          bankRef: l.bankRef,
          description: l.description,
          paymentRef: l.paymentRef,
          kind: l.kind,
          counterparty: l.counterparty,
          chequeRef: l.chequeRef,
          lineKey: l.lineKey,
          // Lines before the account's start date are kept for the balance checks only.
          status: l.bookingDate < account.openingDate ? ("before_start" as const) : ("unmatched" as const),
        })),
      );
    }

    await writeAudit(tx, user, {
      action: "statement_import",
      bankAccountId: account.id,
      before: null,
      after: { importId: created.id, ...summary(preview) },
    });
    return { importId: created.id, preview };
  });
}

const summary = (p: Omit<ImportPreview, "bankAccountId" | "accountName" | "warnings" | "newLineCount" | "beforeStartCount"> & { warnings?: ImportWarning[] }) => ({
  statementRef: p.statementRef,
  openingDate: p.openingDate,
  openingBalanceMinor: p.openingBalanceMinor,
  closingDate: p.closingDate,
  closingBalanceMinor: p.closingBalanceMinor,
  lineCount: p.lineCount,
  skippedLineCount: p.skippedLineCount,
  ...(p.warnings ? { warnings: p.warnings.map((w) => w.code) } : {}),
});

// Only the newest import of an account can be deleted, so the chain of statements stays
// continuous. Lines go with it (cascade); matches must be undone first (M3 adds the undo).
export async function deleteImport(user: LedgerUser, importId: string, database: Executor = db) {
  return database.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(statementImports)
      .where(and(eq(statementImports.id, importId), eq(statementImports.organizationId, user.organizationId)));
    if (!target) throw new LedgerError("importNotFound");

    await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.id, target.bankAccountId)).for("update");
    const [latest] = await tx
      .select({ id: statementImports.id })
      .from(statementImports)
      .where(eq(statementImports.bankAccountId, target.bankAccountId))
      .orderBy(desc(statementImports.createdAt), desc(statementImports.id))
      .limit(1);
    if (latest.id !== target.id) throw new LedgerError("notLatestImport");

    const [matched] = await tx
      .select({ id: statementMatches.id })
      .from(statementMatches)
      .innerJoin(statementLines, eq(statementLines.id, statementMatches.statementLineId))
      .where(eq(statementLines.importId, target.id))
      .limit(1);
    if (matched) throw new LedgerError("importHasMatches");

    await tx.delete(statementImports).where(eq(statementImports.id, target.id));
    await writeAudit(tx, user, {
      action: "statement_delete",
      bankAccountId: target.bankAccountId,
      before: { importId: target.id, ...summary(target) },
      after: null,
    });
    return { bankAccountId: target.bankAccountId };
  });
}

export type LineStatus = (typeof STATEMENT_LINE_STATUSES)[number];
export type StatusCounts = Record<LineStatus, number>;

const statusCounts = () => ({
  unmatched: sql<number>`count(${statementLines.id}) filter (where ${statementLines.status} = 'unmatched')`.mapWith(Number),
  matched: sql<number>`count(${statementLines.id}) filter (where ${statementLines.status} = 'matched')`.mapWith(Number),
  created: sql<number>`count(${statementLines.id}) filter (where ${statementLines.status} = 'created')`.mapWith(Number),
  ignored: sql<number>`count(${statementLines.id}) filter (where ${statementLines.status} = 'ignored')`.mapWith(Number),
  before_start: sql<number>`count(${statementLines.id}) filter (where ${statementLines.status} = 'before_start')`.mapWith(Number),
});

const importColumns = {
  id: statementImports.id,
  bankAccountId: statementImports.bankAccountId,
  accountName: bankAccounts.name,
  bank: statementImports.bank,
  fileName: statementImports.fileName,
  statementRef: statementImports.statementRef,
  openingDate: statementImports.openingDate,
  openingBalanceMinor: statementImports.openingBalanceMinor,
  closingDate: statementImports.closingDate,
  closingBalanceMinor: statementImports.closingBalanceMinor,
  lineCount: statementImports.lineCount,
  skippedLineCount: statementImports.skippedLineCount,
  createdAt: statementImports.createdAt,
};

// Every import, newest statement first, with line counts per status and whether it can
// be deleted (it is the account's newest import).
export async function listStatementImports(organizationId: string, database: Executor = db) {
  const rows = await database
    .select({ ...importColumns, ...statusCounts() })
    .from(statementImports)
    .innerJoin(bankAccounts, eq(bankAccounts.id, statementImports.bankAccountId))
    .leftJoin(statementLines, eq(statementLines.importId, statementImports.id))
    .where(eq(statementImports.organizationId, organizationId))
    .groupBy(statementImports.id, bankAccounts.name)
    .orderBy(desc(statementImports.closingDate), desc(statementImports.createdAt));

  const newestPerAccount = new Map<string, { id: string; createdAt: Date }>();
  for (const r of rows) {
    const current = newestPerAccount.get(r.bankAccountId);
    if (!current || r.createdAt > current.createdAt) newestPerAccount.set(r.bankAccountId, r);
  }
  return rows.map((r) => ({ ...r, deletable: newestPerAccount.get(r.bankAccountId)?.id === r.id }));
}

export type StatementImportRow = Awaited<ReturnType<typeof listStatementImports>>[number];

export async function getStatementImport(organizationId: string, importId: string, database: Executor = db) {
  const rows = await listStatementImports(organizationId, database);
  return rows.find((r) => r.id === importId) ?? null;
}

export async function listStatementLines(
  organizationId: string,
  importId: string,
  status: LineStatus | null = null,
  database: Executor = db,
) {
  return database
    .select({
      id: statementLines.id,
      lineNo: statementLines.lineNo,
      bookingDate: statementLines.bookingDate,
      valueDate: statementLines.valueDate,
      direction: statementLines.direction,
      amountMinor: statementLines.amountMinor,
      typeCode: statementLines.typeCode,
      bankRef: statementLines.bankRef,
      description: statementLines.description,
      kind: statementLines.kind,
      counterparty: statementLines.counterparty,
      chequeRef: statementLines.chequeRef,
      status: statementLines.status,
      ignoreReason: statementLines.ignoreReason,
    })
    .from(statementLines)
    .where(
      and(
        eq(statementLines.organizationId, organizationId),
        eq(statementLines.importId, importId),
        status ? eq(statementLines.status, status) : undefined,
      ),
    )
    .orderBy(asc(statementLines.lineNo));
}

export type StatementLineRow = Awaited<ReturnType<typeof listStatementLines>>[number];
