import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import {
  confirmUniqueAction,
  createAllFeesAction,
  createAllInterestAction,
  ignoreLineAction,
  unignoreLineAction,
  unmatchAction,
} from "@/actions/statements";
import CreateFromLineForm, { type CreateDefaults } from "@/components/CreateFromLineForm";
import InlineAction from "@/components/InlineAction";
import MatchConfirm, { type CandidateOption } from "@/components/MatchConfirm";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { chequeSerial } from "@/lib/statements/match";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import type { TransactionType } from "@/server/db/schema";
import { getActiveAccounts } from "@/server/ledger/accounts";
import { getImportSuggestions } from "@/server/ledger/reconcile";
import { closingCheck, importWarnings } from "@/server/ledger/statementChecks";
import { getStatementImport, type ImportWarning, listStatementLines } from "@/server/ledger/statements";

// "suggested" is not stored: an unmatched line with a suggested record.
const TABS = ["suggested", "unmatched", "matched", "created", "ignored", "before_start"] as const;
type Tab = (typeof TABS)[number];

const STATUS_STYLE: Record<Tab, string> = {
  suggested: "bg-navy-tint text-navy",
  unmatched: "bg-warning-tint text-warning",
  matched: "bg-credit-tint text-credit",
  created: "bg-credit-tint text-credit",
  ignored: "bg-surface-subtle text-foreground-secondary",
  before_start: "bg-surface-subtle text-foreground-tertiary",
};

