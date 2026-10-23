import { getLocale, getTranslations } from "next-intl/server";
import { signOut } from "@/actions/auth";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { Link } from "@/i18n/navigation";
import { hasRole } from "@/server/auth/roles";
import { getSessionUser } from "@/server/auth/session";

export default async function AppHeader() {
  const t = await getTranslations("nav");
  const tm = await getTranslations("metadata");
  const locale = await getLocale();
  // Null on the login page: show only the title and the language switch.
  const user = await getSessionUser();

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-foreground/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Link href="/" className="font-semibold">
          {tm("title")}
        </Link>
        {user && (
          <nav className="flex gap-4 text-sm">
            <Link href="/" className="hover:underline">
              {t("home")}
            </Link>
            <Link href="/cheques" className="hover:underline">
              {t("cheques")}
            </Link>
            {hasRole(user, "admin") && (
              <Link href="/settings" className="hover:underline">
                {t("settings")}
              </Link>
            )}
          </nav>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {user && (
          <span className="text-foreground/70">
            <bdi>{user.name}</bdi> · {t(`roles.${user.role}`)}
          </span>
        )}
        <LanguageSwitcher />
        {user && (
          <form action={signOut}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="hover:underline">
              {t("signOut")}
            </button>
          </form>
        )}
      </div>
    </header>
  );
}
