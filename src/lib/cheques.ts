// "000123" -> "000124": next number after the highest one, keeping leading zeros.
// Returns "" when there is no numeric cheque number yet (the user types the first one).
export function nextChequeNumber(last: string | null): string {
  if (!last || !/^\d+$/.test(last)) return "";
  // BigInt: cheque numbers can be longer than a safe JS number.
  return (BigInt(last) + 1n).toString().padStart(last.length, "0");
}

// Cheques due within this many days are highlighted (FR-8).
export const DUE_SOON_DAYS = 7;

// "YYYY-MM-DD" + n days, as calendar arithmetic (no time zones involved).
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole calendar days from `from` to `to` ("YYYY-MM-DD"); negative when `to` is earlier.
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
