"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { type UploadState, uploadStatement } from "@/actions/statements";
import { panel, primaryButton, secondaryButton } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import type { ImportWarning } from "@/server/ledger/statements";

// Upload a statement: "Check file" shows what importing would do (nothing saved), then
// "Import" sends the same file again with confirm=1. The File lives in React state because
// React resets the form after each action, which would empty a file input.
export default function StatementUploadForm() {
  const t = useTranslations("statements");
  const te = useTranslations("errors");
  const locale = useLocale() as Locale;
  const [state, dispatch, pending] = useActionState<UploadState, FormData>(uploadStatement, {});
  const [file, setFile] = useState<File | null>(null);
  // The file the current preview was made for.
  const [checkedFile, setCheckedFile] = useState<File | null>(null);

  // Imported: start over. Done while rendering, React's pattern for resetting state on a change.
  const [seenImport, setSeenImport] = useState(state.importedIds);
  if (state.importedIds !== seenImport) {
    setSeenImport(state.importedIds);
    setFile(null);
  }

  const submit = (formData: FormData) => {
    if (file) formData.set("file", file);
    // The Import button adds confirm=1 itself (a submit button sends its name and value).
    if (formData.get("confirm") !== "1") setCheckedFile(file);
    dispatch(formData);
  };

  const money = (minor: number) => formatEGP(minor, locale);
  const day = (d: string) => formatDay(d, locale);
  const warningText = (w: ImportWarning) => {
    switch (w.code) {
      case "startsAfterOpening":
        return t("warnings.startsAfterOpening", { statementDate: day(w.statementOpeningDate), openingDate: day(w.accountOpeningDate) });
      case "openingBalanceMismatch":
        return t("warnings.openingBalanceMismatch", { date: day(w.date), statement: money(w.statementMinor), app: money(w.appMinor) });
      case "gap":
        return t("warnings.gap", { from: day(w.from), to: day(w.to) });
      case "previousBalanceMismatch":
        return t("warnings.previousBalanceMismatch", { date: day(w.date), statement: money(w.statementMinor), previous: money(w.previousMinor) });
      case "nothingNew":
        return t("warnings.nothingNew");
    }
  };

  const error = state.error;
  const errorMessage = !error
    ? null
    : error.scope === "statements"
      ? t(`errors.${error.code}`, { detail: error.detail ?? "" })
      : te(error.code as "importNotFound");
  // Previews belong to the file they were made for; a newly chosen file hides them.
  const previews = file && file === checkedFile ? state.previews : undefined;

  return (
    <form action={submit} className="space-y-4" noValidate>
      <div className="flex flex-wrap items-center gap-3">
        <label className={`${secondaryButton} cursor-pointer`}>
          {file ? t("upload.change") : t("upload.choose")}
          <input
            type="file"
            accept=".mt940,.sta,.txt,.940"
            aria-label={t("upload.label")}
            className="sr-only"
            disabled={pending}
            onChange={(e) => {
              setFile(e.currentTarget.files?.[0] ?? null);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {file && <bdi className="text-sm text-foreground-secondary">{file.name}</bdi>}
        {file && !previews && (
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? t("upload.checking") : t("upload.preview")}
          </button>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="rounded-md bg-debit-tint px-3 py-2 text-sm text-debit">
          {errorMessage}
        </p>
      )}

      {!file && state.importedIds && (
        <p role="status" className="rounded-md bg-credit-tint px-3 py-2 text-sm text-credit">
          {t("upload.imported")}{" "}
          {state.importedIds.map((id) => (
            <Link key={id} href={`/statements/${id}`} className="font-medium underline">
              {t("upload.open")}
            </Link>
          ))}
        </p>
      )}

      {previews && (
        <div className="space-y-3">
          <h2 className="text-base font-semibold">{t("preview.title")}</h2>
          {previews.map((p) => (
            <div key={p.statementRef} className={`${panel} space-y-2 p-4 text-sm`}>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-foreground-secondary">{t("preview.account")}</dt>
                  <dd className="font-medium"><bdi>{p.accountName}</bdi></dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-foreground-secondary">{t("preview.period")}</dt>
                  <dd className="tabular-nums">{day(p.openingDate)} – {day(p.closingDate)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-foreground-secondary">{t("preview.opening")}</dt>
                  <dd className="tabular-nums">{money(p.openingBalanceMinor)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-foreground-secondary">{t("preview.closing")}</dt>
                  <dd className="tabular-nums">{money(p.closingBalanceMinor)}</dd>
                </div>
              </dl>
              <p className="text-foreground-secondary">
                {t("preview.lines", { count: p.lineCount })} · {t("preview.newLines", { count: p.newLineCount })}
                {p.skippedLineCount > 0 && <> · {t("preview.skipped", { count: p.skippedLineCount })}</>}
                {p.beforeStartCount > 0 && <> · {t("preview.beforeStart", { count: p.beforeStartCount })}</>}
              </p>
              {p.warnings.length === 0 ? (
                <p className="text-credit">{t("preview.noWarnings")}</p>
              ) : (
                <ul className="space-y-1">
                  {p.warnings.map((w) => (
                    <li key={w.code} className="rounded bg-warning-tint px-2 py-1 text-warning">
                      {warningText(w)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div className="flex gap-3">
            <button type="submit" name="confirm" value="1" disabled={pending} className={primaryButton}>
              {pending ? t("upload.importing") : t("upload.import")}
            </button>
            <button type="button" onClick={() => setFile(null)} disabled={pending} className={secondaryButton}>
              {t("upload.cancel")}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
