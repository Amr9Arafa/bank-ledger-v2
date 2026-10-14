# Bank Accounts Ledger (v2)

Internal web app to record bank transfers, cheques and other movements for the company's EGP
accounts, with live book and bank balances. English and Arabic (right-to-left).

- Requirements: [docs/prd.md](docs/prd.md)
- Architecture and milestones: [docs/technical-plan.md](docs/technical-plan.md)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Supabase values.

## Commands

- `npm run dev` - run locally on http://localhost:3000 (redirects to `/ar`)
- `npm test` - unit tests
- `npm run build` - production build (run before pushing)
