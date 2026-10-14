import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/i18n/routing";

export default async function DashboardPage({
  params,
}: PageProps<"/[locale]">) {
  // The layout already rejected unknown locales with notFound().
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold text-start">{t("title")}</h1>
      <p className="mt-4 text-foreground/70">{t("empty")}</p>
    </div>
  );
}
