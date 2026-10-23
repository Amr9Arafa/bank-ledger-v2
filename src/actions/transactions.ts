"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import {
  fieldErrors,
  internalTransferSchema,
  movementSchema,
  voidSchema,
} from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import {
  createInternalTransfer,
  createMovement,
  type CreateResult,
  voidTransaction,
} from "@/server/ledger/transactions";
import { LedgerError } from "@/server/ledger/types";
import { asInlineAction, formValues, type InlineActionState } from "./form-data";

export type MovementFormState = {
  // Field name -> error key under "errors" in messages/*.json.
  errors: Record<string, string>;
  // Error that belongs to no single field.
  formError?: string;
  // What the user typed: React resets the form after an action, so inputs reload these.
  values: Record<string, string>;
  // FR-4: a likely duplicate exists; submitting again saves anyway.
  duplicate?: boolean;
  // "Save + new" succeeded.
  saved?: boolean;
};

// Fields kept after "Save + new", so the next entry is faster.
const KEEP_AFTER_SAVE = ["type", "bankAccountId", "fromAccountId", "toAccountId", "transactionDate"];

export async function saveMovement(
  _previous: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  // Permissions first, on the server: hiding a button is not security.
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const values = formValues(formData);
  const { intent, allowDuplicate, ...input } = values;

  let result: CreateResult;
  try {
    if (input.type === "internal") {
      const parsed = internalTransferSchema.safeParse(input);
      if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };
      result = await createInternalTransfer(user, parsed.data);
    } else {
      const parsed = movementSchema.safeParse(input);
      if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };
      result = await createMovement(user, parsed.data, {
        allowDuplicate: allowDuplicate === "1",
      });
    }
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.field
        ? { values, errors: { [error.field]: error.code } }
        : { values, errors: {}, formError: error.code };
    }
    throw error;
  }

  if (result.status === "duplicate") return { values, errors: {}, duplicate: true };

  // Every page under /[locale] shows balances: re-render them with the new row.
  revalidatePath("/[locale]", "layout");

  if (intent === "saveNew") {
    const kept = Object.fromEntries(
      KEEP_AFTER_SAVE.filter((k) => values[k]).map((k) => [k, values[k]]),
    );
    return { values: kept, errors: {}, saved: true };
  }

  // Show the account the movement was saved to.
  // redirect() works by throwing, so it stays outside the try/catch above.
  const accountId = input.type === "internal" ? input.fromAccountId : input.bankAccountId;
  return redirect({ href: `/accounts/${accountId}`, locale: await getLocale() });
}

export async function voidMovement(
  _previous: InlineActionState,
  formData: FormData,
): Promise<InlineActionState> {
  const user = await getCurrentUser();
  requireRole(user, "accountant");

  const parsed = voidSchema.safeParse(formValues(formData));
  if (!parsed.success) return { error: Object.values(fieldErrors(parsed.error))[0] };
  const result = await asInlineAction(() => voidTransaction(user, parsed.data));
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}
