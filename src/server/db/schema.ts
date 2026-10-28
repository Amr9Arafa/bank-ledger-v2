import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
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
export const CREDIT_TYPES = ["transfer_in", "deposit", "internal_in"] as const;
export const DEBIT_TYPES = ["transfer_out", "cheque", "fee", "internal_out"] as const;
export const TRANSACTION_TYPES = [...CREDIT_TYPES, ...DEBIT_TYPES] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const MOVEMENT_STATUSES = ["active", "voided"] as const;
export const CHEQUE_STATUSES = ["issued", "cleared", "cancelled"] as const;

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
    createdAt: createdAt(),
  },
  (t) => [
    check("users_role_check", sql`${t.role} in ('admin', 'accountant', 'viewer')`),
    check("users_language_check", sql`${t.language} in ('ar', 'en')`),
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
      sql`${t.type} in ('transfer_in', 'deposit', 'internal_in', 'transfer_out', 'cheque', 'fee', 'internal_out')`,
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
    uniqueIndex("cheque_number_per_account")
      .on(t.bankAccountId, t.chequeNumber)
      .where(sql`${t.type} = 'cheque'`),
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
    // e.g. "create", "update", "void", "clear", "cancel"
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "audit_log_one_target",
      sql`num_nonnulls(${t.transactionId}, ${t.bankAccountId}) = 1`,
    ),
    index("audit_log_transaction").on(t.transactionId),
  ],
).enableRLS();
