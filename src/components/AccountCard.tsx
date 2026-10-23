import { useLocale, useTranslations } from "next-intl";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatAmount, formatEGP } from "@/lib/money";
import type { AccountBalance } from "@/server/ledger/balances";

// One bank account: book balance first, then how much of the bank balance is already
// promised to cheques that have not cleared yet.
export default function AccountCard({ account }: { account: AccountBalance }) {
  const t = useTranslations("dashboard");
  const locale = useLocale() as Locale;
  const { bookBalanceMinor: book, bankBalanceMinor: bank, outstandingChequesMinor: out } = account;

  // Share of today's bank balance that outstanding cheques will take.
  const promisedPct = bank > 0 ? Math.min(100, Math.round((out / bank) * 100)) : out > 0 ? 100 : 0;
  const overCommitted = out > 0 && book < 0;

  return (
    <article className={`${panel} flex flex-col p-5`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            <bdi>{account.name}</bdi>
          </h2>
          <p className="mt-0.5 truncate text-xs text-foreground-secondary">
            <bdi>{account.bankName}</bdi>
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-foreground-tertiary" dir="ltr">
            •••• {account.accountNumber.slice(-4)}
          </p>
        </div>
        <Link
          href={`/accounts/${account.id}`}
          className="shrink-0 text-xs font-medium text-navy hover:underline"
        >
          {t("viewLedger")}
        </Link>
      </header>

      <div className="mt-auto pt-5">
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {formatEGP(book, locale)}
          </span>
          <span className="text-xs text-foreground-tertiary">{t("bookShort")}</span>
        </p>

        {account.issuesCheques ? (
          <>
            <div
              role="img"
              aria-label={t("promisedBar", {
                outstanding: formatEGP(out, locale),
                bank: formatEGP(bank, locale),
              })}
              className="mt-4 flex h-1 w-full overflow-hidden rounded-full bg-surface-muted"
            >
              <div className="h-full bg-credit" style={{ width: `${100 - promisedPct}%` }} />
              <div className="h-full bg-warning" style={{ width: `${promisedPct}%` }} />
            </div>
            <dl className="mt-3 flex justify-between gap-3 text-xs tabular-nums">
              <div className="flex gap-1">
                <dt className="text-foreground-secondary">{t("bankShort")}</dt>
                <dd className="font-medium">{formatAmount(bank, locale)}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="text-foreground-secondary">{t("outstandingShort")}</dt>
                <dd className="font-medium text-warning">{formatAmount(out, locale)}</dd>
              </div>
            </dl>
            {overCommitted && (
              <p className="mt-2 text-xs font-medium text-debit">{t("overCommitted")}</p>
            )}
          </>
        ) : (
          <>
            <div className="mt-4 h-1 w-full rounded-full bg-surface-muted" />
            <div className="mt-3 flex justify-between gap-3 text-xs tabular-nums">
              <dl className="flex gap-1">
                <dt className="text-foreground-secondary">{t("bankShort")}</dt>
                <dd className="font-medium">{formatAmount(bank, locale)}</dd>
              </dl>
              <p className="text-foreground-tertiary">{t("noCheques")}</p>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
