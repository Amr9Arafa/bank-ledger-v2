import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "next-intl";
import en from "../../messages/en.json" with { type: "json" };
import type { Extraction } from "./extraction.ts";
import { buildSavedReply, externalMessageId, parseUpdate, type Translate } from "./telegram.ts";

const message = (fields: Record<string, unknown>) => ({
  update_id: 1,
  message: {
    message_id: 42,
    from: { id: 6689039609, username: "amr" },
    chat: { id: 6689039609, type: "private" },
    ...fields,
  },
});

test("a text message is read with its sender, chat and message id", () => {
  const parsed = parseUpdate(message({ text: "  استلمنا 15 ألف  " }));
  assert.deepEqual(parsed, {
    fromId: "6689039609",
    username: "amr",
    chatId: 6689039609,
    messageId: 42,
    text: "استلمنا 15 ألف",
    file: null,
    problem: null,
    isStart: false,
  });
  assert.equal(externalMessageId(parsed!), "6689039609:42");
});

test("a photo: the largest size under the limit, with the caption as text", () => {
  const parsed = parseUpdate(
    message({
      caption: "شيك",
      photo: [
        { file_id: "small", file_size: 1_000 },
        { file_id: "big", file_size: 200_000 },
        { file_id: "huge", file_size: 9_000_000 },
      ],
    }),
  );
  assert.deepEqual(parsed?.file, { fileId: "big", mediaType: "image/jpeg" });
  assert.equal(parsed?.text, "شيك");
  assert.equal(parsed?.problem, null);
});

test("an image sent as a file keeps its type; a large one or a PDF is a problem", () => {
  const png = parseUpdate(message({ document: { file_id: "d", mime_type: "image/png", file_size: 5 } }));
  assert.deepEqual(png?.file, { fileId: "d", mediaType: "image/png" });

  const large = parseUpdate(
    message({ document: { file_id: "d", mime_type: "image/jpeg", file_size: 9_000_000 } }),
  );
  assert.equal(large?.problem, "imageTooLarge");

  const pdf = parseUpdate(message({ document: { file_id: "d", mime_type: "application/pdf" } }));
  assert.equal(pdf?.problem, "unsupported");
});

test("stickers and other messages without text or photo are unsupported", () => {
  assert.equal(parseUpdate(message({ sticker: { file_id: "s" } }))?.problem, "unsupported");
});

test("/start is recognised, also with the bot's name", () => {
  assert.equal(parseUpdate(message({ text: "/start" }))?.isStart, true);
  assert.equal(parseUpdate(message({ text: "/start@LedgerBot" }))?.isStart, true);
  assert.equal(parseUpdate(message({ text: "/start now" }))?.isStart, false);
});

test("group chats, edited messages and malformed bodies are ignored", () => {
  assert.equal(parseUpdate(message({ text: "x", chat: { id: -100, type: "group" } })), null);
  assert.equal(parseUpdate({ update_id: 1, edited_message: { text: "x" } }), null);
  assert.equal(parseUpdate(null), null);
  assert.equal(parseUpdate({ message: { text: "no ids" } }), null);
});

const t = createTranslator({ locale: "en", messages: en }) as unknown as Translate;

const extraction = (fields: Partial<Extraction>): Extraction => ({
  kind: "transaction",
  direction: "in",
  amount: "15000",
  account_id: null,
  account_text: null,
  counterparty: "Al Nour",
  date: "2026-10-29",
  notes: null,
  cheque_number: null,
  amount_in_words: null,
  amount_in_words_value: null,
  ...fields,
});

test("the reply summarises the entry, lists warnings and links to the inbox", () => {
  const reply = buildSavedReply(t, "en", {
    extracted: extraction({ account_text: "CIB" }),
    warnings: [{ code: "accountUnresolved", value: "CIB" }, { code: "counterpartyNew", value: "Al Nour" }],
    accountName: null,
    inboxUrl: "https://example.test/en/inbox",
  });
  assert.match(reply, /Added to the AI Inbox/);
  assert.match(reply, /Incoming transfer/);
  assert.match(reply, /Amount: EGP\s15,000\.00/);
  assert.match(reply, /Account: CIB/);
  assert.match(reply, /Please check:\n• .+\n• “Al Nour” is a new name/);
  assert.match(reply, /https:\/\/example\.test\/en\/inbox$/);
  assert.doesNotMatch(reply, /Cheque number/);
});

test("a cheque reply shows the cheque number; missing values show a dash", () => {
  const reply = buildSavedReply(t, "en", {
    extracted: extraction({ kind: "cheque", direction: "out", cheque_number: null, date: null }),
    warnings: [],
    accountName: "Main CIB",
    inboxUrl: "u",
  });
  assert.match(reply, /Cheque\n/);
  assert.match(reply, /Account: Main CIB/);
  assert.match(reply, /Date: —/);
  assert.match(reply, /Cheque number: —/);
  assert.doesNotMatch(reply, /Please check/);
});
