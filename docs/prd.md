# PRD: Bank Accounts Ledger (Mini-ERP)

## Overview

We are building a small web app that records every incoming bank transfer and every cheque the company writes, and shows the live balance of each bank account.

The company has 3 bank accounts, all in EGP. All 3 receive transfers, and 2 of them also issue cheques. Tracking this in spreadsheets or paper makes it hard to answer simple questions quickly: how much is in each account right now, which cheques have not cleared yet, and what came in this month.

The MVP is a focused data-entry and ledger tool for internal use. It is also a learning project: a real, small SaaS that later grows into AI features such as reading bank statements automatically.

## Goals and non-goals

The MVP succeeds when the finance team stops using spreadsheets for these accounts and trusts the app's balances.

**Goals**

- Record incoming transfers and issued cheques in under 30 seconds each.
- Show the current balance of every account on one screen.
- Show a full transaction history per account, with a running balance.
- Track each cheque until it clears, so outstanding cheques are always visible.

**Non-goals for the MVP**

- Connecting to bank APIs or importing statements automatically (planned for a later phase).
- Full accounting: chart of accounts, invoices, journal entries, VAT, payroll.
- Multiple currencies, multiple companies, or a public sign-up flow.
- Mobile apps; a responsive web app is enough.

**Success metrics**

| Metric | Target |
| --- | --- |
| App balance matches bank statement at month end | 100% of accounts, after cleared cheques are marked |
| Time to enter one transaction | Under 30 seconds |
| Spreadsheets still used for these accounts | None after 1 month |

## Users and roles

Three roles cover the 2 to 3 people who will use the MVP; every user belongs to one company and signs in with email and password.

| Role | Who | Can do |
| --- | --- | --- |
| Admin | Finance manager or owner | Everything, plus manage users and bank accounts, set opening balances |
| Accountant | Data-entry staff | Add and edit transfers and cheques, change cheque status |
| Viewer | Management | See balances and history only |

Edits to financial records are logged with who changed what and when (see Non-functional requirements).

## Core concepts

The app has one central idea: every account balance is calculated from its transactions, never typed in by hand.

- **Bank account**: a company account at a bank. Each has a name, bank, account number, currency, an opening balance and opening date, and flags for what it is used for (receives transfers, issues cheques). One account can do both.
- **Incoming transfer**: money received into an account. It adds to the balance as soon as it is recorded, because it already arrived.
- **Cheque**: money promised out of an account. A cheque is written on one date, can carry a later due date (post-dated cheques), and only leaves the bank when the payee cashes it.
- **Transaction**: the single record type behind every money movement. Transfers in and deposits are credits (+); cheques and bank fees are debits (−). Storing them all in one table makes the per-account history and running balance one simple query.

**Other movements.** Bank fees, cash deposits and transfers between our own accounts also hit these accounts, so the app records them too; without them the balances can never match the bank. A transfer between two company accounts is saved as two linked rows, a debit on one and a credit on the other, written in one database transaction so one half can never exist without the other.

**Two balances per account.** Because cheques clear later, each account shows two numbers:

| Balance | Formula | Answers |
| --- | --- | --- |
| Book balance | Opening + credits − debits, counting every active cheque | How much money is really ours after paying what we promised |
| Bank balance | Opening + credits − debits, counting cleared cheques only | What the bank statement should show today |

The gap between the two is the total of outstanding (uncleared) cheques, which is exactly what the finance team needs to watch.

**Cheque status.** A cheque is Issued when recorded, then becomes Cleared (cashed) or Cancelled (voided before cashing). A Bounced status (the bank rejects it for lack of funds) is out of scope for the MVP, since the book balance warns before that happens. Cancelled cheques stay in the history but count in no balance.

## Functional requirements (MVP)

The MVP has 15 must-have requirements in six groups; anything not listed here waits for a later phase.

**Accounts**

- FR-1: An admin can add, edit and archive a bank account (name, bank, account number, currency, opening balance, opening date, receives transfers yes/no, issues cheques yes/no).
- FR-2: Archived accounts keep their history but disappear from entry forms.

**Incoming transfers**

