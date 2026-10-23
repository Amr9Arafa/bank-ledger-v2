"use server";

import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { fieldErrors, signInSchema } from "@/lib/validation";
import { getSessionUser } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/auth/supabase";
import { getProfile, saveUserLanguage } from "@/server/users";
import { formValues } from "./form-data";

export type SignInState = {
  errors: Record<string, string>;
  formError?: string;
  values: Record<string, string>;
};

export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const { password, ...values } = formValues(formData); // never echo the password back
  const parsed = signInSchema.safeParse({ ...values, password });
  if (!parsed.success) return { values, errors: fieldErrors(parsed.error) };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error || !data.user) return { values, errors: {}, formError: "invalidCredentials" };

  const profile = await getProfile(data.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    return { values, errors: {}, formError: "noAccess" };
  }
  // Open the app in the user's own language (FR-15).
  return redirect({ href: "/", locale: profile.language });
}

export async function signOut(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  const locale = formData.get("locale") === "en" ? "en" : "ar";
  return redirect({ href: "/login", locale });
}

// Remembers the language the user switched to, for their next sign-in.
export async function saveLanguage(locale: Locale) {
  if (locale !== "ar" && locale !== "en") return;
  const user = await getSessionUser();
  if (user && user.language !== locale) await saveUserLanguage(user.id, locale);
}
