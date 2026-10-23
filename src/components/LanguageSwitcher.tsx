"use client";

import { useLocale, useTranslations } from "next-intl";
import { saveLanguage } from "@/actions/auth";
import { Link, usePathname } from "@/i18n/navigation";

// Links to the same page in the other language, and remembers the choice for the
// signed-in user's next sign-in (FR-15).
export default function LanguageSwitcher() {
  const t = useTranslations("language");
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === "ar" ? "en" : "ar";

  return (
    <Link
      href={pathname}
      locale={other}
      lang={other}
      aria-label={t("label")}
      onClick={() => void saveLanguage(other)}
      className="rounded-md border border-foreground/15 px-3 py-1.5 text-sm hover:bg-foreground/5"
    >
      {t("switchTo")}
    </Link>
  );
}
