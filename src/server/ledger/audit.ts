import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import type { LedgerUser } from "./types.ts";

type AuditEntry = {
  action: "create" | "void" | "clear" | "cancel" | "unclear" | "update" | "archive" | "unarchive";
  before: unknown;
  after: unknown;
} & ({ transactionId: string } | { bankAccountId: string });

// Call inside the same DB transaction as the change it records.
export async function writeAudit(tx: Executor, user: LedgerUser, entry: AuditEntry) {
  await tx.insert(auditLog).values({
    organizationId: user.organizationId,
    userId: user.id,
    ...entry,
  });
}
