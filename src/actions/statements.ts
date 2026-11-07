"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseStatementFile, type ParsedStatement } from "@/lib/statements";
import type { StatementError } from "@/lib/statements/types";
import { createFromLineSchema, fieldErrors } from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { db } from "@/server/db/client";
import {
  deleteImport,
  findAccountForStatement,
  type ImportPreview,
  importStatement,
  previewStatementImport,
} from "@/server/ledger/statements";
import {
  confirmMatch,
  confirmUniqueSuggestions,
  createAllFromImport,
  createFromLine,
  ignoreLine,
  unignoreLine,
  unmatchLine,
} from "@/server/ledger/reconcile";
import { LedgerError } from "@/server/ledger/types";
import { asInlineAction, formValues, type InlineActionState } from "./form-data";

// MT940 files are a few KB a week; anything near this is not a statement.
const MAX_FILE_BYTES = 1_000_000;

export type UploadError =
  // Keys under "statements.errors" (file and parse problems)...
  | { scope: "statements"; code: StatementError | "noFile" | "fileTooLarge" | "accountUnknown"; detail?: string }
  // ...or under "errors" (business rules from the ledger).
  | { scope: "ledger"; code: string };

export type UploadState = {
  error?: UploadError;
  // Step 1: what importing would do. Nothing is saved yet.
  previews?: ImportPreview[];
  // Step 2: saved. Changes on every import, so the form knows to reset.
  importedIds?: string[];
};

type Read =
  | { ok: true; fileName: string; text: string; items: { bankAccountId: string; statement: ParsedStatement }[] }
  | { ok: false; error: UploadError };

// File -> parsed statements, each with the account its :25: number belongs to.
async function readUpload(organizationId: string, formData: FormData): Promise<Read> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: { scope: "statements", code: "noFile" } };
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: { scope: "statements", code: "fileTooLarge" } };

  const text = await file.text();
  const parsed = parseStatementFile(text);
  if (!parsed.ok) return { ok: false, error: { scope: "statements", code: parsed.error, detail: parsed.detail } };

  const items = [];
  for (const statement of parsed.statements) {
    const bankAccountId = await findAccountForStatement(organizationId, statement.accountNumber);
    if (!bankAccountId) return { ok: false, error: { scope: "statements", code: "accountUnknown" } };
    items.push({ bankAccountId, statement });
  }
  return { ok: true, fileName: file.name.slice(0, 200), text, items };
}

// One form, two steps: without confirm=1 it only previews; with it, it imports every
// statement in the file in one DB transaction (all or nothing).
export async function uploadStatement(_previous: UploadState, formData: FormData): Promise<UploadState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const read = await readUpload(user.organizationId, formData);
  if (!read.ok) return { error: read.error };

  try {
    if (formData.get("confirm") !== "1") {
      const previews = [];
      for (const item of read.items) previews.push(await previewStatementImport(user, item));
      return { previews };
    }

    const importedIds = await db.transaction(async (tx) => {
      const ids = [];
      for (const item of read.items) {
        const { importId } = await importStatement(
          user,
          { ...item, fileName: read.fileName, rawText: read.text },
          tx,
        );
        ids.push(importId);
      }
      return ids;
    });
    revalidatePath("/[locale]", "layout");
    return { importedIds };
  } catch (error) {
    if (error instanceof LedgerError) return { error: { scope: "ledger", code: error.code } };
    throw error;
  }
}

const importId = z.uuid({ message: "importNotFound" });

// Admin only: removes the newest import of an account and its lines (ledger unchanged).
export async function deleteImportAction(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "admin");
  const id = importId.safeParse(formData.get("importId"));
  if (!id.success) return { error: "importNotFound" };
  const result = await asInlineAction(() => deleteImport(user, id.data));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}

// ---- Matching (accountant or above) ----

const lineAndRow = z.object({
  lineId: z.uuid({ message: "lineNotFound" }),
  transactionId: z.uuid({ message: "notACandidate" }),
});
const lineOnly = z.object({ lineId: z.uuid({ message: "lineNotFound" }) });
const ignoreInput = z.object({
  lineId: z.uuid({ message: "lineNotFound" }),
  reason: z.string({ error: "required" }).trim().min(1, "required").max(200, "tooLong"),
});

// Validates, checks the role, runs the ledger call and refreshes the pages.
async function matchingAction<T>(
  schema: z.ZodType<T>,
  formData: FormData,
  run: (user: Awaited<ReturnType<typeof getCurrentUser>>, input: T) => Promise<unknown>,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "required" };
  const result = await asInlineAction(() => run(user, parsed.data));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}

export async function confirmMatchAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(lineAndRow, formData, (user, input) => confirmMatch(user, input));
}

export async function unmatchAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(lineOnly, formData, (user, input) => unmatchLine(user, input.lineId));
}

export async function ignoreLineAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(ignoreInput, formData, (user, input) => ignoreLine(user, input));
}

export async function unignoreLineAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(lineOnly, formData, (user, input) => unignoreLine(user, input.lineId));
}

export async function confirmUniqueAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(z.object({ importId }), formData, (user, input) => confirmUniqueSuggestions(user, input.importId));
}

// ---- Creating records from lines (accountant or above) ----

export type CreateFromLineState = {
  errors: Record<string, string>;
  formError?: string;
  // What was typed: React resets the form after an action, so inputs reload these.
  values: Record<string, string>;
  done?: boolean;
};

export async function createFromLineAction(
  _previous: CreateFromLineState,
  formData: FormData,
): Promise<CreateFromLineState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");
  const values = formValues(formData);
  const parsed = createFromLineSchema.safeParse(values);
  if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };
  try {
    await createFromLine(user, parsed.data);
  } catch (error) {
    if (error instanceof LedgerError) {
      // Fields the form shows get the error next to them; anything else goes on top.
      const shown = ["partyName", "description", "chequeNumber", "otherAccountId", "notes"];
      return error.field && shown.includes(error.field)
        ? { values, errors: { [error.field]: error.code } }
        : { values, errors: {}, formError: error.code };
    }
    throw error;
  }
  revalidatePath("/[locale]", "layout");
  return { values, errors: {}, done: true };
}

export async function createAllFeesAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(z.object({ importId }), formData, (user, input) =>
    createAllFromImport(user, { importId: input.importId, kind: "fee" }),
  );
}

export async function createAllInterestAction(_previous: InlineActionState, formData: FormData) {
  return matchingAction(z.object({ importId }), formData, (user, input) =>
    createAllFromImport(user, { importId: input.importId, kind: "interest" }),
  );
}
