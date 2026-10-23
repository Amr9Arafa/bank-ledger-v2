# Bank Accounts Ledger (v2)

Internal web app to record incoming transfers, cheques, deposits, bank fees and internal
transfers for the company's EGP accounts, with live book and bank balances. English and
Arabic (right-to-left, the default).

- Requirements: [docs/prd.md](docs/prd.md)
- Architecture and milestones: [docs/technical-plan.md](docs/technical-plan.md)
- Deploying: [docs/deploy-vercel.md](docs/deploy-vercel.md)

## What it does

| Screen | URL | Who |
| --- | --- | --- |
| Sign in | `/ar/login` | everyone |
| Dashboard: balances per account and company, cheques due soon | `/ar` | all roles |
| Account ledger: running balance, filters, CSV export, void | `/ar/accounts/<id>` | all roles (void: accountant+) |
| New movement: transfer in, deposit, fee, internal transfer | `/ar/transactions/new` | accountant+ |
| Cheques: outstanding / cleared / cancelled, clear, cancel | `/ar/cheques` | all roles (actions: accountant+) |
| New cheque | `/ar/cheques/new` | accountant+ |
| Settings: users, bank accounts, audit log | `/ar/settings` | admin |

Replace `/ar` with `/en` for English.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Supabase values.
3. `npm run db:migrate` (creates the tables), then `npm run db:seed` (placeholder data;
   needs an admin login created in Supabase Auth first, see `scripts/seed.ts`).

## Commands

- `npm run dev` - run locally on http://localhost:3000
- `npm test` - unit tests, plus database tests that run inside a rolled-back
  transaction (skipped when `.env.local` is missing)
- `npm run build` - production build (run before pushing)
- `npm run db:generate` / `npm run db:migrate` - create / apply a migration after
  changing `src/server/db/schema.ts`
