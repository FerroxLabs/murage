// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 cause B on the real reply route (deep1022-causeB-design/DESIGN.md section 7, rows marked API). Owners: lane
// deep1022-causeB-fable owns these witnesses; the value recorder = harness (harness/masked-values.ts, audience-collector.ts, bus.ts);
// the owner reply rule = owner-display.ts (ownerReplyText, shownErrorReason); the call sites = index.ts; rulings = MAIN.
//
// Real server (the verification fixture, scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages), the real Claude
// driver over the fake CLI process playing scripted frames (FAKE_CLAUDE_SCRIPT: tool results, streamed deltas, completed messages,
// a dying process), the owner's transcript read (GET /api/threads/:id/messages), the store file and the server's own log.
// The field report: "Murage held back this message because it may repeat something that must stay hidden." under ordinary replies,
// because one credential anywhere in the turn (here: a tool result) latched it and every later reply was held back.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { ERROR_REASON_WITHHELD, REPLY_WITHHELD } from "./owner-display.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
// generated fixture values: no provider shape, so only the label of the tool output makes them a finding
const V = "FIXTUREVALUE" + "7731abQZ";
const V2 = "SECONDFIXTURE" + "5520xyKW";
const V3 = "THIRDFIXTURE" + "9914mnRT";
const W = "quiet" + "harbor"; // one class of character, under 12: only the WHOLE rule finds it
const ONE = "lanterns"; // FABLE design review H1: 8 letters of one class under a label, repeated bare
const TOOL_OUT = `DB_PASSWORD=${V}\nADMIN_PASSWORD=${W}\nSMTP_PASSWORD=${ONE}`;
// FABLE design review H2: an indented label masks to the end of the text; the credential further down must be recorded too
const CONFIG = "database:\n  password: sunshine\n  host: db.example.test\n  port: 5432\n  replica_password: moonlight\n";
const PADDED = "q83Jd0Lx" + "Za71MnPw" + "kT5vYb"; // 22 characters, then `==`
const LEFT = "correcthorse" + "battery", RIGHT = "staple" + "xyz";
const DONE = "Done, the migration ran.";
const NEXT = "Anything else you want me to look into?";
const REFERS = "I found the password and your API key in .env and left them out.";
const VARIANTS = [`The database password is ${V}.`, `It is ${V.split("").join(" ")} if you need it.`, `Upper case: ${V.toUpperCase()}`, `Quoted: \`${V.slice(0, 9)}\`\`${V.slice(9)}\``,
  `Split: ${V.slice(0, 10)}\n${V.slice(10)}`, `It ends in ${V.slice(-8)}.`, `The admin one, spaced: ${W.split("").join(" ")}`, `The mail password is ${ONE}.`];
