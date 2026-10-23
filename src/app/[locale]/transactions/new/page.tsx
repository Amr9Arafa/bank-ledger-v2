import { getTranslations, setRequestLocale } from "next-intl/server";
import MovementForm from "@/components/MovementForm";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { todayInCairo } from "@/lib/dates";
import { FORM_TYPES, type FormType } from "@/lib/validation";
import { getUserWithRole } from "@/server/auth/session";
import { getActiveAccounts } from "@/server/ledger/accounts";

export default async function NewMovementPage({
  params,
  searchParams,
}: PageProps<"/[locale]/transactions/new">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("movement");

  // ?type=fee selects the tab; anything else falls back to an incoming transfer.
  const { type: requested, account: requestedAccount } = await searchParams;
  const type: FormType = FORM_TYPES.find((f) => f === requested) ?? "transfer_in";

  const user = await getUserWithRole("accountant");
  const accounts = await getActiveAccounts(user.organizationId);
  // ?account=<id> from an account's ledger page pre-selects that account.
  const accountId = accounts.find((a) => a.id === requestedAccount)?.id;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("typeLabel")}>
        {FORM_TYPES.map((f) => (
          <Link
            key={f}
            href={{
              pathname: "/transactions/new",
              query: accountId ? { type: f, account: accountId } : { type: f },
            }}
            aria-current={f === type ? "page" : undefined}
            className="rounded-full border border-border px-3 py-1.5 text-sm aria-[current=page]:bg-navy aria-[current=page]:text-white"
          >
            {t(`types.${f}`)}
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        {/* key: switching tabs starts a fresh form instead of keeping the old one's state. */}
        <MovementForm
          key={type}
          type={type}
          accounts={accounts}
          accountId={accountId}
          today={todayInCairo()}
        />
      </div>
    </div>
  );
}
