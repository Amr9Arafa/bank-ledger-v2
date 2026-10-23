import { getTranslations, setRequestLocale } from "next-intl/server";
import AccountCard from "@/components/AccountCard";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatEGP } from "@/lib/money";
import { getCurrentUser } from "@/server/auth/session";
import { getAccountBalances } from "@/server/ledger/balances";

export default async function DashboardPage({
  params,
}: PageProps<"/[locale]">) {
  // The layout already rejected unknown locales with notFound().
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");

  const user = await getCurrentUser();
  const accounts = await getAccountBalances(user.organizationId);
  const totalBook = accounts.reduce((sum, a) => sum + a.bookBalanceMinor, 0);
  const totalBank = accounts.reduce((sum, a) => sum + a.bankBalanceMinor, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-start">{t("title")}</h1>
        <Link
          href="/transactions/new"
          className="rounded-md bg-foreground px-4 py-2 text-sm text-background"
        >
          {t("newMovement")}
        </Link>
      </div>

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
                  {formatEGP(totalBook, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-foreground/60">{t("bankBalance")}</dt>
                <dd className="text-2xl tabular-nums">
                  {formatEGP(totalBank, locale)}
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
