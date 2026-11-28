// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-heldbound on the real reply route (MAIN-RULING 2026-11-26T18:44:07Z (A), BGDIAG b50b7c3cdc). Owners: lane q1023-heldbound
// owns these witnesses; the value recorder = harness (harness/masked-values.ts, audience-collector.ts, bus.ts); the owner reply rule
// = owner-display.ts; the call sites = index.ts; rulings = MAIN.
//
// Real server (the verification fixture, scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages), the real Claude
// driver over the fake CLI process playing scripted frames (FAKE_CLAUDE_SCRIPT), the owner's transcript read (GET
// /api/threads/:id/messages), the store file and the server's own log; the harness is the one of withheld-values-api-1022.test.ts.
// The field report: after a tool printed a private key or a JWT, every later reply of the owner's turn read "Murage held back this
// message because it may repeat something that must stay hidden.": one masked value over 512 characters marked the list incomplete.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";
import { JWT, JWT_QUOTE, PEM_LINES, PEM_QUOTE, SA_JSON, fixtureChars } from "./testing/heldbound-fixtures-1023.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DONE = "Done, the key is in place and the job ran.";
const NEXT = "Anything else you want me to look into?";
const JWT_OUT = `HTTP/1.1 200 OK\nAuthorization: Bearer ${JWT}\n`;
/** The same 40 characters of the key set apart in groups of 4: no single word repeats the key, the words together do. */
const PEM_SPACED = PEM_QUOTE.match(/.{1,4}/g)!.join(" ");
/** The same key as `cat key.pem` prints it: armour and body on lines of their own, the last body line short (44 chars). */
const PEM_LAST = PEM_LINES[45]!.slice(0, 44), PEM_LAST_QUOTE = PEM_LAST.slice(2, 42);
const PEM_FILE = ["-----BEGIN " + "PRIVATE KEY-----", ...PEM_LINES.slice(0, 45), PEM_LAST, "-----END " + "PRIVATE KEY-----", ""].join("\n");
/** The head of that file only (`head -n 30 key.pem`): the armour opens, no END line follows. */
const PEM_CUT = ["-----BEGIN " + "PRIVATE KEY-----", ...PEM_LINES.slice(0, 29), ""].join("\n");
/** A long api_key= value, no credential shape: labelled, so masked in place in the owner chat (MAIN-RULING 23:37:25Z W9). */
const LONG_KEY = fixtureChars(80, 4242, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
const SAID_KEY = `The api key in the config is ${LONG_KEY} as before.`;
const SAID_PEM = (quote: string) => `The key line has ${quote} in it.`, SAID_JWT = (quote: string) => `The token has ${quote} in it.`;
type Step = [kind: "text" | "delta" | "tool" | "die", text: string, code?: number];
const SCRIPTS: Record<string, Step[]> = {
  pem: [["tool", SA_JSON], ["text", DONE], ["text", SAID_PEM(PEM_QUOTE)], ["text", NEXT]],
  jwt: [["tool", JWT_OUT], ["text", DONE], ["text", SAID_JWT(JWT_QUOTE)], ["text", NEXT]],
  pemsp: [["tool", SA_JSON], ["text", DONE], ["text", SAID_PEM(PEM_SPACED)], ["text", NEXT]],
  pemml: [["tool", PEM_FILE], ["text", DONE], ["text", SAID_PEM(PEM_QUOTE)], ["text", NEXT]],
  pemlast: [["tool", PEM_FILE], ["text", DONE], ["text", SAID_PEM(PEM_LAST_QUOTE)], ["text", NEXT]],
  pemcut: [["tool", PEM_CUT], ["text", DONE], ["text", SAID_PEM(PEM_QUOTE)], ["text", NEXT]],
  longkey: [["tool", `config loaded\napi_key=${LONG_KEY}\n`], ["text", DONE], ["text", SAID_KEY], ["text", NEXT]],
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
/** One owner line in a brand-new chat of that scripted engine (or, `room`, a brand-new shared room whose only member and default
 * responder is that bot); waits until `ready` says the turn's rows are there and still. */
async function turn(script: string, ready: (rows: any[]) => boolean, room = false) {
  const created = await api("POST", "/api/bots", { name: `Fixture ${script}`, modelSelection: { instanceId: script, model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const made = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  let bot = made;
  if (room) {
    const group = await api("POST", "/api/groups", { name: `Fixture room ${script}`, memberIds: [made.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: made.id } } });
    expect(group.status, JSON.stringify(group.body)).toBeLessThan(300);
    bot = group.body.group as { id: string; threadId: string };
  }
  // the rows a new bot's chat (or room) starts with (its greeting) are not this turn's
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  const logFrom = serverLog().length;
  const line = "Fixture owner line: run the step and tell me how it went.";
  const posted = room ? await api("POST", `/api/groups/${bot.id}/messages`, { text: line }) : await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: line });
  expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
  let last = -1, still = 0;
  // the words each engine reply had the first time the owner's transcript showed it (a held reply released later reads differently)
  const first = new Map<string, string>();
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    for (const m of engineReplies(rows)) if (!first.has(m.id)) first.set(m.id, String(m.text ?? ""));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return ready(rows) && still >= 4 ? rows : null;
  }, 90_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  return { bot, first: engineReplies(read).map(m => first.get(m.id)), read, stored, ended: ended !== null, log: serverLog().slice(logFrom), replies: engineReplies(read).map(m => String(m.text ?? "")), kept: engineReplies(stored).map(m => String(m.text ?? "")),
    all: [...read, ...stored].map(shown).join("\n"), diag: `rows ${JSON.stringify(read.map(m => [m.role, m.kind, shown(m).slice(0, 140)]))}` };
}
const replies = (n: number) => (rows: any[]) => engineReplies(rows).length >= n;
const heldLines = (log: string) => log.split("\n").flatMap(line => line.match(/\[owner-held\] reply on thread \S+ held back for the owner: (\S+)/)?.[1] ?? []);

describe("q1023-heldbound, real path: after a tool printed a long key or token, the harmless replies are shown and a quote of it is held", () => {
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

  // MAIN-RULING 2026-11-26T21:44:41Z: option B (MAIN-RULING :7664) never holds a reply in the owner's own chat, so the quote of the
  // key is MASKED IN PLACE there: not held, the key text absent, a redacted marker present (base 3fccd82ce7: held whole; base
  // 33801294e7, ownermask merged: shown in clear)
  for (const [script, secret, said] of [["pem", PEM_LINES.join(""), SAID_PEM(`«redacted ${PEM_QUOTE.length} chars»`)], ["jwt", JWT, SAID_JWT(`«redacted ${JWT_QUOTE.length} chars»`)]] as const)
    it(`HB-API-${script} a ${script === "pem" ? "3 KB private key (service-account JSON, PEM on one line)" : "2 KB JWT"} in a tool result, owner chat: the replies that do not repeat it are read and stored word for word, the one quoting 40 characters of it is shown with the quote masked in place`, async () => {
      const t = await turn(script, replies(3));
      expect(t.ended, t.diag).toBe(true);
      // the quote is masked in place: read and stored, the reply's own words kept, never REPLY_WITHHELD, never the quote
      expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE, said, NEXT], stored: [DONE, said, NEXT] });
      expect(heldLines(t.log)).toEqual([]);
      for (const part of [script === "pem" ? PEM_QUOTE : JWT_QUOTE, secret.slice(600, 640)]) { expect(t.all).not.toContain(part); expect(t.log).not.toContain(part); }
    }, 180_000);

  it("HB-API-pemsp owner chat: the 40 characters quoted in groups of 4 (no single word repeats the key) are masked in place as one run, never shown in clear", async () => {
    const t = await turn("pemsp", replies(3));
    expect(t.ended, t.diag).toBe(true);
    // CHANGED ASSERTION, MAIN-RULING ownermask 2026-11-27 (H1: "Owner's own chat: masking replaces ONLY the secret value in place; it NEVER drops words after it or cuts the reply"): the spaced groups are one run masked in place and the words around them stay (was: the whole reply one marker, `«redacted ${SAID_PEM(PEM_SPACED).length} chars»`); the two lines below still prove no group of the key is shown
    const spaced = SAID_PEM(`«redacted ${PEM_SPACED.length} chars»`);
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE, spaced, NEXT], stored: [DONE, spaced, NEXT] });
    for (const part of PEM_SPACED.split(" ").slice(0, 10).map((_, k, all) => all.slice(k, k + 2).join(" ")).filter(p => p.length > 5)) expect(t.all).not.toContain(part);
    expect(t.log).not.toContain(PEM_SPACED);
  }, 180_000);

  // the same key printed as a PEM file (one body line per line): a quote of a 64-char body line and of the short last line
  for (const [script, quote] of [["pemml", PEM_QUOTE], ["pemlast", PEM_LAST_QUOTE], ["pemcut", PEM_QUOTE]] as const)
    it(`HB-API-${script} owner chat, a PEM file printed line by line${script === "pemcut" ? " and cut before its END line" : ""}: the reply quoting 40 characters of ${script === "pemlast" ? "the short last line" : "a body line"} is shown with the quote masked in place`, async () => {
      const t = await turn(script, replies(3));
      expect(t.ended, t.diag).toBe(true);
      const said = SAID_PEM(`«redacted ${quote.length} chars»`);
      expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE, said, NEXT], stored: [DONE, said, NEXT] });
      expect(t.all).not.toContain(quote); expect(t.log).not.toContain(quote);
    }, 180_000);

  // MAIN-RULING 2026-11-26T23:37:25Z W9 (supersedes the option-B "shown" row here): a long value right after a credential label
  // (api_key=, no credential shape) is masked IN PLACE in the owner's own chat, never held, never in clear
  it("HB-API-longkey owner chat: a reply repeating a long api_key= value (no credential shape) is shown with the value masked in place", async () => {
    const t = await turn("longkey", replies(3));
    expect(t.ended, t.diag).toBe(true);
    const said = SAID_KEY.replace(LONG_KEY, `«redacted ${LONG_KEY.length} chars»`);
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE, said, NEXT], stored: [DONE, said, NEXT] });
    expect(t.all).not.toContain(LONG_KEY); expect(t.log).not.toContain(LONG_KEY);
  }, 180_000);

  // the quote-hold of q1023-heldbound moves to a shared audience (MAIN-RULING 21:44:41Z): in a room the quote stays HELD
  for (const [script, quote] of [["pem", PEM_QUOTE], ["jwt", JWT_QUOTE]] as const)
    it(`HB-ROOM-${script} shared room, same tool result: the reply quoting 40 characters of it stays held back, read and stored; the room never reads the owner mask`, async () => {
      const t = await turn(script, replies(3), true);
      expect(t.ended, t.diag).toBe(true);
      expect({ read: t.replies[1], stored: t.kept[1] }, t.diag).toEqual({ read: REPLY_WITHHELD, stored: REPLY_WITHHELD });
      expect(t.read.concat(t.stored).some(m => m.ownerMasked === true), t.diag).toBe(false);
      expect(t.all).not.toContain(quote); expect(t.log).not.toContain(quote);
    }, 180_000);
});
