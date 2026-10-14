import { defineRouting } from "next-intl/routing";

// Single source of truth for supported languages.
export const routing = defineRouting({
  locales: ["ar", "en"],
  defaultLocale: "ar",
  // Always start in Arabic: ignore the browser's Accept-Language header.
  // The user picks English with the switcher, and the URL keeps the choice.
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];
