import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";
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

export type AuditRow = {
  id: string;
  action: string;
  createdAt: string;
  userName: string;
  transactionType: string | null;
  amountMinor: number | null;
  chequeNumber: string | null;
  partyName: string | null;
  accountId: string | null;
  accountName: string | null;
  beforeStatus: string | null;
  afterStatus: string | null;
};

// Newest changes first: who did what to which movement or account.
export async function listAudit(
  organizationId: string,
  limit = 200,
  database: Executor = db,
): Promise<AuditRow[]> {
  const rows = await database.execute<{
    id: string;
    action: string;
    created_at: string;
    user_name: string;
    transaction_type: string | null;
    amount_minor: string | null;
    cheque_number: string | null;
    party_name: string | null;
    account_id: string | null;
    account_name: string | null;
    before_status: string | null;
    after_status: string | null;
  }>(sql`
    select
      l.id, l.action, l.created_at::text, u.name as user_name,
      t.type as transaction_type, t.amount_minor, t.cheque_number,
      coalesce(t.party_name, t.description) as party_name,
      ba.id as account_id, ba.name as account_name,
      l.before ->> 'status' as before_status, l.after ->> 'status' as after_status
    from audit_log l
    join users u on u.id = l.user_id
    left join transactions t on t.id = l.transaction_id
    left join bank_accounts ba on ba.id = coalesce(t.bank_account_id, l.bank_account_id)
    where l.organization_id = ${organizationId}
    order by l.created_at desc, l.id
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    createdAt: r.created_at,
    userName: r.user_name,
    transactionType: r.transaction_type,
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    chequeNumber: r.cheque_number,
    partyName: r.party_name,
    accountId: r.account_id,
    accountName: r.account_name,
    beforeStatus: r.before_status,
    afterStatus: r.after_status,
  }));
}
