"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { setTelegramIdAction, type TelegramLinkState } from "@/actions/admin";
import { useFieldHelpers } from "@/components/form";

// One user's Telegram id on the settings page. Empty and save unlinks.
export default function TelegramIdForm({
  userId,
  telegramUserId,
}: {
  userId: string;
  telegramUserId: string | null;
}) {
  const t = useTranslations("settings");
  const initial: TelegramLinkState = { value: telegramUserId ?? "" };
  const [state, formAction, pending] = useActionState(setTelegramIdAction, initial);
  const { errorText } = useFieldHelpers({});

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="userId" value={userId} />
      <div className="flex gap-2">
        <input
          // A new key after each save, so the input reloads the saved value.
          key={state.value}
          name="telegramUserId"
          defaultValue={state.value}
          inputMode="numeric"
          dir="ltr"
          aria-label={t("telegramId")}
          aria-invalid={Boolean(state.error)}
          placeholder={t("telegramIdPlaceholder")}
          className="w-36 rounded-md border border-border bg-background px-2 py-1"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
        >
          {t("saveRole")}
        </button>
      </div>
      {state.error && <p className="text-sm text-debit">{errorText(state.error)}</p>}
      {state.saved && <p className="text-sm text-credit">{t("telegramSaved")}</p>}
    </form>
  );
}
