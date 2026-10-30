import { getTranslations, setRequestLocale } from "next-intl/server";
import { changeRoleAction } from "@/actions/admin";
import NewUserForm from "@/components/NewUserForm";
import TelegramIdForm from "@/components/TelegramIdForm";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { getUserWithRole } from "@/server/auth/session";
import { listUsers } from "@/server/users";

export default async function SettingsPage({ params }: PageProps<"/[locale]/settings">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const tn = await getTranslations("nav");

  const admin = await getUserWithRole("admin");
  const people = await listUsers(admin.organizationId);

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tn("settings")}</h1>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link href="/settings/accounts" className="rounded-md border border-border px-3 py-1.5">
            {t("bankAccounts")}
          </Link>
          <Link href="/settings/audit" className="rounded-md border border-border px-3 py-1.5">
            {t("auditLog")}
          </Link>
        </nav>
      </div>

      <section>
        <h2 className="text-lg font-semibold">{t("users")}</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-foreground-secondary">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("name")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("email")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("role")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("telegramId")}</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <bdi>{p.name}</bdi>
                  </td>
                  <td className="px-3 py-2" dir="ltr">
                    {p.email}
                  </td>
                  <td className="px-3 py-2">
                    {p.id === admin.id ? (
                      // Admins cannot change their own role: the company always keeps an admin.
                      <span>{tn(`roles.${p.role}`)}</span>
                    ) : (
                      <form action={changeRoleAction} className="flex gap-2">
                        <input type="hidden" name="userId" value={p.id} />
                        <select
                          name="role"
                          defaultValue={p.role}
                          aria-label={t("role")}
                          className="rounded-md border border-border bg-background px-2 py-1"
                        >
                          {(["admin", "accountant", "viewer"] as const).map((r) => (
                            <option key={r} value={r}>
                              {tn(`roles.${r}`)}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="rounded-md border border-border px-2 py-1">
                          {t("saveRole")}
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <TelegramIdForm userId={p.id} telegramUserId={p.telegramUserId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">{t("addUser")}</h2>
        <div className="mt-3 max-w-2xl">
          <NewUserForm />
        </div>
      </section>
    </div>
  );
}
