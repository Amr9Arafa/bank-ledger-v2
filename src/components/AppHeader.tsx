import { getTranslations } from "next-intl/server";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { Link } from "@/i18n/navigation";

export default async function AppHeader() {
  const t = await getTranslations("nav");
  const tm = await getTranslations("metadata");

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-foreground/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Link href="/" className="font-semibold">
          {tm("title")}
        </Link>
        <nav className="flex gap-4 text-sm">
          <Link href="/" className="hover:underline">
            {t("home")}
          </Link>
          <Link href="/cheques" className="hover:underline">
            {t("cheques")}
          </Link>
        </nav>
      </div>
      <LanguageSwitcher />
    </header>
  );
}
