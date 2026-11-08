import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Supabase Auth's own table. Declared only so we can reference it;
// drizzle-kit manages the "public" schema only and never touches "auth".
const authUsers = pgSchema("auth").table("users", {
  id: uuid("id").primaryKey(),
});

// Money columns are integer piasters, read as JS numbers (exact up to ~90 trillion EGP).
const minor = (name: string) => bigint(name, { mode: "number" });
// Calendar dates as "YYYY-MM-DD" strings: a JS Date would shift with the time zone.
const day = (name: string) => date(name, { mode: "string" });
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const ROLES = ["admin", "accountant", "viewer"] as const;
export const LANGUAGES = ["ar", "en"] as const;
// "deposit" is no longer offered when entering movements (record it as transfer_in with
// a note), but stays valid so existing deposit rows keep their history.
// "interest" is credited by the bank (daily on NBE) and recorded from bank statements.
export const CREDIT_TYPES = ["transfer_in", "deposit", "internal_in", "interest"] as const;
export const DEBIT_TYPES = ["transfer_out", "cheque", "fee", "internal_out"] as const;
export const TRANSACTION_TYPES = [...CREDIT_TYPES, ...DEBIT_TYPES] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const MOVEMENT_STATUSES = ["active", "voided"] as const;
export const CHEQUE_STATUSES = ["issued", "cleared", "cancelled"] as const;
export const PENDING_ENTRY_TYPES = ["transaction", "cheque"] as const;
export const PENDING_ENTRY_SOURCES = ["web", "telegram"] as const;
export const PENDING_ENTRY_STATUSES = ["pending", "approved", "rejected"] as const;

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: createdAt(),
}).enableRLS();

// Our profile for each Supabase Auth login: id is the auth user's id.
export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    language: text("language", { enum: LANGUAGES }).notNull().default("ar"),
    // Telegram user id (digits) linked by an admin; messages to the bot act as this user.
    // Text, not bigint: only ever compared, and Postgres returns bigint as a string anyway.
    telegramUserId: text("telegram_user_id").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    check("users_role_check", sql`${t.role} in ('admin', 'accountant', 'viewer')`),
    check("users_language_check", sql`${t.language} in ('ar', 'en')`),
    check("users_telegram_user_id_check", sql`${t.telegramUserId} ~ '^[0-9]+$'`),
  ],
).enableRLS();

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    bankName: text("bank_name").notNull(),
    // Text, not a number: account numbers may have leading zeros.
    accountNumber: text("account_number").notNull(),
    currency: text("currency").notNull().default("EGP"),
    openingBalanceMinor: minor("opening_balance_minor").notNull(),
    // Transactions dated before this are rejected.
    openingDate: day("opening_date").notNull(),
    receivesTransfers: boolean("receives_transfers").notNull().default(true),
    issuesCheques: boolean("issues_cheques").notNull().default(false),
    // Null while active. Archived accounts keep their history.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // EGP only in the MVP, so the company total never mixes currencies.
    check("bank_accounts_currency_check", sql`${t.currency} = 'EGP'`),
    index("bank_accounts_org").on(t.organizationId),
  ],
).enableRLS();

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    type: text("type", { enum: TRANSACTION_TYPES }).notNull(),
    // Always positive; the type decides the sign.
    amountMinor: minor("amount_minor").notNull(),
    // Sender for transfers, payee for cheques.
    partyName: text("party_name"),
    reference: text("reference"),
    description: text("description"),
    chequeNumber: text("cheque_number"),
    // Date received, or cheque issue date.
    transactionDate: day("transaction_date").notNull(),
    dueDate: day("due_date"),
    status: text("status", {
      enum: [...MOVEMENT_STATUSES, ...CHEQUE_STATUSES],
    }).notNull(),
    clearedDate: day("cleared_date"),
    // Shared by both halves of an internal transfer.
    transferGroupId: uuid("transfer_group_id"),
    // Why a row was voided or a cheque cancelled.
    statusReason: text("status_reason"),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "transactions_type_check",
      sql`${t.type} in ('transfer_in', 'deposit', 'internal_in', 'interest', 'transfer_out', 'cheque', 'fee', 'internal_out')`,
    ),
    check("transactions_amount_positive", sql`${t.amountMinor} > 0`),
    // Cheques must have a number; only cheques have one.
    check(
      "transactions_cheque_number_check",
      sql`(${t.type} = 'cheque') = (${t.chequeNumber} is not null)`,
    ),
    // Valid status per type.
    check(
      "transactions_status_check",
      sql`(${t.type} = 'cheque' and ${t.status} in ('issued', 'cleared', 'cancelled'))
        or (${t.type} <> 'cheque' and ${t.status} in ('active', 'voided'))`,
    ),
    // Cleared cheques carry a cleared date; nothing else does.
    check(
      "transactions_cleared_date_check",
      sql`(${t.status} = 'cleared') = (${t.clearedDate} is not null)`,
    ),
    // Internal transfer rows always belong to a pair.
    check(
      "transactions_transfer_group_check",
      sql`(${t.type} in ('internal_in', 'internal_out')) = (${t.transferGroupId} is not null)`,
    ),
    // A cancelled cheque frees its number: undoing an old cheque created from a statement
    // cancels it, and re-importing that statement must be able to create it again.
    uniqueIndex("cheque_number_per_account")
      .on(t.bankAccountId, t.chequeNumber)
      .where(sql`${t.type} = 'cheque' and ${t.status} <> 'cancelled'`),
    index("ledger_order").on(t.bankAccountId, t.transactionDate, t.createdAt),
    index("transactions_transfer_group").on(t.transferGroupId),
  ],
).enableRLS();

