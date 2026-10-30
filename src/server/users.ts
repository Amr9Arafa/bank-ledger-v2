// User profiles: our users table, linked 1:1 to Supabase Auth logins.
import { and, asc, eq } from "drizzle-orm";
import type { NewUserInput } from "../lib/validation.ts";
import { db, type Executor, isUniqueViolation } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { writeAudit } from "./ledger/audit.ts";
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
      telegramUserId: users.telegramUserId,
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

// Locks the user (same organization only) until the transaction ends, so the audit row's
// "before" is the value this change replaced.
async function lockUser(tx: Executor, admin: LedgerUser, userId: string) {
  const [user] = await tx
    .select({ role: users.role, telegramUserId: users.telegramUserId })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, admin.organizationId)))
    .for("update");
  if (!user) throw new LedgerError("userNotFound");
  return user;
}

// Admins cannot change their own role, so the organization always keeps an admin.
// Permission changes are audited like changes to financial data.
export async function changeRole(
  admin: LedgerUser,
  userId: string,
  role: Role,
  database: Executor = db,
) {
  if (userId === admin.id) throw new LedgerError("cannotChangeOwnRole");
  await database.transaction(async (tx) => {
    const before = await lockUser(tx, admin, userId);
    if (before.role === role) return;
    await tx.update(users).set({ role }).where(eq(users.id, userId));
    await writeAudit(tx, admin, {
      action: "role",
      targetUserId: userId,
      before: { role: before.role },
      after: { role },
    });
  });
}

// The app user a Telegram account is linked to, or null. Telegram messages act as this user.
export async function getUserByTelegramId(telegramUserId: string, database: Executor = db) {
  const [user] = await database.select().from(users).where(eq(users.telegramUserId, telegramUserId));
  return user ?? null;
}

// Links (or, with null, unlinks) a user's Telegram account. One Telegram account per user.
export async function setTelegramUserId(
  admin: LedgerUser,
  userId: string,
  telegramUserId: string | null,
  database: Executor = db,
) {
  try {
    await database.transaction(async (tx) => {
      const before = await lockUser(tx, admin, userId);
      if (before.telegramUserId === telegramUserId) return;
      await tx.update(users).set({ telegramUserId }).where(eq(users.id, userId));
      await writeAudit(tx, admin, {
        action: "telegram",
        targetUserId: userId,
        before: { telegramUserId: before.telegramUserId },
        after: { telegramUserId },
      });
    });
  } catch (error) {
    if (!(error instanceof LedgerError) && isUniqueViolation(error)) {
      throw new LedgerError("telegramIdTaken", "telegramUserId");
    }
    throw error;
  }
}
