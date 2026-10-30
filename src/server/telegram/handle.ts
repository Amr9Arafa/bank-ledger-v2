// One Telegram message -> one AI Inbox entry, through the same extraction service as the
// web form. Runs after the webhook has answered Telegram, so every outcome, including
// errors, is reported to the user by a reply and never by the HTTP response.
import { createTranslator } from "next-intl";
import ar from "../../../messages/ar.json" with { type: "json" };
import en from "../../../messages/en.json" with { type: "json" };
import type { Extraction, ExtractionWarning } from "../../lib/extraction.ts";
import {
  buildSavedReply,
  externalMessageId,
  type TelegramMessage,
  type Translate,
} from "../../lib/telegram.ts";
import { ExtractionError, extractToPendingEntry } from "../ai/extract.ts";
import { hasRole } from "../auth/roles.ts";
import { isUniqueViolation } from "../db/client.ts";
import { getBankAccount } from "../ledger/bankAccounts.ts";
import { pendingEntryExists } from "../ledger/pendingEntries.ts";
import { getUserByTelegramId } from "../users.ts";
import { downloadFile, sendMessage } from "./api.ts";

// Keys are built at run time (warning and error codes), so next-intl's typed keys do not
// apply: a missing key shows the key itself rather than failing.
function translator(locale: "ar" | "en") {
  return createTranslator({ locale, messages: locale === "ar" ? ar : en }) as unknown as Translate;
}

export async function handleTelegramMessage(message: TelegramMessage, appOrigin: string) {
  // Unlinked accounts get no reply: the bot does not reveal itself to strangers.
  const user = await getUserByTelegramId(message.fromId);
  if (!user) {
    console.warn(
      `Telegram: message from unlinked Telegram user ${message.fromId}` +
        `${message.username ? ` (@${message.username})` : ""}. Link it in Settings to allow it.`,
    );
    return;
  }

  const t = translator(user.language);
  const reply = (text: string) =>
    sendMessage(message.chatId, text, message.messageId).catch((error) =>
      console.error("Telegram: could not send a reply:", error),
    );

  // Same permission as the web inbox form.
  if (!hasRole(user, "accountant")) return reply(t("telegram.notAllowed"));
  if (message.isStart) return reply(t("telegram.help"));
  if (message.problem === "imageTooLarge") return reply(t("inbox.errors.imageTooLarge"));
  if (message.problem) return reply(t("telegram.unsupported"));

  const externalId = externalMessageId(message);
  // A delivery we already handled: stay silent rather than answer twice.
  if (await pendingEntryExists(user.organizationId, externalId)) return;

  let image: { bytes: Uint8Array; mediaType: string } | undefined;
  if (message.file) {
    try {
      image = { bytes: await downloadFile(message.file.fileId), mediaType: message.file.mediaType };
    } catch (error) {
      console.error("Telegram: could not download a photo:", error);
      return reply(t("telegram.downloadFailed"));
    }
  }

  try {
    const entry = await extractToPendingEntry(user, {
      text: message.text,
      image,
      source: "telegram",
      externalMessageId: externalId,
    });
    const extracted = entry.extracted as Extraction;
    const account = extracted.account_id ? await getBankAccount(user, extracted.account_id) : null;
    return reply(
      buildSavedReply(t, user.language, {
        extracted,
        warnings: entry.warnings as ExtractionWarning[],
        accountName: account?.name ?? null,
        inboxUrl: `${appOrigin}/${user.language}/inbox`,
      }),
    );
  } catch (error) {
    // Two deliveries of one message raced and the other saved it first.
    if (isUniqueViolation(error)) return;
    if (error instanceof ExtractionError) return reply(t(`inbox.errors.${error.code}`));
    console.error("Telegram: could not handle a message:", error);
    return reply(t("telegram.failed"));
  }
}
