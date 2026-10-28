// Tries the AI Inbox extraction from the terminal. Calls the real API (costs a little).
// By default nothing is saved; --save creates a pending entry (and uploads the photo).
// Run: npm run ai:extract -- "استلمنا تحويل 15 ألف من شركة النور على حساب CIB امبارح"
//      npm run ai:extract -- --image cheque.jpg
//      npm run ai:extract -- --save --email someone@example.com "..."
// Without --email, the first admin's organization is used.
import { readFileSync } from "node:fs";
import { extname } from "node:path";

process.loadEnvFile(".env.local");

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const save = args.includes("--save");
const email = option("--email");
const imagePath = option("--image");
const text = args.filter((a) => !a.startsWith("--")).join(" ").trim() || undefined;
if (!text && !imagePath) {
  console.log('Usage: npm run ai:extract -- [--save] [--email <email>] [--image <file>] ["text"]');
  process.exit(1);
}

// Imported after the env is loaded: client.ts reads DATABASE_URL on import.
const { asc, eq } = await import("drizzle-orm");
const { db, closeDatabase } = await import("../src/server/db/client.ts");
const { users } = await import("../src/server/db/schema.ts");
const { extractToPendingEntry, ExtractionError, runExtraction } = await import(
  "../src/server/ai/extract.ts"
);

const [user] = await db
  .select()
  .from(users)
  .where(email ? eq(users.email, email.toLowerCase()) : eq(users.role, "admin"))
  .orderBy(asc(users.createdAt))
  .limit(1);
if (!user) {
  console.log(email ? `No user with the email ${email}.` : "No admin user found.");
  process.exit(1);
}

const mediaTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const image = imagePath
  ? {
      bytes: new Uint8Array(readFileSync(imagePath)),
      mediaType: mediaTypes[extname(imagePath).toLowerCase()] ?? "unknown",
    }
  : undefined;

const input = { text, image, source: "web" as const };
const model = process.env.EXTRACTION_MODEL || "claude-haiku-5-5";
console.log(`Model: ${model} | user role: ${user.role} | save: ${save}\n`);

try {
  const started = Date.now();
  if (save) {
    const row = await extractToPendingEntry(user, input);
    console.log(`Saved pending entry ${row.id} (${row.type})`);
    console.log(JSON.stringify({ extracted: row.extracted, warnings: row.warnings }, null, 2));
  } else {
    const result = await runExtraction(user, input);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log(`\nTook ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (error) {
  if (error instanceof ExtractionError) {
    console.log(`Extraction failed: ${error.code}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDatabase();
}