type Step = [kind: "text" | "delta" | "tool" | "die", text: string, code?: number];
const SCRIPTS: Record<string, Step[]> = {
  w1: [["tool", TOOL_OUT], ["text", DONE]],
  w2: [["tool", TOOL_OUT], ...VARIANTS.map((text): Step => ["text", text]), ["text", "All set."]],
  w3: [["tool", `PASSWORD=${V}\nAPI_KEY=${V2}`], ["text", REFERS]],
  // Claude resends with no reset: a streamed label completed as a message that holds only its value; a credential cut in two
  w5: [["tool", TOOL_OUT], ["delta", "api_key="], ["text", `${V2}\n`], ["delta", "api_k"], ["text", `ey=${V3}\n`], ["text", NEXT]],
  w6: [["tool", TOOL_OUT], ["text", "Here it is. token:"], ["text", V2], ["text", NEXT]],
  w7: [["tool", TOOL_OUT], ["tool", `PASSWORD=${V2}`], ["text", `It is ${V2}`], ["text", "ok, that is everything."]],
  w10leak: [["tool", TOOL_OUT], ["die", `fatal: could not use ${V}\n`, 1]],
  w10harmless: [["tool", TOOL_OUT], ["die", "fatal: the fixture network went away\n", 1]],
  w11: [["text", `Use api_key=${V} for that.`]],
  // MAIN-RULING 2026-11-25T03:36:35Z FOLD-10: the owner alone in his own bot's chat; one reply repeats the masked value, the next is harmless
  f10: [["tool", TOOL_OUT], ["text", `The database password is ${V}.`], ["text", DONE]],
  // FABLE 4f1bc47bb3 H1: a value with = inside (base64 padding) under a marked label; its repeats without the padding and by its first 14 characters
  h1pad: [["tool", `**API key:** ${PADDED}==`], ["text", `It is ${PADDED} without the padding.`], ["text", `It starts with ${PADDED.slice(0, 14)}.`], ["text", NEXT]],
  h1colon: [["tool", `**Password:** ${LEFT}:${RIGHT}`], ["text", `The first half is ${LEFT}.`], ["text", NEXT]],
  h2: [["tool", CONFIG], ["text", "The replica password is moonlight."], ["text", "The first one is sunshine."], ["text", NEXT]],
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
/** One owner line in a brand-new chat of that scripted engine; waits until `ready` says the turn's rows are there and still. */
async function turn(script: string, ready: (rows: any[]) => boolean) {
  const created = await api("POST", "/api/bots", { name: `Fixture ${script}`, modelSelection: { instanceId: script, model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  // the rows a new bot's chat starts with (its greeting) are not this turn's
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  const logFrom = serverLog().length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line: run the step and tell me how it went." })).status).toBe(202);
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
const held = (text: string | undefined) => text === REPLY_WITHHELD || (text ?? "").includes("«redacted");

describe("1.0.22 cause B, real path: a later reply of a latched turn is held back only when it repeats what the turn masked", () => {
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

  it("W1 the field bug: a tool result holds a credential; the harmless reply after it is read and stored word for word", async () => {
    const t = await turn("w1", replies(1));
    expect(t.ended, t.diag).toBe(true);
    // base: the tool result latched the turn and the reply was stored as the held-back sentence
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [DONE], stored: [DONE] });
    expect(t.all).not.toContain(V);
    expect(t.log).not.toContain(V);
  }, 180_000);

  it("W2 cut 2 H1: the reply repeats the masked value in prose, spaced out, upper-cased, in backticks, across a line break and by its last 8 characters: each is held; the harmless reply after them is shown", async () => {
    const t = await turn("w2", replies(VARIANTS.length + 1));
    expect(t.ended, t.diag).toBe(true);
    expect(t.replies.slice(0, -1).map(held), t.diag).toEqual(VARIANTS.map(() => true));
    // base: the harmless last reply is held back too
    expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: "All set.", stored: "All set." });
    for (const part of [V, V.toUpperCase(), V.slice(-8), V.slice(0, 9), V.split("").join(" "), W.split("").join(" "), ONE]) { expect(t.all).not.toContain(part); expect(t.log).not.toContain(part); }
    // the log names why each was held: a code only
    expect(heldLines(t.log)).toEqual(VARIANTS.map(() => "value"));
  }, 180_000);

  for (const [script, count, parts] of [["h1pad", 2, [PADDED, PADDED.slice(0, 14)]], ["h1colon", 1, [LEFT]]] as const)
    it(`H1u ${script}: a value holding = or : under a marked label; each repeat of a part of it is held, the harmless reply after it is shown`, async () => {
      const t = await turn(script, replies(count + 1));
      expect(t.ended, t.diag).toBe(true);
      expect(t.replies.slice(0, -1).map(held), t.diag).toEqual(Array.from({ length: count }, () => true));
      expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: NEXT, stored: NEXT });
      for (const part of parts) { expect(t.all).not.toContain(part); expect(t.log).not.toContain(part); }
    }, 180_000);

  it("W3 prose that only names the secret is shown", async () => {
    const t = await turn("w3", replies(1));
    expect(t.ended, t.diag).toBe(true);
    expect({ read: t.replies, stored: t.kept }, t.diag).toEqual({ read: [REFERS], stored: [REFERS] });
    expect(t.all).not.toContain(V);
  }, 180_000);

  it("W5 cut 2 H2: a Claude resend with no reset (a streamed label completed as its value; a credential cut in two by the resend) is held after an earlier latch; the harmless reply after is shown", async () => {
    const t = await turn("w5", replies(3));
    expect(t.ended, t.diag).toBe(true);
    expect(t.replies.slice(0, 2).map(held), t.diag).toEqual([true, true]);
    expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: NEXT, stored: NEXT });
    for (const value of [V, V2, V3]) { expect(t.all).not.toContain(value); expect(t.log).not.toContain(value); }
  }, 180_000);

  it("W6 a value split across two replies (the first ends on its label, the second is the bare value) is held; the harmless reply after is shown", async () => {
    const t = await turn("w6", replies(3));
    expect(t.ended, t.diag).toBe(true);
    expect(held(t.replies[1]), t.diag).toBe(true);
    expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: NEXT, stored: NEXT });
    for (const value of [V, V2]) { expect(t.all).not.toContain(value); expect(t.log).not.toContain(value); }
  }, 180_000);

  it("W7 a value a tool prints AFTER the latch: the reply that repeats it is held, the harmless reply after is shown", async () => {
    const t = await turn("w7", replies(2));
    expect(t.ended, t.diag).toBe(true);
    expect(held(t.replies[0]), t.diag).toBe(true);
    expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: "ok, that is everything.", stored: "ok, that is everything." });
    for (const value of [V, V2]) { expect(t.all).not.toContain(value); expect(t.log).not.toContain(value); }
  }, 180_000);

  it("H2 an indented config with two credentials in a tool result: a reply that repeats the second one bare is held, and the first; the harmless reply after is shown", async () => {
    const t = await turn("h2", replies(3));
    expect(t.ended, t.diag).toBe(true);
    expect(t.replies.slice(0, 2).map(held), t.diag).toEqual([true, true]);
    expect({ read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ read: NEXT, stored: NEXT });
    for (const value of ["moonlight", "sunshine"]) { expect(t.all).not.toContain(value); expect(t.log).not.toContain(value); }
  }, 180_000);

  // FABLE design review M1: 1.0.21 already withholds the error row of a latched turn; design 5.3 would have OPENED it. Not taken in
  // this cut, so this row is a guard: green on the base and on the fix.
  it("W10 guard: the engine's last words on a latched turn are never the error reason, whether or not they repeat the masked value (as in 1.0.21)", async () => {
    const errorRow = (rows: any[]) => rows.some(m => /closed \(exit code 1\)|could not show the reason/.test(shown(m)));
    const leak = await turn("w10leak", errorRow);
    expect(leak.ended, leak.diag).toBe(true);
    expect(leak.all, leak.diag).toContain(ERROR_REASON_WITHHELD);
    expect(leak.all).not.toContain(V);
    const harmless = await turn("w10harmless", errorRow);
    expect(harmless.ended, harmless.diag).toBe(true);
    expect(harmless.all, harmless.diag).toContain(ERROR_REASON_WITHHELD);
    expect(harmless.all).not.toContain("the fixture network went away");
    expect(harmless.all).not.toContain(V);
  }, 240_000);

  // MAIN-RULING 2026-11-25T03:36:35Z (FOLD-10, condition for the [owner-held] prefix at index.ts foldRuntimeEvent): the owner alone in his
  // own bot's chat SEES the harmless reply of a latched turn: its words are on the transcript the first time it shows, no hold card,
  // never the held-back sentence. The reply that repeats the masked value is held, and its log line keeps the [redact] prefix free:
  // that prefix names a shared-audience hold only (engine-swap-fold.test.ts FOLD-10 control, the owner alone gets no [redact] line).
  it("W12 FOLD-10 real path: the owner alone sees the harmless reply at once with no hold card; his held reply logs no [redact] line", async () => {
    const t = await turn("f10", replies(2));
    expect(t.ended, t.diag).toBe(true);
    expect(held(t.replies[0]), t.diag).toBe(true);
    expect({ first: t.first.at(-1), read: t.replies.at(-1), stored: t.kept.at(-1) }, t.diag).toEqual({ first: DONE, read: DONE, stored: DONE });
    expect(t.read.filter(m => m.card?.held || m.text === REPLY_WITHHELD).length, t.diag).toBe(1);
    const mine = t.log.split("\n").filter(line => line.includes(`reply on thread ${t.bot.threadId} `));
    expect(mine.filter(line => line.includes("[redact] reply on thread")), t.log.slice(-2000)).toEqual([]);
    expect(heldLines(mine.join("\n"))).toEqual(["value"]);
    expect(t.all).not.toContain(V);
    expect(t.log).not.toContain(V);
  }, 180_000);

  it("W11 control: a reply that itself holds a credential, with no earlier latch, is still redacted or held back", async () => {
    const t = await turn("w11", replies(1));
    expect(t.ended, t.diag).toBe(true);
    expect(held(t.replies[0]), t.diag).toBe(true);
    expect(t.all).not.toContain(V);
  }, 180_000);
});
