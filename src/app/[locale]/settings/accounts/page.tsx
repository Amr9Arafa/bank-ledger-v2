import { getTranslations, setRequestLocale } from "next-intl/server";
import { archiveAccountAction, unarchiveAccountAction } from "@/actions/admin";
import InlineAction from "@/components/InlineAction";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";
import { getUserWithRole } from "@/server/auth/session";
import { getAccountBalances } from "@/server/ledger/balances";

export default async function BankAccountsSettingsPage({
  params,
}: PageProps<"/[locale]/settings/accounts">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("accounts");
  const tl = await getTranslations("ledger");
  const td = await getTranslations("dashboard");

  const admin = await getUserWithRole("admin");
  const accounts = await getAccountBalances(admin.organizationId, undefined, {
    includeArchived: true,
  });

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link
          href="/settings/accounts/new"
          className="rounded-md bg-navy px-4 py-2 text-sm text-white"
        >
          {t("add")}
        </Link>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-foreground-secondary">
            <tr>
              <th className="px-3 py-2 text-start font-medium">{t("name")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("bankName")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("usedFor")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("openingDate")}</th>
              <th className="px-3 py-2 text-end font-medium">{t("openingBalance")}</th>
              <th className="px-3 py-2 text-end font-medium">{td("bookBalance")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{tl("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr
                key={a.id}
                className={`border-t border-border align-top ${a.archived ? "text-foreground-tertiary" : ""}`}
              >
                <td className="px-3 py-2">
                  <Link href={`/accounts/${a.id}`} className="font-medium hover:underline">
                    <bdi>{a.name}</bdi>
                  </Link>
                  {a.archived && (
                    <span className="ms-2 rounded bg-surface-muted px-1.5 py-0.5 text-xs">
                      {tl("archived")}
                    </span>
                  )}
                  <p className="text-xs text-foreground-tertiary" dir="ltr">
                    {a.accountNumber}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <bdi>{a.bankName}</bdi>
                </td>
                <td className="px-3 py-2">
                  {[a.receivesTransfers && t("receivesTransfers"), a.issuesCheques && t("issuesCheques")]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {formatDay(a.openingDate, locale)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                  {formatEGP(a.openingBalanceMinor, locale)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                  {formatEGP(a.bookBalanceMinor, locale)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-3">
                    <Link href={`/settings/accounts/${a.id}`} className="text-sm hover:underline">
                      {t("edit")}
                    </Link>
                    <InlineAction
                      action={a.archived ? unarchiveAccountAction : archiveAccountAction}
                      transactionId={a.id}
                      label={a.archived ? t("unarchive") : t("archive")}
                      confirmLabel={a.archived ? t("confirmUnarchive") : t("confirmArchive")}
                      keepLabel={tl("keep")}
                      note={a.archived ? undefined : t("archiveNote")}
                      tone={a.archived ? "normal" : "danger"}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
