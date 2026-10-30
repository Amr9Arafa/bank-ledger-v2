# Deploying to Vercel

How to put the app online with Vercel (app) and Supabase (database), and how to ship
changes afterwards. Takes about 15 minutes the first time.

## How the pieces connect

```
GitHub (main branch) ──push──▶ Vercel builds and hosts the Next.js app
                                     │  DATABASE_URL (transaction pooler, port 6543)
                                     ▼
                               Supabase Postgres (Frankfurt)
```

- Vercel runs `npm run build` on every push and serves the result. Server code (pages,
  server actions, `src/server/*`) runs as Vercel Functions; only client components reach
  the browser.
- The database is the same Supabase project you use locally. There is no separate
  production database yet; that is fine while the data is placeholder data.
- Migrations are **not** run by Vercel. You run them from your machine (see "Shipping
  changes").

## Before the first deploy: Supabase Auth settings

Every page requires sign-in, and only an admin creates logins (Settings → Users). Make
sure nobody can create a login on their own:

1. Supabase → **Authentication → Sign In / Providers → Email**: keep Email enabled,
   turn **off** "Allow new users to sign up". (Even if someone signs up, a login without
   a profile in our `users` table gets "no access"; this setting is the first line.)
2. Supabase → **Project Settings → API Keys**: copy the **secret key** (`sb_secret_…`).
   Put it in `.env.local` as `SUPABASE_SECRET_KEY` and in Vercel (step 3). It lets the
   server create users; it must never reach the browser.

Before entering real company figures: reset the database password (it was shared in a
chat during setup) and update `DATABASE_URL` / `DATABASE_URL_MIGRATIONS` everywhere.

## 1. Push the code to GitHub

Vercel builds what is on GitHub, not what is on your machine.

```powershell
git push origin main
```

## 2. Create the Vercel project

1. Go to <https://vercel.com>, sign in with GitHub.
2. **Add New… → Project**, find `bank-ledger-v2`, click **Import**.
   If the repo is not listed, click **Adjust GitHub App Permissions** and give Vercel
   access to it.
3. Framework Preset shows **Next.js**. Leave Root Directory, Build Command and Output
   Directory as they are.
4. Do **not** click Deploy yet: open **Environment Variables** first (step 3).

## 3. Environment variables

Add these in the import screen (or later in Project → Settings → Environment Variables).
Copy the values from your `.env.local`.

| Name | Value | Sensitive | Environments |
| --- | --- | --- | --- |
| `DATABASE_URL` | Transaction pooler URL, port **6543** | **Yes** | Production, Preview |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (creates users from Settings) | **Yes** | Production, Preview |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | No (public by design) | Production, Preview |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | No (public by design) | Production, Preview |

- Do **not** add `DATABASE_URL_MIGRATIONS`: migrations run only from your machine.
- The password inside `DATABASE_URL` must be URL-encoded exactly as in `.env.local`
  (a `%` in a password is written `%25`).
- Port 6543 matters: Vercel Functions open many short connections, which is what the
  transaction pooler is for.
- Changing an env var later does **not** update the running site: redeploy
  (Deployments → ⋯ → Redeploy).

Now click **Deploy**. The first build takes 1–2 minutes.

## 4. Put the functions next to the database

Supabase is in Frankfurt; Vercel runs functions in Washington, D.C. (`iad1`) by default,
so every query would cross the Atlantic and pages would load slowly.

Project → **Settings → Functions → Function Region** → choose **Frankfurt, Germany
(fra1)** → Save, then redeploy.

## 5. Check it works

1. Open the URL Vercel shows (`https://bank-ledger-v2-….vercel.app`). It redirects to
   `/ar/login`.
2. Sign in with your admin login: the dashboard shows the seeded accounts.
3. Click an account: the ledger opens. Switch to English and back.
4. Settings → Users: add a test accountant, sign in as them in a private window, and
   check that Settings is hidden for them.

If something fails, open the deployment → **Logs** (runtime errors) or the build output
(build errors), and compare with "Troubleshooting" below.

## 6. Telegram bot (AI Inbox input)

Telegram calls `POST /api/telegram/webhook` for every message sent to the bot, so it needs
a public HTTPS URL: the production domain **`https://bank-ledger-v2.vercel.app`**. The
other `*.vercel.app` URLs sit behind Vercel's login (Standard Protection) and Telegram
would get a redirect there.

1. Vercel env vars (Production, Sensitive): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   and `ANTHROPIC_API_KEY` for the extraction. Redeploy after adding them.
2. Settings → Users: put each person's numeric Telegram id in the Telegram ID column.
   Messages from anyone else are ignored and logged with their id
   (`Telegram: message from unlinked Telegram user …`), which is how to find a new id.
   Each person must press **Start** in the bot once, or Telegram refuses the replies.
3. Point the bot at production (once; again only if the domain or secret changes):
   ```
   npm run telegram:webhook -- set https://bank-ledger-v2.vercel.app --drop-pending
   npm run telegram:webhook -- info
   ```
   `--drop-pending` throws away messages queued while no webhook was set.
4. Send the bot a text message and a cheque photo. Each gets a reply with what was read,
   and appears in the AI Inbox for approval.

**Testing without deploying:** with no webhook set (`npm run telegram:webhook -- delete`),
messages wait at Telegram. Read them with the Bot API's `getUpdates`, then POST each update
to `http://localhost:3000/api/telegram/webhook` with the header
`X-Telegram-Bot-Api-Secret-Token`. Replies are ordinary outgoing calls, so they reach
Telegram from your machine. Posting the same update twice must create only one entry.

## Shipping changes afterwards

| You changed | What to do |
| --- | --- |
| Code only | `npm run build` and `npm test` locally, then `git push`. Vercel deploys `main` to production automatically. |
| The database schema (`schema.ts`) | `npm run db:generate`, review the SQL in `drizzle/`, `npm run db:migrate`, **then** push. The database must have the new columns before the new code runs. |
| An environment variable | Change it in Vercel, then redeploy. |

- Push a branch other than `main` (e.g. `git push origin feature-x`) to get a **Preview**
  URL for that branch without touching production. Note that previews use the same
  database.
- A bad deploy can be undone in seconds: Deployments → pick the last good one → ⋯ →
  **Promote to Production** (rollback).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Build fails with `SecurityFatalError` | Next.js version has a known vulnerability | Upgrade Next.js locally (`npm install --save-exact next@<fixed> eslint-config-next@<fixed>`), test, push |
| Page shows an error; logs say `DATABASE_URL is not set` | Env var missing, or added after the deploy | Add it, then redeploy |
| Logs say `password authentication failed` | Wrong or non-encoded password in `DATABASE_URL` | Copy the exact value from `.env.local`, redeploy |
| Logs say `URI malformed` | A raw `%` in the password | Encode it as `%25` |
| Pages are slow (several seconds) | Functions far from Frankfurt | Step 4 (Function Region `fra1`) |
| Old data after saving | Should not happen: actions call `revalidatePath` | Hard refresh; if it persists, check the action ran (logs) |
| Dates look one day off | A date was created from a JS `Date` in UTC | Dates must stay `YYYY-MM-DD` strings; see `src/lib/dates.ts` |
| Bot does not answer; `telegram:webhook -- info` shows `Wrong response from the webhook: 401` | `TELEGRAM_WEBHOOK_SECRET` differs between Vercel and the last `set` | Fix the Vercel value and redeploy, or run `set` again |
| `info` shows `302 Found` | The webhook URL is behind Vercel's login | `set` with `https://bank-ledger-v2.vercel.app` |
| Bot does not answer; no error in `info` | Sender's Telegram id is not linked (see the log), or they never pressed Start | Link it in Settings; press Start in the bot |
