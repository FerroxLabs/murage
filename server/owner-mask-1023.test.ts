// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-ownermask (MAIN PREPARED OPTION B, as upstream OpenMausBot) on the real reply route. Owners: lane q1023-ownermask owns these
// witnesses and the switch (owner-display.ts ownerMaskedReplyText, index.ts item.completed assistant_text); the shape rules =
// redact.ts (redactCredentialShapesInText); the owner-only facts = index.ts ownerOnlyDisplayThread; the ruling = MAIN.
//
// Real server (scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages, POST /api/groups/:id/messages), the real Claude
// driver over the fake CLI playing scripted frames, the transcript read (GET /api/threads/:id/messages) and the store file.
// In the owner's own direct chat a reply is never held back: only credential shapes are masked in place as «redacted N chars»,
// everything else word for word. A shared room keeps today's hold.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
// generated fixture values, assembled at run time
const KEY = ["sk", "proj", "FIXTURE0wnerMask" + "7731abQZ" + "x0Lm4Nb7Vc2Xd9"].join("-");
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LONG = Array.from({ length: 1567 }, (_, i) => ALPHABET[(i * 7 + 3) % ALPHABET.length]).join("");
const SAID = (key: string) => `Your new key is ${key}. Keep it somewhere safe.`;
const DONE = "Done, the migration ran.";
const NEXT = "Anything else you want me to look into?";
type Step = [kind: "text" | "tool", text: string];
const SCRIPTS: Record<string, Step[]> = {
  // W-OM1: a tool printed a vendor key; the reply repeats it; a clean reply after it
  om1: [["tool", `Created key ${KEY}`], ["text", SAID(KEY)], ["text", NEXT]],
  // W-OM2: a tool printed one 1567-char value under a label (past the masked-value bound); the reply is clean
  om2: [["tool", `TOKEN=${LONG}`], ["text", DONE]],
  // W-OM3: the same as W-OM1 in a shared room
  om3: [["tool", `Created key ${KEY}`], ["text", SAID(KEY)], ["text", NEXT]],
};

let fixture: VerificationServer, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); } finally { db.close(); }
}
const shown = (row: any): string => JSON.stringify([row.text ?? "", row.tool ?? "", row.card ?? ""]);
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
async function poll<T>(read: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 300)); }
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
async function createBot(script: string) {
  const created = await api("POST", "/api/bots", { name: `Fixture ${script}`, modelSelection: { instanceId: script, model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** One owner line in `threadId` (sent by `send`); waits until `n` engine replies are there and still. */
async function turn(threadId: string, send: () => Promise<{ status: number; body: any }>, n: number) {
  const seeded = new Set((await transcript(threadId)).map(m => m.id));
  const logFrom = serverLog().length;
  const sent = await send();
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= n && still >= 4 ? rows : null;
  }, 90_000);
  const read = ended ?? (await transcript(threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(threadId).filter(m => !seeded.has(m.id));
  return { ended: ended !== null, log: serverLog().slice(logFrom), replies: engineReplies(read).map(m => String(m.text ?? "")), kept: engineReplies(stored).map(m => String(m.text ?? "")),
    // the stored rows' ownerMasked flag (store.ts Message.ownerMasked): set only on a reply stored under the owner mask
    flags: engineReplies(stored).map(m => m.ownerMasked === true),
    all: [...read, ...stored].map(shown).join("\n"), diag: `rows ${JSON.stringify(read.map(m => [m.role, m.kind, shown(m).slice(0, 140)]))}` };
}
const LINE = "Fixture owner line: run the step and tell me how it went.";
const direct = async (script: string, n: number) => { const bot = await createBot(script); return turn(bot.threadId, () => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: LINE }), n); };

describe("q1023-ownermask, real path: the owner's own direct chat never holds a reply back; only credential shapes are masked in place", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    const instances = Object.fromEntries(Object.entries(SCRIPTS).map(([name, steps]) => [name, { driver: "claudeAgent", displayName: `Claude fixture ${name}`, config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_SCRIPT: JSON.stringify([steps]) } }]));
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs'); const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      Object.assign(cfg.instances, ${JSON.stringify(instances)});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90_000);
  afterAll(async () => { await fixture?.close(); });

  it("W-OM1 owner chat: a tool printed an sk- key and the reply repeats it: the reply is shown with the key masked in place", async () => {
    const t = await direct("om1", 2);
    expect(t.ended, t.diag).toBe(true);
    const masked = SAID(`«redacted ${KEY.length} chars»`);
    // base: the whole reply was held back (REPLY_WITHHELD), read and stored
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [masked, NEXT], stored: [masked, NEXT] });
    expect(t.all).not.toContain(KEY);
    expect(t.log).not.toContain(KEY);
    expect(t.log).not.toContain("[owner-held]");
    // the masked reply is stored flagged ownerMasked, so no shared audience can quote it (room-shares.ts; room-shares.test.ts OM-SHARE)
    expect(t.flags[0], t.diag).toBe(true);
  }, 180_000);

  it("W-OM2 owner chat: a tool printed a 1567-char value; the clean reply after it is shown word for word", async () => {
    const t = await direct("om2", 1);
    expect(t.ended, t.diag).toBe(true);
    // base: held back (the value is past the masked-value bound: incomplete:bound)
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE], stored: [DONE] });
    expect(t.all).not.toContain(LONG.slice(0, 40));
    expect(t.log).not.toContain(LONG.slice(0, 40));
  }, 180_000);

  it("W-OM3 shared room: the same key repeated in a reply is held as today; the room never reads the owner mask", async () => {
    const bot = await createBot("om3");
    const created = await api("POST", "/api/groups", { name: "Fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const room = created.body.group as { id: string; threadId: string };
    const t = await turn(room.threadId, () => api("POST", `/api/groups/${room.id}/messages`, { text: LINE }), 2);
    expect(t.ended, t.diag).toBe(true);
    // the reply that repeats the key is held back whole for the room, read and stored; the room never gets the owner's masked words
    expect({ read: t.replies[0], stored: t.kept[0] }, t.diag).toEqual({ read: REPLY_WITHHELD, stored: REPLY_WITHHELD });
    expect(t.all).not.toContain(SAID(`«redacted ${KEY.length} chars»`));
    expect(t.all).not.toContain(KEY);
    expect(t.flags.some(Boolean), t.diag).toBe(false);
  }, 180_000);
});
