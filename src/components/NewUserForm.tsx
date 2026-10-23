"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createUserAction, type NewUserState } from "@/actions/admin";
import { inputClass, primaryButton, useFieldHelpers } from "@/components/form";

export default function NewUserForm() {
  const t = useTranslations("settings");
  const tn = useTranslations("nav");
  const [state, formAction, pending] = useActionState<NewUserState, FormData>(createUserAction, {
    errors: {},
    values: {},
  });
  const { field, a11y, errorText } = useFieldHelpers(state.errors);
  const v = state.values;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "name",
          t("name"),
          <input type="text" {...a11y("name")} defaultValue={v.name ?? ""} required className={inputClass} />,
        )}
        {field(
          "email",
          t("email"),
          <input
            type="email"
            dir="ltr"
            autoComplete="off"
            {...a11y("email")}
            defaultValue={v.email ?? ""}
            required
            className={inputClass}
          />,
        )}
        {field(
          "role",
          t("role"),
          <select {...a11y("role")} defaultValue={v.role ?? "accountant"} className={inputClass}>
            {(["accountant", "viewer", "admin"] as const).map((r) => (
              <option key={r} value={r}>
                {tn(`roles.${r}`)}
              </option>
            ))}
          </select>,
        )}
        {field(
          "password",
          t("firstPassword"),
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            {...a11y("password")}
            required
            className={inputClass}
          />,
        )}
      </div>
      <p className="text-sm text-foreground/60">{t("firstPasswordNote")}</p>
      <div aria-live="polite">
        {state.formError && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{errorText(state.formError)}</p>
        )}
        {state.saved && !pending && (
          <p className="rounded-md bg-green-50 p-3 text-sm text-green-800">{t("userCreated")}</p>
        )}
      </div>
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? t("creating") : t("createUser")}
      </button>
    </form>
  );
}