- FR-3: An accountant can record a transfer: account (only accounts that receive transfers), date received, amount, sender name, bank reference, notes.
- FR-4: The app warns, but allows saving, when a transfer with the same account, amount, date and reference already exists (likely duplicate).

**Other movements**

- FR-13: An accountant can record a bank fee or charge (debit) and a cash deposit or other credit: account, date, amount, description.
- FR-14: An accountant can record a transfer between two company accounts in one form (from, to, date, amount); the app saves a linked debit and credit, and voiding one voids both.

**Language**

- FR-15: Every screen works in English and Arabic, with a right-to-left layout in Arabic; each user picks their language.

**Cheques**

- FR-5: An accountant can record a cheque: account (only accounts that issue cheques), cheque number, payee, issue date, due date, amount, notes.
- FR-6: Cheque numbers are unique per account; the form suggests the next number.
- FR-7: An accountant can mark a cheque Cleared (with the cleared date) or Cancelled (with a reason).
- FR-8: A cheques list shows outstanding cheques sorted by due date, highlighting those due in the next 7 days.

**Balances and history**

- FR-9: A dashboard shows each active account with its book balance, bank balance and outstanding cheque total, plus a company total.
- FR-10: Each account has a ledger: every transaction newest first, with date, type, party, reference, amount, status and running balance.
- FR-11: The ledger can be filtered by date range, type, status and text search (party, reference, cheque number).
- FR-12: Any ledger view can be exported to CSV (Excel-friendly).

**Editing rules**

- Records are never hard-deleted. A mistaken transfer is voided; a mistaken cheque is cancelled. Both stay visible with a strikethrough.
- Only admins can edit a cleared cheque; accountants can see it but not change it.

## Screens

Six screens cover the MVP; the dashboard is the home page.

| Screen | Purpose | Key elements |
| --- | --- | --- |
| Dashboard | See all balances at a glance | One card per account (book balance, bank balance, outstanding cheques), company total, quick buttons: New transfer, New cheque, cheques due this week |
| Account ledger | Full history of one account | Header with balances, filter bar, transaction table with running balance, Export CSV |
| New / edit transfer | Fast data entry | Account dropdown, date (defaults to today), amount, sender, reference, notes; Save and Save + new |
| New / edit cheque | Fast data entry | Account dropdown, suggested cheque number, payee, issue date, due date, amount, notes |
| Cheques | Follow up on outstanding cheques | Tabs: Outstanding, Cleared, Cancelled; mark-cleared action per row |
| Settings | Admin only | Bank accounts, users and roles |

All amounts use thousands separators and two decimals. The UI is in English and Arabic, chosen per user; in Arabic the whole layout flips right to left.

## Data model (draft)

Five tables are enough; balances are computed with SQL, not stored, so they can never drift out of sync.

**organizations**: id, name, created_at. Only one row in the MVP, but every other table carries organization_id so the app can become multi-company later without a migration.

**users**: id, organization_id, email, name, role (admin / accountant / viewer), language (en / ar), created_at.

**bank_accounts**

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| organization_id | uuid | |
| name | text | e.g. "CIB main" |
| bank_name | text | |
| account_number | text | Text, not a number: may have leading zeros |
| currency | text | Always "EGP" in the MVP; kept for later |
| opening_balance_minor | bigint | In piasters (1 EGP = 100) |
| opening_date | date | Transactions before this date are rejected |
| receives_transfers | boolean | |
| issues_cheques | boolean | |
| archived_at | timestamp | Null when active |

**transactions**

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | |
| organization_id | uuid | |
| bank_account_id | uuid | |
| type | text | transfer_in, cheque, deposit, fee, internal_out, internal_in |
| amount_minor | bigint | Always positive; the type decides the sign |
| party_name | text | Sender for transfers, payee for cheques |
| reference | text | Bank reference for transfers |
| cheque_number | text | Unique per account, cheques only |
| transaction_date | date | Date received, or cheque issue date |
| due_date | date | Cheques only |
| status | text | Transfers: active / voided. Cheques: issued / cleared / cancelled |
| cleared_date | date | Cheques only |
| notes | text | |
| created_by, updated_by | uuid | |
| created_at, updated_at | timestamp | |

