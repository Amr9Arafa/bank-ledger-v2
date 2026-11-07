import { sql } from "drizzle-orm";
import { CREDIT_TYPES } from "../db/schema.ts";

// `t.type in ('transfer_in', ...)` for queries that alias transactions as `t`. Built from
// CREDIT_TYPES so a new credit type (e.g. interest) is counted as a credit everywhere.
// sql.raw is safe here: the values are constants from our own code, not user input.
export const isCredit = sql.raw(`t.type in (${CREDIT_TYPES.map((type) => `'${type}'`).join(", ")})`);
