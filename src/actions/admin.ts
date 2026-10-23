"use server";

import { revalidatePath } from "next/cache";
import { fieldErrors, newUserSchema, roleChangeSchema } from "@/lib/validation";
import { requireRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { createSupabaseAdminClient } from "@/server/auth/supabase";
import { LedgerError } from "@/server/ledger/types";
import { changeRole, createProfile } from "@/server/users";
import { formValues } from "./form-data";

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
