// Telegram Bot API calls (plain fetch). The bot token is part of every URL, so URLs are
// never logged and errors carry only the method name and Telegram's description.
// https://core.telegram.org/bots/api
const API = "https://api.telegram.org";
// Per call. The webhook route has 300 s in total, most of it reserved for the model.
const TIMEOUT_MS = 15_000;

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return value;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API}/${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // Rethrown without the URL (and so without the token).
    throw new Error(`Telegram request failed: ${(error as Error).name}`);
  }
}

// Calls a Bot API method and returns its result, or throws with Telegram's description.
export async function callTelegram<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await request(`bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? response.status}`);
  return data.result as T;
}

// As a reply to the user's message, which stays readable if that message was deleted.
export async function sendMessage(chatId: number, text: string, replyTo?: number) {
  await callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(replyTo && {
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    }),
  });
}

// getFile gives a temporary path; the file itself is then downloaded with the token.
export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const file = await callTelegram<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram getFile: no file_path");
  const response = await request(`file/bot${token()}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
