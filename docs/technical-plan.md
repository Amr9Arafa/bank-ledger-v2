# Technical Plan: Bank Accounts Ledger

This plan turns `docs/prd.md` into a buildable design: one Next.js + TypeScript app with Postgres on Supabase, delivered in 5 milestones.

Updated for v2 with what we learned building v1 (see "Lessons from v1" in CLAUDE.md).

## Stack decisions

Every choice favours one codebase, one language and as few services as possible; each row can be swapped later without rewriting the domain logic.

| Concern | Choice | Why | Android analogy |
| --- | --- | --- | --- |
| Language | TypeScript everywhere | One language for UI, server and DB schema; types catch money and status mistakes | Kotlin across all modules |
| Framework | Next.js 16 (App Router) | Pages, server code and forms in one project, one deploy | App module + backend in one repo |
| UI | React + Tailwind CSS | Utility classes; logical start/end classes support RTL natively | Compose modifiers |
| Database | Postgres on Supabase | Relational data, SUM and window functions for balances, daily backups included | Room, but a real server DB |
| DB access | Drizzle ORM + drizzle-kit migrations | Schema written in TypeScript, queries stay close to SQL | Room entities + DAOs + migrations |
| Auth | Supabase Auth (email + password) | Hashed passwords and sessions without building them | Firebase Auth |
| Validation | Zod | One schema validates form input on the server | A shared validator class |
| i18n | next-intl | Locale in the URL, translation files, number and date formatting | strings.xml per locale |
| Hosting | Vercel (app) + Supabase (DB) | Push to GitHub, it deploys; preview URL per branch | Play Console tracks |
| Tests | Node's built-in test runner (`node --test`) | Zero extra packages for unit tests | JUnit |

Not used on purpose: a separate backend service, Redux or other client state libraries, GraphQL, Docker. None solves a problem this app has.

## Code structure and layers

All business rules live in one domain layer (`src/server/ledger`) that knows nothing about React; pages and server actions are thin callers of it.

This matters for later: in phase 2 and 3, AI tools and API routes will call the same functions, so the rules (sign of amounts, who may edit a cleared cheque) exist in exactly one place.

```
src/
  app/
    [locale]/                 # ar | en, from next-intl
      layout.tsx              # sets <html lang dir>
      page.tsx                # dashboard
      login/page.tsx
      accounts/[id]/page.tsx  # ledger
      transactions/new/page.tsx
      cheques/page.tsx
      settings/page.tsx
  actions/                    # 'use server' functions called by forms
  server/
    db/
      schema.ts               # Drizzle tables
      client.ts
    auth/
      session.ts              # getCurrentUser(), requireRole()
    ledger/                   # domain layer, no React
      balances.ts
      transactions.ts         # create, void, internal transfer, cheques
      audit.ts
  lib/
    money.ts                  # parse and format piasters
    validation.ts             # Zod schemas
  components/                 # UI pieces
  i18n/                       # routing and request config
  messages/
    en.json
    ar.json
  proxy.ts                    # runs before each request (Next 16 name for middleware)
drizzle/                      # generated SQL migrations
```

The layering, mapped to Android:

| Layer | Folder | Android equivalent |
| --- | --- | --- |
| UI | `app/`, `components/` | Activities, Fragments, Composables |
| Entry points | `actions/` | ViewModel methods |
| Domain | `server/ledger/` | Use cases / repository |
| Data | `server/db/` | Room DAOs and entities |

One difference from Android: server components run on the server and query the database directly while rendering, so a read-only page like the dashboard needs no API call at all. Only writes go through server actions.

## Database

The database enforces the money rules itself, so a bug in the app cannot save an invalid cheque or a negative amount.

The schema is written in Drizzle (`schema.ts`); this is the SQL for the core table:

```sql
create table transactions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id),
  bank_account_id   uuid not null references bank_accounts(id),
  type              text not null check (type in
                      ('transfer_in','deposit','internal_in',
                       'cheque','fee','internal_out')),
  amount_minor      bigint not null check (amount_minor > 0),
  party_name        text,
  reference         text,
  description       text,
  cheque_number     text,
  transaction_date  date not null,
  due_date          date,
  status            text not null,
  cleared_date      date,
  transfer_group_id uuid,
  status_reason     text,
  notes             text,
  created_by        uuid not null references users(id),
  updated_by        uuid not null references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- cheques must have a number; only cheques have one
  check ((type = 'cheque') = (cheque_number is not null)),
  -- valid status per type
  check (
    (type = 'cheque' and status in ('issued','cleared','cancelled'))
    or (type <> 'cheque' and status in ('active','voided'))
  ),
  -- cleared cheques carry a cleared date
  check ((status = 'cleared') = (cleared_date is not null)),
  -- internal transfer rows always belong to a pair
  check ((type in ('internal_in','internal_out')) = (transfer_group_id is not null))
);

create unique index cheque_number_per_account
  on transactions (bank_account_id, cheque_number)
  where type = 'cheque';

create index ledger_order
  on transactions (bank_account_id, transaction_date, created_at);
```

