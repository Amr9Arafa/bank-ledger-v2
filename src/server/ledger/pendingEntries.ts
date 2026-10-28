// AI Inbox entries: what the model read, waiting for review. Nothing here touches a balance.
import { db, type Executor } from "../db/client.ts";
import { pendingEntries } from "../db/schema.ts";
import type { LedgerUser } from "./types.ts";

export type NewPendingEntry = {
  // Chosen by the caller, so the photo's storage path can use it before the row exists.
  id: string;
  type: "transaction" | "cheque";
  source: "web" | "telegram";
  rawText: string | null;
  imagePath: string | null;
  extracted: unknown;
  warnings: unknown[];
  // Telegram: "<chat_id>:<message_id>" (message ids are only unique within a chat).
  externalMessageId?: string;
};

export async function createPendingEntry(
  user: LedgerUser,
  entry: NewPendingEntry,
  database: Executor = db,
) {
  const [row] = await database
    .insert(pendingEntries)
    .values({
      id: entry.id,
      organizationId: user.organizationId,
      type: entry.type,
      source: entry.source,
      rawText: entry.rawText,
      imageUrl: entry.imagePath,
      extracted: entry.extracted,
      warnings: entry.warnings,
      externalMessageId: entry.externalMessageId,
      createdBy: user.id,
    })
    .returning();
  return row;
}
