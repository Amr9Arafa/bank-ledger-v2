import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExtraction, type Extraction, foundNothing, normalizeName } from "./extraction.ts";

const CIB = "11111111-1111-4111-8111-111111111111";
const NBE = "22222222-2222-4222-8222-222222222222";
const context = {
  accounts: [
    { id: CIB, receivesTransfers: true, issuesCheques: true, openingDate: "2026-01-01" },
    { id: NBE, receivesTransfers: false, issuesCheques: false, openingDate: "2026-01-01" },
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

test("date: before the account's opening date is flagged (an old cheque, usually)", () => {
  const started = {
    ...context,
    accounts: context.accounts.map((a) => ({ ...a, openingDate: "2026-10-20" })),
  };
  const check = (e: Extraction) => checkExtraction(e, started).warnings;
  assert.deepEqual(check({ ...cheque, date: "2026-10-19" }), [
    { code: "dateBeforeOpening", value: "2026-10-19" },
  ]);
  assert.deepEqual(check({ ...transfer, date: "2026-10-19" }), [
    { code: "dateBeforeOpening", value: "2026-10-19" },
  ]);
  // On the opening date itself it can be saved.
  assert.deepEqual(check({ ...cheque, date: "2026-10-20" }), []);
  // Takes the place of "far past": one warning about the date is enough.
  assert.deepEqual(check({ ...transfer, date: "2026-01-01" }).map((w) => w.code), ["dateBeforeOpening"]);
  // Unknown account: no opening date to compare with.
  assert.deepEqual(
    check({ ...transfer, account_id: null, date: "2026-10-19" }).map((w) => w.code),
    ["accountUnresolved"],
  );
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

test("reviewDefaults: transfer fields, empty when unknown", async () => {
  const { reviewDefaults } = await import("./extraction.ts");
  const { resolved } = checkExtraction(transfer, context);
  assert.deepEqual(reviewDefaults(transfer, resolved, context.today), {
    type: "transfer_in", bankAccountId: CIB, amountMinor: "15000.00",
    partyName: "شركة النور للتوريدات", notes: "", transactionDate: "2026-10-28", reference: "",
  });
  const unknown = { ...transfer, direction: null, account_id: null, amount: null, date: null };
  const d = reviewDefaults(unknown, checkExtraction(unknown, context).resolved, context.today);
  assert.equal(d.type, "");
  assert.equal(d.bankAccountId, "");
  assert.equal(d.amountMinor, "");
  assert.equal(d.transactionDate, "2026-10-29");
});

test("reviewDefaults: a post-dated cheque is issued today and due on its date", async () => {
  const { reviewDefaults } = await import("./extraction.ts");
  const later = { ...cheque, date: "2026-11-15" };
  const d = reviewDefaults(later, checkExtraction(later, context).resolved, context.today);
  assert.equal(d.transactionDate, "2026-10-29");
  assert.equal(d.dueDate, "2026-11-15");
  assert.equal(d.chequeNumber, "000123");
  assert.equal(d.amountMinor, "1250.50");
  const d2 = reviewDefaults(cheque, checkExtraction(cheque, context).resolved, context.today);
  assert.equal(d2.transactionDate, "2026-10-28");
  assert.equal(d2.dueDate, "");
});

test("found nothing: only when both the amount and the direction are missing", () => {
  assert.equal(foundNothing({ ...transfer, amount: null, direction: null }), true);
  assert.equal(foundNothing({ ...transfer, amount: "  ", direction: null }), true);
  assert.equal(foundNothing({ ...transfer, amount: null }), false);
  assert.equal(foundNothing({ ...transfer, direction: null }), false);
  assert.equal(foundNothing({ ...cheque, amount: null }), false);
});

test("labeledNote: the rest of the line after a note label, as written", async () => {
  const { labeledNote } = await import("./extraction.ts");
  assert.equal(labeledNote("transfer 8000 to Ahmed. note: payment for invoice 234"), "payment for invoice 234");
  assert.equal(labeledNote("Notes:  advance, 50%  "), "advance, 50%");
  assert.equal(labeledNote("حولنا 5000 ملاحظة: دفعة من فاتورة 234"), "دفعة من فاتورة 234");
  assert.equal(labeledNote("ملاحظات: سلفة مقدم عقد"), "سلفة مقدم عقد");
  assert.equal(labeledNote("ملاحظه: سلفة"), "سلفة");
  // The real message: "notes =" mid-line, and the next line is not part of the note.
  assert.equal(
    labeledNote("حولنا فلوس الي دكتور محمود و اكتب في ال notes = social media \nمبلغ 20002 من حساب بنك الاهلي"),
    "social media",
  );
  assert.equal(labeledNote("note: a\nnotes: b"), "a · b");
  assert.equal(labeledNote("this will denote: nothing"), null);
  assert.equal(labeledNote("دفعة من فاتورة 234"), null);
  assert.equal(labeledNote(null), null);
});

test("mergedNotes: the labelled note is kept as written, with the model's other details", async () => {
  const { mergedNotes } = await import("./extraction.ts");
  // The model copied it: nothing added twice.
  assert.equal(mergedNotes("note: invoice 234", "invoice 234"), "invoice 234");
  assert.equal(mergedNotes("note: invoice 234", "invoice 234 · first instalment"), "invoice 234 · first instalment");
  // The model dropped or reworded it: the user's words come first.
  assert.equal(mergedNotes("ملاحظة: دفعة أولى", null), "دفعة أولى");
  assert.equal(mergedNotes("note: invoice 234", "Invoice #234 payment"), "invoice 234 · Invoice #234 payment");
  // No label: the model's notes as now.
  assert.equal(mergedNotes("دفعة من فاتورة 234", "دفعة من فاتورة 234"), "دفعة من فاتورة 234");
  assert.equal(mergedNotes(null, null), "");
});

test("reviewDefaults: notes include the labelled note from the raw text", async () => {
  const { reviewDefaults } = await import("./extraction.ts");
  const fromModel = { ...transfer, notes: "first instalment" };
  const resolved = checkExtraction(fromModel, context).resolved;
  assert.equal(
    reviewDefaults(fromModel, resolved, context.today, "15000 from Al Nour. note: invoice 234").notes,
    "invoice 234 · first instalment",
  );
  assert.equal(reviewDefaults(fromModel, resolved, context.today).notes, "first instalment");
  const d = reviewDefaults(cheque, checkExtraction(cheque, context).resolved, context.today, "ملاحظة: إيجار");
  assert.equal(d.notes, "إيجار");
});
