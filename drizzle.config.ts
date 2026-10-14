import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so it loads .env.local itself.
process.loadEnvFile(".env.local");

const url = process.env.DATABASE_URL_MIGRATIONS;
if (!url) throw new Error("DATABASE_URL_MIGRATIONS is not set");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  // Session pooler (port 5432): one connection for the whole migration.
  dbCredentials: { url },
  // Only manage our tables; Supabase owns "auth", "storage", etc.
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
