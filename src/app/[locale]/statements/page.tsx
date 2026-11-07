import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteImportAction } from "@/actions/statements";
import InlineAction from "@/components/InlineAction";
import StatementUploadForm from "@/components/StatementUploadForm";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { accountReconciliation } from "@/server/ledger/statementChecks";
import { listStatementImports } from "@/server/ledger/statements";

export default async function StatementsPage({ params }: PageProps<"/[locale]/statements">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("statements");

  const user = await getCurrentUser();
  const [imports, reconciliation] = await Promise.all([
    listStatementImports(user.organizationId),
    accountReconciliation(user.organizationId),
  ]);
  const ta = await getTranslations("statements.accounts");
  const day = (d: string) => formatDay(d, locale);
  const canWrite = hasRole(user, "accountant");
  const isAdmin = hasRole(user, "admin");
  const timestamp = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t("intro")}</p>
      </div>

      {canWrite && (
        <section className={`${panel} p-4`}>
          <StatementUploadForm />
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold">{ta("title")}</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {reconciliation.map((r) => (
            <article key={r.accountId} className={`${panel} space-y-1 p-4 text-sm`}>
              <h3 className="font-semibold"><bdi>{r.accountName}</bdi></h3>
              <p className={r.reconciledUntil ? "font-medium text-credit" : "text-foreground-secondary"}>
                {r.reconciledUntil ? ta("reconciledUntil", { date: day(r.reconciledUntil) }) : ta("notReconciled")}
              </p>
              <p className="text-foreground-secondary">
                {r.coveredUntil ? ta("coveredUntil", { date: day(r.coveredUntil) }) : ta("noStatements")}
              </p>
              {r.gaps.map((g) => (
                <p key={g.from} className="rounded bg-warning-tint px-2 py-0.5 text-warning">
                  {ta("gap", { from: day(g.from), to: day(g.to) })}
                </p>
              ))}
              {r.unmatchedLines > 0 && <p className="text-warning">{ta("unmatched", { count: r.unmatchedLines })}</p>}
              {r.latest && (
                <p className="text-xs tabular-nums text-foreground-secondary">
                  <Link href={`/statements/${r.latest.importId}`} className="hover:underline">
                    {ta("latest", {
                      date: day(r.latest.closingDate),
                      bank: formatEGP(r.latest.check.bankMinor, locale),
                      app: formatEGP(r.latest.check.appMinor, locale),
                    })}
                  </Link>
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">{t("list.title")}</h2>
        {imports.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-secondary">{t("list.empty")}</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-subtle text-foreground-secondary">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">{t("list.account")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("list.period")}</th>
                  <th className="px-3 py-2 text-end font-medium">{t("list.closing")}</th>
                  <th className="px-3 py-2 text-end font-medium">{t("list.lines")}</th>
                  <th className="px-3 py-2 text-end font-medium">{t("list.toReview")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("list.imported")}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {imports.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-2"><bdi>{r.accountName}</bdi></td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {formatDay(r.openingDate, locale)} – {formatDay(r.closingDate, locale)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                      {formatEGP(r.closingBalanceMinor, locale)}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">
                      {r.lineCount - r.skippedLineCount}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.unmatched}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{timestamp.format(r.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-start justify-end gap-3">
                        <Link href={`/statements/${r.id}`} className="text-navy underline-offset-2 hover:underline">
                          {t("list.details")}
                        </Link>
                        {isAdmin && r.deletable && (
                          <InlineAction
                            action={deleteImportAction}
                            transactionId={r.id}
                            idName="importId"
                            label={t("list.delete")}
                            confirmLabel={t("list.confirmDelete")}
                            keepLabel={t("list.keep")}
                            note={t("list.deleteNote")}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
