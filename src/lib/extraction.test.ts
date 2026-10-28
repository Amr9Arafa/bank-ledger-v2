import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExtraction, type Extraction, normalizeName } from "./extraction.ts";

const CIB = "11111111-1111-4111-8111-111111111111";
const NBE = "22222222-2222-4222-8222-222222222222";
const context = {
  accounts: [
    { id: CIB, receivesTransfers: true, issuesCheques: true },
    { id: NBE, receivesTransfers: false, issuesCheques: false },
  ],
  counterparties: ["شركة النور للتوريدات", "Ahmed Hassan"],
  today: "2026-10-29",
  hasImage: true,
};

const transfer: Extraction = {
  kind: "transaction",
  direction: "in",
  amount: "15000",
  account_id: CIB,
  account_text: "CIB",
  counterparty: "شركة النور للتوريدات",
  date: "2026-10-28",
  notes: null,
  cheque_number: null,
  amount_in_words: null,
  amount_in_words_value: null,
};

const cheque: Extraction = {
  ...transfer,
  kind: "cheque",
  direction: "out",
  amount: "1250.50",
  cheque_number: "000123",
  amount_in_words: "ألف ومائتان وخمسون جنيهاً وخمسون قرشاً",
  amount_in_words_value: "1250.50",
};

const codes = (e: Extraction) => checkExtraction(e, context).warnings.map((w) => w.code);

test("a complete transfer has no warnings and resolves every field", () => {
  const { warnings, resolved } = checkExtraction(transfer, context);
  assert.deepEqual(warnings, []);
  assert.deepEqual(resolved, {
    amountMinor: 1500000,
    accountId: CIB,
    counterparty: "شركة النور للتوريدات",
    date: "2026-10-28",
  });
});

test("amount: missing, zero, negative and too many decimals are warnings", () => {
  assert.deepEqual(codes({ ...transfer, amount: null }), ["amountMissing"]);
  assert.deepEqual(codes({ ...transfer, amount: " " }), ["amountMissing"]);
  assert.deepEqual(codes({ ...transfer, amount: "0" }), ["amountInvalid"]);
  assert.deepEqual(codes({ ...transfer, amount: "-50" }), ["amountInvalid"]);
  assert.deepEqual(codes({ ...transfer, amount: "10.555" }), ["amountInvalid"]);
  assert.equal(checkExtraction({ ...transfer, amount: "١٥٠٠٠" }, context).resolved.amountMinor, 1500000);
});

test("account: an id that is not ours is unresolved, never trusted", () => {
  assert.deepEqual(codes({ ...transfer, account_id: null }), ["accountUnresolved"]);
  const made_up = checkExtraction({ ...transfer, account_id: "not-an-account" }, context);
  assert.deepEqual(made_up.warnings, [{ code: "accountUnresolved", value: "CIB" }]);
  assert.equal(made_up.resolved.accountId, null);
});

test("account: flags accounts that cannot take this movement", () => {
  assert.deepEqual(codes({ ...transfer, account_id: NBE }), ["accountNoTransfers"]);
  assert.deepEqual(codes({ ...transfer, account_id: NBE, direction: "out" }), []);
  assert.deepEqual(codes({ ...cheque, account_id: NBE }), ["accountNoCheques"]);
});

test("counterparty: matches known names despite spelling variants, flags new ones", () => {
  const variant = checkExtraction({ ...transfer, counterparty: "شركه النور  للتوريدات" }, context);
  assert.deepEqual(variant.warnings, []);
  assert.equal(variant.resolved.counterparty, "شركة النور للتوريدات");
  assert.equal(checkExtraction({ ...transfer, counterparty: "ahmed hassan" }, context).resolved.counterparty, "Ahmed Hassan");
  assert.deepEqual(checkExtraction({ ...transfer, counterparty: "Omar" }, context).warnings, [
    { code: "counterpartyNew", value: "Omar" },
  ]);
  assert.deepEqual(codes({ ...transfer, counterparty: null }), ["counterpartyMissing"]);
});

test("date: missing, invalid, future and far past", () => {
  assert.deepEqual(codes({ ...transfer, date: null }), ["dateMissing"]);
  assert.deepEqual(codes({ ...transfer, date: "2026-02-30" }), ["dateInvalid"]);
  assert.deepEqual(codes({ ...transfer, date: "2026-10-29" }), []);
  assert.deepEqual(codes({ ...transfer, date: "2026-10-30" }), ["dateInFuture"]);
  assert.deepEqual(codes({ ...transfer, date: "2026-05-02" }), []);
  assert.deepEqual(codes({ ...transfer, date: "2026-05-01" }), ["dateFarPast"]);
});

test("date: post-dated cheques are normal up to a year ahead", () => {
  assert.deepEqual(codes({ ...cheque, date: "2027-03-01" }), []);
  assert.deepEqual(codes({ ...cheque, date: "2027-10-29" }), []);
  assert.deepEqual(codes({ ...cheque, date: "2027-10-30" }), ["dateFarFuture"]);
});

test("cheque: number and amount in words", () => {
  assert.deepEqual(codes(cheque), []);
  assert.deepEqual(codes({ ...cheque, cheque_number: null }), ["chequeNumberMissing"]);
  assert.deepEqual(codes({ ...cheque, amount_in_words_value: null }), ["amountWordsMissing"]);
  // A typed message about a cheque has no amount in words to compare.
  const typed = { ...context, hasImage: false };
  assert.deepEqual(checkExtraction({ ...cheque, amount_in_words_value: null }, typed).warnings, []);
  assert.deepEqual(checkExtraction({ ...cheque, amount_in_words_value: "1205.50" }, context).warnings, [
    { code: "amountWordsMismatch", value: cheque.amount_in_words },
  ]);
  // "1250.5" and "1,250.50" are the same amount.
  assert.deepEqual(codes({ ...cheque, amount_in_words_value: "1,250.5" }), []);
});

test("transactions need a direction; cheques do not", () => {
  assert.deepEqual(codes({ ...transfer, direction: null }), ["directionMissing"]);
  assert.deepEqual(codes({ ...cheque, direction: null }), []);
});

test("normalizeName ignores case, spacing, harakat and Arabic letter variants", () => {
  assert.equal(normalizeName("  أحمد   حسن "), normalizeName("احمد حسن"));
  assert.equal(normalizeName("مكتبة الهُدى"), normalizeName("مكتبه الهدي"));
  assert.equal(normalizeName("AL NOUR"), "al nour");
});
