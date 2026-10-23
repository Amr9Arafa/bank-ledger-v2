import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";

export type AccountBalance = {
  id: string;
  name: string;
  bankName: string;
  accountNumber: string;
  receivesTransfers: boolean;
  issuesCheques: boolean;
  openingBalanceMinor: number;
  openingDate: string;
  archived: boolean;
  // What is really ours after paying every active cheque.
  bookBalanceMinor: number;
  // What the bank statement should show: only cleared cheques count.
  bankBalanceMinor: number;
  // Issued, not yet cleared: always bank balance - book balance.
  outstandingChequesMinor: number;
};

// Balances are computed from transactions, never stored.
// Credits add, debits subtract; voided and cancelled rows count nowhere.
export async function getAccountBalances(
  organizationId: string,
  database: Executor = db,
  options: { includeArchived?: boolean } = {},
): Promise<AccountBalance[]> {
  const rows = await database.execute<{
    id: string;
    name: string;
    bank_name: string;
    account_number: string;
    receives_transfers: boolean;
    issues_cheques: boolean;
    opening_balance_minor: string;
    opening_date: string;
    archived: boolean;
    book_balance_minor: string;
    bank_balance_minor: string;
    outstanding_cheques_minor: string;
  }>(sql`
    select
      a.id,
      a.name,
      a.bank_name,
      a.account_number,
      a.receives_transfers,
      a.issues_cheques,
      a.opening_balance_minor,
      a.opening_date::text,
      a.archived_at is not null as archived,
      a.opening_balance_minor + coalesce(sum(
        case when t.type in ('transfer_in', 'deposit', 'internal_in')
             then t.amount_minor else -t.amount_minor end
      ) filter (where t.status in ('active', 'issued', 'cleared')), 0)
        as book_balance_minor,
      a.opening_balance_minor + coalesce(sum(
        case when t.type in ('transfer_in', 'deposit', 'internal_in')
             then t.amount_minor else -t.amount_minor end
      ) filter (where t.status in ('active', 'cleared')), 0)
        as bank_balance_minor,
      coalesce(sum(t.amount_minor) filter (where t.type = 'cheque' and t.status = 'issued'), 0)
        as outstanding_cheques_minor
    from bank_accounts a
    left join transactions t
      on t.bank_account_id = a.id and t.organization_id = a.organization_id
    where a.organization_id = ${organizationId}
      and (${options.includeArchived ?? false} or a.archived_at is null)
    group by a.id
    order by a.archived_at is not null, a.name
  `);

  // Postgres returns bigint and sum() as strings.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    receivesTransfers: r.receives_transfers,
    issuesCheques: r.issues_cheques,
    openingBalanceMinor: Number(r.opening_balance_minor),
    openingDate: r.opening_date,
    archived: r.archived,
    bookBalanceMinor: Number(r.book_balance_minor),
    bankBalanceMinor: Number(r.bank_balance_minor),
    outstandingChequesMinor: Number(r.outstanding_cheques_minor),
  }));
}
