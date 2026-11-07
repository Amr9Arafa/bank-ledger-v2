import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { STATEMENT_LINE_STATUSES } from "@/server/db/schema";
import { getCurrentUser } from "@/server/auth/session";
import { getStatementImport, listStatementLines } from "@/server/ledger/statements";

const STATUS_STYLE: Record<(typeof STATEMENT_LINE_STATUSES)[number], string> = {
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

  const user = await getCurrentUser();
  if (!z.uuid().safeParse(id).success) notFound();
  const statement = await getStatementImport(user.organizationId, id);
  if (!statement) notFound();

  const requested = (await searchParams).tab;
  const tab = STATEMENT_LINE_STATUSES.find((s) => s === requested) ?? null;
  const lines = await listStatementLines(user.organizationId, id, tab);
  const counts = { all: statement.lineCount - statement.skippedLineCount, ...statement };

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
            <dd className="tabular-nums">{formatDay(statement.openingDate, locale)} – {formatDay(statement.closingDate, locale)}</dd>
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

      <nav className="flex flex-wrap gap-2" aria-label={t("detail.status")}>
        {([null, ...STATEMENT_LINE_STATUSES] as const).map((s) => (
          <Link
            key={s ?? "all"}
            href={{ pathname: `/statements/${id}`, query: s ? { tab: s } : {} }}
            aria-current={s === tab ? "page" : undefined}
            className="rounded-full border border-border px-3 py-1.5 text-sm aria-[current=page]:bg-navy aria-[current=page]:text-white"
          >
            {s ? t(`statuses.${s}`) : t("detail.all")} <span className="tabular-nums">({counts[s ?? "all"]})</span>
          </Link>
        ))}
      </nav>

      {lines.length === 0 ? (
        <p className="text-sm text-foreground-secondary">{t("detail.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-foreground-secondary">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("detail.lineNo")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.date")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.description")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.kind")}</th>
                <th className="px-3 py-2 text-end font-medium">{t("detail.amount")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("detail.status")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 tabular-nums text-foreground-tertiary">{l.lineNo}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {formatDay(l.bookingDate, locale)}
                    {l.valueDate !== l.bookingDate && (
                      <div className="text-xs text-foreground-tertiary">
                        {t("detail.valueDate")} {formatDay(l.valueDate, locale)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {l.counterparty && <div className="font-medium"><bdi>{l.counterparty}</bdi></div>}
                    <div className="text-xs text-foreground-secondary"><bdi dir="auto">{l.description}</bdi></div>
                    {l.chequeRef && <div className="text-xs tabular-nums text-foreground-secondary">#<bdi>{l.chequeRef}</bdi></div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{t(`kinds.${l.kind}`)}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-end tabular-nums ${l.direction === "credit" ? "text-credit" : "text-debit"}`}>
                    {formatEGP(l.direction === "credit" ? l.amountMinor : -l.amountMinor, locale)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_STYLE[l.status]}`}>
                      {t(`statuses.${l.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