// One row per change to financial data, written in the same DB transaction as the change.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Exactly one of these is set: what was changed.
    transactionId: uuid("transaction_id").references(() => transactions.id),
    bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
    // The user whose permissions changed (role, Telegram link).
    targetUserId: uuid("target_user_id").references(() => users.id),
    // e.g. "create", "update", "void", "clear", "cancel", "role", "telegram"
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "audit_log_one_target",
      sql`num_nonnulls(${t.transactionId}, ${t.bankAccountId}, ${t.targetUserId}) = 1`,
    ),
    index("audit_log_transaction").on(t.transactionId),
  ],
).enableRLS();

// AI Inbox: what the LLM read from a message or photo, waiting for a person to approve it.
// Nothing here counts in any balance; approving creates the real row in `transactions`.
export const pendingEntries = pgTable(
  "pending_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    type: text("type", { enum: PENDING_ENTRY_TYPES }).notNull(),
    source: text("source", { enum: PENDING_ENTRY_SOURCES }).notNull(),
    status: text("status", { enum: PENDING_ENTRY_STATUSES }).notNull().default("pending"),
    rawText: text("raw_text"),
    // Path in the private Storage bucket, not a public URL. Cleared when the image is
    // deleted on reject.
    imageUrl: text("image_url"),
    // The model's output as it came back: kept unedited, to compare with what was approved.
    extracted: jsonb("extracted").notNull(),
    // [{ code, ...params }]: codes are keys under "inbox.warnings" in messages/*.json.
    warnings: jsonb("warnings").notNull().default([]),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Both outcomes (movement or cheque) are rows in `transactions`.
    resultingRecordId: uuid("resulting_record_id").references(() => transactions.id),
    // Telegram message id, so a webhook retry never creates a second entry.
    externalMessageId: text("external_message_id").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    check("pending_entries_type_check", sql`${t.type} in ('transaction', 'cheque')`),
    check("pending_entries_source_check", sql`${t.source} in ('web', 'telegram')`),
    check(
      "pending_entries_status_check",
      sql`${t.status} in ('pending', 'approved', 'rejected')`,
    ),
    // Something to extract from. A rejected entry may have lost its image.
    check(
      "pending_entries_input_check",
      sql`${t.status} = 'rejected' or num_nonnulls(${t.rawText}, ${t.imageUrl}) > 0`,
    ),
    // Reviewed exactly when no longer pending.
    check(
      "pending_entries_review_check",
      sql`(${t.status} = 'pending') = (${t.reviewedBy} is null and ${t.reviewedAt} is null)`,
    ),
    // Only approved entries point at a real record, and they always do.
    check(
      "pending_entries_result_check",
      sql`(${t.status} = 'approved') = (${t.resultingRecordId} is not null)`,
    ),
    index("pending_entries_inbox").on(t.organizationId, t.status, t.createdAt),
  ],
).enableRLS();

// ---- Bank statements and reconciliation ----
// Statement rows are evidence, not financial records: deleting an import hard-deletes its
// lines and matches, after the ledger has reversed every change the import made.

export const STATEMENT_BANKS = ["nbe", "cib"] as const;
export const STATEMENT_FORMATS = ["mt940", "csv"] as const;
export const STATEMENT_DIRECTIONS = ["credit", "debit"] as const;
export const STATEMENT_LINE_KINDS = [
  "incoming_transfer",
  "outgoing_transfer",
  "account_transfer",
  "cheque",
  "fee",
  "interest",
  "other",
] as const;
// "suggested" is not stored: suggestions are computed when the page loads.
export const STATEMENT_LINE_STATUSES = [
  "unmatched",
  "matched",
  "created",
  "ignored",
  "before_start",
] as const;
export const STATEMENT_MATCH_ORIGINS = ["matched", "created"] as const;
// A reviewer's call on an unmatched line's suggestions (null: none yet).
//   needs_decision: "Not the same": never a sure match, so "Confirm all" skips it.
//   not_in_app: "Not in the app": no suggestions at all; the line needs a record created.
export const STATEMENT_REVIEW_STATES = ["needs_decision", "not_in_app"] as const;

