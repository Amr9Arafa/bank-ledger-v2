// Zod schemas for form input. Every error message is a key under "errors" in messages/*.json.
// Only shape and format live here; rules that need the database live in server/ledger.
import { z } from "zod";
import { toMinor } from "./money.ts";

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
export const FORM_TYPES = ["transfer_in", "deposit", "fee", "internal"] as const;
export type FormType = (typeof FORM_TYPES)[number];

// Transfer in, deposit and fee share one form; fields differ by type.
export const movementSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transfer_in"),
    bankAccountId: accountId,
    transactionDate: day,
    amountMinor: amount,
    partyName: requiredText(200),
    reference: optionalText(100),
    notes,
  }),
  z.object({
    type: z.enum(["deposit", "fee"]),
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
