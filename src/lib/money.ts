// Money is always integer piasters (1 EGP = 100). Never use floats for money.

export type AmountError =
  | "empty"
  | "invalid"
  | "tooManyDecimals"
  | "notPositive"
  | "tooLarge";

export type AmountResult =
  | { ok: true; minor: number }
  | { ok: false; error: AmountError };

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Western, Arabic separators to "." and ",".
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

// "1,250.5" -> 125050. Parses the string; never multiplies a float.
export function toMinor(input: string): AmountResult {
  const s = normalizeDigits(input).trim().replace(/[,\s]/g, "");
  if (s === "") return { ok: false, error: "empty" };

  const match = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) return { ok: false, error: "invalid" };

  const [, whole, frac = ""] = match;
  if (frac.length > 2) return { ok: false, error: "tooManyDecimals" };

  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "tooLarge" };
  if (minor === 0) return { ok: false, error: "notPositive" };
  return { ok: true, minor };
}

// 125050 -> "EGP 1,250.50" (en) or "١٬٢٥٠٫٥٠ ج.م." (ar). Display only.
export function formatEGP(minor: number, locale: "ar" | "en"): string {
  // A decimal string keeps Intl exact; minor / 100 would go through a float.
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
  }).format(minorToDecimal(minor) as Intl.StringNumericLiteral);
}

// Like toMinor, but for balances: zero and a leading "-" are allowed ("-1,250.50" -> -125050).
export function toSignedMinor(input: string): AmountResult {
  const s = normalizeDigits(input).trim();
  const negative = s.startsWith("-");
  const result = toMinor(negative ? s.slice(1) : s);
  if (result.ok) return { ok: true, minor: negative ? -result.minor : result.minor };
  if (result.error === "notPositive") return { ok: true, minor: 0 };
  return result;
}

// 125050 -> "1250.50", -5 -> "-0.05": plain decimal for CSV and form fields, no grouping.
export function minorToDecimal(minor: number): string {
  const abs = Math.abs(minor);
  const piasters = abs % 100;
  return `${minor < 0 ? "-" : ""}${(abs - piasters) / 100}.${String(piasters).padStart(2, "0")}`;
}

// 23664000 -> "236,640.00" / "٢٣٦٬٦٤٠٫٠٠": grouped amount without the currency, for tight
// spots where the currency is already clear (sidebar, compact columns).
export function formatAmount(minor: number, locale: "ar" | "en"): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minorToDecimal(minor) as Intl.StringNumericLiteral);
}
