// Rehearsal-only per-token Telegram Bot API stand-in for
// scripts/channel-telegram-auth-recovery.ts. It installs the shared stand-in
// (channel-live-telegram-fake-api.mjs) first and then answers by token, so one
// fixture can model a revoked token, a replacement for the same bot and a
// token that belongs to a different bot. A live run never imports this file.
//
// Token bytes never reach disk: every token is named by
// sha256(token).slice(0, 12). CHANNEL_LIVE_TELEGRAM_DIR adds two files:
//   tokens.json          {"<label>": {"state": "revoked"} | {"botId": 456}} until rewritten
//                        revoked  every method answers 401 Unauthorized
//                        botId    getMe answers that bot id; other methods reach the shared stand-in
//   token-requests.jsonl one line per Bot API call: {at, method, token: label, control}
// Tokens without an entry reach the shared stand-in unchanged (bot 123).
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

await import("./channel-live-telegram-fake-api.mjs");

const dir = process.env.CHANNEL_LIVE_TELEGRAM_DIR;
const inner = globalThis.fetch;
const label = token => createHash("sha256").update(token).digest("hex").slice(0, 12);
const controls = () => {
  try { return JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")); } catch { return {}; }
};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const match = url.origin === "https://api.telegram.org" ? /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname) : null;
  if (!match) return inner(input, init);
  const token = label(decodeURIComponent(match[1])), method = match[2], control = controls()[token] ?? null;
  const kind = control?.state === "revoked" ? "revoked" : Number.isSafeInteger(control?.botId) ? "other-bot" : null;
  appendFileSync(join(dir, "token-requests.jsonl"), JSON.stringify({ at: Date.now(), method, token, control: kind }) + "\n");
  if (kind === "revoked") return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
  if (kind === "other-bot" && method === "getMe") return Response.json({ ok: true, result: { id: control.botId, is_bot: true, username: "other_rehearsal_bot" } });
  return inner(input, init);
};
