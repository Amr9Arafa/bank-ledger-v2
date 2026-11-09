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

// The day `t` hits the bank balance.
//   Matched to a statement line: the bank's booking date of that line (the bank is the
//   authority on when money moved; the record keeps its own date as entered).
//   Otherwise: the cleared date for cheques, the record's date for everything else.
// Derived, not stored: unmatching or deleting the import removes the match, and the record
// falls back to its own date. The subquery uses statement_matches.transaction_id (unique),
// with aliases of its own so it can sit inside queries that already use `m` and `l`.
export const bankDate = sql.raw(`coalesce(
  (select bd_l.booking_date from statement_matches bd_m join statement_lines bd_l on bd_l.id = bd_m.statement_line_id
   where bd_m.transaction_id = t.id),
  (case when t.type = 'cheque' then t.cleared_date else t.transaction_date end)
)`);
