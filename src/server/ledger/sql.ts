import { sql } from "drizzle-orm";
import { CREDIT_TYPES } from "../db/schema.ts";

// `t.type in ('transfer_in', ...)` for queries that alias transactions as `t`. Built from
// CREDIT_TYPES so a new credit type (e.g. interest) is counted as a credit everywhere.
// sql.raw is safe here: the values are constants from our own code, not user input.
export const isCredit = sql.raw(`t.type in (${CREDIT_TYPES.map((type) => `'${type}'`).join(", ")})`);

// Signed amount of `t`: credits positive, debits negative.
export const signedAmount = sql`(case when ${isCredit} then t.amount_minor else -t.amount_minor end)`;

// `t` affects the bank balance: an active movement, or a cheque the bank has paid.
export const countsAtBank = sql.raw(
  `((t.type <> 'cheque' and t.status = 'active') or (t.type = 'cheque' and t.status = 'cleared'))`,
);

// The day `t` hits the bank balance: the cleared date for cheques, the date otherwise.
export const bankDate = sql.raw(`(case when t.type = 'cheque' then t.cleared_date else t.transaction_date end)`);
