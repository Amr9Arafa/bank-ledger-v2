import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { voidMovement } from "@/actions/transactions";
import InlineAction from "@/components/InlineAction";
import LedgerFilterBar from "@/components/LedgerFilterBar";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { parseLedgerFilters } from "@/lib/validation";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { getAccountBalances } from "@/server/ledger/balances";
import { getAccountLedger, type LedgerRow } from "@/server/ledger/ledger";
import type { TransactionType } from "@/server/db/schema";


export default async function AccountLedgerPage({
  params,
  searchParams,
}: PageProps<"/[locale]/accounts/[id]">) {
  const { locale: rawLocale, id } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);
  // A malformed id would make Postgres throw; treat it as "not found".
  if (!z.uuid().safeParse(id).success) notFound();

  const t = await getTranslations("ledger");
  const td = await getTranslations("dashboard");

  const user = await getCurrentUser();
  // Scoped by organization: another company's account id is simply not found.
  // Archived accounts keep their history (FR-2), so include them here.
  const account = (
    await getAccountBalances(user.organizationId, undefined, { includeArchived: true })
  ).find((a) => a.id === id);
  if (!account) notFound();
  const filters = parseLedgerFilters(await searchParams);
  const filtered = Object.values(filters).some(Boolean);
  const rows = await getAccountLedger(user.organizationId, id, filters);
  // The export downloads exactly this view: same filters, same order of rules.
  const query = new URLSearchParams(
    Object.entries(filters).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const exportHref = `/${locale}/accounts/${id}/export${query ? `?${query}` : ""}`;
  const canWrite = hasRole(user, "accountant") && !account.archived;

  const day = (d: string) => formatDay(d, locale);
  const details = (r: LedgerRow) => {
    if (r.type === "internal_out") return t("internalTo", { name: r.counterpartName ?? "" });
    if (r.type === "internal_in") return t("internalFrom", { name: r.counterpartName ?? "" });
    return r.partyName ?? r.description ?? "";
  };
  const isVoid = (r: LedgerRow) => r.status === "voided" || r.status === "cancelled";

  return (
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            <bdi>{account.name}</bdi>
            {account.archived && (
              <span className="ms-2 rounded bg-surface-muted px-2 py-0.5 align-middle text-xs font-normal">
                {t("archived")}
              </span>
            )}
          </h1>
          <p className="text-sm text-foreground-tertiary">
            <bdi>{account.bankName}</bdi> · <bdi>{account.accountNumber}</bdi>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Link
              href={{ pathname: "/transactions/new", query: { account: account.id } }}
              className="rounded-md bg-navy px-4 py-2 text-sm text-white"
            >
              {td("newMovement")}
            </Link>
          )}
          {canWrite && account.issuesCheques && (
            <Link
              href={{ pathname: "/cheques/new", query: { account: account.id } }}
              className="rounded-md border border-border px-4 py-2 text-sm"
            >
              {td("newCheque")}
            </Link>
          )}
          {/* A file download, not a page: a plain link, not the app's Link. */}
          <a href={exportHref} className="rounded-md border border-border px-4 py-2 text-sm">
            {t("exportCsv")}
          </a>
        </div>
      </header>

      <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-2 rounded-lg bg-surface-subtle p-4">
        <div>
          <dt className="text-xs text-foreground-tertiary">{td("bookBalance")}</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {formatEGP(account.bookBalanceMinor, locale)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-foreground-tertiary">{td("bankBalance")}</dt>
          <dd className="text-xl tabular-nums">{formatEGP(account.bankBalanceMinor, locale)}</dd>
        </div>
        {account.issuesCheques && (
          <div>
            <dt className="text-xs text-foreground-tertiary">{td("outstandingCheques")}</dt>
            <dd className="text-xl tabular-nums">
              {formatEGP(account.outstandingChequesMinor, locale)}
            </dd>
          </div>
        )}
      </dl>

      <LedgerFilterBar
        action={`/${locale}/accounts/${id}`}
        resetHref={`/accounts/${id}`}
        filters={filters}
      />
      {filtered && (
        <p className="mt-3 text-sm text-foreground-secondary">{t("filteredCount", { count: rows.length })}</p>
      )}

      {/* Wide table: scrolls sideways inside its box on phones, never the whole page. */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-foreground-secondary">
            <tr>
              <th className="px-3 py-2 text-start font-medium">{t("date")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("type")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("details")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("reference")}</th>
              <th className="px-3 py-2 text-end font-medium">{t("amount")}</th>
              <th className="px-3 py-2 text-end font-medium">{t("balance")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {day(r.transactionDate)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {t(`types.${r.type as TransactionType}`)}
                  {isVoid(r) && (
                    <span className="ms-2 rounded bg-debit-tint px-1.5 py-0.5 text-xs text-debit">
                      {t("voided")}
                    </span>
                  )}
                  {r.status === "issued" && (
                    <span className="ms-2 rounded bg-warning-tint px-1.5 py-0.5 text-xs text-warning">
                      {t("chequeOutstanding")}
                    </span>
                  )}
                  {r.status === "cleared" && r.clearedDate && (
                    <span className="ms-2 rounded bg-credit-tint px-1.5 py-0.5 text-xs text-credit">
                      {t("chequeClearedOn", { date: day(r.clearedDate) })}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={isVoid(r) ? "text-foreground-tertiary line-through" : ""}>
                    <bdi>{details(r)}</bdi>
                  </span>
                  {isVoid(r) && r.statusReason && (
                    <p className="text-xs text-foreground-tertiary">
                      {t("voidedBecause", { reason: r.statusReason })}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 text-foreground-secondary">
                  <bdi>{r.reference ?? r.chequeNumber ?? ""}</bdi>
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-2 text-end tabular-nums ${
                    isVoid(r)
                      ? "text-foreground-tertiary line-through"
                      : r.signedAmountMinor < 0
                        ? "text-debit"
                        : "text-credit"
                  }`}
                >
                  {formatEGP(r.signedAmountMinor, locale)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                  {formatEGP(r.runningBalanceMinor, locale)}
                </td>
                <td className="px-3 py-2">
                  {canWrite && r.status === "active" && (
                    <InlineAction
                      action={voidMovement}
                      transactionId={r.id}
                      label={t("void")}
                      confirmLabel={t("confirmVoid")}
                      keepLabel={t("keep")}
                      input={{ name: "reason", type: "text", label: t("voidReason") }}
                      note={
                        r.type === "internal_in" || r.type === "internal_out"
                          ? t("voidPairNote")
                          : undefined
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
            {/* The opening balance belongs to the full history, not to a filtered view. */}
            {!filtered && (
              <tr className="border-t border-border bg-surface-subtle">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {day(account.openingDate)}
                </td>
                <td className="px-3 py-2" colSpan={4}>
                  {t("openingBalance")}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-end font-medium tabular-nums">
                  {formatEGP(account.openingBalanceMinor, locale)}
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="mt-4 text-foreground-secondary">{filtered ? t("noMatches") : t("empty")}</p>
      )}
    </div>
  );
}
