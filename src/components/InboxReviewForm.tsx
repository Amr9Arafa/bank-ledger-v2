"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { approveEntry, type ReviewFormState } from "@/actions/inbox";
import { inputClass, primaryButton, useFieldHelpers } from "@/components/form";
import type { AccountOption } from "@/server/ledger/accounts";

// The extracted fields of one AI Inbox entry, editable before approving. Approving runs the
// same validation and ledger rules as entering the movement or cheque by hand.
export default function InboxReviewForm({
  entryId,
  type,
  defaults,
  accounts,
  warnedFields,
}: {
  entryId: string;
  type: "transaction" | "cheque";
  defaults: Record<string, string>;
  accounts: AccountOption[];
  // Fields a warning is about: highlighted until the reviewer has looked at them.
  warnedFields: string[];
}) {
  const t = useTranslations("inbox");
  const tm = useTranslations("movement");
  const tc = useTranslations("cheque");
  const [state, formAction, pending] = useActionState<ReviewFormState, FormData>(approveEntry, {
    errors: {},
    values: defaults,
  });
  const { field, a11y, errorText } = useFieldHelpers(state.errors, `${entryId}-`);
  const v = state.values;
  // The party label follows the direction while the reviewer edits it.
  const [direction, setDirection] = useState(v.type ?? "");

  // Amber ring on fields a warning points at, unless they already show an error.
  const cls = (name: string, extra = "") =>
    `${inputClass} ${extra} ${warnedFields.includes(name) && !state.errors[name] ? "ring-1 ring-warning" : ""}`;

  const accountSelect = (options: AccountOption[]) => (
    <select
      {...a11y("bankAccountId")}
      defaultValue={v.bankAccountId ?? ""}
      required
      className={cls("bankAccountId")}
    >
      <option value="" disabled>
        {tm("selectAccount")}
      </option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} — {a.bankName}
        </option>
      ))}
    </select>
  );

  const textInput = (name: string, extra: { dir?: "ltr"; required?: boolean } = {}) => (
    <input
      type="text"
      {...a11y(name)}
      defaultValue={v[name] ?? ""}
      dir={extra.dir}
      required={extra.required}
      className={cls(name)}
    />
  );

  const amountInput = () => (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      dir="ltr"
      {...a11y("amountMinor")}
      defaultValue={v.amountMinor ?? ""}
      placeholder="0.00"
      required
      className={cls("amountMinor", "tabular-nums")}
    />
  );

  const dateInput = (name: string, required = true) => (
    <input
      type="date"
      {...a11y(name)}
      defaultValue={v[name] ?? ""}
      required={required}
      className={cls(name)}
    />
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="entryType" value={type} />
      {state.duplicate && <input type="hidden" name="allowDuplicate" value="1" />}

      {type === "transaction" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              "type",
              tm("typeLabel"),
              <select
                {...a11y("type")}
                defaultValue={v.type ?? ""}
                onChange={(e) => setDirection(e.target.value)}
                required
                className={cls("type")}
              >
                <option value="" disabled>
                  {t("selectDirection")}
                </option>
                <option value="transfer_in">{tm("types.transfer_in")}</option>
                <option value="transfer_out">{tm("types.transfer_out")}</option>
              </select>,
            )}
            {field("bankAccountId", tm("account"), accountSelect(accounts))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              "partyName",
              direction === "transfer_out" ? tm("beneficiary") : tm("sender"),
              textInput("partyName", { required: true }),
            )}
            {field(
              "reference",
              `${tm("reference")} ${tm("optional")}`,
              textInput("reference", { dir: "ltr" }),
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field("transactionDate", tm("date"), dateInput("transactionDate"))}
            {field("amountMinor", tm("amount"), amountInput())}
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              "bankAccountId",
              tc("account"),
              accountSelect(accounts.filter((a) => a.issuesCheques)),
            )}
            {field("chequeNumber", tc("number"), textInput("chequeNumber", { dir: "ltr", required: true }))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field("partyName", tc("payee"), textInput("partyName", { required: true }))}
            {field("amountMinor", tm("amount"), amountInput())}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field("transactionDate", tc("issueDate"), dateInput("transactionDate"))}
            {field("dueDate", `${tc("dueDate")} ${tm("optional")}`, dateInput("dueDate", false))}
          </div>
        </>
      )}

      {field(
        "notes",
        `${tm("notes")} ${tm("optional")}`,
        <textarea {...a11y("notes")} defaultValue={v.notes ?? ""} rows={2} className={inputClass} />,
      )}

      <div aria-live="polite">
        {state.duplicate && (
          <p className="rounded-md bg-warning-tint p-3 text-sm text-warning">
            {t("duplicateWarning")}
          </p>
        )}
        {state.formError && (
          <p className="rounded-md bg-debit-tint p-3 text-sm text-debit">
            {errorText(state.formError)}
          </p>
        )}
      </div>

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? t("approving") : state.duplicate ? t("approveAnyway") : t("approve")}
      </button>
    </form>
  );
}
