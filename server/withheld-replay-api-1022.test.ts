// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 release gate, the field sequence on the real path. Owners: lane deep1022-withheld-fable owns these witnesses, the runner's
// source rule (memory/memory-revocation.ts tick, io-budget.ts withoutSource); the revoke marker owns the windows; the harness owns the
// collector and its latch (unchanged here: W-SECRET-CONTROL pins that a reply holding a credential stays hidden from the owner's rows).
//
// Real server (the verification fixture, scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages), the real Claude
// driver over the fake CLI process, the owner's transcript read, the store file and the server's own log. The field log of 1.0.21
// (memory and relay lines only, never chat text) reads, for 27 hours:
//   [memory] revocation job: BG_DEFERRED; trying again                       (105 times)
//   [memory] fence recovery tier=0 thread=X refused=none parts=0 omitted=N cause=checking
//   turn dispatch recall=withheld thread=X                                    (19 withheld against 12 full)
// and the owner read "Murage left remembered details out of this reply." under every reply, in a brand-new chat too.
// (The held-back replies of the same report have another cause, the turn's secret latch; not changed on this branch.)
// What W-REPLAY reproduces on base: the runner refused on every write and the all-chat windows of a revoke in ANOTHER chat left open.
// What it does not: on this fixture the owner's own turn still reads recall=full with the windows open (its lines postdate nothing the
// window covers), so the turn-level fields are a regression guard here; window -> "left out" note is fence-pending-turn-api.test.ts T3.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { LEFT_OUT_NOTE } from "./memory/fence-recovery.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const importUrl = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const FIXTURE_VALUE = "FIXTURESECRET" + "123456";
const KEY_LINE = `Here is the key you asked for: api_key=${FIXTURE_VALUE}`;
const HARMLESS = "I made it to the harbour town.";
const HELD_NOTE = "Memory wasn't ready";
const DEFERRED_LINE = "[memory] revocation job: BG_DEFERRED; trying again";

let fixture: VerificationServer, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function store<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
const storedRows = (threadId: string): any[] => store(db => (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))));
const openWindows = () => store(db => Number(db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending) + (SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n));
const shown = (row: any): string => JSON.stringify([row.text ?? "", row.tool ?? "", row.card ?? ""]);
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
async function poll<T>(read: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 300)); }
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
/** A brand-new chat: a new bot of that engine instance and its own thread. */
async function newChat(name: string, instanceId: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** One owner line in that chat; waits for `replies` new engine replies and still rows. `log` is the server log of this turn only. */
async function ownerTurn(bot: { id: string; threadId: string }, replies: number, line = "Fixture owner line: where did you get to?") {
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  const logFrom = serverLog().length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: line })).status).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= replies && still >= 4 ? rows : null;
  }, 90_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  return { bot, read, stored: storedRows(bot.threadId).filter(m => !seeded.has(m.id)), ended: ended !== null, log: serverLog().slice(logFrom) };
}
const freshChatTurn = async (name: string, instanceId: string, replies: number) => ownerTurn(await newChat(name, instanceId), replies);
const diag = (read: any[]) => `rows ${JSON.stringify(read.map(m => [m.role, m.kind, m.memoryNote ?? "", shown(m).slice(0, 110)]))}`;
const dispatchLines = (log: string) => log.split("\n").flatMap(line => line.match(/turn dispatch recall=\w+/)?.[0] ?? []);
const checkingLines = (log: string) => log.split("\n").filter(line => /\[memory\] fence recovery .* cause=checking/.test(line)).length;

