"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { voidMovement, type VoidFormState } from "@/actions/transactions";
import type messages from "../../messages/en.json";

type ErrorKey = keyof (typeof messages)["errors"];

// "Void" opens a small inline form that asks for the reason.
export default function VoidButton({
  transactionId,
  isInternal,
}: {
  transactionId: string;
  isInternal: boolean;
}) {
  const t = useTranslations("ledger");
  const te = useTranslations("errors");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<VoidFormState, FormData>(
    voidMovement,
    {},
  );

  if (!open || state.done) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-red-700 underline-offset-2 hover:underline"
      >
        {t("void")}
      </button>
    );
  }

  return (
    <form action={formAction} className="flex min-w-56 flex-col gap-2 text-sm">
      <input type="hidden" name="transactionId" value={transactionId} />
      <label className="sr-only" htmlFor={`reason-${transactionId}`}>
        {t("voidReason")}
      </label>
      <input
        id={`reason-${transactionId}`}
        name="reason"
        placeholder={t("voidReason")}
        autoFocus
        required
        className="rounded-md border border-foreground/20 bg-background px-2 py-1"
      />
      {isInternal && <p className="text-foreground/60">{t("voidPairNote")}</p>}
      {state.error && <p className="text-red-600">{te(state.error as ErrorKey)}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-red-700 px-3 py-1 text-white disabled:opacity-50"
        >
          {t("confirmVoid")}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-2 py-1">
          {t("keep")}
        </button>
      </div>
    </form>
  );
}
