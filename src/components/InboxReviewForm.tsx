"use client";

import { type ReactNode, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { approveEntry, type ReviewFormState } from "@/actions/inbox";
import { inputClass, primaryButton, useFieldHelpers } from "@/components/form";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { fieldChanged } from "@/lib/extraction";
import type { AccountOption } from "@/server/ledger/accounts";

// The extracted fields of one AI Inbox entry, editable before approving. Approving runs the
// same validation and ledger rules as entering the movement or cheque by hand.
// Direction and account are buttons, not dropdowns: a focused dropdown changes value with
// the arrow keys or a typed letter without being opened, which once saved two entries with
// the wrong direction or account. Any field that differs from what the AI read is marked.
export default function InboxReviewForm({
  entryId,
  type,
  defaults,
  aiRead,
  accounts,
  warnedFields,
  today,
}: {
  entryId: string;
  type: "transaction" | "cheque";
  defaults: Record<string, string>;
  // What the AI read, per field ("" when it read nothing): the reference for "changed" marks.
  aiRead: Record<string, string>;
  accounts: AccountOption[];
  // Fields a warning is about: highlighted until the reviewer has looked at them.
  warnedFields: string[];
  // YYYY-MM-DD in Cairo: a date after it gets a strong, explained highlight.
  today: string;
}) {
  const t = useTranslations("inbox");
  const tm = useTranslations("movement");
  const tc = useTranslations("cheque");
  const locale = useLocale() as Locale;
  const [state, formAction, pending] = useActionState<ReviewFormState, FormData>(approveEntry, {
    errors: {},
    values: defaults,
  });
  const { field, a11y, errorText } = useFieldHelpers(state.errors, `${entryId}-`);
  const v = state.values;
  // Current value of every field, for the "changed" marks (inputs stay uncontrolled).
  const [current, setCurrent] = useState<Record<string, string>>(v);
  const track = (name: string) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setCurrent((c) => ({ ...c, [name]: value }));
  };
  const direction = current.type ?? "";
  const date = current.transactionDate ?? "";
  const futureDate = date !== "" && date > today;

  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.name} · …${a.last4}` : "";
  };
  const shown = (name: string, value: string): string => {
    if (name === "type") return value === "transfer_in" || value === "transfer_out" ? tm(`types.${value}`) : value;
    if (name === "bankAccountId") return accountLabel(value);
    if (name === "transactionDate" || name === "dueDate") return value ? formatDay(value, locale) : value;
    return value;
  };
  // "changed: AI read …" under a field whose value differs from a value the AI did read.
  const changed = (name: string): ReactNode => {
    const ai = aiRead[name] ?? "";
    if (!fieldChanged(name, ai, current[name] ?? "")) return null;
    return (
      <p className="mt-1 text-xs font-medium text-warning">
        {t("changedFrom", { value: "" })}
        <bdi>{shown(name, ai)}</bdi>
      </p>
    );
  };
  const withMark = (name: string, node: ReactNode) => (
    <div>
      {node}
      {changed(name)}
    </div>
  );

  // Amber ring on fields a warning points at, unless they already show an error.
  const ring = (name: string) => (warnedFields.includes(name) && !state.errors[name] ? "ring-1 ring-warning" : "");
  const cls = (name: string, extra = "") => `${inputClass} ${extra} ${ring(name)}`;

  // A group of buttons that sets one hidden field. Buttons only change on a click (or
  // Enter/Space on the focused button): no arrow-key or type-ahead changes.
  const choice = (name: string, label: string, options: { value: string; label: ReactNode }[]) => {
    const value = current[name] ?? "";
    const labelId = `${entryId}-${name}-label`;
    return (
      <div>
        <p id={labelId} className="mb-1 block text-sm font-medium">
          {label}
        </p>
        <input type="hidden" name={name} value={value} />
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-invalid={Boolean(state.errors[name])}
          className={`flex flex-wrap gap-2 rounded-md ${ring(name)}`}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setCurrent((c) => ({ ...c, [name]: o.value }))}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  selected
                    ? "border-navy bg-navy text-white"
                    : "border-border bg-background text-foreground hover:bg-surface-subtle"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {state.errors[name] && <p className="mt-1 text-sm text-debit">{errorText(state.errors[name])}</p>}
        {changed(name)}
      </div>
    );
  };

  const accountChoice = (options: AccountOption[]) =>
    choice(
      "bankAccountId",
      type === "cheque" ? tc("account") : tm("account"),
      options.map((a) => ({
        value: a.id,
        label: (
          <>
            <bdi>{a.name}</bdi> <span className="tabular-nums opacity-80" dir="ltr">…{a.last4}</span>
          </>
        ),
      })),
    );

  const textInput = (name: string, extra: { dir?: "ltr"; required?: boolean } = {}) => (
    <input
      type="text"
      {...a11y(name)}
      defaultValue={v[name] ?? ""}
      onChange={track(name)}
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
      onChange={track("amountMinor")}
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
      onChange={track(name)}
      required={required}
      className={
        name === "transactionDate" && futureDate && !state.errors[name]
          ? `${inputClass} ring-2 ring-warning bg-warning-tint`
          : cls(name)
      }
    />
  );

  const futureDateNote = futureDate && (
    <p role="alert" className="rounded-md border border-warning bg-warning-tint px-3 py-2 text-sm font-medium text-warning">
      {t("futureDateNote", { date: formatDay(date, locale) })}
    </p>
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="entryType" value={type} />
      {state.duplicate && <input type="hidden" name="allowDuplicate" value="1" />}

      {type === "transaction" ? (
        <>
          {choice("type", tm("typeLabel"), [
            { value: "transfer_in", label: tm("types.transfer_in") },
            { value: "transfer_out", label: tm("types.transfer_out") },
          ])}
          {accountChoice(accounts)}
          <div className="grid gap-4 sm:grid-cols-2">
            {withMark(
              "partyName",
              field("partyName", direction === "transfer_out" ? tm("beneficiary") : tm("sender"), textInput("partyName", { required: true })),
            )}
            {withMark("reference", field("reference", `${tm("reference")} ${tm("optional")}`, textInput("reference", { dir: "ltr" })))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {withMark("transactionDate", field("transactionDate", tm("date"), dateInput("transactionDate")))}
            {withMark("amountMinor", field("amountMinor", tm("amount"), amountInput()))}
          </div>
          {futureDateNote}
        </>
      ) : (
        <>
          {accountChoice(accounts.filter((a) => a.issuesCheques))}
          <div className="grid gap-4 sm:grid-cols-2">
            {withMark("chequeNumber", field("chequeNumber", tc("number"), textInput("chequeNumber", { dir: "ltr", required: true })))}
            {withMark("partyName", field("partyName", tc("payee"), textInput("partyName", { required: true })))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {withMark("amountMinor", field("amountMinor", tm("amount"), amountInput()))}
            {withMark("transactionDate", field("transactionDate", tc("issueDate"), dateInput("transactionDate")))}
          </div>
          {withMark("dueDate", field("dueDate", `${tc("dueDate")} ${tm("optional")}`, dateInput("dueDate", false)))}
          {futureDateNote}
        </>
      )}

      {withMark(
        "notes",
        field(
          "notes",
          `${tm("notes")} ${tm("optional")}`,
          <textarea {...a11y("notes")} defaultValue={v.notes ?? ""} onChange={track("notes")} rows={2} className={inputClass} />,
        ),
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
