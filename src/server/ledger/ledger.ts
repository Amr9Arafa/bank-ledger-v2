import { sql, type SQL } from "drizzle-orm";
import type { LedgerFilters } from "../../lib/validation.ts";
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

// Filters apply to the outer query, AFTER the running balance is computed over all
// rows, so a filtered view still shows the true balance at each row (FR-11).
function filterConditions(f: LedgerFilters): SQL {
  const conditions: SQL[] = [sql`true`];
  if (f.from) conditions.push(sql`l.transaction_date >= ${f.from}`);
  if (f.to) conditions.push(sql`l.transaction_date <= ${f.to}`);
  if (f.type === "internal") conditions.push(sql`l.type in ('internal_in', 'internal_out')`);
  else if (f.type) conditions.push(sql`l.type = ${f.type}`);
  if (f.status === "counted") conditions.push(sql`l.status in ('active', 'issued', 'cleared')`);
  if (f.status === "outstanding") conditions.push(sql`l.status = 'issued'`);
  if (f.status === "void") conditions.push(sql`l.status in ('voided', 'cancelled')`);
  if (f.q) {
    // Escape LIKE wildcards so "50%" searches for the text "50%".
    const pattern = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`(
      l.party_name ilike ${pattern} or l.description ilike ${pattern}
      or l.reference ilike ${pattern} or l.cheque_number ilike ${pattern}
      or l.counterpart_name ilike ${pattern} or l.notes ilike ${pattern}
    )`);
  }
  return sql.join(conditions, sql` and `);
}

// Movements of one account, newest first, with their running balance.
export async function getAccountLedger(
  organizationId: string,
  accountId: string,
  filters: LedgerFilters = {},
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
    ),
    ledger as (
      select
        s.id, s.type, s.signed_amount_minor, s.party_name, s.reference, s.description,
        s.cheque_number, s.transaction_date, s.cleared_date, s.status, s.status_reason,
        s.notes, s.created_at,
        other.name as counterpart_name,
        -- Cumulative sum oldest-first, over ALL rows of the account.
        a.opening_balance_minor + sum(
          case when s.status in ('active', 'issued', 'cleared') then s.signed_amount_minor else 0 end
        ) over (order by s.transaction_date, s.created_at, s.id) as running_balance_minor
      from signed s
      join bank_accounts a on a.id = s.bank_account_id
      left join transactions pair
        on pair.transfer_group_id = s.transfer_group_id and pair.id <> s.id
      left join bank_accounts other on other.id = pair.bank_account_id
    )
    select
      l.id, l.type, l.signed_amount_minor, l.party_name, l.reference, l.description,
      l.cheque_number, l.transaction_date::text, l.cleared_date::text, l.status,
      l.status_reason, l.notes, l.counterpart_name, l.running_balance_minor
    from ledger l
    where ${filterConditions(filters)}
    order by l.transaction_date desc, l.created_at desc, l.id desc
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

export const MOVEMENT_VIEWS = ["all", "in", "out", "cheques"] as const;
export type MovementView = (typeof MOVEMENT_VIEWS)[number];

export type RecentMovement = {
  id: string;
  accountId: string;
  accountName: string;
  type: string;
  status: string;
  // Signed: credits positive, debits negative.
  signedAmountMinor: number;
  partyName: string | null;
  description: string | null;
  reference: string | null;
  chequeNumber: string | null;
  transactionDate: string;
  counterpartName: string | null;
};

// Latest movements across all accounts for the dashboard. Voided and cancelled rows are
// left out: the dashboard shows what counts; the account ledger keeps the full history.
export async function listRecentMovements(
  organizationId: string,
  view: MovementView = "all",
  limit = 8,
  database: Executor = db,
): Promise<RecentMovement[]> {
  const viewFilter =
    view === "in"
      ? sql`and t.type in ('transfer_in', 'deposit', 'internal_in')`
      : view === "out"
        ? sql`and t.type in ('cheque', 'fee', 'internal_out')`
        : view === "cheques"
          ? sql`and t.type = 'cheque'`
          : sql``;

  const rows = await database.execute<{
    id: string;
    account_id: string;
    account_name: string;
    type: string;
    status: string;
    signed_amount_minor: string;
    party_name: string | null;
    description: string | null;
    reference: string | null;
    cheque_number: string | null;
    transaction_date: string;
    counterpart_name: string | null;
  }>(sql`
    select
      t.id, a.id as account_id, a.name as account_name, t.type, t.status,
      case when t.type in ('transfer_in', 'deposit', 'internal_in')
           then t.amount_minor else -t.amount_minor end as signed_amount_minor,
      t.party_name, t.description, t.reference, t.cheque_number,
      t.transaction_date::text, other.name as counterpart_name
    from transactions t
    join bank_accounts a on a.id = t.bank_account_id
    left join transactions pair
      on pair.transfer_group_id = t.transfer_group_id and pair.id <> t.id
    left join bank_accounts other on other.id = pair.bank_account_id
    where t.organization_id = ${organizationId}
      and t.status in ('active', 'issued', 'cleared')
      ${viewFilter}
    order by t.transaction_date desc, t.created_at desc, t.id desc
    limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    type: r.type,
    status: r.status,
    signedAmountMinor: Number(r.signed_amount_minor),
    partyName: r.party_name,
    description: r.description,
    reference: r.reference,
    chequeNumber: r.cheque_number,
    transactionDate: r.transaction_date,
    counterpartName: r.counterpart_name,
  }));
}
