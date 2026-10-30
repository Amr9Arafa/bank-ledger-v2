// Telegram bot: reading an incoming update and writing the reply. Pure functions only;
// the Bot API calls live in server/telegram.
import { z } from "zod";
import type { Extraction, ExtractionWarning } from "./extraction.ts";
import { MAX_IMAGE_BYTES } from "./image.ts";
import { formatEGP, toMinor } from "./money.ts";

// The parts of a Telegram update we use; everything else is ignored.
// https://core.telegram.org/bots/api#update
const updateSchema = z.object({
  message: z
    .object({
      message_id: z.number(),
      from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
      chat: z.object({ id: z.number(), type: z.string() }),
      text: z.string().optional(),
      caption: z.string().optional(),
      // The same photo in several sizes, smallest first.
      photo: z
        .array(z.object({ file_id: z.string(), file_size: z.number().optional() }))
        .optional(),
      // A file sent "as a file" (uncompressed), which may be an image.
      document: z
        .object({
          file_id: z.string(),
          mime_type: z.string().optional(),
          file_size: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type TelegramMessage = {
  // Telegram user id as text, the way users.telegram_user_id stores it.
  fromId: string;
  username: string | null;
  chatId: number;
  messageId: number;
  // The message text, or a photo's caption.
  text: string;
  file: { fileId: string; mediaType: string } | null;
  // Something we cannot read, to explain in the reply instead of calling the model.
  problem: "unsupported" | "imageTooLarge" | null;
  isStart: boolean;
};

// A private-chat message from a person, or null for anything we ignore (other update
// kinds, group chats, channel posts, malformed bodies).
export function parseUpdate(body: unknown): TelegramMessage | null {
  const parsed = updateSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message : undefined;
  if (!message?.from || message.chat.type !== "private") return null;

  const text = (message.text ?? message.caption ?? "").trim();
  let file: TelegramMessage["file"] = null;
  let problem: TelegramMessage["problem"] = null;

  if (message.photo?.length) {
    // The largest size that fits; Telegram photos are always JPEG.
    const fitting = message.photo.filter((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES);
    const best = fitting.at(-1);
    if (best) file = { fileId: best.file_id, mediaType: "image/jpeg" };
    else problem = "imageTooLarge";
  } else if (message.document?.mime_type?.startsWith("image/")) {
    // The extraction service decides which image types it reads.
    if ((message.document.file_size ?? 0) > MAX_IMAGE_BYTES) problem = "imageTooLarge";
    else file = { fileId: message.document.file_id, mediaType: message.document.mime_type };
  } else if (message.document || !text) {
    // Stickers, voice notes, PDFs...
    problem = "unsupported";
  }

  return {
    fromId: String(message.from.id),
    username: message.from.username ?? null,
    chatId: message.chat.id,
    messageId: message.message_id,
    text,
    file,
    problem,
    isStart: !file && /^\/start(@\w+)?$/.test(text),
  };
}

// Message ids are only unique within a chat.
export function externalMessageId(message: Pick<TelegramMessage, "chatId" | "messageId">) {
  return `${message.chatId}:${message.messageId}`;
}

// A message key (under the app's messages/*.json) -> text in the user's language.
export type Translate = (key: string, values?: Record<string, string>) => string;

// Plain text (no Markdown): names and amounts need no escaping.
export function buildSavedReply(
  t: Translate,
  locale: "ar" | "en",
  input: {
    extracted: Extraction;
    warnings: ExtractionWarning[];
    accountName: string | null;
    inboxUrl: string;
  },
): string {
  const { extracted: x, warnings } = input;
  const none = t("telegram.none");
  const amount = x.amount ? toMinor(x.amount) : null;

  const kind =
    x.kind === "cheque"
      ? t("ledger.types.cheque")
      : x.direction === "in"
        ? t("ledger.types.transfer_in")
        : x.direction === "out"
          ? t("ledger.types.transfer_out")
          : t("telegram.directionUnknown");

  const lines = [
    `✅ ${t("telegram.saved")}`,
    "",
    kind,
    `${t("telegram.amount")}: ${amount?.ok ? formatEGP(amount.minor, locale) : (x.amount ?? none)}`,
    `${t("telegram.account")}: ${input.accountName ?? x.account_text ?? none}`,
    `${t("telegram.counterparty")}: ${x.counterparty ?? none}`,
    `${t("telegram.date")}: ${x.date ?? none}`,
  ];
  if (x.kind === "cheque") lines.push(`${t("telegram.chequeNumber")}: ${x.cheque_number ?? none}`);

  if (warnings.length > 0) {
    lines.push("", `⚠️ ${t("telegram.check")}`);
    for (const w of warnings) lines.push(`• ${t(`inbox.warnings.${w.code}`, { value: w.value ?? "" })}`);
  }

  lines.push("", t("telegram.review", { url: input.inboxUrl }));
  return lines.join("\n");
}
