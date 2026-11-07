"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { type CreateFromLineState, createFromLineAction } from "@/actions/statements";
import { inputClass, primaryButton, secondaryButton, useFieldHelpers } from "@/components/form";

type RecordType = "transfer_in" | "transfer_out" | "fee" | "interest" | "cheque" | "internal";

export type CreateDefaults = {
  type: RecordType;
  partyName: string;
  description: string;
  chequeNumber: string;
};

// Create the ledger record for an unmatched statement line. Only the record type and the
// names/notes are chosen here; amount, date and bank reference come from the line on the server.
export default function CreateFromLineForm({
  lineId,
  direction,
  defaults,
  otherAccounts,
  canIssueCheques,
}: {
  lineId: string;
  direction: "credit" | "debit";
  defaults: CreateDefaults;
  otherAccounts: { id: string; name: string }[];
  canIssueCheques: boolean;
}) {
  const t = useTranslations("statements.create");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CreateFromLineState, FormData>(createFromLineAction, {
    errors: {},
    values: {},
  });
  const v = state.values;
  const types: RecordType[] = (
    direction === "credit"
      ? ["transfer_in", "interest", "internal"]
      : ["transfer_out", "fee", ...(canIssueCheques ? (["cheque"] as const) : []), "internal"]
  ).filter((x) => x !== "internal" || otherAccounts.length > 0) as RecordType[];
  const [type, setType] = useState<RecordType>(
    (v.type as RecordType) ?? (types.includes(defaults.type) ? defaults.type : types[0]),
  );
  const { field, a11y, errorText } = useFieldHelpers(state.errors, `create-${lineId}-`);

  if (state.done) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-navy underline-offset-2 hover:underline">
        {t("open")}
      </button>
    );
  }

  const partyLabel = type === "transfer_in" ? t("sender") : type === "cheque" ? t("payee") : t("beneficiary");
  return (
    <form action={formAction} className="flex min-w-64 flex-col gap-2 rounded-md border border-border p-3">
      <input type="hidden" name="lineId" value={lineId} />
      {field(
        "type",
        t("type"),
        <select {...a11y("type")} value={type} onChange={(e) => setType(e.currentTarget.value as RecordType)} className={inputClass}>
          {types.map((x) => (
            <option key={x} value={x}>
              {t(`types.${x}`)}
            </option>
          ))}
        </select>,
      )}

      {type === "cheque" &&
        field(
          "chequeNumber",
          t("chequeNumber"),
          <input {...a11y("chequeNumber")} dir="ltr" defaultValue={v.chequeNumber ?? defaults.chequeNumber} className={inputClass} />,
        )}
      {(type === "transfer_in" || type === "transfer_out" || type === "cheque") &&
        field(
          "partyName",
          partyLabel,
          <input {...a11y("partyName")} dir="auto" defaultValue={v.partyName ?? defaults.partyName} className={inputClass} />,
        )}
      {(type === "fee" || type === "interest") &&
        field(
          "description",
          t("description"),
          <input {...a11y("description")} dir="auto" defaultValue={v.description ?? defaults.description} className={inputClass} />,
        )}
      {type === "internal" &&
        field(
          "otherAccountId",
          direction === "debit" ? t("toAccount") : t("fromAccount"),
          <select {...a11y("otherAccountId")} defaultValue={v.otherAccountId ?? otherAccounts[0]?.id} className={inputClass}>
            {otherAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>,
        )}
      {field(
        "notes",
        t("notes"),
        <input
          {...a11y("notes")}
          dir="auto"
          // Keyed by type so switching to "old cheque" shows its default note.
          key={type}
          defaultValue={v.notes ?? (type === "cheque" ? t("oldChequeNote") : "")}
          className={inputClass}
        />,
      )}

      <p className="text-xs text-foreground-secondary">{t("fromLine")}</p>
      {state.formError && (
        <p role="alert" className="text-sm text-debit">
          {errorText(state.formError)}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={`${primaryButton} px-3 py-1`}>
          {t("save")}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending} className={`${secondaryButton} px-3 py-1`}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
