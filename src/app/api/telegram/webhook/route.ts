// Telegram webhook: Telegram POSTs every message sent to the bot here.
// Outside the locale/login proxy (/api is excluded): the secret header is the only check.
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { parseUpdate } from "@/lib/telegram";
import { handleTelegramMessage } from "@/server/telegram/handle";

// after() gets the route's whole duration. Worst case for a photo: 3 model attempts of
// 60 s plus Telegram and Storage calls, about 200 s. 300 s is the Hobby plan maximum.
export const maxDuration = 300;

// Set with setWebhook (scripts/telegram-webhook.ts); Telegram sends it with every update.
function hasValidSecret(request: Request, secret: string) {
  const sent = Buffer.from(request.headers.get("x-telegram-bot-api-secret-token") ?? "");
  const expected = Buffer.from(secret);
  // Constant time, so the response time does not reveal how much of a guess was right.
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set");
    return new Response(null, { status: 500 });
  }
  if (!hasValidSecret(request, secret)) return new Response(null, { status: 401 });

  const message = parseUpdate(await request.json().catch(() => null));
  if (message) {
    // Answer Telegram now; reading a photo can take longer than Telegram waits, and a
    // timeout would make it deliver the message again. Errors are replied to the user.
    const origin = new URL(request.url).origin;
    after(() =>
      handleTelegramMessage(message, origin).catch((error) =>
        console.error("Telegram webhook: unexpected error:", error),
      ),
    );
  }
  // Always 200 for a genuine update, handled or not, so Telegram does not retry it.
  return new Response(null, { status: 200 });
}
