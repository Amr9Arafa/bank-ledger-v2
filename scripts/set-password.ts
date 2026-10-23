// Sets a new password for an existing login (e.g. a forgotten admin password).
// Uses SUPABASE_SECRET_KEY from .env.local. The password is typed at a prompt, so it
// never ends up in shell history.
// Run: npm run user:set-password -- someone@example.com
//      npm run user:set-password -- --check someone@example.com   (only looks the login up)
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !secretKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local");
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
if (!email) {
  console.log("Usage: npm run user:set-password -- [--check] <email>");
  process.exit(1);
}

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Find the login by email (the admin API lists users page by page).
async function findUser(target: string) {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === target);
    if (user || data.users.length < 200) return user ?? null;
  }
}

const user = await findUser(email);
if (!user) {
  console.log(`No login with the email ${email}.`);
  process.exit(1);
}
console.log(`Found the login for ${user.email} (id ${user.id}).`);
if (checkOnly) process.exit(0);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("New password (at least 8 characters): ");
const again = await rl.question("Type it again: ");
rl.close();
if (password.length < 8) {
  console.log("Too short: nothing changed.");
  process.exit(1);
}
if (password !== again) {
  console.log("The two passwords differ: nothing changed.");
  process.exit(1);
}

const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
if (error) {
  console.log(`Supabase refused the change: ${error.message}`);
  process.exit(1);
}
console.log("Password changed. You can sign in now.");
