// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-ownershow (MAIN release blocker, option B + MAIN-RULING 2026-11-27T03:17:37Z labelled-value floor) on the real turn path.
// Owners: lane q1023-ownershow owns these witnesses and the one owner-zone rule (redact.ts ownerZoneGrade / redactOwnerZone) as used by
// owner-display.ts ownerMaskedReplyText, store.ts redactBotAuthored, transcript-page.ts sanitizeBotDisplayMessage and index.ts
// ownerZoneFrame; labelled-value grading = q1023-labelfloor (harness/masked-values.ts); rulings = MAIN.
//
// Real server (scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages, POST /api/groups/:id/messages), the real Claude
// driver over the fake CLI: a Read tool of a real workspace file, then a reply that quotes its `token:` line word for word (the 1.0.23
// RC canary's turn). Read back three ways: the live SSE message frame, the transcript read (GET /api/threads/:id/messages) and the saved
// row (messages.db). In the owner's own direct chat a short labelled value SHOWS; a 16+ char labelled value or a real sk-/ghp_/AKIA
// shape stays masked in place; a shared room still masks the short value.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const WS = mkdtempSync(join(tmpdir(), "ownershow-ws-"));
// generated fixture values, assembled at run time
const SHORT = ["D", "4821"].join("-");
const LONG16 = "Wq7Lm2Xr" + "9Tb4Kd8N";
const LONG24 = "Hy3Pz8Qa" + "5Rc1Vb6M" + "n2Ks7Lx4";
// a 16-char labelled value no tool printed: only the owner-zone rule itself (redact.ts redactOwnerZone) can mask it
const REPLY16 = "Pn5Gx2Rk" + "8Ld3Ws7J";
const SK = ["sk", "proj", "FIXTURE0wnerShow" + "4417abQZ" + "x0Lm4Nb7Vc"].join("-");
const GHP = "ghp" + "_" + "FIXTURE0wnerShow4417abQZx0Lm4Nb7Vc2X";
const AKIA = "AKIA" + "FIXTURE0WNER4417";
const file = (name: string, body: string) => { const path = join(WS, name); writeFileSync(path, body); return path; };
const NOTES = file("notes.txt", `Garage notes\ntoken: ${SHORT}\nopen at 7\n`);
const KEYS = file("keys.txt", `service config\napi_key: ${LONG24}\nsecret: ${LONG16}\n`);
const SHAPES = file("shapes.txt", `token: ${SK}\ntoken2: ${GHP}\naws: ${AKIA}\n`);
const DIGITS15 = "1234567" + "89012345";
const PIN = file("pin.txt", `door\npassword: ${DIGITS15}\n`);
// a short value under a bold label with a sentence after it: the scanner wraps the span over the sentence
const WRAPPED_REPLY = `**token:** ${SHORT}\nA normal second sentence follows here.`;
const LINK_REPLY = `**token:** ${SHORT}\n[DocumentationLinks]`;
// 16 characters whose last is a literal underscore: the value, not Markdown
const UNDERSCORE16 = "abcdefghijklmno" + "_";
const UNDERSCORE_REPLY = `token: ${UNDERSCORE16}`;
const REPLY_ONLY = `Set it as password: ${REPLY16} and then restart.`;
const REPLY_SHORT = ["Your password: ab", "12"].join("");
// a query-key value: masked by the labelled-value rules of the pass itself (QUERY_KEY), not by the turn's masked-value list
const QUERY20 = "Tm4Hq9Wz" + "2Lc7Rb5X" + "k8Vd";
const REPLY_QUERY = `Callback: https://example.invalid/cb?token=${QUERY20}`;
const REPLY_QUERY_SHORT = ["Short link: https://example.invalid/cb?token=ab", "12"].join("");
type Step = [kind: "text" | "tool" | "read" | "quote", text: string];
const SCRIPTS: Record<string, Step[]> = {
  // OS1: the canary turn: Read notes.txt, quote `token: D-4821`
  os1: [["read", NOTES], ["quote", "token:"]],
  // OS2: Read keys.txt, quote the 24-char and the 16-char labelled values; then a 16-char labelled value no tool printed
  os2: [["read", KEYS], ["quote", "api_key:"], ["quote", "secret:"], ["text", REPLY_ONLY]],
  // OS5: no tool at all: a 16-char labelled value the reply itself carries, then a short labelled value
  os5: [["text", REPLY_ONLY], ["text", REPLY_SHORT], ["text", REPLY_QUERY_SHORT], ["text", REPLY_QUERY]],
  // OS3: Read shapes.txt, quote an sk- key, a ghp_ token and an AKIA key id (each under a label)
  os3: [["read", SHAPES], ["quote", "token:"], ["quote", "token2:"], ["quote", "aws:"]],
  // OS6: Read pin.txt, quote a 15-char labelled value inside inline code (the backticks are not part of the value)
  os6: [["read", PIN], ["quote", "password:"]],
  // OS6 second turn (no tool): a short value under a bold label, a sentence after it
  os7: [["text", WRAPPED_REPLY]],
  os8: [["text", LINK_REPLY]],
  os9: [["text", UNDERSCORE_REPLY]],
  // OS4: the canary turn in a shared room
  os4: [["read", NOTES], ["quote", "token:"]],
};
const quoted = (line: string, at: number) => `Line ${at} of the file reads:\n\n\`${line}\``;

