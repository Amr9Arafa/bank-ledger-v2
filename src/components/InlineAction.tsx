"use client";

import { useActionState, useState } from "react";
import type { InlineActionState } from "@/actions/form-data";
import { useFieldHelpers } from "@/components/form";

// A small button that opens an inline confirm form: void with a reason,
// clear with a date, cancel with a reason, or a plain confirmation.
// The server action is passed in by the (server) page.
export default function InlineAction({
  action,
  transactionId,
  idName = "transactionId",
  label,
  confirmLabel,
  keepLabel,
  input,
  note,
  tone = "danger",
}: {
  action: (state: InlineActionState, formData: FormData) => Promise<InlineActionState>;
  transactionId: string;
  // Name of the hidden id field, for actions on something other than a transaction.
  idName?: string;
  label: string;
  confirmLabel: string;
  keepLabel: string;
  // Optional single field the user fills in before confirming.
  input?: { name: string; type: "text" | "date"; label: string; defaultValue?: string };
  note?: string;
  tone?: "danger" | "normal";
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, {});
  const { errorText } = useFieldHelpers({});
  const color = tone === "danger" ? "text-debit" : "text-foreground";
  const fill = tone === "danger" ? "bg-debit text-white" : "bg-navy text-white";

  if (!open || state.done) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`whitespace-nowrap text-sm underline-offset-2 hover:underline ${color}`}
      >
        {label}
      </button>
    );
  }

  const inputId = input ? `${input.name}-${transactionId}` : undefined;
  return (
    <form action={formAction} className="flex min-w-56 flex-col gap-2 text-sm">
      <input type="hidden" name={idName} value={transactionId} />
      {input && (
        <>
          <label className="sr-only" htmlFor={inputId}>
            {input.label}
          </label>
          <input
            id={inputId}
            name={input.name}
            type={input.type}
            defaultValue={input.defaultValue}
            placeholder={input.label}
            autoFocus
            required
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        </>
      )}
      {note && <p className="text-foreground-tertiary">{note}</p>}
      {state.error && <p className="text-debit">{errorText(state.error)}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className={`rounded-md px-3 py-1 disabled:opacity-50 ${fill}`}
        >
          {confirmLabel}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-2 py-1">
          {keepLabel}
        </button>
      </div>
    </form>
  );
}
