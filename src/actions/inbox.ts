"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { chequeSchema, fieldErrors, movementSchema } from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import {
  ExtractionError,
  type ExtractionErrorCode,
  extractToPendingEntry,
} from "@/server/ai/extract";
import { getCurrentUser } from "@/server/auth/session";
import {
  type ApprovalInput,
  approvePendingEntry,
  rejectPendingEntry,
} from "@/server/ledger/pendingEntries";
import { LedgerError } from "@/server/ledger/types";
import { deleteInboxImage } from "@/server/storage";
import { asInlineAction, formValues, type InlineActionState } from "./form-data";

export type ReviewFormState = {
  errors: Record<string, string>;
  formError?: string;
  // What the reviewer typed: React resets the form after an action, so inputs reload these.
  values: Record<string, string>;
  // FR-4: a likely duplicate exists; approving again saves anyway.
  duplicate?: boolean;
};

const entryId = z.uuid({ message: "entryNotFound" });

export type InboxSubmitState = {
  // Key under "inbox.errors" in messages/*.json. Nothing was saved.
  error?: ExtractionErrorCode;
  // Kept on error, so a retry is one click.
  text: string;
  // Changes on every success, so the form knows to clear the photo.
  createdId?: string;
};

// Text and/or a photo (already shrunk in the browser) -> AI -> a pending entry.
export async function submitToInbox(
  _previous: InboxSubmitState,
  formData: FormData,
): Promise<InboxSubmitState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const text = typeof formData.get("text") === "string" ? (formData.get("text") as string) : "";
  const image = formData.get("image");
  const file = image instanceof File && image.size > 0 ? image : null;

  try {
    const entry = await extractToPendingEntry(user, {
      text,
      image: file
        ? { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type }
        : undefined,
      source: "web",
    });
    revalidatePath("/[locale]", "layout");
    return { text: "", createdId: entry.id };
  } catch (error) {
    if (error instanceof ExtractionError) return { error: error.code, text };
    throw error;
  }
}

// Approve: the edited values go through the same validation as the manual forms, then the
// ledger creates the record and marks the entry approved in one DB transaction.
// Same permission as entering a movement or cheque by hand.
export async function approveEntry(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const values = formValues(formData);
  const { entryId: rawId, entryType, allowDuplicate, ...input } = values;
  const id = entryId.safeParse(rawId);
  if (!id.success) return { values, errors: {}, formError: "entryNotFound" };

  let approval: ApprovalInput;
  if (entryType === "cheque") {
    const parsed = chequeSchema.safeParse(input);
    if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };
    approval = { type: "cheque", cheque: parsed.data };
  } else {
    const parsed = movementSchema.safeParse(input);
    if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };
    approval = { type: "transaction", movement: parsed.data };
  }

  try {
    const result = await approvePendingEntry(user, id.data, approval, {
      allowDuplicate: allowDuplicate === "1",
    });
    if (result.status === "duplicate") return { values, errors: {}, duplicate: true };
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.field
        ? { values, errors: { [error.field]: error.code } }
        : { values, errors: {}, formError: error.code };
    }
    throw error;
  }

  // Balances, the inbox count and the inbox list all change.
  revalidatePath("/[locale]", "layout");
  return { values, errors: {} };
}

export async function rejectEntry(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");
  const id = entryId.safeParse(formValues(formData).entryId);
  if (!id.success) return { error: "entryNotFound" };

  let imagePath: string | null = null;
  const result = await asInlineAction(async () => {
    imagePath = (await rejectPendingEntry(user, id.data)).imagePath;
  });
  if (result.done) {
    // After the commit: if deleting the photo fails, the entry stays rejected and only an
    // unreferenced file is left behind, which is logged.
    if (imagePath) {
      await deleteInboxImage(imagePath).catch((error) =>
        console.error("Inbox: could not delete the photo of a rejected entry:", error),
      );
    }
    revalidatePath("/[locale]", "layout");
  }
  return result;
}
