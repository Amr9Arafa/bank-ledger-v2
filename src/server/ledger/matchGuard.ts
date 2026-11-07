import { inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { statementMatches } from "../db/schema.ts";
import { LedgerError } from "./types.ts";

// A ledger row matched to a statement line cannot be voided, cancelled or un-cleared until
// it is unmatched. The database enforces this too (migration 0007 trigger); this check
// runs first so the user gets a clear message instead of a database error.
export async function assertNotMatched(tx: Executor, transactionIds: string[]) {
  if (transactionIds.length === 0) return;
  const [match] = await tx
    .select({ id: statementMatches.id })
    .from(statementMatches)
    .where(inArray(statementMatches.transactionId, transactionIds))
    .limit(1);
  if (match) throw new LedgerError("matchedToStatement");
}
