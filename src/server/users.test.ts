// Permission changes (role, Telegram link) are audited in the same transaction, and a
// Telegram account links to at most one user.
// Runs against the dev database inside a transaction that is always rolled back.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Executor } from "./db/client.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (e.g. CI): the tests below are skipped.
}
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

// Imported after the env is loaded: client.ts reads DATABASE_URL on import.
const load = async () => ({
  ...(await import("drizzle-orm")),
  ...(await import("./db/client.ts")),
  ...(await import("./db/schema.ts")),
  ...(await import("./users.ts")),
  ...(await import("./ledger/types.ts")),
});

class Rollback extends Error {}

async function inRollback(fn: (tx: Executor) => Promise<void>) {
  const { db } = await load();
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(async () => {
  if (!skip) await (await load()).closeDatabase();
});

// A test organization with an admin and an accountant. users.id references auth.users,
// so each gets a bare auth row too (rolled back with everything else).
async function setup(tx: Executor) {
  const m = await load();
  const orgId = crypto.randomUUID();
  await tx.insert(m.organizations).values({ id: orgId, name: "Users test" });
  const makeUser = async (role: "admin" | "accountant") => {
    const id = crypto.randomUUID();
    await tx.execute(m.sql`insert into auth.users (id) values (${id})`);
    await tx.insert(m.users).values({
      id, organizationId: orgId, email: `${id}@test.invalid`, name: role, role,
    });
    return { id, organizationId: orgId };
  };
  return { m, admin: await makeUser("admin"), accountant: await makeUser("accountant") };
}

async function auditRows(tx: Executor, targetUserId: string) {
  const m = await load();
  return tx
    .select({ action: m.auditLog.action, before: m.auditLog.before, after: m.auditLog.after })
    .from(m.auditLog)
    .where(m.eq(m.auditLog.targetUserId, targetUserId));
}

test("linking Telegram writes one audit row; the same value again writes none", { skip }, () =>
  inRollback(async (tx) => {
    const { m, admin, accountant } = await setup(tx);
    await m.setTelegramUserId(admin, accountant.id, "900000001", tx);
    await m.setTelegramUserId(admin, accountant.id, "900000001", tx);
    assert.equal((await m.getUserByTelegramId("900000001", tx))?.id, accountant.id);
    assert.deepEqual(await auditRows(tx, accountant.id), [
      { action: "telegram", before: { telegramUserId: null }, after: { telegramUserId: "900000001" } },
    ]);

    await m.setTelegramUserId(admin, accountant.id, null, tx);
    assert.equal(await m.getUserByTelegramId("900000001", tx), null);
    assert.equal((await auditRows(tx, accountant.id)).length, 2);
  }));

test("a Telegram id already linked to another user is refused", { skip }, () =>
  inRollback(async (tx) => {
    const { m, admin, accountant } = await setup(tx);
    await m.setTelegramUserId(admin, admin.id, "900000002", tx);
    await assert.rejects(m.setTelegramUserId(admin, accountant.id, "900000002", tx), {
      code: "telegramIdTaken",
      field: "telegramUserId",
    });
    assert.deepEqual(await auditRows(tx, accountant.id), []);
  }));

test("a role change writes an audit row with the old and new role", { skip }, () =>
  inRollback(async (tx) => {
    const { m, admin, accountant } = await setup(tx);
    await m.changeRole(admin, accountant.id, "viewer", tx);
    assert.deepEqual(await auditRows(tx, accountant.id), [
      { action: "role", before: { role: "accountant" }, after: { role: "viewer" } },
    ]);
  }));

test("an admin of another organization cannot change the user", { skip }, () =>
  inRollback(async (tx) => {
    const { m, accountant } = await setup(tx);
    const outsider = { id: crypto.randomUUID(), organizationId: crypto.randomUUID() };
    await assert.rejects(m.changeRole(outsider, accountant.id, "admin", tx), { code: "userNotFound" });
    await assert.rejects(m.setTelegramUserId(outsider, accountant.id, "900000003", tx), {
      code: "userNotFound",
    });
  }));
