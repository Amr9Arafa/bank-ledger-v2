import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";
import { bankAccounts } from "../db/schema.ts";

// Active (not archived) accounts for entry forms. FR-2: archived accounts disappear here.
export async function getActiveAccounts(organizationId: string, database: Executor = db) {
  return database
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      bankName: bankAccounts.bankName,
      receivesTransfers: bankAccounts.receivesTransfers,
      issuesCheques: bankAccounts.issuesCheques,
    })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.organizationId, organizationId), isNull(bankAccounts.archivedAt)),
    )
    .orderBy(asc(bankAccounts.name));
}

export type AccountOption = Awaited<ReturnType<typeof getActiveAccounts>>[number];