describe("1.0.22 deep withheld, real path: the field log sequence replayed", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    const claude = (replies: unknown) => ({ driver: "claudeAgent", displayName: "Claude fixture", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_TEXT_ONLY: "1", FAKE_CLAUDE_REPLIES: JSON.stringify(replies) } });
    const instances = { plain: claude([HARMLESS]), keyonly: claude([[`${HARMLESS} ${KEY_LINE}`]]) };
    // The field trigger, in the server process: a memory worker slice (io-budget source "memory-worker") wakes the runner (every commit
    // does: revoke-commit.ts and the commit bus call wakeIfStarted) and its slice is deferred (ioBudget.deferCurrentSlice: in production
    // the connection sets it when a background slice is refused a write inside a transaction, io-budget.ts afterWrite; a spent
    // background minute refuses through refusalRetry without it. This fixture's minute has room, so the fixture names the deferral).
    // In the same step a revoke of a line of ANOTHER chat commits. The wake's microtask and the runner's deadline timer keep the
    // slice's store. Every module is the server's own instance; the stand-in is the slice's state, never the runner or the gate.
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs'); const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      Object.assign(cfg.instances, ${JSON.stringify(instances)});
      fs.writeFileSync(file,JSON.stringify(cfg));
      const gate=path.join(process.env.MURAGE_DATA_DIR,'deep1022-background-revoke');
      const watch=setInterval(async()=>{
        if(!fs.existsSync(gate))return;
        fs.rmSync(gate);
        try{
          const {ioBudget}=await import(${importUrl("server/io-budget.ts")});
          const {database}=await import(${importUrl("server/database.ts")});
          const {commitRevoke}=await import(${importUrl("server/memory/revoke-commit.ts")});
          const {wakeIfStarted,memoryRevocationIdle}=await import(${importUrl("server/memory/memory-revocation.ts")});
          // the runner has ended whatever the first turn queued (a runner already ticking keeps the store it was started in)
          await memoryRevocationIdle();
          // one synchronous step: the worker slice's commit wake is queued first (its microtask keeps the slice's store), then the revoke commits
          ioBudget.withSource('memory-worker',()=>{wakeIfStarted();ioBudget.deferCurrentSlice();});
          const db=database();
          db.exec('BEGIN IMMEDIATE');
          try{commitRevoke(db,{kind:'line',threadId:'deep1022-another-chat',messageIds:['deep1022-line'],cause:'forget'},{inline:false});db.exec('COMMIT');}
          catch(error){db.exec('ROLLBACK');throw error;}
          fs.writeFileSync(gate+'.done','ok');
        }catch(error){fs.writeFileSync(gate+'.done','failed: '+String(error&&error.stack||error));}
      },100);
      watch.unref();
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90_000);
  afterAll(async () => { await fixture?.close(); });

  it("W-REPLAY a revoke in another chat, woken from a background slice, holds neither a chat with history nor a brand-new chat: the runner walks it, both owner turns get full recall and no left-out note", async () => {
    // the owner's chat as it was before the revoke: one turn, so its engine session and its lines predate the revoke's commit
    const chat = await newChat("Chat with history", "plain");
    const first = await ownerTurn(chat, 1);
    expect(first.ended, diag(first.read)).toBe(true);
    expect(dispatchLines(first.log)).toEqual(["turn dispatch recall=full"]);
    const gate = join(fixture.info.dataDir, "deep1022-background-revoke");
    writeFileSync(gate, "go");
    expect(await poll(() => existsSync(`${gate}.done`) ? readFileSync(`${gate}.done`, "utf8") : null, 20_000)).toBe("ok");
    // the runner's part: with nothing else wrong it walks the revoke in well under a second; fifteen seconds of its retries on base
    await poll(() => openWindows() === 0 ? true : null, 15_000);
    const windowsBeforeTurn = openWindows();
    const again = await ownerTurn(chat, 1, "Fixture owner line: and after that?");
    const fresh = await freshChatTurn("Fresh chat after a background revoke", "plain", 1);
    expect(again.ended && fresh.ended, `${diag(again.read)} ${diag(fresh.read)}`).toBe(true);
    const notes = (rows: any[]) => rows.filter(m => m.memoryNote).map(m => String(m.tool?.name ?? m.text ?? "")).filter(note => note.includes(LEFT_OUT_NOTE) || note.includes(HELD_NOTE)).length;
    // base (435d038d9c + revoke-ioerr + withheld-compaction): the runner ticks as the background slice, the server's own background gate
    // refuses its writes (BG_DEFERRED, trying again), the '*' windows of a revoke in another chat stand, and the owner's next turn in
    // his own chat is dispatched without its memory and says so (the field lines, in the field order)
    expect({
      deferredRetries: serverLog().split("\n").filter(line => line.includes(DEFERRED_LINE)).length, windowsBeforeTurn,
      history: { dispatch: dispatchLines(again.log), checking: checkingLines(again.log), leftOutNotes: notes(again.read) },
      fresh: { dispatch: dispatchLines(fresh.log), checking: checkingLines(fresh.log), leftOutNotes: notes(fresh.read) },
    }, `${diag(again.read)} ${diag(fresh.read)}`).toEqual({ deferredRetries: 0, windowsBeforeTurn: 0,
      history: { dispatch: ["turn dispatch recall=full"], checking: 0, leftOutNotes: 0 }, fresh: { dispatch: ["turn dispatch recall=full"], checking: 0, leftOutNotes: 0 } });
    for (const turn of [again, fresh]) {
      expect(engineReplies(turn.read).map(m => String(m.text ?? ""))).toEqual([HARMLESS]);
      expect([...turn.read, ...turn.stored].map(shown).join("\n")).not.toContain(REPLY_WITHHELD);
    }
  }, 240_000);

  it("W-SECRET-CONTROL a reply that itself holds a credential is still redacted or held back for the owner, in the read and in the store", async () => {
    const { read, stored, ended } = await freshChatTurn("A reply with a credential", "keyonly", 1);
    expect(ended, diag(read)).toBe(true);
    const all = [...read, ...stored].map(shown).join("\n");
    expect(all).not.toContain(FIXTURE_VALUE);
    const reply = String(engineReplies(read).at(-1)?.text ?? "");
    expect(reply === REPLY_WITHHELD || reply.includes("«redacted"), diag(read)).toBe(true);
    expect(reply).not.toBe(`${HARMLESS} ${KEY_LINE}`);
  }, 180_000);
});
