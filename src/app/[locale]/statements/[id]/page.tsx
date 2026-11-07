import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import {
  confirmUniqueAction,
  ignoreLineAction,
  unignoreLineAction,
  unmatchAction,
} from "@/actions/statements";
import InlineAction from "@/components/InlineAction";
import MatchConfirm, { type CandidateOption } from "@/components/MatchConfirm";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import type { TransactionType } from "@/server/db/schema";
import { getImportSuggestions } from "@/server/ledger/reconcile";
import { getStatementImport, listStatementLines } from "@/server/ledger/statements";

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

  const [allLines, { suggestions, rows }] = await Promise.all([
    listStatementLines(user.organizationId, id),
    getImportSuggestions(user.organizationId, id),
  ]);
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

      {canWrite && uniqueCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
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
                        </div>
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
