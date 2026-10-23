import { getTranslations, setRequestLocale } from "next-intl/server";
import BankAccountForm from "@/components/BankAccountForm";
import type { Locale } from "@/i18n/routing";
import { todayInCairo } from "@/lib/dates";
import { getUserWithRole } from "@/server/auth/session";

export default async function NewBankAccountPage({
  params,
}: PageProps<"/[locale]/settings/accounts/new">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("accounts");
  await getUserWithRole("admin");

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{t("add")}</h1>
      <div className="mt-6">
        <BankAccountForm initial={{ openingDate: todayInCairo(), receivesTransfers: "on" }} />
      </div>
    </div>
  );
}
