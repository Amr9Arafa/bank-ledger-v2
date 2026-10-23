"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import {
  cancelChequeSchema,
  chequeSchema,
  clearChequeSchema,
  fieldErrors,
  transactionIdSchema,
} from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { cancelCheque, clearCheque, createCheque, unclearCheque } from "@/server/ledger/cheques";
import { LedgerError } from "@/server/ledger/types";
import { asInlineAction, formValues, type InlineActionState } from "./form-data";

export type ChequeFormState = {
  errors: Record<string, string>;
  formError?: string;
  values: Record<string, string>;
  saved?: boolean;
};

export async function saveCheque(
  _previous: ChequeFormState,
  formData: FormData,
): Promise<ChequeFormState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const { intent, ...values } = formValues(formData);
  const parsed = chequeSchema.safeParse(values);
  if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };

  try {
    await createCheque(user, parsed.data);
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.field
        ? { values, errors: { [error.field]: error.code } }
        : { values, errors: {}, formError: error.code };
    }
    throw error;
  }

  revalidatePath("/[locale]", "layout");
  if (intent === "saveNew") {
    // Keep account and dates; the page re-renders with the next suggested number.
    const { bankAccountId, transactionDate } = values;
    return { values: { bankAccountId, transactionDate }, errors: {}, saved: true };
  }
  return redirect({ href: "/cheques", locale: await getLocale() });
}

export async function clearChequeAction(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");
  const parsed = clearChequeSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: Object.values(fieldErrors(parsed.error))[0] };
  const result = await asInlineAction(() => clearCheque(user, parsed.data));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}

export async function cancelChequeAction(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");
  const parsed = cancelChequeSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: Object.values(fieldErrors(parsed.error))[0] };
  const result = await asInlineAction(() => cancelCheque(user, parsed.data));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}

// Only admins may change a cleared cheque.
export async function unclearChequeAction(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "admin");
  const parsed = transactionIdSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: "invalidTransaction" };
  const result = await asInlineAction(() => unclearCheque(user, parsed.data.transactionId));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}
