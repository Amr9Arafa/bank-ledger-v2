import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Supabase's transaction pooler (port 6543) does not support prepared statements.
const client = postgres(url, { prepare: false });

export const db = drizzle(client, { schema });

// The db itself or an open transaction: ledger functions accept either,
// so tests can run them inside a transaction and roll everything back.
export type Database = typeof db;
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// For scripts and tests: an open connection keeps the Node process alive.
export async function closeDatabase() {
  await client.end();
}
