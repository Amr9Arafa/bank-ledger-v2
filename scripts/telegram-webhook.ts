// Points the Telegram bot at our webhook, or shows / removes the current one.
// Run: npm run telegram:webhook -- set https://<production-domain> [--drop-pending]
//      npm run telegram:webhook -- info
//      npm run telegram:webhook -- delete
// Uses TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local; prints neither.
// While a webhook is set, getUpdates does not work; "delete" switches back to it.
// A static import is fine: api.ts reads the token when a call is made, not on import.
import { callTelegram } from "../src/server/telegram/api.ts";

process.loadEnvFile(".env.local");

const [command, ...rest] = process.argv.slice(2);
const dropPending = rest.includes("--drop-pending");
const base = rest.find((a) => !a.startsWith("--"));

type WebhookInfo = {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
  ip_address?: string;
};

async function info() {
  const webhook = await callTelegram<WebhookInfo>("getWebhookInfo");
  console.log(`URL:             ${webhook.url || "(none: the bot uses getUpdates)"}`);
  console.log(`Pending updates: ${webhook.pending_update_count}`);
  console.log(`Allowed updates: ${webhook.allowed_updates?.join(", ") ?? "(all)"}`);
  if (webhook.ip_address) console.log(`Resolved IP:     ${webhook.ip_address}`);
  if (webhook.last_error_date) {
    const when = new Date(webhook.last_error_date * 1000).toISOString();
    console.log(`Last error:      ${when}  ${webhook.last_error_message}`);
  } else {
    console.log("Last error:      none");
  }
}

if (command === "set") {
  if (!base?.startsWith("https://")) {
    console.error("Give the production URL, starting with https:// (Telegram requires HTTPS).");
    process.exit(1);
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  // Telegram's rule for secret_token; anything else makes setWebhook fail.
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    console.error("TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ and -.");
    process.exit(1);
  }
  const url = `${base.replace(/\/+$/, "")}/api/telegram/webhook`;
  await callTelegram("setWebhook", {
    url,
    secret_token: secret,
    // Edited messages, reactions etc. are not entries.
    allowed_updates: ["message"],
    // Only when asked: dropping also loses real messages sent while no webhook was set.
    drop_pending_updates: dropPending,
  });
  console.log(`Webhook set: ${url}\n`);
  await info();
} else if (command === "info") {
  await info();
} else if (command === "delete") {
  await callTelegram("deleteWebhook", { drop_pending_updates: dropPending });
  console.log("Webhook removed: the bot is back on getUpdates.");
} else {
  console.log("Usage: npm run telegram:webhook -- set <https://domain> [--drop-pending] | info | delete");
  process.exit(1);
}
