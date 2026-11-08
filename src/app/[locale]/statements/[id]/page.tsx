import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import type { CreateDefaults } from "@/components/CreateFromLineForm";
import StatementReview, { type ReviewCandidate, type ReviewLine } from "@/components/StatementReview";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { chequeSerial } from "@/lib/statements/match";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { CREDIT_TYPES, type TransactionType } from "@/server/db/schema";
import { getActiveAccounts } from "@/server/ledger/accounts";
import { getImportSuggestions } from "@/server/ledger/reconcile";
import { closingCheck, importWarnings } from "@/server/ledger/statementChecks";
import { getStatementImport, type ImportWarning, listStatementLines } from "@/server/ledger/statements";

const credit = new Set<string>(CREDIT_TYPES);

export default async function StatementImportPage({ params }: PageProps<"/[locale]/statements/[id]">) {
  const { locale: rawLocale, id } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("statements");
  const tr = await getTranslations("statements.review");
  const tk = await getTranslations("statements.checks");
  const tl = await getTranslations("ledger");

  const user = await getCurrentUser();
  if (!z.uuid().safeParse(id).success) notFound();
  const statement = await getStatementImport(user.organizationId, id);
  if (!statement) notFound();
  const canWrite = hasRole(user, "accountant");

  const [allLines, { suggestions, rows }, accounts, check, warnings] = await Promise.all([
    listStatementLines(user.organizationId, id),
    getImportSuggestions(user.organizationId, id),
    getActiveAccounts(user.organizationId),
    closingCheck(user.organizationId, id),
    importWarnings(user.organizationId, id),
  ]);
  const otherAccounts = accounts.filter((a) => a.id !== statement.bankAccountId).map((a) => ({ id: a.id, name: a.name }));
  const canIssueCheques = accounts.find((a) => a.id === statement.bankAccountId)?.issuesCheques ?? false;

  // Everything the four steps need, as plain data for the client component.
  const lines: ReviewLine[] = allLines.map((l) => {
    const s = suggestions.get(l.id);
    const ordered = s
      ? [...(s.suggested ? [s.suggested] : []), ...s.candidates.filter((c) => c.transactionId !== s.suggested?.transactionId)]
      : [];
    const candidates: ReviewCandidate[] = ordered.map((c) => {
      const r = rows.get(c.transactionId)!;
      return {
        transactionId: c.transactionId,
        type: r.type,
        status: r.status,
        date: r.type === "cheque" && r.status === "cleared" && r.clearedDate ? r.clearedDate : r.transactionDate,
        signedMinor: credit.has(r.type) ? r.amountMinor : -r.amountMinor,
        name: r.partyName ?? r.description,
        reference: r.reference,
        notes: r.notes,
        chequeNumber: r.chequeNumber,
        dayDiff: c.dayDiff,
        nameMatch: c.nameMatch,
        chequeNumberMatch: c.chequeNumberMatch,
      };
    });
    const createDefaults: CreateDefaults = {
      type:
        l.kind === "cheque" ? "cheque"
        : l.kind === "fee" ? "fee"
        : l.kind === "interest" ? "interest"
        : l.kind === "account_transfer" ? "internal"
        : l.direction === "credit" ? "transfer_in"
        : "transfer_out",
      partyName: l.counterparty ?? "",
      description: l.description.slice(0, 200),
      // The serial printed on the cheque, the same format as cheques entered by hand.
      chequeNumber: l.chequeRef ? chequeSerial(l.chequeRef, statement.bank) : "",
    };
    return {
      id: l.id,
      lineNo: l.lineNo,
      bookingDate: l.bookingDate,
      valueDate: l.valueDate,
      direction: l.direction,
      signedMinor: l.direction === "credit" ? l.amountMinor : -l.amountMinor,
      kind: l.kind,
      counterparty: l.counterparty,
      description: l.description,
      bankRef: l.bankRef,
      chequeRef: l.chequeRef,
      status: l.status,
      ignoreReason: l.ignoreReason,
      reviewState: l.reviewState,
      sure: s?.unique ?? false,
      candidates,
      matched:
        l.matchedId && l.matchOrigin
          ? {
              type: l.matchedType!,
              date: l.matchedType === "cheque" && l.matchedClearedDate ? l.matchedClearedDate : l.matchedDate!,
              name: l.matchedParty ?? l.matchedDescription,
              chequeNumber: l.matchedChequeNumber,
              origin: l.matchOrigin,
              clearedCheque: l.matchClearedCheque ?? false,
            }
          : null,
      createDefaults,
    };
  });

  // Same rule as the ledger's bulkCandidates: unmatched, right kind and direction, nothing it could match.
  const bulkCount = (kind: "fee" | "interest") =>
    lines.filter(
      (l) => l.status === "unmatched" && l.kind === kind && l.direction === (kind === "fee" ? "debit" : "credit") && l.candidates.length === 0,
    ).length;

  const total = lines.filter((l) => l.status !== "before_start").length;
  const resolved = lines.filter((l) => l.status === "matched" || l.status === "created" || l.status === "ignored").length;
  const pct = total === 0 ? 100 : Math.round((resolved / total) * 100);

  const day = (d: string) => formatDay(d, locale);
  const money = (minor: number) => formatEGP(minor, locale);
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

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Link href="/statements" className="text-sm text-navy underline-offset-2 hover:underline">
        {t("detail.back")}
      </Link>

      <header className={`${panel} space-y-4 p-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h1 className="text-xl font-semibold"><bdi>{statement.accountName}</bdi></h1>
          <p className="text-sm tabular-nums text-foreground-secondary">
            {day(statement.openingDate)} – {day(statement.closingDate)} · {t("preview.opening")} {money(statement.openingBalanceMinor)} ·{" "}
            {t("preview.closing")} {money(statement.closingBalanceMinor)}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-medium">{tr("progress", { done: resolved, total })}</p>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={resolved}
              aria-label={tr("progress", { done: resolved, total })}
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            >
              <div className="h-full bg-credit" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div>
            {check.differenceMinor === 0 ? (
              <p className="text-sm font-medium text-credit">{tr("closingOk", { date: day(check.date) })}</p>
            ) : (
              <p className="text-sm font-medium text-warning">
                {tr("closingDifference", { date: day(check.date) })}{" "}
                <span className="tabular-nums">{money(check.differenceMinor)}</span>
              </p>
            )}
            <p className="mt-1 text-xs tabular-nums text-foreground-secondary">
              {tk("bank")} {money(check.bankMinor)} · {tk("app")} {money(check.appMinor)}
            </p>
          </div>
        </div>

        {(warnings.length > 0 || check.unexplainedMinor !== 0) && (
          <ul className="space-y-1 text-sm">
            {warnings.map((w) => (
              <li key={w.code} className="rounded bg-warning-tint px-2 py-1 text-warning">{warningText(w)}</li>
            ))}
            {check.unexplainedMinor !== 0 && (
              <li className="rounded bg-debit-tint px-2 py-1 text-debit">
                {tk("unexplained")} {money(check.unexplainedMinor)}: {tk("unexplainedNote")}
              </li>
            )}
          </ul>
        )}

        {check.differenceMinor !== 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-navy">{tr("explain")}</summary>
            <dl className="mt-2 grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 tabular-nums">
              {check.bankOnly.count > 0 && (
                <>
                  <dt>{tk("bankOnly", { count: check.bankOnly.count })}</dt>
                  <dd className="text-end">{money(-check.bankOnly.totalMinor)}</dd>
                </>
              )}
              {check.ignored.count > 0 && (
                <>
                  <dt>{tk("ignored", { count: check.ignored.count })}</dt>
                  <dd className="text-end">{money(-check.ignored.totalMinor)}</dd>
                </>
              )}
              {check.appOnly.rows.length > 0 && (
                <>
                  <dt>{tk("appOnly", { count: check.appOnly.rows.length })}</dt>
                  <dd className="text-end">{money(check.appOnly.totalMinor)}</dd>
                </>
              )}
              {check.timing.count > 0 && (
                <>
                  <dt>{tk("timing", { count: check.timing.count, date: day(check.date) })}</dt>
                  <dd className="text-end">{money(check.timing.totalMinor)}</dd>
                </>
              )}
            </dl>
            {check.appOnly.rows.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {check.appOnly.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-2 tabular-nums">
                    <span>{day(r.date)}</span>
                    <span>{tl(`types.${r.type as TransactionType}`)}{r.chequeNumber && <> #<bdi>{r.chequeNumber}</bdi></>}</span>
                    <bdi>{r.partyName ?? r.description ?? ""}</bdi>
                    <span className={r.signedMinor >= 0 ? "text-credit" : "text-debit"}>{money(r.signedMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </header>

      <StatementReview
        importId={id}
        lines={lines}
        canWrite={canWrite}
        otherAccounts={otherAccounts}
        canIssueCheques={canIssueCheques}
        bulk={{ fees: bulkCount("fee"), interest: bulkCount("interest") }}
      />
    </div>
  );
}
