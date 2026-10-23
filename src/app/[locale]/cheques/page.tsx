import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  cancelChequeAction,
  clearChequeAction,
  unclearChequeAction,
} from "@/actions/cheques";
import InlineAction from "@/components/InlineAction";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { addDays, DUE_SOON_DAYS } from "@/lib/cheques";
import { formatDay, todayInCairo } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getCurrentUser } from "@/server/auth/session";
import { listCheques, type ChequeStatus } from "@/server/ledger/cheques";

const TABS: ChequeStatus[] = ["issued", "cleared", "cancelled"];

export default async function ChequesPage({ params, searchParams }: PageProps<"/[locale]/cheques">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("cheque");
  const tl = await getTranslations("ledger");

  const requested = (await searchParams).tab;
  const tab = TABS.find((s) => s === requested) ?? "issued";

  const user = await getCurrentUser();
  const cheques = await listCheques(user.organizationId, tab);
  const canWrite = hasRole(user, "accountant");
  const isAdmin = hasRole(user, "admin");

  const today = todayInCairo();
  const soon = addDays(today, DUE_SOON_DAYS);
  const total = cheques.reduce((sum, c) => sum + c.amountMinor, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {canWrite && (
          <Link
            href="/cheques/new"
            className="rounded-md bg-navy px-4 py-2 text-sm text-white"
          >
            {t("newTitle")}
          </Link>
        )}
      </div>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("title")}>
        {TABS.map((s) => (
          <Link
            key={s}
            href={{ pathname: "/cheques", query: { tab: s } }}
            aria-current={s === tab ? "page" : undefined}
            className="rounded-full border border-border px-3 py-1.5 text-sm aria-[current=page]:bg-navy aria-[current=page]:text-white"
          >
            {t(`tabs.${s}`)}
          </Link>
        ))}
      </nav>

      <p className="mt-4 text-sm text-foreground-secondary">
        {t("count", { count: cheques.length })} · {t("total")}{" "}
        <span className="font-semibold tabular-nums text-foreground">
          {formatEGP(total, locale)}
        </span>
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-foreground-secondary">
            <tr>
              <th className="px-3 py-2 text-start font-medium">
                {tab === "cleared" ? t("clearedDate") : t("dueDate")}
              </th>
              <th className="px-3 py-2 text-start font-medium">{t("number")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("payee")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("account")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("issueDate")}</th>
              <th className="px-3 py-2 text-end font-medium">{tl("amount")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{tl("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cheques.map((c) => {
              // FR-8: highlight overdue and due in the next 7 days.
              const overdue = tab === "issued" && c.dueDate < today;
              const dueSoon = tab === "issued" && !overdue && c.dueDate <= soon;
              return (
                <tr
                  key={c.id}
                  className={`border-t border-border align-top ${
                    overdue ? "bg-debit-tint" : dueSoon ? "bg-warning-tint" : ""
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {formatDay(
                      tab === "cleared" && c.clearedDate ? c.clearedDate : c.dueDate,
                      locale,
                    )}
                    {overdue && (
                      <span className="ms-2 rounded bg-debit-tint px-1.5 py-0.5 text-xs text-debit">
                        {t("overdue")}
                      </span>
                    )}
                    {dueSoon && (
                      <span className="ms-2 rounded bg-warning-tint px-1.5 py-0.5 text-xs text-warning">
                        {t("dueSoon")}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    <bdi>{c.chequeNumber}</bdi>
                  </td>
                  <td className="px-3 py-2">
                    <bdi>{c.partyName}</bdi>
                    {tab === "cancelled" && c.statusReason && (
                      <p className="text-xs text-foreground-tertiary">
                        {tl("voidedBecause", { reason: c.statusReason })}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/accounts/${c.accountId}`} className="hover:underline">
                      <bdi>{c.accountName}</bdi>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {formatDay(c.transactionDate, locale)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                    {formatEGP(c.amountMinor, locale)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-3">
                      {tab === "issued" && canWrite && (
                        <>
                          <InlineAction
                            action={clearChequeAction}
                            transactionId={c.id}
                            label={t("markCleared")}
                            confirmLabel={t("confirmClear")}
                            keepLabel={tl("keep")}
                            input={{
                              name: "clearedDate",
                              type: "date",
                              label: t("clearedDate"),
                              defaultValue: today,
                            }}
                            tone="normal"
                          />
                          <InlineAction
                            action={cancelChequeAction}
                            transactionId={c.id}
                            label={t("cancel")}
                            confirmLabel={t("confirmCancel")}
                            keepLabel={tl("keep")}
                            input={{ name: "reason", type: "text", label: t("cancelReason") }}
                          />
                        </>
                      )}
                      {tab === "cleared" && isAdmin && (
                        <InlineAction
                          action={unclearChequeAction}
                          transactionId={c.id}
                          label={t("undoClear")}
                          confirmLabel={t("confirmUndoClear")}
                          keepLabel={tl("keep")}
                          note={t("undoClearNote")}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {cheques.length === 0 && <p className="mt-4 text-foreground-secondary">{t(`empty.${tab}`)}</p>}
    </div>
  );
}
