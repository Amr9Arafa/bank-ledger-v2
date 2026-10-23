import { getLocale } from "next-intl/server";
import { cache } from "react";
import { redirect } from "@/i18n/navigation";
import type { users } from "@/server/db/schema";
import { getProfile } from "@/server/users";
import { hasRole, type Role } from "./roles";
import { createSupabaseServerClient } from "./supabase";

export type CurrentUser = typeof users.$inferSelect;

// The Supabase Auth user id of this request's session, or null when signed out.
// getClaims() verifies the session token's signature; the cookie alone is not trusted.
// cache(): one lookup per request, however many components ask.
export const getAuthUserId = cache(async (): Promise<string | null> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ?? null;
});

// The signed-in user's profile (role, organization, language), or null.
// A login without a profile row (e.g. created outside the app) gets no access.
export const getSessionUser = cache(async (): Promise<CurrentUser | null> => {
  const authUserId = await getAuthUserId();
  return authUserId ? getProfile(authUserId) : null;
});

// For pages and actions that need a user: everyone else goes to the login page.
export async function getCurrentUser(): Promise<CurrentUser> {
  const user = await getSessionUser();
  if (!user) return redirect({ href: "/login", locale: await getLocale() });
  return user;
}

// For pages only some roles may open: others go back to the dashboard.
// (Actions use requireRole, which throws: a forged request gets an error, not a page.)
export async function getUserWithRole(minimum: Role): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!hasRole(user, minimum)) return redirect({ href: "/", locale: await getLocale() });
  return user;
}