Internal transfers need one more column, transfer_group_id (uuid, null for other types): both halves of a pair share it, so voiding one finds the other.

**audit_log**: id, organization_id, user_id, transaction_id, action, before (json), after (json), created_at.

Amounts are stored as whole piasters in an integer column. Floating-point numbers lose cents (0.1 + 0.2 ≠ 0.3), which is unacceptable for money.

## Non-functional requirements

Financial data must be correct, private and traceable; speed and scale matter far less at this size.

- **Correctness**: integer money, server-side validation (amount > 0, dates not before the account's opening date, cheque number unique per account), and database constraints as a second line of defence.
- **Auditability**: every create, edit, void and status change writes an audit_log row with the before and after values.
- **Security**: HTTPS only, hashed passwords via the auth provider, role checks on the server for every write, and every query scoped by organization_id.
- **Backups**: daily automatic database backups with at least 7 days kept.
- **Performance**: dashboard and ledger load in under 1 second for up to 50,000 transactions.
- **Usability**: works on desktop and phone browsers; forms usable with keyboard only.
- **Time zone and currency**: dates shown in Africa/Cairo; EGP formatting by default.

## Architecture and build plan

Recommended stack: one Next.js app in TypeScript plus a hosted Postgres database on Supabase, with no separate backend service.

**How data flows when someone saves a cheque:** the form posts to a server action; the action checks the session and role, validates the input, then inserts the transaction and its audit_log row in one database transaction; the page then reloads balances from SQL.

**Why this stack**

- **Next.js (full-stack)**: frontend pages and backend code live in one TypeScript project with one deploy. Trade-off: less separation than a standalone API, which is fine at this size; route handlers can expose a REST API later for AI tool calling.
- **Postgres**: financial records are relational, and SUM plus window functions give balances and running balances in one query.
- **Supabase**: hosted Postgres with auth and daily backups included. Trade-off: one more vendor, but it is plain Postgres underneath, so we can move.
- **Drizzle ORM**: typed queries that stay close to SQL, so the balance logic remains readable.
- **Considered, not chosen now**: a Python (FastAPI) backend with a separate React app. It becomes attractive if the AI work grows heavy in Python; it doubles the moving parts today.

**Milestones** (each one is usable on its own)

1. Skeleton: project setup, database tables, bank accounts seeded, dashboard showing opening balances, and English/Arabic switching with right-to-left layout from day one (adding RTL later means reworking every screen).
2. Transfers and other movements: entry forms for incoming transfers, deposits, fees and internal transfers; account ledger with running balance.
3. Cheques: entry form, clear and cancel actions, cheques list, book vs bank balance.
4. Auth and roles: sign-in, role checks, audit log.
5. Polish and launch: filters, CSV export, production deploy, first real month of data.

## Later phases

AI features come after the ledger is trusted, because each one writes into or reads from that ledger.

| Phase | Feature | What it teaches |
| --- | --- | --- |
| 2 | Upload a bank statement (PDF or Excel); the LLM extracts transactions as structured JSON; the user reviews and confirms before saving | Structured outputs, prompt design, human-in-the-loop |
| 2 | Photo of a cheque fills the cheque form | Vision input, structured outputs |
| 3 | Ask questions in plain language: "How much did we receive from Customer X in September?" | Tool / function calling over our own API, guarding against wrong answers |
| 3 | Reconciliation assistant: match statement lines to ledger entries and flag cheques that should have cleared | A simple agent loop with read-only tools, evaluation on real statements |
| 4 | Multi-company sign-up, billing | Real SaaS: tenants, subscriptions |

## Decisions

- Accounts: 3 accounts, all receive transfers; 2 of them also issue cheques.
- Currency: EGP only.
- Cheques received from customers: very rare, out of scope.
- Bounced cheques: not in the MVP.
- Bank fees, cash deposits and internal transfers: in the MVP.
- Language: English and Arabic, right-to-left included.
- Users: 2 to 3 people; only admins edit cleared cheques.