Enable Row Level Security on every table with no policies: the publishable key could otherwise read data through Supabase's REST API. The server connects with `DATABASE_URL` and is not affected.

**Balances are a query, not a column.** Credits are `transfer_in`, `deposit`, `internal_in`; everything else is a debit. Voided and cancelled rows count nowhere.

```sql
select
  a.id,
  a.opening_balance_minor + coalesce(sum(
    case when t.type in ('transfer_in','deposit','internal_in')
         then t.amount_minor else -t.amount_minor end
  ) filter (where t.status in ('active','issued','cleared')), 0)
    as book_balance,
  a.opening_balance_minor + coalesce(sum(
    case when t.type in ('transfer_in','deposit','internal_in')
         then t.amount_minor else -t.amount_minor end
  ) filter (where t.status in ('active','cleared')), 0)
    as bank_balance
from bank_accounts a
left join transactions t on t.bank_account_id = a.id
where a.organization_id = $1 and a.archived_at is null
group by a.id;
```

**Running balance in the ledger** uses a window function: Postgres computes a cumulative sum row by row, in date order, in the same query that lists the rows.

```sql
sum(signed_amount) over (
  partition by bank_account_id
  order by transaction_date, created_at, id
) + opening_balance_minor as running_balance
```

The query sorts oldest-first to compute the sum, and the page then shows rows newest-first. Compute the running balance over all rows first, then apply filters, so a filtered view still shows true balances.

## Core flows

Every write follows the same five steps, and each multi-row write runs inside one database transaction so it fully succeeds or fully fails.

**Saving any transaction (transfer, deposit, fee, cheque)**

1. The form submits to a server action, a normal async function that Next.js turns into a POST request.
2. The action loads the session, calls `requireRole('accountant')`, and validates the input with Zod (never trust the client).
3. It calls the ledger function, which, in one DB transaction, inserts the row and its `audit_log` row.
4. The action calls `revalidatePath()` so the dashboard and ledger re-render with fresh balances.
5. It redirects (to the ledger, or back to a fresh form for "Save + new").

**Internal transfer between two company accounts**

1. One form: from account, to account (must differ), date, amount, note.
2. The ledger generates one `transfer_group_id`, then inserts an `internal_out` row on the source and an `internal_in` row on the destination, plus two audit rows, all in one DB transaction.
3. Voiding either row voids every row with the same `transfer_group_id`, in one DB transaction.

**Clearing or cancelling a cheque**

1. From the cheques list, "Mark cleared" asks for the cleared date (defaults to today).
2. The ledger checks the cheque is currently `issued`, sets status and cleared date, and writes an audit row.
3. Cancel works the same way with a required reason, and is allowed only from `issued`.
4. Editing a `cleared` cheque requires the admin role.

**Duplicate warning** (FR-4): before insert, look for a row with the same account, amount, date and reference. If one exists, return a warning instead of saving, and the form shows "Save anyway".

## Auth and permissions

Supabase Auth proves who the user is; our own `users` table decides what they may do, and that check happens on the server for every write.

- **Sign-in**: email and password through Supabase Auth, using `@supabase/ssr` so the session lives in an HTTP-only cookie.
- **No public sign-up**: the admin invites users from Settings (needs the Supabase secret key on the server).
- **Proxy**: `src/proxy.ts` runs before every request, picks the locale, refreshes the session cookie and sends signed-out users to `/login`.
- **Roles**: `requireRole('viewer' | 'accountant' | 'admin')` loads the current user and throws if their role is too low. Roles are ordered, so an admin passes an accountant check.
- **Org scoping**: every query in `server/ledger` takes the user and filters by their `organization_id`.
- **UI hiding is not security**: buttons are hidden for roles that cannot use them, but the server check is what actually protects the data.

## Arabic, right-to-left and number formatting

RTL is built into milestone 1 by following three rules from the first screen.

- **Locale in the URL**: `/ar/...` (default) and `/en/...`, handled by next-intl. The layout sets `<html lang="ar" dir="rtl">` for Arabic.
- **Logical CSS only**: use Tailwind's start/end classes (`ms-4`, `pe-2`, `text-start`), never left/right ones (`ml-4`, `text-left`).
- **No hard-coded strings**: every label comes from `messages/en.json` or `messages/ar.json`.

