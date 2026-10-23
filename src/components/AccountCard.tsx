import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatEGP } from "@/lib/money";
import type { AccountBalance } from "@/server/ledger/balances";

export default function AccountCard({ account }: { account: AccountBalance }) {
  const t = useTranslations("dashboard");
  const locale = useLocale();

  return (
    <article className="rounded-lg border border-foreground/10 p-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            <Link href={`/accounts/${account.id}`} className="hover:underline">
              <bdi>{account.name}</bdi>
            </Link>
          </h2>
          <p className="text-sm text-foreground/60">
            <bdi>{account.bankName}</bdi> · <bdi>{account.accountNumber}</bdi>
          </p>
        </div>
        {account.issuesCheques && (
          <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-foreground/70">
            {t("issuesCheques")}
          </span>
        )}
      </header>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-foreground/60">{t("bookBalance")}</dt>
          <dd className="font-semibold tabular-nums">
            {formatEGP(account.bookBalanceMinor, locale)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-foreground/60">{t("bankBalance")}</dt>
          <dd className="tabular-nums">
            {formatEGP(account.bankBalanceMinor, locale)}
          </dd>
        </div>
      </dl>
    </article>
  );
}
