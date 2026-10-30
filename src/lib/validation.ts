// Zod schemas for form input. Every error message is a key under "errors" in messages/*.json.
// Only shape and format live here; rules that need the database live in server/ledger.
import { z } from "zod";
import { toMinor, toSignedMinor } from "./money.ts";

// Amount typed by the user -> integer piasters.
const amount = z.string({ error: "required" }).transform((input, ctx) => {
  const result = toMinor(input);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  }
  return result.minor;
});

// "YYYY-MM-DD" from <input type="date">; rejects impossible dates like 2026-02-30.
const day = z.iso.date({ message: "invalidDate" });

const accountId = z.uuid({ message: "invalidAccount" });

const requiredText = (max: number) =>
  z.string({ error: "required" }).trim().min(1, "required").max(max, "tooLong");

// Empty fields arrive as "" from forms; store them as null.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .optional()
    .transform((s) => s || null);

const notes = optionalText(1000);

// The tabs of the new movement form. "internal" saves an internal_out + internal_in pair.
// Deposits are entered as incoming transfers (with a note), so they have no tab.
export const FORM_TYPES = ["transfer_in", "transfer_out", "fee", "internal"] as const;
export type FormType = (typeof FORM_TYPES)[number];

// Transfers in/out and fees share one form; fields differ by type.
export const movementSchema = z.discriminatedUnion("type", [
  z.object({
    // partyName: the sender for an incoming transfer, the beneficiary for an outgoing one.
    type: z.enum(["transfer_in", "transfer_out"]),
    bankAccountId: accountId,
    transactionDate: day,
    amountMinor: amount,
    partyName: requiredText(200),
    reference: optionalText(100),
    notes,
  }),
  z.object({
    type: z.literal("fee"),
    bankAccountId: accountId,
    transactionDate: day,
    amountMinor: amount,
    description: requiredText(200),
    notes,
  }),
]);
export type MovementInput = z.infer<typeof movementSchema>;

export const internalTransferSchema = z
  .object({
    fromAccountId: accountId,
    toAccountId: accountId,
    transactionDate: day,
    amountMinor: amount,
    notes,
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: "sameAccount",
    path: ["toAccountId"],
  });
export type InternalTransferInput = z.infer<typeof internalTransferSchema>;

export const voidSchema = z.object({
  transactionId: z.uuid({ message: "invalidTransaction" }),
  reason: requiredText(500),
});
export type VoidInput = z.infer<typeof voidSchema>;

// Field name -> first error key, ready for the form to translate.
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [field, messages] of Object.entries(
    z.flattenError(error).fieldErrors as Record<string, string[] | undefined>,
  )) {
    if (messages?.[0]) errors[field] = messages[0];
  }
  return errors;
}

// Issued cheque. dueDate is optional: empty means due on the issue date.
export const chequeSchema = z
  .object({
    bankAccountId: accountId,
    chequeNumber: z
      .string({ error: "required" })
      .trim()
      .min(1, "required")
      .max(30, "tooLong")
      .regex(/^[0-9A-Za-z-]+$/, "invalidChequeNumber"),
    partyName: requiredText(200),
    transactionDate: day,
    dueDate: z
      .union([z.literal(""), day])
      .optional()
      .transform((d) => d || null),
    amountMinor: amount,
    notes,
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.transactionDate, {
    message: "dueBeforeIssue",
    path: ["dueDate"],
  });
export type ChequeInput = z.infer<typeof chequeSchema>;

export const clearChequeSchema = z.object({
  transactionId: z.uuid({ message: "invalidTransaction" }),
  clearedDate: day,
});
export type ClearChequeInput = z.infer<typeof clearChequeSchema>;

export const cancelChequeSchema = voidSchema;
export type CancelChequeInput = VoidInput;

// Actions that only need the id of an existing transaction.
export const transactionIdSchema = z.object({
  transactionId: z.uuid({ message: "invalidTransaction" }),
});

export const signInSchema = z.object({
  email: z.email({ message: "invalidEmail" }),
  password: z.string({ error: "required" }).min(1, "required"),
});

// Admin creates a user and sets a first password (no public sign-up).
export const newUserSchema = z.object({
  email: z.email({ message: "invalidEmail" }),
  name: requiredText(100),
  role: z.enum(["admin", "accountant", "viewer"], { message: "invalidRole" }),
  password: z.string({ error: "required" }).min(8, "passwordTooShort").max(72, "tooLong"),
});
export type NewUserInput = z.infer<typeof newUserSchema>;

export const roleChangeSchema = z.object({
  userId: z.uuid({ message: "invalidUser" }),
  role: z.enum(["admin", "accountant", "viewer"], { message: "invalidRole" }),
});

// Links a user to their Telegram account (numeric user id). Empty unlinks: null.
export const telegramLinkSchema = z.object({
  userId: z.uuid({ message: "invalidUser" }),
  telegramUserId: z
    .string({ error: "required" })
    .trim()
    .regex(/^(\d{1,20})?$/, "invalidTelegramId")
    .transform((id) => id || null),
});

// FR-11: ledger filters from the URL. Bad values are ignored rather than rejected.
export const LEDGER_TYPES = ["transfer_in", "transfer_out", "fee", "internal", "cheque"] as const;
// counted: in the book balance; outstanding: issued cheques; void: voided or cancelled.
export const LEDGER_STATUSES = ["counted", "outstanding", "void"] as const;

const ledgerFilterSchema = z.object({
  from: day.optional().catch(undefined),
  to: day.optional().catch(undefined),
  type: z.enum(LEDGER_TYPES).optional().catch(undefined),
  status: z.enum(LEDGER_STATUSES).optional().catch(undefined),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .catch(undefined)
    .transform((s) => s || undefined),
});
// Every filter is optional: {} means the full ledger.
export type LedgerFilters = Partial<z.infer<typeof ledgerFilterSchema>>;

export function parseLedgerFilters(
  searchParams: Record<string, string | string[] | undefined>,
): LedgerFilters {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return ledgerFilterSchema.parse({
    from: first(searchParams.from) || undefined,
    to: first(searchParams.to) || undefined,
    type: first(searchParams.type) || undefined,
    status: first(searchParams.status) || undefined,
    q: first(searchParams.q),
  });
}

// Opening balance: zero or negative allowed (an account can start overdrawn).
const signedAmount = z.string({ error: "required" }).transform((input, ctx) => {
  const result = toSignedMinor(input);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  }
  return result.minor;
});

// HTML checkboxes send "on" when ticked and nothing otherwise.
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on");

// FR-1: an admin adds or edits a bank account.
export const bankAccountSchema = z.object({
  name: requiredText(100),
  bankName: requiredText(100),
  // Text, not a number: account numbers may have leading zeros, spaces or dashes.
  accountNumber: z
    .string({ error: "required" })
    .trim()
    .min(1, "required")
    .max(40, "tooLong")
    .regex(/^[0-9A-Za-z -]+$/, "invalidAccountNumber"),
  openingBalanceMinor: signedAmount,
  openingDate: day,
  receivesTransfers: checkbox,
  issuesCheques: checkbox,
});
export type BankAccountInput = z.infer<typeof bankAccountSchema>;
