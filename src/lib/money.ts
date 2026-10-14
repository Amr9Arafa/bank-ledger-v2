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
  const abs = Math.abs(minor);
  const piasters = abs % 100;
  const pounds = (abs - piasters) / 100;
  // A decimal string keeps Intl exact; minor / 100 would go through a float.
  const decimal = `${minor < 0 ? "-" : ""}${pounds}.${String(piasters).padStart(2, "0")}`;
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
  }).format(decimal as Intl.StringNumericLiteral);
}
