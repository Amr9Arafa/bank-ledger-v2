"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signIn, type SignInState } from "@/actions/auth";
import { inputClass, primaryButton, useFieldHelpers } from "@/components/form";

export default function LoginForm() {
  const t = useTranslations("login");
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signIn, {
    errors: {},
    values: {},
  });
  const { field, a11y, errorText } = useFieldHelpers(state.errors);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {field(
        "email",
        t("email"),
        <input
          type="email"
          autoComplete="username"
          dir="ltr"
          {...a11y("email")}
          defaultValue={state.values.email ?? ""}
          required
          className={inputClass}
        />,
      )}
      {field(
        "password",
        t("password"),
        <input
          type="password"
          autoComplete="current-password"
          dir="ltr"
          {...a11y("password")}
          required
          className={inputClass}
        />,
      )}
      <div aria-live="polite">
        {state.formError && (
          <p className="rounded-md bg-debit-tint p-3 text-sm text-debit">
            {errorText(state.formError)}
          </p>
        )}
      </div>
      <button type="submit" disabled={pending} className={`${primaryButton} w-full`}>
        {pending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