**Numbers and money.** Amounts are stored as integer piasters and only formatted for display:

```ts
// src/lib/money.ts
// "1250.5" -> 125050. Splits the string instead of multiplying a float.
export const toMinor = (input: string) => {
  const [whole, frac = ''] = input.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}
export const formatEGP = (minor: number, locale: 'en' | 'ar') =>
  new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', {
    style: 'currency', currency: 'EGP',
  }).format(minor / 100)
```

`ar-EG` shows Arabic-Indic digits (١٢٣). Amount inputs accept both digit styles and normalise to Western digits before validation. Mixed-direction text (an English reference inside an Arabic row) is wrapped in `<bdi>`.

## Testing

Tests concentrate where a bug costs money: amount parsing, balance math and the cheque rules.

| Level | What it covers |
| --- | --- |
| Unit (`node --test`) | `toMinor`, `formatEGP`, validation schemas, role ordering |
| Balance contract | Seed an account with known transactions; assert exact book balance, bank balance and every running-balance value |
| Manual end to end | Sign in, add a transfer, add a cheque, clear it, check both balances; once in English and once in Arabic |

## Environments and deployment

| Environment | App | Database |
| --- | --- | --- |
| Local | `npm run dev` | The Supabase cloud project (dev data) |
| Production | Vercel, `main` branch | Supabase project, daily backups on |

**Migrations**: change `schema.ts`, run `drizzle-kit generate` to produce a SQL file in `drizzle/`, review it, commit it, then apply it. Never edit the production schema by hand in the Supabase dashboard.

**Secrets** (`DATABASE_URL`, `SUPABASE_SECRET_KEY`) live in `.env.local` locally and in Vercel environment variables as Secret, never in Git.

## Milestones

Each milestone ends with something the finance team can open and use.

**M1: Skeleton** — done when the dashboard shows the 3 seeded accounts with opening balances, in English and Arabic.

- [ ] Supabase project and `.env.local`
- [ ] Drizzle setup; `schema.ts` for all five tables; first migration; RLS enabled
- [ ] Seed: 1 organization, 1 admin user, 3 bank accounts (2 issue cheques)
- [ ] next-intl with `/ar` and `/en`, `dir` on `<html>`, language switcher
- [ ] `money.ts` with unit tests
- [ ] Dashboard page reading balances with the SQL above

**M2: Transfers and other movements** — done when every non-cheque movement can be entered and appears in the ledger with a correct running balance.

- [ ] Zod schemas and server actions for transfer in, deposit, fee
- [ ] Internal transfer form with linked pair
- [ ] Void action (voids both halves of an internal pair)
- [ ] Account ledger page with running balance
- [ ] Duplicate warning (FR-4)
- [ ] Balance contract test

**M3: Cheques** — done when cheques can be issued, cleared and cancelled, and book vs bank balances differ by exactly the outstanding total.

- [ ] Cheque form with suggested next number per account
- [ ] Cheques page with Outstanding, Cleared, Cancelled tabs; due-in-7-days highlight
- [ ] Clear and cancel actions
- [ ] Dashboard shows book balance, bank balance, outstanding total

**M4: Auth, roles and audit** — done when real users sign in with the right permissions and every change is in the audit log.

- [ ] Supabase Auth login, proxy, sessions
- [ ] `requireRole()` on every action; hide buttons per role
- [ ] Admin invite flow in Settings
- [ ] Audit log writes inside every ledger function; admin-only audit view
- [ ] Admin-only edit of cleared cheques

**M5: Polish and launch** — done when the first real month is entered and matches the bank statements.

- [ ] Ledger filters and search; CSV export (UTF-8 with BOM so Excel shows Arabic)
- [ ] Settings: manage bank accounts
- [ ] Production deploy on Vercel
- [ ] Enter opening balances and one month of real data; reconcile with the bank

## Risks

The biggest risk is not technical: balances that do not match the bank will make the team stop trusting the app.

| Risk | Mitigation |
| --- | --- |
| App balance does not match the bank statement | Record fees, deposits and internal transfers from day one; reconcile the first real month with the team |
| Wrong opening balances | Take them from the bank statement on one agreed date; earlier transactions are rejected |
| Rounding errors in money | Integer piasters everywhere; string-based parsing; balance contract test |
| RTL bugs found late | Logical CSS rule from M1; test every screen in Arabic |
| Someone edits history silently | No hard deletes, audit log on every change, admin-only edits to cleared cheques |
| Learning curve on Next.js server vs client code | Keep business logic in `server/ledger`; pages stay thin |
