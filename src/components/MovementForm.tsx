"use client";

import { useActionState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { saveMovement, type MovementFormState } from "@/actions/transactions";
import type messages from "../../messages/en.json";
import type { FormType } from "@/lib/validation";
import type { AccountOption } from "@/server/ledger/accounts";

type ErrorKey = keyof (typeof messages)["errors"];

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 aria-invalid:border-red-600";

export default function MovementForm({
  type,
  accounts,
  accountId,
  today,
}: {
  type: FormType;
  accounts: AccountOption[];
  // Pre-selected account, e.g. when coming from that account's ledger.
  accountId?: string;
  today: string;
}) {
  const t = useTranslations("movement");
  const te = useTranslations("errors");
  const preselected = accountId
    ? { [type === "internal" ? "fromAccountId" : "bankAccountId"]: accountId }
    : {};
  const initial: MovementFormState = {
    errors: {},
    values: { type, transactionDate: today, ...preselected },
  };
  const [state, formAction, pending] = useActionState(saveMovement, initial);
  const v = state.values;

  // Shows a label, the input, and the translated error for one field.
  const field = (name: string, label: string, input: ReactNode) => (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {state.errors[name] && (
        <p id={`${name}-error`} className="mt-1 text-sm text-red-600">
          {te(state.errors[name] as ErrorKey)}
        </p>
      )}
    </div>
  );
  const a11y = (name: string) => ({
    id: name,
    name,
    "aria-invalid": Boolean(state.errors[name]),
    "aria-describedby": state.errors[name] ? `${name}-error` : undefined,
  });

  const accountSelect = (name: string, options: AccountOption[]) => (
    <select {...a11y(name)} defaultValue={v[name] ?? ""} required className={inputClass}>
      <option value="" disabled>
        {t("selectAccount")}
      </option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} — {a.bankName}
        </option>
      ))}
    </select>
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="type" value={type} />
      {state.duplicate && <input type="hidden" name="allowDuplicate" value="1" />}

      {type === "internal" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {field("fromAccountId", t("fromAccount"), accountSelect("fromAccountId", accounts))}
          {field("toAccountId", t("toAccount"), accountSelect("toAccountId", accounts))}
        </div>
      ) : (
        field(
          "bankAccountId",
          t("account"),
          accountSelect(
            "bankAccountId",
            type === "transfer_in" ? accounts.filter((a) => a.receivesTransfers) : accounts,
          ),
        )
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "transactionDate",
          t("date"),
          <input
            type="date"
            {...a11y("transactionDate")}
            defaultValue={v.transactionDate ?? today}
            required
            className={inputClass}
          />,
        )}
        {field(
          "amountMinor",
          t("amount"),
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

      {type === "transfer_in" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {field(
            "partyName",
            t("sender"),
            <input
              type="text"
              {...a11y("partyName")}
              defaultValue={v.partyName ?? ""}
              required
              className={inputClass}
            />,
          )}
          {field(
            "reference",
            `${t("reference")} ${t("optional")}`,
            <input
              type="text"
              dir="ltr"
              {...a11y("reference")}
              defaultValue={v.reference ?? ""}
              className={inputClass}
            />,
          )}
        </div>
      )}

      {(type === "deposit" || type === "fee") &&
        field(
          "description",
          t("description"),
          <input
            type="text"
            {...a11y("description")}
            defaultValue={v.description ?? ""}
            required
            className={inputClass}
          />,
        )}

      {field(
        "notes",
        `${t("notes")} ${t("optional")}`,
        <textarea {...a11y("notes")} defaultValue={v.notes ?? ""} rows={2} className={inputClass} />,
      )}

      <div aria-live="polite">
        {state.duplicate && (
          <p className="rounded-md bg-amber-100 p-3 text-sm text-amber-900">
            {t("duplicateWarning")}
          </p>
        )}
        {state.formError && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {te(state.formError as ErrorKey)}
          </p>
        )}
        {state.saved && !pending && (
          <p className="rounded-md bg-green-50 p-3 text-sm text-green-800">{t("saved")}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
        >
          {pending ? t("saving") : state.duplicate ? t("saveAnyway") : t("save")}
        </button>
        <button
          type="submit"
          name="intent"
          value="saveNew"
          disabled={pending}
          className="rounded-md border border-foreground/20 px-4 py-2 disabled:opacity-50"
        >
          {t("saveNew")}
        </button>
      </div>
    </form>
  );
}
