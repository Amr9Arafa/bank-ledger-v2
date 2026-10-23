// User profiles: our users table, linked 1:1 to Supabase Auth logins.
import { and, asc, eq } from "drizzle-orm";
import type { NewUserInput } from "../lib/validation.ts";
import { db, type Executor } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { LedgerError, type LedgerUser } from "./ledger/types.ts";

type Role = "admin" | "accountant" | "viewer";

export async function getProfile(userId: string, database: Executor = db) {
  const [user] = await database.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

export async function saveUserLanguage(userId: string, language: "ar" | "en", database: Executor = db) {
  await database.update(users).set({ language }).where(eq(users.id, userId));
}

export async function listUsers(organizationId: string, database: Executor = db) {
  return database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      language: users.language,
    })
    .from(users)
    .where(eq(users.organizationId, organizationId))
    .orderBy(asc(users.name));
}

// Profile for a login the admin just created in Supabase Auth.
export async function createProfile(
  admin: LedgerUser,
  authUserId: string,
  input: Omit<NewUserInput, "password">,
  database: Executor = db,
) {
  await database.insert(users).values({
    id: authUserId,
    organizationId: admin.organizationId,
    email: input.email.toLowerCase(),
    name: input.name,
    role: input.role,
  });
}

// Admins cannot change their own role, so the organization always keeps an admin.
export async function changeRole(
  admin: LedgerUser,
  userId: string,
  role: Role,
  database: Executor = db,
) {
  if (userId === admin.id) throw new LedgerError("cannotChangeOwnRole");
  const updated = await database
    .update(users)
    .set({ role })
    .where(and(eq(users.id, userId), eq(users.organizationId, admin.organizationId)))
    .returning({ id: users.id });
  if (updated.length === 0) throw new LedgerError("userNotFound");
}
