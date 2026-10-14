import { asc, eq } from "drizzle-orm";
import { connection } from "next/server";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";

export type CurrentUser = typeof users.$inferSelect;

// TEMPORARY until M4: there is no sign-in yet, so every request acts as the first admin.
// M4 replaces the body with the Supabase session lookup; callers stay the same.
export async function getCurrentUser(): Promise<CurrentUser> {
  // Who is asking is per request: never prerender pages that depend on it.
  await connection();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!user) throw new Error("No admin user found: run npm run db:seed");
  return user;
}
