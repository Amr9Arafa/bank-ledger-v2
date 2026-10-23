import { getTranslations, setRequestLocale } from "next-intl/server";
import AccountCard from "@/components/AccountCard";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { addDays, DUE_SOON_DAYS } from "@/lib/cheques";
import { todayInCairo } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { getAccountBalances } from "@/server/ledger/balances";
import { listCheques } from "@/server/ledger/cheques";

export default async function DashboardPage({ params }: PageProps<"/[locale]">) {
  // The layout already rejected unknown locales with notFound().
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");

  const user = await getCurrentUser();
  const [accounts, outstanding] = await Promise.all([
    getAccountBalances(user.organizationId),
    listCheques(user.organizationId, "issued"),
  ]);
  const sum = (pick: (a: (typeof accounts)[number]) => number) =>
    accounts.reduce((total, a) => total + pick(a), 0);
  const canWrite = hasRole(user, "accountant");

  // Outstanding cheques due within 7 days, including overdue ones.
  const dueBy = addDays(todayInCairo(), DUE_SOON_DAYS);
  const dueSoon = outstanding.filter((c) => c.dueDate <= dueBy);
  const dueSoonTotal = dueSoon.reduce((total, c) => total + c.amountMinor, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-start">{t("title")}</h1>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Link
              href={{ pathname: "/transactions/new", query: { type: "transfer_in" } }}
              className="rounded-md bg-foreground px-4 py-2 text-sm text-background"
            >
              {t("newTransfer")}
            </Link>
            <Link
              href="/cheques/new"
              className="rounded-md border border-foreground/20 px-4 py-2 text-sm"
            >
              {t("newCheque")}
            </Link>
            <Link
              href="/transactions/new"
              className="rounded-md border border-foreground/20 px-4 py-2 text-sm"
            >
              {t("newMovement")}
            </Link>
          </div>
        )}
      </div>

      {dueSoon.length > 0 && (
        <Link
          href="/cheques"
          className="mt-4 block rounded-lg bg-amber-50 p-3 text-sm text-amber-900 hover:bg-amber-100"
        >
          {t("chequesDueSoon", { count: dueSoon.length, total: formatEGP(dueSoonTotal, locale) })}
        </Link>
      )}

      {accounts.length === 0 ? (
        <p className="mt-4 text-foreground/70">{t("empty")}</p>
      ) : (
        <>
          <section className="mt-6 rounded-lg bg-foreground/5 p-4">
            <h2 className="text-sm text-foreground/60">{t("companyTotal")}</h2>
            <dl className="mt-2 flex flex-wrap gap-x-10 gap-y-2">
              <div>
                <dt className="text-xs text-foreground/60">{t("bookBalance")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {formatEGP(sum((a) => a.bookBalanceMinor), locale)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-foreground/60">{t("bankBalance")}</dt>
                <dd className="text-2xl tabular-nums">
                  {formatEGP(sum((a) => a.bankBalanceMinor), locale)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-foreground/60">{t("outstandingCheques")}</dt>
                <dd className="text-2xl tabular-nums">
                  {formatEGP(sum((a) => a.outstandingChequesMinor), locale)}
                </dd>
              </div>
            </dl>
          </section>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
