"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { saveBankAccount, type BankAccountFormState } from "@/actions/admin";
import { inputClass, primaryButton, useFieldHelpers } from "@/components/form";

// Add (no initial values) or edit (values from the account) a bank account.
export default function BankAccountForm({
  accountId,
  initial,
}: {
  accountId?: string;
  initial: Record<string, string>;
}) {
  const t = useTranslations("accounts");
  const tm = useTranslations("movement");
  const [state, formAction, pending] = useActionState<BankAccountFormState, FormData>(
    saveBankAccount,
    { errors: {}, values: initial },
  );
  const { field, a11y, errorText } = useFieldHelpers(state.errors);
  const v = state.values;
  // Ticked boxes are "on"; an unticked box is absent, both initially and after a failed submit.
  const checked = (name: string) => v[name] === "on";

  const text = (name: string, label: string, ltr = false) =>
    field(
      name,
      label,
      <input
        type="text"
        dir={ltr ? "ltr" : undefined}
        {...a11y(name)}
        defaultValue={v[name] ?? ""}
        required
        className={inputClass}
      />,
    );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {accountId && <input type="hidden" name="accountId" value={accountId} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {text("name", t("name"))}
        {text("bankName", t("bankName"))}
        {text("accountNumber", t("accountNumber"), true)}
        {field(
          "openingBalanceMinor",
          t("openingBalance"),
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            {...a11y("openingBalanceMinor")}
            defaultValue={v.openingBalanceMinor ?? ""}
            placeholder="0.00"
            required
            className={`${inputClass} tabular-nums`}
          />,
        )}
        {field(
          "openingDate",
          t("openingDate"),
          <input
            type="date"
            {...a11y("openingDate")}
            defaultValue={v.openingDate ?? ""}
            required
            className={inputClass}
          />,
        )}
      </div>
      <p className="text-sm text-foreground-tertiary">{t("openingNote")}</p>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{t("usedFor")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="receivesTransfers" defaultChecked={checked("receivesTransfers")} />
          {t("receivesTransfers")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="issuesCheques" defaultChecked={checked("issuesCheques")} />
          {t("issuesCheques")}
        </label>
      </fieldset>

      <div aria-live="polite">
        {state.formError && (
          <p className="rounded-md bg-debit-tint p-3 text-sm text-debit">{errorText(state.formError)}</p>
        )}
      </div>
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? tm("saving") : tm("save")}
      </button>
    </form>
  );
}
