import { getTranslations, setRequestLocale } from "next-intl/server";
import ChequeForm from "@/components/ChequeForm";
import type { Locale } from "@/i18n/routing";
import { todayInCairo } from "@/lib/dates";
import { getUserWithRole } from "@/server/auth/session";
import { getActiveAccounts } from "@/server/ledger/accounts";
import { suggestChequeNumbers } from "@/server/ledger/cheques";

export default async function NewChequePage({
  params,
  searchParams,
}: PageProps<"/[locale]/cheques/new">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("cheque");

  const user = await getUserWithRole("accountant");
  // FR-5: only accounts that issue cheques.
  const accounts = (await getActiveAccounts(user.organizationId)).filter((a) => a.issuesCheques);
  const suggestions = await suggestChequeNumbers(user.organizationId);
  const requested = (await searchParams).account;
  const accountId = accounts.find((a) => a.id === requested)?.id;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <div className="mt-6">
        {accounts.length === 0 ? (
          <p className="text-foreground/70">{t("noChequeAccounts")}</p>
        ) : (
          <ChequeForm
            accounts={accounts}
            suggestions={suggestions}
            accountId={accountId}
            today={todayInCairo()}
          />
        )}
      </div>
    </div>
  );
}
