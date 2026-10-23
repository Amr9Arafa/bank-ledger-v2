// Calendar dates are "YYYY-MM-DD" strings in Cairo time, whatever the server's time zone.
export function todayInCairo(now: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

// "2026-10-05" -> "05/10/2026" (day first, as used in Egypt), Arabic-Indic digits in Arabic.
// Formatted in UTC from UTC midnight, so the calendar date never shifts.
export function formatDay(day: string, locale: "ar" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}
