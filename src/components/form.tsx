"use client";

// Shared pieces for forms whose server action returns { errors: { field: errorKey } }.
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type messages from "../../messages/en.json";

export type ErrorKey = keyof (typeof messages)["errors"];

// The class strings live in a plain module so server pages can use them too.
export { inputClass, primaryButton, secondaryButton } from "./styles";

export function useFieldHelpers(errors: Record<string, string>) {
  const te = useTranslations("errors");

  // Label, input and the translated error for one field.
  const field = (name: string, label: string, input: ReactNode) => (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {errors[name] && (
        <p id={`${name}-error`} className="mt-1 text-sm text-debit">
          {te(errors[name] as ErrorKey)}
        </p>
      )}
    </div>
  );

  // id, name and the accessibility attributes that link an input to its error.
  const a11y = (name: string) => ({
    id: name,
    name,
    "aria-invalid": Boolean(errors[name]),
    "aria-describedby": errors[name] ? `${name}-error` : undefined,
  });

  const errorText = (key: string | undefined) => (key ? te(key as ErrorKey) : null);

  return { field, a11y, errorText };
}
