import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatEGP } from "@/lib/money";
import { getUserWithRole } from "@/server/auth/session";
import { listAudit } from "@/server/ledger/audit";

type RowType = "transfer_in" | "deposit" | "fee" | "internal_in" | "internal_out" | "cheque";
type Action = "create" | "void" | "clear" | "cancel" | "unclear" | "update" | "archive" | "unarchive";

export default async function AuditPage({ params }: PageProps<"/[locale]/settings/audit">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const tl = await getTranslations("ledger");

  const admin = await getUserWithRole("admin");
  const rows = await listAudit(admin.organizationId);

  // Date and time of each change, in Cairo.
  const when = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold">{t("auditLog")}</h1>
      <p className="mt-1 text-sm text-foreground-tertiary">{t("auditNote", { count: rows.length })}</p>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-foreground-secondary">
            <tr>
              <th className="px-3 py-2 text-start font-medium">{t("when")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("who")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("action")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("what")}</th>
              <th className="px-3 py-2 text-end font-medium">{tl("amount")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {when.format(new Date(r.createdAt))}
                </td>
                <td className="px-3 py-2">
                  <bdi>{r.userName}</bdi>
                </td>
                <td className="whitespace-nowrap px-3 py-2">{t(`actions.${r.action as Action}`)}</td>
                <td className="px-3 py-2">
                  {r.transactionType ? (
                    <>
                      {tl(`types.${r.transactionType as RowType}`)}
                      {r.chequeNumber && <> #<bdi>{r.chequeNumber}</bdi></>}
                      {r.partyName && <> · <bdi>{r.partyName}</bdi></>}
                    </>
                  ) : (
                    t("accountChange")
                  )}
                  {r.accountId && (
                    <>
                      {" · "}
                      <Link href={`/accounts/${r.accountId}`} className="hover:underline">
                        <bdi>{r.accountName}</bdi>
                      </Link>
                    </>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                  {r.amountMinor === null ? "" : formatEGP(r.amountMinor, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
