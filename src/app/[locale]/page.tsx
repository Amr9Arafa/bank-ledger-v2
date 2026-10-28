import { getTranslations, setRequestLocale } from "next-intl/server";
import { clearChequeAction } from "@/actions/cheques";
import AccountCard from "@/components/AccountCard";
import InlineAction from "@/components/InlineAction";
import NewMenu from "@/components/NewMenu";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { daysBetween, DUE_SOON_DAYS } from "@/lib/cheques";
import { formatDay, formatLongDay, todayInCairo } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import type { TransactionType } from "@/server/db/schema";
import { getAccountBalancesForRequest } from "@/server/ledger/cached";
import { listCheques } from "@/server/ledger/cheques";
import {
  listRecentMovements,
  MOVEMENT_VIEWS,
  type MovementView,
  type RecentMovement,
} from "@/server/ledger/ledger";

// How many upcoming cheques the dashboard lists; the cheques page has them all.
const UPCOMING_LIMIT = 5;

export default async function DashboardPage({ params, searchParams }: PageProps<"/[locale]">) {
  // The layout already rejected unknown locales with notFound().
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const tl = await getTranslations("ledger");
  const tc = await getTranslations("cheque");

  // ?view=in|out|cheques filters "Recent movements"; anything else shows all.
  const requested = (await searchParams).view;
  const view: MovementView = MOVEMENT_VIEWS.find((v) => v === requested) ?? "all";

  const user = await getCurrentUser();
  const [accounts, outstanding, movements] = await Promise.all([
    getAccountBalancesForRequest(user.organizationId),
    listCheques(user.organizationId, "issued"),
    listRecentMovements(user.organizationId, view),
  ]);
  const sum = (pick: (a: (typeof accounts)[number]) => number) =>
    accounts.reduce((total, a) => total + pick(a), 0);
  const canWrite = hasRole(user, "accountant");

  const today = todayInCairo();
  const dueSoonCount = outstanding.filter(
    (c) => daysBetween(today, c.dueDate) <= DUE_SOON_DAYS,
  ).length;
  const outstandingTotal = sum((a) => a.outstandingChequesMinor);

  const tiles = [
    { label: t("bookBalance"), value: sum((a) => a.bookBalanceMinor), note: t("bookNote") },
    { label: t("bankBalance"), value: sum((a) => a.bankBalanceMinor), note: t("bankNote") },
    {
      label: t("outstandingCheques"),
      value: outstandingTotal,
      note: t("outstandingNote", { count: outstanding.length }),
      warn: outstandingTotal > 0,
    },
  ];

  const describe = (m: RecentMovement) => {
    if (m.type === "internal_out") return tl("internalTo", { name: m.counterpartName ?? "" });
    if (m.type === "internal_in") return tl("internalFrom", { name: m.counterpartName ?? "" });
    return m.partyName ?? m.description ?? "";
  };

  // "Tomorrow", "In 4 days", "2 days overdue", with urgency carried by color.
  const dueLabel = (dueDate: string) => {
    const days = daysBetween(today, dueDate);
    if (days < 0) return { text: t("overdue", { count: -days }), tone: "text-debit" };
    if (days === 0) return { text: t("dueToday"), tone: "text-warning" };
    if (days === 1) return { text: t("dueTomorrow"), tone: "text-warning" };
    return {
      text: t("dueIn", { count: days }),
      tone: days <= DUE_SOON_DAYS ? "text-warning" : "text-foreground-tertiary",
    };
  };

  return (
    <div className="mx-auto max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-foreground-tertiary">{formatLongDay(today, locale)}</p>
          <h1 className="mt-1 text-[28px] font-semibold leading-none tracking-tight">
            {t("title")}
          </h1>
        </div>
        {canWrite && (
          <NewMenu
            label={t("new")}
            items={[
              { href: "/transactions/new?type=transfer_in", label: t("newTransfer") },
              { href: "/cheques/new", label: t("newCheque") },
              { href: "/transactions/new", label: t("newMovement") },
            ]}
          />
        )}
      </header>

      {accounts.length === 0 ? (
        <p className="mt-8 text-foreground-secondary">{t("empty")}</p>
      ) : (
        <>
          <section aria-label={t("companyTotal")} className="mt-8 grid gap-4 md:grid-cols-3">
            {tiles.map((tile) => (
              <div key={tile.label} className={`${panel} p-5`}>
                <h2 className="text-sm text-foreground-secondary">{tile.label}</h2>
                <p
                  className={`mt-1 text-[28px] font-semibold leading-tight tabular-nums tracking-tight ${
                    tile.warn ? "text-warning" : ""
                  }`}
                >
                  {formatEGP(tile.value, locale)}
                </p>
                <p className="mt-2 text-xs text-foreground-tertiary">{tile.note}</p>
              </div>
            ))}
          </section>

          <section
            aria-label={t("accounts")}
            className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {accounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </section>

          <div className="mt-8 grid gap-6 xl:grid-cols-3">
            <section className={`${panel} overflow-hidden xl:col-span-2`}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
                <h2 className="text-base font-semibold">{t("recentMovements")}</h2>
                <nav aria-label={t("recentMovements")} className="flex rounded-md bg-surface-muted p-1">
                  {MOVEMENT_VIEWS.map((v) => (
                    <Link
                      key={v}
                      href={v === "all" ? "/" : { pathname: "/", query: { view: v } }}
                      scroll={false}
                      aria-current={v === view ? "page" : undefined}
                      className="rounded px-3 py-1 text-xs font-medium text-foreground-secondary hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-hairline"
                    >
                      {t(`views.${v}`)}
                    </Link>
                  ))}
                </nav>
              </div>
              {movements.length === 0 ? (
                <p className="p-4 text-sm text-foreground-secondary">{t(`noMovements.${view}`)}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-surface-subtle text-xs text-foreground-tertiary">
                      <tr>
                        <th className="px-4 py-2.5 text-start font-medium">{tl("date")}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{t("description")}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{tc("account")}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{tl("reference")}</th>
                        <th className="px-4 py-2.5 text-end font-medium">{tl("amount")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {movements.map((m) => (
                        <tr key={m.id} className="hover:bg-surface-subtle">
                          <td className="whitespace-nowrap px-4 py-3 tabular-nums text-foreground-secondary">
                            {formatDay(m.transactionDate, locale)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-medium">
                                <bdi>{describe(m)}</bdi>
                              </span>
                              <span className="rounded-sm bg-surface-muted px-1.5 py-0.5 text-[11px] text-foreground-secondary">
                                {m.type === "cheque"
                                  ? t("chequeBadge", { number: m.chequeNumber ?? "" })
                                  : tl(`types.${m.type as TransactionType}`)}
                              </span>
                              {m.status === "issued" && (
                                <span className="rounded-sm bg-warning-tint px-1.5 py-0.5 text-[11px] text-warning">
                                  {tl("chequeOutstanding")}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <Link
                              href={`/accounts/${m.accountId}`}
                              className="text-foreground-secondary hover:text-foreground hover:underline"
                            >
                              <bdi>{m.accountName}</bdi>
                            </Link>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-foreground-tertiary">
                            <bdi>{m.reference ?? "—"}</bdi>
                          </td>
                          <td
                            className={`whitespace-nowrap px-4 py-3 text-end font-medium tabular-nums ${
                              m.signedAmountMinor < 0 ? "text-debit" : "text-credit"
                            }`}
                          >
                            {formatEGP(m.signedAmountMinor, locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className={`${panel} flex flex-col`}>
              <div className="flex items-baseline justify-between gap-3 border-b border-border p-4">
                <h2 className="text-base font-semibold">{t("upcomingCheques")}</h2>
                {dueSoonCount > 0 && (
                  <p className="text-xs font-medium text-warning">
                    {t("dueSoonCount", { count: dueSoonCount })}
                  </p>
                )}
              </div>
              {outstanding.length === 0 ? (
                <p className="p-4 text-sm text-foreground-secondary">{t("noUpcoming")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {outstanding.slice(0, UPCOMING_LIMIT).map((c) => {
                    const due = dueLabel(c.dueDate);
                    return (
                      <li key={c.id} className="flex items-start justify-between gap-4 p-4">
                        <div className="min-w-0">
                          <p className={`text-xs font-medium ${due.tone}`}>{due.text}</p>
                          <p className="mt-1 truncate text-sm font-medium">
                            <bdi>{c.partyName}</bdi>
                          </p>
                          <p className="mt-0.5 text-xs tabular-nums text-foreground-tertiary">
                            {t("chequeMeta", { account: c.accountName, number: c.chequeNumber })}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <p className="text-sm font-medium tabular-nums">
                            {formatEGP(c.amountMinor, locale)}
                          </p>
                          {canWrite && (
                            <InlineAction
                              action={clearChequeAction}
                              transactionId={c.id}
                              label={tc("markCleared")}
                              confirmLabel={tc("confirmClear")}
                              keepLabel={tl("keep")}
                              input={{
                                name: "clearedDate",
                                type: "date",
                                label: tc("clearedDate"),
                                defaultValue: today,
                              }}
                              tone="normal"
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-auto border-t border-border p-4">
                <Link href="/cheques" className="text-xs font-medium text-navy hover:underline">
                  {outstanding.length > UPCOMING_LIMIT
                    ? t("allChequesCount", { count: outstanding.length })
                    : t("allCheques")}
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