// One statement (one :20: ... :62F: block) for one account.
export const statementImports = pgTable(
  "statement_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    bank: text("bank", { enum: STATEMENT_BANKS }).notNull(),
    format: text("format", { enum: STATEMENT_FORMATS }).notNull(),
    fileName: text("file_name").notNull(),
    // The bank's statement reference (MT940 :20:).
    statementRef: text("statement_ref").notNull(),
    // The uploaded file as text, kept as evidence and to re-read it if a parser is fixed.
    rawText: text("raw_text").notNull(),
    // Balance at the end of opening_date (:60F:) and of closing_date (:62F:).
    openingDate: day("opening_date").notNull(),
    openingBalanceMinor: minor("opening_balance_minor").notNull(),
    closingDate: day("closing_date").notNull(),
    closingBalanceMinor: minor("closing_balance_minor").notNull(),
    // Lines in the file, and how many were skipped because an earlier import has them.
    lineCount: integer("line_count").notNull(),
    skippedLineCount: integer("skipped_line_count").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("statement_imports_bank_check", sql`${t.bank} in ('nbe', 'cib')`),
    check("statement_imports_format_check", sql`${t.format} in ('mt940', 'csv')`),
    check("statement_imports_period_check", sql`${t.closingDate} >= ${t.openingDate}`),
    check(
      "statement_imports_counts_check",
      sql`${t.lineCount} >= 0 and ${t.skippedLineCount} between 0 and ${t.lineCount}`,
    ),
    uniqueIndex("statement_imports_ref_per_account").on(t.bankAccountId, t.statementRef),
    index("statement_imports_account_period").on(t.bankAccountId, t.closingDate),
  ],
).enableRLS();

export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    importId: uuid("import_id")
      .notNull()
      .references(() => statementImports.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    lineNo: integer("line_no").notNull(),
    // Entry date: the date the bank booked it, which drives the statement balance.
    bookingDate: day("booking_date").notNull(),
    valueDate: day("value_date").notNull(),
    direction: text("direction", { enum: STATEMENT_DIRECTIONS }).notNull(),
    amountMinor: minor("amount_minor").notNull(),
    typeCode: text("type_code").notNull(),
    customerRef: text("customer_ref").notNull(),
    // Not unique: a transfer and its fee can share one.
    bankRef: text("bank_ref").notNull(),
    description: text("description").notNull(),
    paymentRef: text("payment_ref"),
    kind: text("kind", { enum: STATEMENT_LINE_KINDS }).notNull(),
    counterparty: text("counterparty"),
    chequeRef: text("cheque_ref"),
    // Same line in two overlapping statements -> same key; it is stored only once.
    lineKey: text("line_key").notNull(),
    status: text("status", { enum: STATEMENT_LINE_STATUSES }).notNull(),
    ignoreReason: text("ignore_reason"),
    reviewState: text("review_state", { enum: STATEMENT_REVIEW_STATES }),
    createdAt: createdAt(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("statement_lines_direction_check", sql`${t.direction} in ('credit', 'debit')`),
    check("statement_lines_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "statement_lines_kind_check",
      sql`${t.kind} in ('incoming_transfer', 'outgoing_transfer', 'account_transfer', 'cheque', 'fee', 'interest', 'other')`,
    ),
    check(
      "statement_lines_status_check",
      sql`${t.status} in ('unmatched', 'matched', 'created', 'ignored', 'before_start')`,
    ),
    // Ignored lines always say why; nothing else has a reason.
    check(
      "statement_lines_ignore_reason_check",
      sql`(${t.status} = 'ignored') = (${t.ignoreReason} is not null)`,
    ),
    check(
      "statement_lines_review_state_check",
      sql`${t.reviewState} is null or ${t.reviewState} in ('needs_decision', 'not_in_app')`,
    ),
    // Only an unmatched line carries a review state: confirming, creating, ignoring and
    // every undo clear it.
    check(
      "statement_lines_review_state_unmatched",
      sql`${t.reviewState} is null or ${t.status} = 'unmatched'`,
    ),
    uniqueIndex("statement_lines_key_per_account").on(t.bankAccountId, t.lineKey),
    uniqueIndex("statement_lines_import_line").on(t.importId, t.lineNo),
    index("statement_lines_account_status").on(t.bankAccountId, t.status, t.bookingDate),
  ],
).enableRLS();

// One statement line <-> one ledger row. An internal transfer is two ledger rows (one per
// account), so each account's line matches its own row and 1:1 still holds.
// No cascade from lines: a matched line cannot be deleted until its match is reversed.
export const statementMatches = pgTable(
  "statement_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .unique()
      .references(() => statementLines.id),
    transactionId: uuid("transaction_id")
      .notNull()
      .unique()
      .references(() => transactions.id),
    // "created": the ledger row was created from this line (undo voids/cancels it).
    origin: text("origin", { enum: STATEMENT_MATCH_ORIGINS }).notNull(),
    // True when confirming this match cleared an issued cheque (undo un-clears it).
    clearedCheque: boolean("cleared_cheque").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [check("statement_matches_origin_check", sql`${t.origin} in ('matched', 'created')`)],
).enableRLS();
