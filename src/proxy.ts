import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const intl = createIntlMiddleware(routing);

// Runs before every page request:
// 1. next-intl: "/" -> "/ar", validates the locale.
// 2. Supabase: refreshes the session cookie when it is about to expire.
// 3. Signed-out visitors go to /<locale>/login. (The login page itself sends signed-in
//    users onward, or shows "no access" to a login without a profile, avoiding a loop.)
export default async function proxy(request: NextRequest) {
  const response = intl(request);
  if (response.headers.has("location")) return response; // next-intl redirected

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list, headers) {
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
          for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
        },
      },
    },
  );
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const [, locale = routing.defaultLocale, page] = request.nextUrl.pathname.split("/");
  if (!signedIn && page !== "login") {
    const target = request.nextUrl.clone();
    target.pathname = `/${locale}/login`;
    target.search = "";
    const redirect = NextResponse.redirect(target);
    // Keep any refreshed session cookie on the redirect too.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}

export const config = {
  // Skip Next internals, API routes and files with an extension (favicon.ico, images).
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
