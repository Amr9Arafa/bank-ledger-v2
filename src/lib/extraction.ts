// AI Inbox: the shape the model must return, and the checks we run on it afterwards.
// The model's answer is a suggestion for a person to review: checks add warnings, never fail.
import { z } from "zod";
import { addDays } from "./cheques.ts";
import { minorToDecimal, toMinor } from "./money.ts";

// Sent to the API as a JSON schema (structured outputs): the response always matches it.
// Descriptions are part of the schema, so they double as per-field instructions.
// Amounts are strings: we parse them with toMinor, never as floats.
export const extractionSchema = z.object({
  kind: z
    .enum(["transaction", "cheque"])
    .describe('"cheque" for a cheque photo or a cheque we issued; otherwise "transaction".'),
  direction: z
    .enum(["in", "out"])
    .nullable()
    .describe('"in" when money came into our account, "out" when it left. "out" for cheques.'),
  amount: z
    .string()
    .nullable()
    .describe('Amount in EGP as plain digits with an optional "." and up to 2 decimals, e.g. "15000" or "1250.50". No separators or currency.'),
  account_id: z
    .string()
    .nullable()
    .describe("id of one of our accounts, only when the input clearly identifies it; otherwise null."),
  account_text: z
    .string()
    .nullable()
    .describe("The words the input used for the account, copied as written; null if none."),
  counterparty: z
    .string()
    .nullable()
    .describe("Sender of an incoming transfer, beneficiary of an outgoing one, payee of a cheque."),
  date: z.string().nullable().describe("YYYY-MM-DD. For a cheque, the date written on it."),
  notes: z
    .string()
    .nullable()
    .describe("Short note with useful details not captured elsewhere (purpose, reference number)."),
  cheque_number: z.string().nullable().describe("Cheques only: the cheque number."),
  amount_in_words: z
    .string()
    .nullable()
    .describe("Cheques only: the amount written in words, copied exactly as written."),
  amount_in_words_value: z
    .string()
    .nullable()
    .describe("Cheques only: your reading of amount_in_words as plain digits, read from the words alone."),
});
export type Extraction = z.infer<typeof extractionSchema>;

// Codes are keys under "inbox.warnings" in messages/*.json; value fills the message.
export type ExtractionWarning = { code: ExtractionWarningCode; value?: string };
export type ExtractionWarningCode =
  | "directionMissing"
  | "amountMissing"
  | "amountInvalid"
  | "accountUnresolved"
  | "accountNoTransfers"
  | "accountNoCheques"
  | "counterpartyMissing"
  | "counterpartyNew"
  | "dateMissing"
  | "dateInvalid"
  | "dateInFuture"
  | "dateFarFuture"
  | "dateFarPast"
  | "chequeNumberMissing"
  | "amountWordsMissing"
  | "amountWordsMismatch";

export type ExtractionContext = {
  accounts: { id: string; receivesTransfers: boolean; issuesCheques: boolean }[];
  counterparties: string[];
  // "YYYY-MM-DD" in Cairo.
  today: string;
  // Only a photo has an amount in words; a typed message about a cheque does not.
  hasImage: boolean;
};

// Cheques are often post-dated, so they may be up to a year ahead; transfers cannot.
const CHEQUE_MAX_DAYS_AHEAD = 365;
const MAX_DAYS_BACK = 180;

// What the checks could resolve, ready to prefill the review form.
export type ResolvedExtraction = {
  amountMinor: number | null;
  accountId: string | null;
  // The known spelling when the name matches an existing counterparty.
  counterparty: string | null;
  date: string | null;
};

