"use client";

import { useActionState, useRef } from "react";
import { useTranslations } from "next-intl";
import { saveCheque, type ChequeFormState } from "@/actions/cheques";
import { inputClass, primaryButton, secondaryButton, useFieldHelpers } from "@/components/form";
import type { AccountOption } from "@/server/ledger/accounts";

export default function ChequeForm({
  accounts,
  suggestions,
  accountId,
  today,
}: {
  // Accounts that issue cheques.
  accounts: AccountOption[];
  // Account id -> suggested next cheque number (FR-6).
  suggestions: Record<string, string>;
  accountId?: string;
  today: string;
}) {
  const t = useTranslations("cheque");
  const tm = useTranslations("movement");
  const firstAccount = accountId ?? (accounts.length === 1 ? accounts[0].id : "");
  const initial: ChequeFormState = {
    errors: {},
    values: { bankAccountId: firstAccount, transactionDate: today },
  };
  const [state, formAction, pending] = useActionState(saveCheque, initial);
  const { field, a11y, errorText } = useFieldHelpers(state.errors);
  const v = state.values;
  const selected = v.bankAccountId ?? "";

  // When the account changes, replace the number only if the user has not typed their own.
  const numberRef = useRef<HTMLInputElement>(null);
  const lastSuggestion = useRef(suggestions[selected] ?? "");
  const onAccountChange = (id: string) => {
    const input = numberRef.current;
    const next = suggestions[id] ?? "";
    if (input && (input.value === "" || input.value === lastSuggestion.current)) {
      input.value = next;
    }
    lastSuggestion.current = next;
  };

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "bankAccountId",
          tm("account"),
          <select
            {...a11y("bankAccountId")}
            defaultValue={selected}
            onChange={(e) => onAccountChange(e.target.value)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              {tm("selectAccount")}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.bankName}
              </option>
            ))}
          </select>,
        )}
        {field(
          "chequeNumber",
          t("number"),
          <input
            ref={numberRef}
            type="text"
            inputMode="numeric"
            dir="ltr"
            autoComplete="off"
            {...a11y("chequeNumber")}
            defaultValue={v.chequeNumber ?? suggestions[selected] ?? ""}
            required
            className={`${inputClass} tabular-nums`}
          />,
        )}
      </div>

      {field(
        "partyName",
        t("payee"),
        <input
          type="text"
          {...a11y("partyName")}
          defaultValue={v.partyName ?? ""}
          required
          className={inputClass}
        />,
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {field(
          "transactionDate",
          t("issueDate"),
          <input
            type="date"
            {...a11y("transactionDate")}
            defaultValue={v.transactionDate ?? today}
            required
            className={inputClass}
          />,
        )}
        {field(
          "dueDate",
          `${t("dueDate")} ${tm("optional")}`,
          <input
            type="date"
            {...a11y("dueDate")}
            defaultValue={v.dueDate ?? ""}
            className={inputClass}
          />,
        )}
        {field(
          "amountMinor",
          tm("amount"),
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            {...a11y("amountMinor")}
            defaultValue={v.amountMinor ?? ""}
            placeholder="0.00"
            required
            className={`${inputClass} tabular-nums`}
          />,
        )}
      </div>

      {field(
        "notes",
        `${tm("notes")} ${tm("optional")}`,
        <textarea {...a11y("notes")} defaultValue={v.notes ?? ""} rows={2} className={inputClass} />,
      )}

      <div aria-live="polite">
        {state.formError && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {errorText(state.formError)}
          </p>
        )}
        {state.saved && !pending && (
          <p className="rounded-md bg-green-50 p-3 text-sm text-green-800">{t("saved")}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button type="submit" name="intent" value="save" disabled={pending} className={primaryButton}>
          {pending ? tm("saving") : tm("save")}
        </button>
        <button
          type="submit"
          name="intent"
          value="saveNew"
          disabled={pending}
          className={secondaryButton}
        >
          {tm("saveNew")}
        </button>
      </div>
    </form>
  );
}
