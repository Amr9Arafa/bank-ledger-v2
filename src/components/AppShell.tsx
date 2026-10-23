import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { signOut } from "@/actions/auth";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import MobileMenu from "@/components/MobileMenu";
import NavLinks from "@/components/NavLinks";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatAmount } from "@/lib/money";
import { hasRole } from "@/server/auth/roles";
import { getSessionUser } from "@/server/auth/session";
import { getAccountBalancesForRequest } from "@/server/ledger/cached";

// The app frame. Signed in: a start-side sidebar on large screens, a top bar with a menu
// button below that. Signed out (login page): just the title and the language switch.
export default async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations("nav");
  const tm = await getTranslations("metadata");
  const locale = (await getLocale()) as Locale;
  const user = await getSessionUser();

  const wordmark = (
    <Link href="/" className="text-base font-semibold tracking-tight text-foreground">
      {tm("title")}
    </Link>
  );

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-6">
          {wordmark}
          <LanguageSwitcher />
        </header>
        <main className="flex-1 px-4 py-10 sm:px-6">{children}</main>
      </div>
    );
  }

  const accounts = await getAccountBalancesForRequest(user.organizationId);
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

  const sidebar = (
    <div className="flex h-full flex-col justify-between gap-8">
      <div className="space-y-8 px-3 pt-5">
        <nav aria-label={t("main")}>
          <NavLinks
            items={[
              { href: "/", label: t("home") },
              { href: "/cheques", label: t("cheques") },
              ...(hasRole(user, "admin") ? [{ href: "/settings", label: t("settings") }] : []),
            ]}
          />
        </nav>
        {accounts.length > 0 && (
          <nav aria-labelledby="sidebar-accounts">
            <h2 id="sidebar-accounts" className="mb-2 px-3 text-xs font-medium text-foreground-tertiary">
              {t("accounts")}
            </h2>
            <NavLinks
              size="compact"
              items={accounts.map((a) => ({
                href: `/accounts/${a.id}`,
                label: a.name,
                hint: formatAmount(a.bookBalanceMinor, locale),
              }))}
            />
          </nav>
        )}
      </div>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-navy-tint text-xs font-semibold text-navy"
          >
            {initials}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              <bdi>{user.name}</bdi>
            </p>
            <p className="text-xs text-foreground-tertiary">{t(`roles.${user.role}`)}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <LanguageSwitcher />
          <form action={signOut}>
            <input type="hidden" name="locale" value={locale} />
            <button
              type="submit"
              className="text-xs text-foreground-secondary transition-colors hover:text-foreground"
            >
              {t("signOut")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e border-border bg-surface-subtle lg:flex">
        <div className="px-6 pt-5">{wordmark}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">{sidebar}</div>
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-border bg-surface-subtle px-4 sm:px-6 lg:hidden">
        {wordmark}
        <MobileMenu openLabel={t("menu")} closeLabel={t("closeMenu")}>
          {sidebar}
        </MobileMenu>
      </header>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
