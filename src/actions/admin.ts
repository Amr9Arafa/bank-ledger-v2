"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import {
  bankAccountSchema,
  fieldErrors,
  newUserSchema,
  roleChangeSchema,
  transactionIdSchema,
} from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/auth/supabase";
import {
  createBankAccount,
  setBankAccountArchived,
  updateBankAccount,
} from "@/server/ledger/bankAccounts";
import { LedgerError } from "@/server/ledger/types";
import { changeRole, createProfile } from "@/server/users";
import { asInlineAction, formValues, type InlineActionState } from "./form-data";

export type NewUserState = {
  errors: Record<string, string>;
  formError?: string;
  values: Record<string, string>;
  saved?: boolean;
};

// No public sign-up: an admin creates each login with a first password.
export async function createUserAction(
  _previous: NewUserState,
  formData: FormData,
): Promise<NewUserState> {
  const admin = await getCurrentUser();
  requireRole(admin, "admin");

  const { password, ...values } = formValues(formData); // never echo the password back
  const parsed = newUserSchema.safeParse({ ...values, password });
  if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };

  const supabase = createSupabaseAdminClient();
  if (!supabase) return { values, errors: {}, formError: "secretKeyMissing" };

  const { password: pw, ...profile } = parsed.data;
  const { data, error } = await supabase.auth.admin.createUser({
    email: profile.email,
    password: pw,
    email_confirm: true,
  });
  if (error || !data.user) {
    const taken = error?.code === "email_exists" || error?.status === 422;
    return { values, errors: taken ? { email: "emailTaken" } : {}, formError: taken ? undefined : "unexpected" };
  }

  try {
    await createProfile(admin, data.user.id, profile);
  } catch (e) {
    // Keep Auth and our users table in step: no login without a profile.
    await supabase.auth.admin.deleteUser(data.user.id);
    throw e;
  }

  revalidatePath("/[locale]/settings", "page");
  return { values: {}, errors: {}, saved: true };
}

export async function changeRoleAction(formData: FormData) {
  const admin = await getCurrentUser();
  requireRole(admin, "admin");
  const parsed = roleChangeSchema.safeParse(formValues(formData));
  if (!parsed.success) return;
  try {
    await changeRole(admin, parsed.data.userId, parsed.data.role);
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
  }
  revalidatePath("/[locale]/settings", "page");
}

export type BankAccountFormState = {
  errors: Record<string, string>;
  formError?: string;
  values: Record<string, string>;
};

// Adds a bank account, or edits it when the form carries an accountId.
export async function saveBankAccount(
  _previous: BankAccountFormState,
  formData: FormData,
): Promise<BankAccountFormState> {
  const admin = await getCurrentUser();
  requireRole(admin, "admin");

  const { accountId, ...values } = formValues(formData);
  const parsed = bankAccountSchema.safeParse(values);
  const echo = { ...values, accountId: accountId ?? "" };
  if (accountId && !transactionIdSchema.safeParse({ transactionId: accountId }).success) {
    return { values: echo, errors: {}, formError: "accountNotFound" };
  }
  if (!parsed.success) return { values: echo, errors: fieldErrors(parsed.error) };

  try {
    if (accountId) await updateBankAccount(admin, accountId, parsed.data);
    else await createBankAccount(admin, parsed.data);
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.field
        ? { values: echo, errors: { [error.field]: error.code } }
        : { values: echo, errors: {}, formError: error.code };
    }
    throw error;
  }

  revalidatePath("/[locale]", "layout");
  return redirect({ href: "/settings/accounts", locale: await getLocale() });
}

// InlineAction sends the record id as "transactionId", whatever the record is.
async function setArchived(formData: FormData, archived: boolean): Promise<InlineActionState> {
  const admin = await getCurrentUser();
  requireRole(admin, "admin");
  const parsed = transactionIdSchema.safeParse({ transactionId: formData.get("transactionId") });
  if (!parsed.success) return { error: "accountNotFound" };
  const result = await asInlineAction(() =>
    setBankAccountArchived(admin, parsed.data.transactionId, archived),
  );
  if (result.done) revalidatePath("/[locale]", "layout");
  return result;
}

export async function archiveAccountAction(_previous: InlineActionState, formData: FormData) {
  return setArchived(formData, true);
}

export async function unarchiveAccountAction(_previous: InlineActionState, formData: FormData) {
  return setArchived(formData, false);
}
