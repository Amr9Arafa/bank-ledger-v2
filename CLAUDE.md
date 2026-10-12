@AGENTS.md

# Bank Accounts Ledger (v2)

Internal web app for our company: record incoming bank transfers, issued cheques and other
bank movements for 3 EGP accounts, and show live book and bank balances. It is also a
learning project: I am rebuilding it step by step to understand modern web + AI development.

Full requirements: `docs/prd.md`. Architecture and milestones: `docs/technical-plan.md`.
Reference implementation (v1, already working): https://github.com/Amr9Arafa/Bank-Account-Ledger

## About me and how to work with me

- Experienced Android developer (Kotlin/Java, MVVM, DI, Room, REST). New to Next.js, React,
  TypeScript, Postgres and web deployment. Do not explain general programming concepts.
- Explain new web concepts briefly, comparing them to Android when it helps.
- Build ONE milestone at a time, in small steps. Before writing code for a step, tell me in a
  few lines what you will build, which files change, and why. Wait for my OK on big decisions.
- After each step: run it (`npm run dev`, `npm test`, `npm run build`) and fix errors before
  moving on. Tell me what to open in the browser to see the result.
- Prefer the simplest solution. Do not add libraries, abstractions or infrastructure unless
  they solve a real problem we have now.
- When something breaks, explain the root cause, not only the fix.

## Stack

- Next.js (App Router, server components, server actions) + TypeScript + Tailwind CSS
- Postgres and Auth on Supabase; Drizzle ORM for queries; Zod for validation
- next-intl for English/Arabic (`/en`, `/ar`, Arabic is the default and right-to-left)
- Hosting: Vercel (deploys on push to `main`)

## Commands

- `npm run dev` - run locally on http://localhost:3000
- `npm run build` - production build (run before pushing)
- `npm test` - unit tests

## Architecture rules

- Layers: `src/app` (pages, thin) -> `src/actions` (server actions: check role, validate,
  call ledger, revalidate) -> `src/server/ledger` (ALL business rules) -> `src/server/db`.
- Pages and actions never write to the database directly; only `src/server/ledger` does.
- Every write that touches more than one row runs inside one database transaction.
- Every change to financial data writes an `audit_log` row in the same transaction.
- Every query is scoped by the signed-in user's `organization_id`.
- Check permissions on the server for every write; hiding a button is not security.

## Money and data rules

- Money is always integer piasters (`*_minor`, 1 EGP = 100). Never use floats for money.
  Parse user input from the string, format only for display.
- Balances are never stored; they are computed from transactions.
  - Book balance: opening + credits - debits, counting issued and cleared cheques.
  - Bank balance: same, but counting only cleared cheques.
- Records are never deleted: movements are voided, cheques are cancelled.
- Credits: `transfer_in`, `deposit`, `internal_in`. Debits: `cheque`, `fee`, `internal_out`.
- An internal transfer is two linked rows sharing `transfer_group_id`; voiding one voids both.

## Secrets and environment

- Secrets live in `.env.local` (never committed) and in Vercel env vars as "Secret".
- Never prefix a secret with `NEXT_PUBLIC_` (that ships it to the browser).
- Public by design: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Secret: `DATABASE_URL` (Supabase transaction pooler, port 6543), `SUPABASE_SECRET_KEY`.
- Never print, log or commit secret values.

## UI rules

- Every label comes from `messages/en.json` and `messages/ar.json`; no hard-coded text.
- Use logical Tailwind classes (`ms-`, `me-`, `ps-`, `pe-`, `text-start`, `text-end`),
  never left/right (`ml-`, `mr-`, `text-left`), so Arabic RTL works.

## Lessons from v1 (avoid these traps)

- Next.js 16 calls the middleware file `src/proxy.ts`.
- `params` and `searchParams` in pages are Promises: `const { id } = await params`.
- The postgres client needs `prepare: false` with Supabase's transaction pooler.
- Postgres returns `bigint` and `sum()` as strings: convert with `Number()`.
- Enable RLS on every table (no policies): the publishable key can otherwise read data
  through Supabase's REST API. The server connects with `DATABASE_URL` and is unaffected.
- `redirect()` works by throwing: call it outside `try/catch`.