let fixture: VerificationServer, headers: Record<string, string> = {}, stream: SseRecorder;
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); } finally { db.close(); }
}
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
/** One owner line in `threadId`; waits until `n` engine replies are there and still. Returns each reply as the live SSE message
 * frame, the transcript read and the saved row carry it (in reply order). */
async function turn(threadId: string, send: () => Promise<{ status: number; body: any }>, n: number) {
  const seeded = new Set((await transcript(threadId)).map(m => m.id));
  const framesFrom = stream.frames.length;
  const sent = await send();
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= n && still >= 4 ? rows : null;
  }, 90_000);
  const read = engineReplies(ended ?? (await transcript(threadId)).filter(m => !seeded.has(m.id)));
  const stored = engineReplies(storedRows(threadId).filter(m => !seeded.has(m.id)));
  // the live frame of each reply row: the last message/message.patch frame naming its id
  const frameOf = (id: string) => stream.frames.slice(framesFrom).filter(f => (f?.kind === "message" || f?.kind === "message.patch") && f.threadId === threadId && f.message?.id === id).at(-1)?.message?.text;
  // stored: what the owner's own read of the saved row starts from (store.ts ownerText when the row has an owner view, else its text);
  // strict: the saved row's `text`, which every other reader of a stored row takes (search, recall, quotes, summaries, memory)
  return { ended: ended !== null, read: read.map(m => String(m.text ?? "")), stored: stored.map(m => String(m.ownerText?.text ?? m.text ?? "")), strict: stored.map(m => String(m.text ?? "")), live: read.map(m => String(frameOf(m.id) ?? "<no frame>")),
    diag: JSON.stringify({ read: read.map(m => m.text), stored: stored.map(m => m.text) }).slice(0, 1500) };
}
const LINE = "Read the file and quote its line word for word.";
const direct = async (script: string, n: number) => { const bot = await createBot(script); return turn(bot.threadId, () => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: LINE }), n); };