export function checkExtraction(
  extraction: Extraction,
  context: ExtractionContext,
): { warnings: ExtractionWarning[]; resolved: ResolvedExtraction } {
  const warnings: ExtractionWarning[] = [];
  const warn = (code: ExtractionWarningCode, value?: string) =>
    warnings.push(value === undefined ? { code } : { code, value });
  const isCheque = extraction.kind === "cheque";

  if (!isCheque && !extraction.direction) warn("directionMissing");

  // Amount: toMinor rejects zero, negatives, and more than 2 decimals.
  let amountMinor: number | null = null;
  if (!extraction.amount?.trim()) {
    warn("amountMissing");
  } else {
    const parsed = toMinor(extraction.amount);
    if (parsed.ok) amountMinor = parsed.minor;
    else warn("amountInvalid", extraction.amount);
  }

  // Account: the model must return one of our ids; anything else is treated as unknown.
  const account = context.accounts.find((a) => a.id === extraction.account_id);
  if (!account) {
    warn("accountUnresolved", extraction.account_text ?? undefined);
  } else if (isCheque && !account.issuesCheques) {
    warn("accountNoCheques");
  } else if (!isCheque && extraction.direction === "in" && !account.receivesTransfers) {
    warn("accountNoTransfers");
  }

  // Counterparty: a new name is allowed (there is no counterparties table yet), but flagged.
  let counterparty = extraction.counterparty?.trim() || null;
  if (!counterparty) {
    warn("counterpartyMissing");
  } else {
    const key = normalizeName(counterparty);
    const known = context.counterparties.find((c) => normalizeName(c) === key);
    if (known) counterparty = known;
    else warn("counterpartyNew", counterparty);
  }

  let date: string | null = null;
  if (!extraction.date) {
    warn("dateMissing");
  } else if (!z.iso.date().safeParse(extraction.date).success) {
    warn("dateInvalid", extraction.date);
  } else {
    date = extraction.date;
    if (isCheque && date > addDays(context.today, CHEQUE_MAX_DAYS_AHEAD)) {
      warn("dateFarFuture", date);
    } else if (!isCheque && date > context.today) {
      warn("dateInFuture", date);
    } else if (date < addDays(context.today, -MAX_DAYS_BACK)) {
      warn("dateFarPast", date);
    }
  }

  if (isCheque) {
    if (!extraction.cheque_number?.trim()) warn("chequeNumberMissing");
    if (!extraction.amount_in_words_value?.trim()) {
      if (context.hasImage) warn("amountWordsMissing");
    } else if (amountMinor !== null) {
      const inWords = toMinor(extraction.amount_in_words_value);
      if (!inWords.ok || inWords.minor !== amountMinor) {
        warn("amountWordsMismatch", extraction.amount_in_words ?? extraction.amount_in_words_value);
      }
    }
  }

  return {
    warnings,
    resolved: { amountMinor, accountId: account?.id ?? null, counterparty, date },
  };
}

// Compares names the way people write them: case, spacing and common Arabic letter
// variants (أ/إ/آ -> ا, ة -> ه, ى -> ي) do not make a different counterparty.
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ً-ْـ]/g, "") // harakat and tatweel
    .replace(/\s+/g, " ")
    .trim();
}

// Starting values for the review form, with the same field names as the manual forms.
// A cheque's written date is its due date when it is in the future (post-dated);
// otherwise it is the issue date. Anything unknown is left empty for the reviewer.
export function reviewDefaults(
  extraction: Extraction,
  resolved: ResolvedExtraction,
  today: string,
): Record<string, string> {
  const common = {
    bankAccountId: resolved.accountId ?? "",
    amountMinor: resolved.amountMinor === null ? "" : minorToDecimal(resolved.amountMinor),
    partyName: resolved.counterparty ?? "",
    notes: extraction.notes ?? "",
  };
  if (extraction.kind === "cheque") {
    const postDated = resolved.date !== null && resolved.date > today;
    return {
      ...common,
      chequeNumber: extraction.cheque_number ?? "",
      transactionDate: postDated ? today : (resolved.date ?? today),
      dueDate: postDated ? (resolved.date ?? "") : "",
    };
  }
  return {
    ...common,
    type:
      extraction.direction === "in"
        ? "transfer_in"
        : extraction.direction === "out"
          ? "transfer_out"
          : "",
    transactionDate: resolved.date ?? today,
    reference: "",
  };
}

// Which review form field each warning is about, so the form can highlight it.
export const WARNING_FIELDS: Record<ExtractionWarningCode, string[]> = {
  directionMissing: ["type"],
  amountMissing: ["amountMinor"],
  amountInvalid: ["amountMinor"],
  amountWordsMissing: ["amountMinor"],
  amountWordsMismatch: ["amountMinor"],
  accountUnresolved: ["bankAccountId"],
  accountNoTransfers: ["bankAccountId"],
  accountNoCheques: ["bankAccountId"],
  counterpartyMissing: ["partyName"],
  counterpartyNew: ["partyName"],
  dateMissing: ["transactionDate"],
  dateInvalid: ["transactionDate"],
  dateInFuture: ["transactionDate"],
  dateFarFuture: ["transactionDate", "dueDate"],
  dateFarPast: ["transactionDate"],
  chequeNumberMissing: ["chequeNumber"],
};
