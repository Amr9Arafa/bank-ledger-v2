"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { confirmMatchAction } from "@/actions/statements";
import type { InlineActionState } from "@/actions/form-data";
import { inputClass, primaryButton } from "@/components/styles";

export type CandidateOption = { transactionId: string; label: string };

// The suggested record is preselected; other possible records are in the same list.
// The server checks the pairing again, so the list is a convenience, not a rule.
export default function MatchConfirm({ lineId, options }: { lineId: string; options: CandidateOption[] }) {
  const t = useTranslations("statements.match");
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState<InlineActionState, FormData>(confirmMatchAction, {});
  if (state.done) return null;

  return (
    <form action={formAction} className="flex min-w-64 flex-col gap-2">
      <input type="hidden" name="lineId" value={lineId} />
      {options.length === 1 ? (
        <>
          <input type="hidden" name="transactionId" value={options[0].transactionId} />
          <p className="text-sm"><bdi>{options[0].label}</bdi></p>
        </>
      ) : (
        <select name="transactionId" aria-label={t("candidates")} className={inputClass} defaultValue={options[0].transactionId}>
          {options.map((o) => (
            <option key={o.transactionId} value={o.transactionId}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <div>
        <button type="submit" disabled={pending} className={`${primaryButton} px-3 py-1`}>
          {t("confirm")}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-debit">
          {te(state.error as "notACandidate")}
        </p>
      )}
    </form>
  );
}
