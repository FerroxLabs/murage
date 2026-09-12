// Test-process-only Telegram Bot API fixture (`--import`ed ahead of
// server/index.ts). Production has no endpoint override: the transport talks
// to https://api.telegram.org and nothing else, so a harness test that needs
// a channel message end to end replaces the process's fetch for that origin.
//
// FAKE_TELEGRAM_DIR holds the fixture's state, so the test drives it with
// plain files and no timing knowledge of the poll loop:
//   updates.json  JSON array of raw Telegram updates the test wrote (written
//                 atomically: a half-written file reads as no updates).
//                 getUpdates answers the ones at or after the requested offset.
//   sent.jsonl    one {chatId, text} line per sendMessage the channel made.
// getMe is bot 123 (@fixture_bot); every other method answers a 400 the way
// Telegram refuses an unknown request.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const original = globalThis.fetch;
const dir = process.env.FAKE_TELEGRAM_DIR;
let messageId = 0;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!dir || !url.startsWith("https://api.telegram.org/bot")) return original(input, init);
  const method = url.slice(url.lastIndexOf("/") + 1);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  if (method === "getMe") return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "fixture_bot" } });
  if (method === "getUpdates") {
    let updates = [];
    try { updates = JSON.parse(readFileSync(join(dir, "updates.json"), "utf8")); } catch { updates = []; }
    const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 100);
    return Response.json({ ok: true, result: updates.filter((update) => update.update_id >= offset).slice(0, limit) });
  }
  if (method === "sendMessage") {
    appendFileSync(join(dir, "sent.jsonl"), JSON.stringify({ chatId: String(body.chat_id), text: body.text }) + "\n");
    return Response.json({ ok: true, result: { message_id: ++messageId, chat: { id: Number(body.chat_id) } } });
  }
  return Response.json({ ok: false, error_code: 400, description: "telegram fixture: unsupported method" });
};