export default async function StatementImportPage({ params, searchParams }: PageProps<"/[locale]/statements/[id]">) {
  const { locale: rawLocale, id } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("statements");
  const tm = await getTranslations("statements.match");
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
  const tk = await getTranslations("statements.checks");
  const money = (minor: number) => formatEGP(minor, locale);
  const warningText = (w: ImportWarning) => {
    switch (w.code) {
      case "startsAfterOpening":
        return t("warnings.startsAfterOpening", { statementDate: formatDay(w.statementOpeningDate, locale), openingDate: formatDay(w.accountOpeningDate, locale) });
      case "openingBalanceMismatch":
        return t("warnings.openingBalanceMismatch", { date: formatDay(w.date, locale), statement: money(w.statementMinor), app: money(w.appMinor) });
      case "gap":
        return t("warnings.gap", { from: formatDay(w.from, locale), to: formatDay(w.to, locale) });
      case "previousBalanceMismatch":
        return t("warnings.previousBalanceMismatch", { date: formatDay(w.date, locale), statement: money(w.statementMinor), previous: money(w.previousMinor) });
      case "nothingNew":
        return t("warnings.nothingNew");
    }
  };
  const otherAccounts = accounts.filter((a) => a.id !== statement.bankAccountId).map((a) => ({ id: a.id, name: a.name }));
  const canIssueCheques = accounts.find((a) => a.id === statement.bankAccountId)?.issuesCheques ?? false;
  const lines = allLines.map((l) => ({
    ...l,
    shown: (l.status === "unmatched" && suggestions.get(l.id)?.suggested ? "suggested" : l.status) as Tab,
    suggestion: suggestions.get(l.id),
  }));
  const requested = (await searchParams).tab;
  const tab = TABS.find((s) => s === requested) ?? null;
  const visible = tab ? lines.filter((l) => l.shown === tab) : lines;
  const count = (s: Tab | null) => (s ? lines.filter((l) => l.shown === s).length : lines.length);
  const uniqueCount = lines.filter((l) => l.suggestion?.unique).length;
  // Same rule as the ledger's bulkCandidates: unmatched, right kind and direction, nothing it could match.
  const bulkCount = (kind: "fee" | "interest") =>
    lines.filter(
      (l) =>
        l.status === "unmatched" &&
        l.kind === kind &&
        l.direction === (kind === "fee" ? "debit" : "credit") &&
        (l.suggestion?.candidates.length ?? 0) === 0,
    ).length;
  const feeCount = bulkCount("fee");
  const interestCount = bulkCount("interest");
  const tc = await getTranslations("statements.create");
  // What the create form starts with, from what the bank wrote.
  const defaultsFor = (l: (typeof lines)[number]): CreateDefaults => ({
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
    chequeNumber: l.chequeRef ? chequeSerial(l.chequeRef) : "",
  });

  const day = (d: string) => formatDay(d, locale);
  const typeLabel = (type: string) => tl(`types.${type as TransactionType}`);
  const optionLabel = (transactionId: string, dayDiff: number, chequeNumberMatch: boolean): string => {
    const r = rows.get(transactionId)!;
    const parts = [
      day(r.type === "cheque" && r.status === "cleared" && r.clearedDate ? r.clearedDate : r.transactionDate),
      typeLabel(r.type) + (r.chequeNumber ? ` #${r.chequeNumber}` : ""),
      r.partyName ?? r.description ?? "",
      tm("dayDiff", { days: Math.abs(dayDiff) }),
    ];
    if (chequeNumberMatch) parts.push(tm("chequeNumberMatch"));
    if (r.type === "cheque" && r.status === "issued") parts.push(tm("clearsCheque"));
    return parts.filter(Boolean).join(" · ");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <Link href="/statements" className="text-sm text-navy underline-offset-2 hover:underline">
        {t("detail.back")}
      </Link>

      <div className={`${panel} p-4`}>
        <h1 className="text-xl font-semibold"><bdi>{statement.accountName}</bdi></h1>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div className="flex gap-2">
            <dt className="text-foreground-secondary">{t("preview.period")}</dt>
            <dd className="tabular-nums">{day(statement.openingDate)} – {day(statement.closingDate)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-foreground-secondary">{t("preview.opening")}</dt>
            <dd className="tabular-nums">{formatEGP(statement.openingBalanceMinor, locale)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-foreground-secondary">{t("preview.closing")}</dt>
            <dd className="tabular-nums">{formatEGP(statement.closingBalanceMinor, locale)}</dd>
          </div>
        </dl>
      </div>

      <section className={`${panel} space-y-3 p-4 text-sm`} aria-labelledby="checks-title">
        <h2 id="checks-title" className="text-base font-semibold">{tk("title")}</h2>
        {warnings.length === 0 ? (
          <p className="text-credit">{tk("continuityOk")}</p>
        ) : (
          <ul className="space-y-1">
            {warnings.map((w) => (
              <li key={w.code} className="rounded bg-warning-tint px-2 py-1 text-warning">{warningText(w)}</li>
            ))}
          </ul>
        )}

        <div>
          <h3 className="font-medium">{tk("closingTitle", { date: day(check.date) })}</h3>
          <dl className="mt-1 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 tabular-nums">
            <dt className="text-foreground-secondary">{tk("bank")}</dt>
            <dd className="text-end">{money(check.bankMinor)}</dd>
            <dt className="text-foreground-secondary">{tk("app")}</dt>
            <dd className="text-end">{money(check.appMinor)}</dd>
            <dt className="font-medium">{tk("difference")}</dt>
            <dd className={`text-end font-medium ${check.differenceMinor === 0 ? "text-credit" : "text-warning"}`}>
              {money(check.differenceMinor)}
            </dd>
          </dl>
          {check.differenceMinor !== 0 && (
            <div className="mt-2">
              <p className="text-foreground-secondary">{tk("explainedBy")}</p>
              <dl className="mt-1 grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 tabular-nums">
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
                {check.unexplainedMinor !== 0 && (
                  <>
                    <dt className="font-medium text-debit">{tk("unexplained")}</dt>
                    <dd className="text-end font-medium text-debit">{money(check.unexplainedMinor)}</dd>
                  </>
                )}
              </dl>
              {check.unexplainedMinor !== 0 && <p className="mt-1 text-xs text-debit">{tk("unexplainedNote")}</p>}
              {check.appOnly.rows.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-navy">{tk("appOnly", { count: check.appOnly.rows.length })}</summary>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {check.appOnly.rows.map((r) => (
                      <li key={r.id} className="flex flex-wrap gap-x-2 tabular-nums">
                        <span>{day(r.date)}</span>
                        <span>{typeLabel(r.type)}{r.chequeNumber && <> #<bdi>{r.chequeNumber}</bdi></>}</span>
                        <bdi>{r.partyName ?? r.description ?? ""}</bdi>
                        <span className={r.signedMinor >= 0 ? "text-credit" : "text-debit"}>{money(r.signedMinor)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
        {check.reconciled ? (
          <p className="font-medium text-credit">{tk("reconciled")}</p>
        ) : (
          check.unmatchedInImport > 0 && <p className="text-warning">{tk("notReconciled", { count: check.unmatchedInImport })}</p>
        )}
      </section>

      {canWrite && uniqueCount + feeCount + interestCount > 0 && (
        <div className="flex flex-wrap items-start gap-6 text-sm">
          {uniqueCount > 0 && (
            <InlineAction
              action={confirmUniqueAction}
              transactionId={id}
              idName="importId"
              tone="normal"
              label={tm("confirmUnique", { count: uniqueCount })}
              confirmLabel={tm("confirmUnique", { count: uniqueCount })}
              keepLabel={tm("keep")}
              note={tm("confirmUniqueNote")}
            />
          )}
          {feeCount > 0 && (
            <InlineAction
              action={createAllFeesAction}
              transactionId={id}
              idName="importId"
              tone="normal"
              label={tc("bulkFees", { count: feeCount })}
              confirmLabel={tc("bulkFees", { count: feeCount })}
              keepLabel={tc("keep")}
              note={tc("bulkNote")}
            />
          )}
          {interestCount > 0 && (
            <InlineAction
              action={createAllInterestAction}
              transactionId={id}
              idName="importId"
              tone="normal"
              label={tc("bulkInterest", { count: interestCount })}
              confirmLabel={tc("bulkInterest", { count: interestCount })}
              keepLabel={tc("keep")}
              note={tc("bulkNote")}
            />
          )}
        </div>
      )}

      <nav className="flex flex-wrap gap-2" aria-label={t("detail.status")}>
        {([null, ...TABS] as const).map((s) => (
          <Link
            key={s ?? "all"}
            href={{ pathname: `/statements/${id}`, query: s ? { tab: s } : {} }}
            aria-current={s === tab ? "page" : undefined}
            className="rounded-full border border-border px-3 py-1.5 text-sm aria-[current=page]:bg-navy aria-[current=page]:text-white"
          >
            {s ? t(`statuses.${s}`) : t("detail.all")} <span className="tabular-nums">({count(s)})</span>
          </Link>
        ))}
      </nav>

      {visible.length === 0 ? (
        <p className="text-sm text-foreground-secondary">{t("detail.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-foreground-secondary">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("detail.lineNo")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.date")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.description")}</th>
                <th className="px-3 py-2 text-end font-medium">{t("detail.amount")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.status")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => {
                const s = l.suggestion;
                const options: CandidateOption[] = s
                  ? [
                      ...(s.suggested ? [s.suggested] : []),
                      ...s.candidates.filter((c) => c.transactionId !== s.suggested?.transactionId),
                    ].map((c) => ({ transactionId: c.transactionId, label: optionLabel(c.transactionId, c.dayDiff, c.chequeNumberMatch) }))
                  : [];
                return (
                  <tr key={l.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 tabular-nums text-foreground-tertiary">{l.lineNo}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {day(l.bookingDate)}
                      {l.valueDate !== l.bookingDate && (
                        <div className="text-xs text-foreground-tertiary">
                          {t("detail.valueDate")} {day(l.valueDate)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-foreground-secondary">{t(`kinds.${l.kind}`)}</div>
                      {l.counterparty && <div className="font-medium"><bdi>{l.counterparty}</bdi></div>}
                      <div className="text-xs text-foreground-secondary"><bdi dir="auto">{l.description}</bdi></div>
                      {l.chequeRef && <div className="text-xs tabular-nums text-foreground-secondary">#<bdi>{l.chequeRef}</bdi></div>}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-end tabular-nums ${l.direction === "credit" ? "text-credit" : "text-debit"}`}>
                      {formatEGP(l.direction === "credit" ? l.amountMinor : -l.amountMinor, locale)}
                    </td>
                    <td className="space-y-2 px-3 py-2">
                      <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_STYLE[l.shown]}`}>
                        {t(`statuses.${l.shown}`)}
                      </span>

                      {l.matchedId && (
                        <div className="text-xs">
                          <span className="text-foreground-secondary">{tm("matchedTo")} </span>
                          {typeLabel(l.matchedType!)}
                          {l.matchedChequeNumber && <> #<bdi>{l.matchedChequeNumber}</bdi></>}
                          {(l.matchedParty ?? l.matchedDescription) && <> · <bdi>{l.matchedParty ?? l.matchedDescription}</bdi></>}
                          {" · "}<span className="tabular-nums">{day(l.matchedDate!)}</span>
                          {l.matchClearedCheque && <div className="text-foreground-secondary">{tm("clearedByMatch")}</div>}
                          {l.matchOrigin === "created" && <div className="text-foreground-secondary">{tc("createdNote")}</div>}
                        </div>
                      )}
                      {canWrite && l.status === "created" && (
                        <InlineAction
                          action={unmatchAction}
                          transactionId={l.id}
                          idName="lineId"
                          label={tc("undo")}
                          confirmLabel={tc("confirmUndo")}
                          keepLabel={tc("keep")}
                          note={tc("undoNote")}
                        />
                      )}
                      {canWrite && l.status === "matched" && (
                        <InlineAction
                          action={unmatchAction}
                          transactionId={l.id}
                          idName="lineId"
                          label={tm("unmatch")}
                          confirmLabel={tm("confirmUnmatch")}
                          keepLabel={tm("keep")}
                          note={tm("unmatchNote")}
                        />
                      )}

                      {l.status === "unmatched" && (
                        <>
                          {options.length > 0 ? (
                            canWrite ? (
                              <MatchConfirm lineId={l.id} options={options} />
                            ) : (
                              <p className="text-xs"><bdi>{options[0].label}</bdi></p>
                            )
                          ) : (
                            <p className="text-xs text-foreground-secondary">{tm("noCandidate")}</p>
                          )}
                          {canWrite && (
                            <CreateFromLineForm
                              lineId={l.id}
                              direction={l.direction}
                              defaults={defaultsFor(l)}
                              otherAccounts={otherAccounts}
                              canIssueCheques={canIssueCheques}
                            />
                          )}
                          {canWrite && (
                            <InlineAction
                              action={ignoreLineAction}
                              transactionId={l.id}
                              idName="lineId"
                              tone="normal"
                              label={tm("ignore")}
                              confirmLabel={tm("confirmIgnore")}
                              keepLabel={tm("keep")}
                              input={{ name: "reason", type: "text", label: tm("ignoreReason") }}
                            />
                          )}
                        </>
                      )}

                      {l.status === "ignored" && (
                        <>
                          <p className="text-xs text-foreground-secondary"><bdi dir="auto">{l.ignoreReason}</bdi></p>
                          {canWrite && (
                            <InlineAction
                              action={unignoreLineAction}
                              transactionId={l.id}
                              idName="lineId"
                              tone="normal"
                              label={tm("unignore")}
                              confirmLabel={tm("confirmUnignore")}
                              keepLabel={tm("keep")}
                            />
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
