import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import {
  fieldErrors,
  internalTransferSchema,
  movementSchema,
  voidSchema,
} from "./validation.ts";

const A = "6173ce4b-0ab1-4bed-a1c3-3935b4aa73d6";
const B = "11a45c97-c4e8-4023-b5c7-9267872e9b83";

// Parses and returns { field: errorKey }, or {} when valid.
const errorsOf = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  return r.success ? {} : fieldErrors(r.error);
};

test("transfer_in: valid input becomes piasters, empty optionals become null", () => {
  const r = movementSchema.parse({
    type: "transfer_in",
    bankAccountId: A,
    transactionDate: "2026-10-05",
    amountMinor: "1,250.50",
    partyName: "  Customer X  ",
    reference: "",
    notes: "",
  });
  assert.deepEqual(r, {
    type: "transfer_in",
    bankAccountId: A,
    transactionDate: "2026-10-05",
    amountMinor: 125050,
    partyName: "Customer X",
    reference: null,
    notes: null,
  });
});

test("transfer_in: errors are translation keys per field", () => {
  assert.deepEqual(
    errorsOf(movementSchema, {
      type: "transfer_in",
      bankAccountId: "not-a-uuid",
      transactionDate: "2026-02-30",
      amountMinor: "1.234",
      partyName: "   ",
    }),
    {
      bankAccountId: "invalidAccount",
      transactionDate: "invalidDate",
      amountMinor: "tooManyDecimals",
      partyName: "required",
    },
  );
});

test("fee needs a description, not a party", () => {
  const base = { bankAccountId: A, transactionDate: "2026-10-05", amountMinor: "50" };
  assert.deepEqual(errorsOf(movementSchema, { ...base, type: "fee" }), {
    description: "required",
  });
  const fee = movementSchema.parse({ ...base, type: "fee", description: "Monthly fee" });
  assert.equal(fee.amountMinor, 5000);
});

test("outgoing transfer needs a beneficiary; deposit is no longer accepted", () => {
  const base = { bankAccountId: A, transactionDate: "2026-10-05", amountMinor: "75" };
  assert.deepEqual(errorsOf(movementSchema, { ...base, type: "transfer_out" }), {
    partyName: "required",
  });
  const out = movementSchema.parse({ ...base, type: "transfer_out", partyName: "Supplier" });
  assert.equal(out.amountMinor, 7500);
  assert.ok("type" in errorsOf(movementSchema, { ...base, type: "deposit", description: "x" }));
});

test("missing amount is required", () => {
  assert.equal(
    errorsOf(movementSchema, { type: "fee", bankAccountId: A, transactionDate: "2026-10-05", description: "x" }).amountMinor,
    "required",
  );
});

test("unknown movement type is rejected", () => {
  assert.ok("type" in errorsOf(movementSchema, { type: "cheque" }));
});

test("long text is rejected", () => {
  assert.equal(
    errorsOf(movementSchema, {
      type: "transfer_in",
      bankAccountId: A,
      transactionDate: "2026-10-05",
      amountMinor: "1",
      partyName: "x".repeat(201),
    }).partyName,
    "tooLong",
  );
});

test("internal transfer: from and to must differ", () => {
  const base = { transactionDate: "2026-10-05", amountMinor: "100" };
  assert.deepEqual(
    errorsOf(internalTransferSchema, { ...base, fromAccountId: A, toAccountId: A }),
    { toAccountId: "sameAccount" },
  );
  const ok = internalTransferSchema.parse({ ...base, fromAccountId: A, toAccountId: B });
  assert.equal(ok.amountMinor, 10000);
});

test("void needs a reason", () => {
  assert.deepEqual(errorsOf(voidSchema, { transactionId: A, reason: " " }), {
    reason: "required",
  });
});

test("cheque: due date optional, never before issue date", async () => {
  const { chequeSchema } = await import("./validation.ts");
  const base = {
    bankAccountId: A,
    chequeNumber: "000124",
    partyName: "Supplier",
    transactionDate: "2026-10-05",
    amountMinor: "300",
  };
  assert.equal(chequeSchema.parse({ ...base, dueDate: "" }).dueDate, null);
  assert.equal(chequeSchema.parse({ ...base, dueDate: "2026-11-01" }).dueDate, "2026-11-01");
  assert.deepEqual(errorsOf(chequeSchema, { ...base, dueDate: "2026-10-01" }), {
    dueDate: "dueBeforeIssue",
  });
  assert.deepEqual(errorsOf(chequeSchema, { ...base, chequeNumber: "12 3" }), {
    chequeNumber: "invalidChequeNumber",
  });
});

test("ledger filters keep valid values and drop bad ones", async () => {
  const { parseLedgerFilters } = await import("./validation.ts");
  assert.deepEqual(
    parseLedgerFilters({ from: "2026-01-01", to: "bad", type: "cheque", status: "x", q: "  REF1 " }),
    { from: "2026-01-01", to: undefined, type: "cheque", status: undefined, q: "REF1" },
  );
  assert.equal(parseLedgerFilters({ type: "deposit" }).type, undefined); // no longer a filter
  assert.deepEqual(parseLedgerFilters({ type: ["fee", "transfer_out"], q: "" }), {
    from: undefined,
    to: undefined,
    type: "fee",
    status: undefined,
    q: undefined,
  });
});

test("bank account: signed opening balance and checkboxes", async () => {
  const { bankAccountSchema } = await import("./validation.ts");
  const base = { name: "CIB", bankName: "CIB", accountNumber: "0012 345-6", openingDate: "2026-10-01" };
  const r = bankAccountSchema.parse({ ...base, openingBalanceMinor: "-500", receivesTransfers: "on" });
  assert.equal(r.openingBalanceMinor, -50000);
  assert.equal(r.receivesTransfers, true);
  assert.equal(r.issuesCheques, false);
  assert.equal(bankAccountSchema.parse({ ...base, openingBalanceMinor: "0" }).openingBalanceMinor, 0);
  assert.deepEqual(errorsOf(bankAccountSchema, { ...base, accountNumber: "12#4", openingBalanceMinor: "1" }), {
    accountNumber: "invalidAccountNumber",
  });
});
