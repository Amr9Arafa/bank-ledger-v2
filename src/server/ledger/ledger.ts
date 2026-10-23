import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";

export type LedgerRow = {
  id: string;
  type: string;
  // Signed: credits positive, debits negative.
  signedAmountMinor: number;
  partyName: string | null;
  reference: string | null;
  description: string | null;
  chequeNumber: string | null;
  transactionDate: string;
  clearedDate: string | null;
  status: string;
  statusReason: string | null;
  notes: string | null;
  // Internal transfers: the name of the other account in the pair.
  counterpartName: string | null;
  // Book balance right after this row. Voided and cancelled rows add 0.
  runningBalanceMinor: number;
};

// Every movement of one account, newest first, with its running balance.
export async function getAccountLedger(
  organizationId: string,
  accountId: string,
  database: Executor = db,
): Promise<LedgerRow[]> {
  const rows = await database.execute<{
    id: string;
    type: string;
    signed_amount_minor: string;
    party_name: string | null;
    reference: string | null;
    description: string | null;
    cheque_number: string | null;
    transaction_date: string;
    cleared_date: string | null;
    status: string;
    status_reason: string | null;
    notes: string | null;
    counterpart_name: string | null;
    running_balance_minor: string;
  }>(sql`
    with signed as (
      select
        t.*,
        case when t.type in ('transfer_in', 'deposit', 'internal_in')
             then t.amount_minor else -t.amount_minor end as signed_amount_minor
      from transactions t
      where t.organization_id = ${organizationId} and t.bank_account_id = ${accountId}
    )
    select
      s.id, s.type, s.signed_amount_minor, s.party_name, s.reference, s.description,
      s.cheque_number, s.transaction_date::text, s.cleared_date::text, s.status, s.status_reason, s.notes,
      other.name as counterpart_name,
      -- Cumulative sum oldest-first, over ALL rows, before any display order or filter.
      a.opening_balance_minor + sum(
        case when s.status in ('active', 'issued', 'cleared') then s.signed_amount_minor else 0 end
      ) over (order by s.transaction_date, s.created_at, s.id) as running_balance_minor
    from signed s
    join bank_accounts a on a.id = s.bank_account_id
    left join transactions pair
      on pair.transfer_group_id = s.transfer_group_id and pair.id <> s.id
    left join bank_accounts other on other.id = pair.bank_account_id
    order by s.transaction_date desc, s.created_at desc, s.id desc
  `);

  // Postgres returns bigint and sum() as strings.
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    signedAmountMinor: Number(r.signed_amount_minor),
    partyName: r.party_name,
    reference: r.reference,
    description: r.description,
    chequeNumber: r.cheque_number,
    transactionDate: r.transaction_date,
    clearedDate: r.cleared_date,
    status: r.status,
    statusReason: r.status_reason,
    notes: r.notes,
    counterpartName: r.counterpart_name,
    runningBalanceMinor: Number(r.running_balance_minor),
  }));
}