describe("q1023-ownershow, real turn path: the owner's own direct chat shows a short labelled value; keys and shapes stay masked; rooms stay strict", () => {
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
    stream = await openSse(`${fixture.info.url}/api/events`, headers);
  }, 90_000);
  afterAll(async () => { stream?.close(); await fixture?.close(); rmSync(WS, { recursive: true, force: true }); });

  it("OS1 owner chat: the Read workspace line `token: D-4821` is shown word for word, live, on the transcript read and in the saved row", async () => {
    const t = await direct("os1", 1);
    expect(t.ended, t.diag).toBe(true);
    const want = quoted(`token: ${SHORT}`, 2);
    // base (RC1 f887a65c45 behaviour): `token: «redacted 7 chars»` in the saved row, so on every read and in the live frame
    expect(t.stored, `saved row ${t.diag}`).toEqual([want]);
    // every other reader of the saved row (search snippets, a bot's thread recall, quotes, summaries) takes the strict text
    expect(t.strict.join("\n"), t.diag).not.toContain(SHORT);
    expect(t.read, `owner transcript read ${t.diag}`).toEqual([want]);
    expect(t.live, `live message frame ${t.diag}`).toEqual([want]);
  }, 180_000);

  it("OS2 owner chat: a 24-char and a 16-char labelled value, read or reply-only, stay masked in place", async () => {
    const t = await direct("os2", 3);
    expect(t.ended, t.diag).toBe(true);
    for (const where of [t.live, t.read, t.stored]) {
      expect(where.length, t.diag).toBe(3);
      expect(where.join("\n"), t.diag).not.toContain(LONG24);
      expect(where.join("\n"), t.diag).not.toContain(LONG16);
      expect(where.join("\n"), t.diag).not.toContain(REPLY16);
      // masked IN PLACE: the label and the words around it are still there
      expect(where[0], t.diag).toMatch(/^Line 2 of the file reads:\n\n`api_key: «redacted \d+ chars»/);
      // the 16-char value the turn's own Read printed: masked (maskRepeatsInPlace may take the whole line, fail closed), never shown
      expect(where[1], t.diag).toMatch(/«redacted \d+ chars»/);
      // in the same turn as the Read: masked (in place, or the whole line by maskRepeatsInPlace's fail-closed check), never shown
      expect(where[2], t.diag).toMatch(/«redacted \d+ chars»/);
    }
  }, 180_000);

  it("OS5 owner chat, no tool: a 16-char labelled value in the reply is masked in place by the owner-zone rule; a short one shows", async () => {
    const t = await direct("os5", 4);
    expect(t.ended, t.diag).toBe(true);
    for (const where of [t.stored, t.read, t.live]) {
      expect(where.join("\n"), t.diag).not.toContain(REPLY16);
      expect(where.join("\n"), t.diag).not.toContain(QUERY20);
      expect(where[0], t.diag).toMatch(/^Set it as password: «redacted \d+ chars» and then restart\.$/);
      expect(where[1], t.diag).toBe(REPLY_SHORT);
      expect(where[2], t.diag).toBe(REPLY_QUERY_SHORT);
      expect(where[3], t.diag).toMatch(/^Callback: https:\/\/example\.invalid\/cb\?token=«redacted \d+ chars»$/);
    }
  }, 180_000);

  it("OS3 owner chat: an sk- key, a ghp_ token and an AKIA key id stay masked in place", async () => {
    const t = await direct("os3", 3);
    expect(t.ended, t.diag).toBe(true);
    for (const where of [t.live, t.read, t.stored]) {
      expect(where.length, t.diag).toBe(3);
      const all = where.join("\n");
      for (const key of [SK, GHP, AKIA, SK.slice(8, 28), GHP.slice(4, 24), AKIA.slice(4)]) expect(all, t.diag).not.toContain(key);
      expect(where.map(text => /«redacted \d+ chars»/.test(text)), t.diag).toEqual([true, true, true]);
    }
  }, 180_000);

  it("OS6 owner chat: a 15-char labelled value quoted in inline code is shown word for word (the floor counts the value, not its backticks)", async () => {
    const t = await direct("os6", 1);
    expect(t.ended, t.diag).toBe(true);
    const want = quoted(`password: ${DIGITS15}`, 2);
    for (const where of [t.stored, t.read, t.live]) expect(where[0], t.diag).toBe(want);
  }, 180_000);

  it("OS7 owner chat, no tool: a short value under a bold label shows; the floor grades the label's own value, not the next line", async () => {
    const w = await direct("os7", 1);
    expect(w.ended, w.diag).toBe(true);
    for (const where of [w.stored, w.read, w.live]) expect(where[0], w.diag).toBe(WRAPPED_REPLY);
    // a later line counts only when it is key material (letters and digits), never link text
    const l = await direct("os8", 1);
    expect(l.ended, l.diag).toBe(true);
    for (const where of [l.stored, l.read, l.live]) expect(where[0], l.diag).toBe(LINK_REPLY);
    // a 16-char value ending in a literal underscore is 16 characters: masked in place
    const u = await direct("os9", 1);
    expect(u.ended, u.diag).toBe(true);
    for (const where of [u.stored, u.read, u.live]) expect(where[0], u.diag).toMatch(/^token: «redacted \d+ chars»$/);
  }, 180_000);

  it("OS4 shared room: the same `token: D-4821` line stays masked for the room (live, read and saved)", async () => {
    const bot = await createBot("os4");
    const created = await api("POST", "/api/groups", { name: "Fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const room = created.body.group as { id: string; threadId: string };
    const t = await turn(room.threadId, () => api("POST", `/api/groups/${room.id}/messages`, { text: LINE }), 1);
    expect(t.ended, t.diag).toBe(true);
    for (const where of [t.live, t.read, t.stored]) {
      expect(where.length, t.diag).toBe(1);
      expect(where[0], t.diag).not.toContain(SHORT);
    }
    // the room line is the masked or held form, never the owner's shown words
    expect(t.stored[0], t.diag).not.toBe(quoted(`token: ${SHORT}`, 2));
  }, 180_000);
});
