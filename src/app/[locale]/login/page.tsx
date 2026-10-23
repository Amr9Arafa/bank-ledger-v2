import { getTranslations, setRequestLocale } from "next-intl/server";
import { signOut } from "@/actions/auth";
import LoginForm from "@/components/LoginForm";
import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { getAuthUserId, getSessionUser } from "@/server/auth/session";

export default async function LoginPage({ params }: PageProps<"/[locale]/login">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("login");

  // Already signed in with a profile: nothing to do here.
  if (await getSessionUser()) return redirect({ href: "/", locale });
  // Signed in, but the login has no profile in this app.
  const noAccess = Boolean(await getAuthUserId());

  return (
    <div className="mx-auto mt-10 max-w-sm">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="mt-6">
        {noAccess ? (
          <form action={signOut} className="space-y-4">
            <input type="hidden" name="locale" value={locale} />
            <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{t("noAccess")}</p>
            <button type="submit" className="rounded-md border border-foreground/20 px-4 py-2">
              {t("signOut")}
            </button>
          </form>
        ) : (
          <LoginForm />
        )}
      </div>
    </div>
  );
}
