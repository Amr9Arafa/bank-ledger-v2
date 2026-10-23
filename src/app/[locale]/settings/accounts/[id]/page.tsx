import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import BankAccountForm from "@/components/BankAccountForm";
import type { Locale } from "@/i18n/routing";
import { minorToDecimal } from "@/lib/money";
import { getUserWithRole } from "@/server/auth/session";
import { getBankAccount } from "@/server/ledger/bankAccounts";

export default async function EditBankAccountPage({
  params,
}: PageProps<"/[locale]/settings/accounts/[id]">) {
  const { locale: rawLocale, id } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);
  if (!z.uuid().safeParse(id).success) notFound();
  const t = await getTranslations("accounts");

  const admin = await getUserWithRole("admin");
  const account = await getBankAccount(admin, id);
  if (!account) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">
        {t("editTitle")} <bdi>{account.name}</bdi>
      </h1>
      <div className="mt-6">
        <BankAccountForm
          accountId={account.id}
          initial={{
            name: account.name,
            bankName: account.bankName,
            accountNumber: account.accountNumber,
            openingBalanceMinor: minorToDecimal(account.openingBalanceMinor),
            openingDate: account.openingDate,
            receivesTransfers: account.receivesTransfers ? "on" : "",
            issuesCheques: account.issuesCheques ? "on" : "",
          }}
        />
      </div>
    </div>
  );
}
