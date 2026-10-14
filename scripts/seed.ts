// Dev seed: 1 organization, the admin profile, 3 placeholder bank accounts.
// Safe to run again: fixed ids + "on conflict do nothing", so existing rows are never changed.
// Run: npm run db:seed
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { bankAccounts, organizations, users } from "../src/server/db/schema.ts";

// The admin login created in Supabase Auth; our users.id must match it.
const ADMIN_ID = "4fe23c29-0ab0-43c0-9bfd-a5a296b58841";
const ADMIN_NAME = "Amr Arafa";

const ORG_ID = "e5ddd84b-5d38-497e-b482-0c26691edac1";
const OPENING_DATE = "2026-10-01";

// Placeholders until the real accounts and opening balances are agreed.
const ACCOUNTS = [
  {
    id: "6173ce4b-0ab1-4bed-a1c3-3935b4aa73d6",
    name: "CIB Main",
    bankName: "Commercial International Bank",
    accountNumber: "100012345678",
    openingBalanceMinor: 25_000_000, // 250,000.00 EGP
    issuesCheques: true,
  },
  {
    id: "11a45c97-c4e8-4023-b5c7-9267872e9b83",
    name: "NBE Operations",
    bankName: "National Bank of Egypt",
    accountNumber: "0012345678901",
    openingBalanceMinor: 12_050_050, // 120,500.50 EGP
    issuesCheques: true,
  },
  {
    id: "e9256a09-8bb7-40f6-ab3d-4d5bda2475df",
    name: "QNB Collections",
    bankName: "QNB Egypt",
    accountNumber: "0098765432",
    openingBalanceMinor: 7_500_000, // 75,000.00 EGP
    issuesCheques: false,
  },
];

process.loadEnvFile(".env.local");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { prepare: false });
const db = drizzle(client);

try {
  await db.transaction(async (tx) => {
    const [authUser] = await tx.execute<{ email: string }>(
      sql`select email from auth.users where id = ${ADMIN_ID}`,
    );
    if (!authUser) {
      throw new Error(`No Supabase Auth user with id ${ADMIN_ID}`);
    }

    await tx
      .insert(organizations)
      .values({ id: ORG_ID, name: "Our Company (placeholder)" })
      .onConflictDoNothing();

    await tx
      .insert(users)
      .values({
        id: ADMIN_ID,
        organizationId: ORG_ID,
        email: authUser.email,
        name: ADMIN_NAME,
        role: "admin",
        language: "ar",
      })
      .onConflictDoNothing();

    await tx
      .insert(bankAccounts)
      .values(
        ACCOUNTS.map((a) => ({
          ...a,
          organizationId: ORG_ID,
          openingDate: OPENING_DATE,
          receivesTransfers: true,
        })),
      )
      .onConflictDoNothing();
  });

  const rows = await db
    .select({ name: bankAccounts.name, issuesCheques: bankAccounts.issuesCheques })
    .from(bankAccounts)
    .where(eq(bankAccounts.organizationId, ORG_ID));
  console.log(`Seeded organization, admin and ${rows.length} accounts:`);
  console.table(rows);
} finally {
  await client.end();
}
