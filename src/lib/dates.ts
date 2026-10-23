// Calendar dates are "YYYY-MM-DD" strings in Cairo time, whatever the server's time zone.
export function todayInCairo(now: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}
