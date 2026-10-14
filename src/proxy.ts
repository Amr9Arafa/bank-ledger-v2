import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Runs before every page request: redirects "/" to "/ar" and validates the locale.
export default createMiddleware(routing);

export const config = {
  // Skip Next internals, API routes and files with an extension (favicon.ico, images).
  matcher: "/((?!api|_next|_vercel|.*\..*).*)",
};
