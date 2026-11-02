// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall, design S (the seal), tests S6 and S7, through the real server and the fake Claude CLI.
// A native session handed recall output, and every session started before the seal moved, is never resumed,
// and no line is steered into it. The first session started at the current seal holds only Murage's own
// authorized replay: its cursor is bound to that generation (THREAD-SEAL 3.1) and it resumes like any other, until
// the next release. A sealed thread is never warmed.
//
// Covered: direct turns on a Claude engine (two engine instances, a restart that reloads the seal from
// disk), an engine switch, a rewind (edit), an audience move and a contract move, the /warm route, the task
// wire shape, the sealed-turn counter, and the steering fence (S7 a to d); then a routine run, a project card
// run, a delegated turn and an engine command on a sealed thread, and a seal written by the harness itself when
// a real thread_search answer is released (no manually installed seal), and a session that starts after the release carried by the
// real session.started fold; and the same sealed dispatch on the Codex, Pi and
// ACP (Fuigo) drivers, each read at the fake engine's own protocol (no thread/resume, switch_session or session/load).
//
// Needs a POSIX host (the fake CLIs are shebang scripts).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { RESTARTED_PREAMBLE, FRESH_PREAMBLE } from "./turn-context.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(join(SERVER_DIR, "store.ts")).href;
const WATCH_URL = pathToFileURL(join(SERVER_DIR, "memory", "reset-watch.ts")).href;
const ALLOWANCE_URL = pathToFileURL(join(SERVER_DIR, "memory", "lineage-allowance.ts")).href;
const posixOnly = describe.skipIf(process.platform === "win32");

/** The marks a prompt carries (turn-context.ts). */
const RESTARTED = RESTARTED_PREAMBLE;
const SWITCHED = FRESH_PREAMBLE.slice(0, 60);
const REWOUND = "The user rewound this conversation";

/**
 * Runs in the server child's main thread before the server loads: adds engine instances (every one a fake Claude CLI), has
 * every fake log each prompt and steer, and opens a small control file so a test can seal a thread inside the running
 * server (the real Store.sealThread) and read the sealed-turn counter.
 */
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');
  const dir=process.env.MURAGE_DATA_DIR;
  const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
  const base=cfg.instances.verification;
  const log=path.join(dir,'seal-turns.jsonl');
  const gate=(name)=>path.join(dir,name);
  const make=(env)=>({...base,environment:{...(base.environment??{}),FAKE_CLAUDE_DUMP_LOG:log,...env}});
  cfg.instances.verification=make({});
  cfg.instances.second=make({});
  cfg.instances.cmds=make({FAKE_CLAUDE_COMMANDS:'1'});
  cfg.instances.warmable=make({FAKE_CLAUDE_START_DELAY_MS:'1',FAKE_CLAUDE_START_LOG:gate('warm-starts.log')});
  cfg.instances.slowA=make({FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_REPLY_GATE:gate('gate-a')});
  cfg.instances.slowB=make({FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_REPLY_GATE:gate('gate-b')});
  cfg.instances.slowInitC=make({FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_START_DELAY_MS:'6500'});
  cfg.instances.slowInitD=make({FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_START_DELAY_MS:'6500'});
  const memoryLate=JSON.stringify({'murage-memory':2500,agents:2500});
  cfg.instances.early=make({FAKE_CLAUDE_INIT_AT_START:'1'});
  cfg.instances.noReinit=make({FAKE_CLAUDE_NO_REINIT:'1'});
  cfg.instances.gated=make({FAKE_CLAUDE_MCP_READY_MS:memoryLate});
  cfg.instances.earlyGated=make({FAKE_CLAUDE_INIT_AT_START:'1',FAKE_CLAUDE_MCP_READY_MS:memoryLate});
  cfg.instances.gatedLong=make({FAKE_CLAUDE_MCP_READY_MS:JSON.stringify({'murage-memory':6000,agents:6000}),MURAGE_MCP_REQUIRED_WAIT_MS:'20000'});
  cfg.instances.newIdGated=make({FAKE_CLAUDE_INIT_AT_START:'1',FAKE_CLAUDE_RESUME_NEW_ID:'reported-other-id',FAKE_CLAUDE_MCP_READY_MS:memoryLate});
  cfg.instances.newIdLate=make({FAKE_CLAUDE_RESUME_NEW_ID:'reported-other-id'});
  cfg.instances.finalSteer=make({FAKE_CLAUDE_MODE:'final-steer',FAKE_CLAUDE_FINAL_STEERS:'2'});
  cfg.instances.earlyWarm=make({FAKE_CLAUDE_INIT_AT_START:'1'});
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS='250';
  const {Store}=await import(${JSON.stringify(STORE_URL)});
  const watch=await import(${JSON.stringify(WATCH_URL)});
  // a resume after a restart must not meet the 50 ms budget of a cold lineage check (reason=lineage-warming, fail closed): a slow runner proves nothing here
  (await import(${JSON.stringify(ALLOWANCE_URL)})).setLineageTimeBudgetForTest(null);
  let store,lockedFolds=false;
  for(const name of ['taskByThread','bot']){const original=Store.prototype[name];Store.prototype[name]=function(...args){store=this;return original.apply(this,args);};}
  const saveCursor=Store.prototype.setResumeCursor;
  Store.prototype.setResumeCursor=function(...args){if(lockedFolds&&args[2]!==undefined)throw Object.assign(new Error('database is locked'),{errcode:5});if(args[2]!==undefined)fs.appendFileSync(gate('cursor-saves.jsonl'),JSON.stringify({cursor:args[2],sealStart:args[8]??null})+String.fromCharCode(10));return saveCursor.apply(this,args);};
  const ctl=gate('seal-ctl.json');const out=gate('seal-out.json');
  setInterval(()=>{
    let command;try{command=JSON.parse(fs.readFileSync(ctl,'utf8'));}catch{return;}
    fs.rmSync(ctl,{force:true});
    const result={id:command.id};
    try{
      if(command.seal)result.sealed=store.sealThread(command.seal[0],command.seal[1]);
      if(command.counts)result.counts=watch.sealedTurnCounts();
      if(command.gauges)result.gauges=watch.sessionGauges();
      if(command.lockFolds!==undefined)lockedFolds=command.lockFolds;
      if(command.pair)saveCursor.apply(store,command.pair);
    }catch(error){result.error=String(error);}
    fs.writeFileSync(out,JSON.stringify(result));
  },30).unref();
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let sequence = 0;

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const authenticate = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret }; };
const file = (name: string) => join(fixture.info.dataDir, name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Not expect.poll: the setup hook uses this too. */
async function waitUntil(check: () => unknown | Promise<unknown>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const logged = () => (existsSync(file("seal-turns.jsonl")) ? readFileSync(file("seal-turns.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { botId: string | null; threadId: string | null; prompt?: string; steer?: string }) : []);

interface Bot { id: string; threadId: string }
let control = 0;
/** Asks the running server (through the instrumentation) to seal a thread or report the sealed-turn counter. */
async function ask(command: { seal?: [string, string]; counts?: true; gauges?: true; lockFolds?: boolean; pair?: unknown[] }) {
  const id = ++control;
  rmSync(file("seal-out.json"), { force: true });
  writeFileSync(file("seal-ctl.json"), JSON.stringify({ ...command, id }));
  await expect.poll(() => readJson(file("seal-out.json"))?.id, { timeout: 10_000 }).toBe(id);
  const answer = readJson(file("seal-out.json"));
  expect(answer.error, JSON.stringify(answer)).toBeUndefined();
  return answer;
}
const seal = (bot: Bot, threadId = bot.threadId) => ask({ seal: [bot.id, threadId] });

async function createBot(instanceId: string, name: string): Promise<Bot> {
  const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
  const modelSelection = { instanceId, model: instance.models.options[0].id };
  const created = await call("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
  expect(created.status, created.text).toBe(201);
  const bot = created.body.bot as Bot;
  expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
  return bot;
}
const botView = async (bot: Bot) => (await call("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
const isIdle = async (bot: Bot) => (await botView(bot))?.busy === false;
const mark = (label: string) => `${label}_${++sequence}`;

/** The task as saved on disk (bots.json is the saved roster). */
const taskOnDisk = (bot: Bot, threadId = bot.threadId): any =>
  (JSON.parse(readFileSync(file("bots.json"), "utf8")) as any[]).find((row) => row.id === bot.id)?.tasks?.find((task: any) => task.threadId === threadId);
/** Everything a pre-seal session left on the task: the cursor and the three records beside it. */
const sessionMeta = (task: any) => JSON.stringify([task?.resumeCursors ?? null, task?.resumeAudiences ?? null, task?.resumeContracts ?? null, task?.resumePlainToolNames ?? null]);
const editDisk = (change: (rows: any[]) => void) => { const rows = JSON.parse(readFileSync(file("bots.json"), "utf8")); change(rows); writeFileSync(file("bots.json"), JSON.stringify(rows)); };
const taskRow = (rows: any[], bot: Bot, threadId = bot.threadId) => rows.find((row) => row.id === bot.id).tasks.find((task: any) => task.threadId === threadId);

/** What the fake Claude CLI was launched with for the turn that carried `tag`: argv and the whole prompt. */
async function engineSaw(tag: string) {
  let dump: any;
  await waitUntil(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, `the engine to receive ${tag}`);
  return { argv: dump.argv as string[], prompt: JSON.stringify(dump.prompt), pid: dump.pid as number };
}
/** One direct message and the engine launch it caused, after the turn settled. */
async function turn(bot: Bot, text: string, threadId = bot.threadId) {
  const tag = mark("SEALTAG");
  rmSync(fixture.fixtureDumpPath, { force: true });
  const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text: `${text} ${tag}`, threadId });
  expect(sent.status, sent.text).toBe(202);
  const saw = await engineSaw(tag);
  await waitUntil(() => isIdle(bot), "the turn to settle");
  return { ...saw, tag };
}
const resumed = (argv: string[]) => argv.includes("--resume");
/** The native session a turn ran in, whether its process was spawned for it (--resume, --session-id) or kept from the turn before. */
const sessionOf = (argv: string[]): string => argv[argv.includes("--resume") ? argv.indexOf("--resume") + 1 : argv.indexOf("--session-id") + 1]!;
/** Saved to disk, the cursor and its binding for this engine (the save is coalesced). */
const bound = (bot: Bot, instanceId = "verification", threadId = bot.threadId) => waitUntil(() => { const task = taskOnDisk(bot, threadId); const entry = task?.resumeSeals?.[instanceId]; return task?.resumeCursors?.[instanceId] !== undefined && entry?.cursor === task.resumeCursors[instanceId] && entry.generation >= (task.sealGeneration ?? 0); }, "the cursor to be saved with its binding", 15_000);
const waitCursor = (bot: Bot) => waitUntil(() => taskOnDisk(bot)?.resumeCursors?.verification && taskOnDisk(bot)?.resumeContracts?.verification !== undefined, "the first cursor to be saved", 15_000);

posixOnly("thread recall seal at dispatch (S2, S3, S4)", () => {
  const bots: Record<string, Bot> = {};
  let preSealCursor = "";

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    await authenticate();
    for (const [key, instanceId] of [["cursor", "verification"], ["stripped", "verification"], ["fresh", "verification"], ["aud", "verification"], ["con", "verification"],
      ["switch", "verification"], ["rewind", "verification"], ["second", "second"], ["plain", "verification"], ["ten", "verification"], ["warmSealed", "warmable"], ["warmOpen", "warmable"],
      ["mixed", "verification"]] as const) bots[key] = await createBot(instanceId, key);
    // a first, ordinary turn on the engine-backed bots: this is the session a recall later outlives
    for (const key of ["cursor", "stripped", "aud", "con", "switch", "rewind", "plain", "ten", "mixed"]) {
      await turn(bots[key]!, `PRE_${key} remember the word PELICAN_${key}`);
      await waitCursor(bots[key]!);
    }
    await turn(bots.rewind!, "PRE2_rewind and a second line");
    await turn(bots.second!, "PRE_second remember the word PELICAN_second");
    await waitUntil(() => taskOnDisk(bots.second!)?.resumeCursors?.second, "the second engine's cursor", 15_000);
    await sleep(1_500);
    preSealCursor = taskOnDisk(bots.cursor!).resumeCursors.verification;
    // Seal on disk, then restart: the seal is read back from the saved roster. Four bots carry an unusual pre-seal state.
    await fixture.stop();
    editDisk((rows) => {
      for (const key of ["cursor", "stripped", "aud", "con", "switch", "rewind", "second", "ten", "warmSealed", "mixed"]) taskRow(rows, bots[key]!).sealGeneration = 1;
      // no pre-seal cursor at all (an old thread, or one whose cursor was dropped), though the thread did run
      delete rows.find((row) => row.id === bots.stripped!.id).resumeCursors; // the bot-level mirror of the active task's cursor
      const stripped = taskRow(rows, bots.stripped!); delete stripped.resumeCursors; delete stripped.resumeAudiences; delete stripped.resumeContracts; delete stripped.resumePlainToolNames;
      taskRow(rows, bots.aud!).resumeAudiences = { verification: "a-different-audience" };
      delete taskRow(rows, bots.con!).resumeContracts;
    });
    await fixture.restart();
    await authenticate();
  }, 300_000);

  afterAll(async () => { await fixture?.close(); });

  it("the seal reads back from disk after a restart, and the roster and task wire carry no sealGeneration", async () => {
    expect(taskOnDisk(bots.cursor!).sealGeneration).toBe(1);
    const roster = await call("GET", "/api/bots");
    expect(roster.status).toBe(200);
    expect(roster.text).not.toContain("sealGeneration");
    expect(roster.text).not.toContain("resumeSeals");
    const one = await call("GET", `/api/bots/${bots.cursor!.id}/tasks/${bots.cursor!.threadId}`);
    expect(one.status).toBe(200);
    expect(one.body.task.threadId).toBe(bots.cursor!.threadId);
    expect(one.text).not.toContain("sealGeneration");
    expect(one.text).not.toContain("resumeSeals");
    const list = await call("GET", `/api/bots/${bots.cursor!.id}/tasks`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("sealGeneration");
    expect(list.text).not.toContain("resumeSeals");
    const patched = await call("PATCH", `/api/bots/${bots.cursor!.id}/tasks/${bots.cursor!.threadId}`, { unread: false });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain("sealGeneration");
    expect(patched.text).not.toContain("resumeSeals");
  });

  it("the first turn after a seal is fresh and replays, and the turns after it continue that session with no replay", async () => {
    const bot = bots.cursor!;
    const first = await turn(bot, "SEALED_1 what was the word");
    expect(resumed(first.argv)).toBe(false);
    expect(first.argv).toContain("--session-id");
    const started = sessionOf(first.argv);
    expect(started).not.toBe(preSealCursor);
    expect(first.prompt).toContain(RESTARTED);
    expect(first.prompt).not.toContain(SWITCHED);
    expect(first.prompt).toContain("PELICAN_cursor");
    // the session.started of that turn replaced the pre-seal cursor and bound the new one to the current seal
    await bound(bot);
    expect(taskOnDisk(bot).resumeCursors.verification).toBe(started);
    expect(taskOnDisk(bot).resumeSeals.verification).toEqual({ cursor: started, generation: 1 });
    for (const n of [2, 3]) {
      const saw = await turn(bot, `SEALED_${n} and the next`);
      expect(sessionOf(saw.argv), `turn ${n}`).toBe(started);
      expect(saw.prompt).not.toContain(RESTARTED);
    }
    expect(taskOnDisk(bot).resumeSeals.verification).toEqual({ cursor: started, generation: 1 });
    expect(serverLog()).not.toMatch(/continuation reset/);
  }, 120_000);

  it("a sealed thread with no pre-seal cursor at all opens as restarted once, then continues", async () => {
    const bot = bots.stripped!;
    const first = await turn(bot, "STRIPPED_1 go on");
    expect(resumed(first.argv)).toBe(false);
    expect(first.prompt).toContain(RESTARTED);
    expect(first.prompt).not.toContain(SWITCHED);
    expect(first.prompt).toContain("PELICAN_stripped");
    await bound(bot);
    const next = await turn(bot, "STRIPPED_2 go on");
    expect(sessionOf(next.argv)).toBe(sessionOf(first.argv));
    expect(next.prompt).not.toContain(RESTARTED);
  }, 120_000);

  it("a sealed thread that never ran starts fresh with the conversation replayed and no cursor", async () => {
    const bot = bots.fresh!;
    await seal(bot);
    const saw = await turn(bot, "FIRST_EVER hello");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.argv).toContain("--session-id");
    await bound(bot);
    expect(taskOnDisk(bot).resumeSeals.verification.generation).toBe(1);
    expect(taskOnDisk(bot).sealGeneration).toBe(1);
  }, 60_000);

  it("a sealed thread on a second engine instance behaves the same, after a restart", async () => {
    const bot = bots.second!;
    const first = await turn(bot, "SECOND_1 carry on");
    expect(resumed(first.argv)).toBe(false);
    expect(first.prompt).toContain(RESTARTED);
    expect(first.prompt).toContain("PELICAN_second");
    await bound(bot, "second");
    const next = await turn(bot, "SECOND_2 carry on");
    expect(sessionOf(next.argv)).toBe(sessionOf(first.argv));
    expect(next.prompt).not.toContain(RESTARTED);
  }, 120_000);

  it("a sealed turn after an engine switch opens as a switch (the fresh preamble), and the new engine's session then continues", async () => {
    const bot = bots.switch!;
    const model = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "second").models.options[0].id;
    expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "second", model }, computer: "off" })).status).toBe(200);
    const switched = await turn(bot, "AFTER_SWITCH who are you");
    expect(resumed(switched.argv)).toBe(false);
    expect(switched.prompt).toContain(SWITCHED);
    expect(switched.prompt).not.toContain(RESTARTED);
    await bound(bot, "second");
    const again = await turn(bot, "AFTER_SWITCH_TWO and again");
    expect(sessionOf(again.argv)).toBe(sessionOf(switched.argv));
    expect(again.prompt).not.toContain(RESTARTED);
    expect(again.prompt).not.toContain(SWITCHED);
  }, 120_000);

  it("a sealed rewind (an edit) opens as rewound, and is never continued past the rewind", async () => {
    const bot = bots.rewind!;
    const mine = (await botView(bot)).messages.find((m: any) => m.role === "user" && m.kind === "text" && String(m.text).includes("PRE2_rewind"));
    const tag = mark("EDITED");
    rmSync(fixture.fixtureDumpPath, { force: true });
    const edited = await call("POST", `/api/bots/${bot.id}/messages/${mine.id}/edit`, { text: `EDITED history ${tag}` });
    expect(edited.status, edited.text).toBe(202);
    const saw = await engineSaw(tag);
    await expect.poll(() => isIdle(bot), { timeout: 30_000 }).toBe(true);
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(REWOUND);
    expect(saw.prompt).not.toContain(RESTARTED);
    // the rewind's own patch empties the cursors (and their bindings) when its dispatch is taken: what is left decides the next turn, as anywhere
    await sleep(1_000);
    const held = taskOnDisk(bot).resumeCursors?.verification;
    const after = await turn(bot, "AFTER_REWIND next");
    if (held === undefined) {
      expect(resumed(after.argv)).toBe(false);
      expect(after.prompt).toContain(RESTARTED);
    } else {
      expect(sessionOf(after.argv)).toBe(sessionOf(saw.argv));
      expect(after.prompt).not.toContain(RESTARTED);
    }
  }, 120_000);

  it("a tainted turn after an audience move opens as restarted (not a switch), notes no reset, and its session then carries the new audience", async () => {
    const bot = bots.aud!;
    expect(sessionMeta(taskOnDisk(bot))).toContain("a-different-audience");
    const saw = await turn(bot, "AUDIENCE_MOVED continue");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(saw.prompt).not.toContain(SWITCHED);
    await bound(bot);
    // cursor metadata is live again on a sealed thread
    expect(sessionMeta(taskOnDisk(bot))).not.toContain("a-different-audience");
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
    const next = await turn(bot, "AUDIENCE_MOVED_TWO continue");
    expect(sessionOf(next.argv)).toBe(sessionOf(saw.argv));
  }, 60_000);

  it("a tainted turn after a contract move opens as restarted (not a switch), notes no reset, and its session then carries the contract", async () => {
    const bot = bots.con!;
    expect(taskOnDisk(bot).resumeContracts).toBeUndefined();
    const saw = await turn(bot, "CONTRACT_MOVED continue");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(saw.prompt).not.toContain(SWITCHED);
    await bound(bot);
    expect(taskOnDisk(bot).resumeContracts?.verification).toBeDefined();
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
    const next = await turn(bot, "CONTRACT_MOVED_TWO continue");
    expect(sessionOf(next.argv)).toBe(sessionOf(saw.argv));
  }, 60_000);

  it("a thread that was never recalled resumes its session exactly as before", async () => {
    const bot = bots.plain!;
    const cursor = taskOnDisk(bot).resumeCursors.verification;
    expect(taskOnDisk(bot).sealGeneration).toBeUndefined();
    const saw = await turn(bot, "NOT_SEALED continue");
    expect(saw.argv[saw.argv.indexOf("--resume") + 1]).toBe(cursor);
    expect(saw.prompt).not.toContain(RESTARTED);
    expect(saw.prompt).not.toContain(SWITCHED);
  }, 60_000);

  it("a new conversation of a sealed bot is unsealed: it stores its cursor and opens with no restart notice", async () => {
    const bot = bots.cursor!;
    const created = await call("POST", `/api/bots/${bot.id}/tasks`, { title: "A new conversation" });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain("sealGeneration");
    const threadId = created.body.task.threadId as string;
    expect(taskOnDisk(bot, threadId).sealGeneration).toBeUndefined();
    const saw = await turn(bot, "NEW_THREAD hello", threadId);
    expect(saw.prompt).not.toContain(RESTARTED);
    await expect.poll(() => taskOnDisk(bot, threadId)?.resumeCursors?.verification, { timeout: 15_000 }).toBeTruthy();
    expect(taskOnDisk(bot, threadId).sealGeneration).toBeUndefined();
    // the sealed thread is still sealed
    expect(taskOnDisk(bot).sealGeneration).toBe(1);
  }, 60_000);

  it("/warm on a sealed thread starts no engine and answers started false; on an unsealed thread it warms as before", async () => {
    const starts = () => (existsSync(file("warm-starts.log")) ? readFileSync(file("warm-starts.log"), "utf8").split("\n").filter(Boolean).length : 0);
    const sealed = bots.warmSealed!, open = bots.warmOpen!;
    // each thread takes one turn first: the engine remembers how to start itself for a thread only after one (claude.ts lastTurns),
    // then lets the idle engine go when the (shortened) activity window passes
    await turn(sealed, "WARM_SEALED_TURN hello");
    await turn(open, "WARM_OPEN_TURN hello");
    await sleep(3_000);
    const baseline = starts();
    expect(baseline).toBe(2);
    const refused = await call("POST", `/api/bots/${sealed.id}/warm`, { threadId: sealed.threadId });
    expect(refused.status).toBe(200);
    expect(refused.body).toEqual({ warming: true, started: false });
    await sleep(2_000);
    expect(starts()).toBe(baseline);
    const warmed = await call("POST", `/api/bots/${open.id}/warm`, { threadId: open.threadId });
    expect(warmed.status).toBe(200);
    expect(warmed.body.warming).toBe(true);
    expect(warmed.body.started).toBe(true);
    await expect.poll(starts, { timeout: 15_000 }).toBe(baseline + 1);
    // (j) a clean turn ended and its session is resumable: the seal still refuses the warm, and the same with a chat's own engine
    await bound(sealed, "warmable");
    const task = await call("POST", `/api/bots/${sealed.id}/tasks`, { title: "Its own engine" });
    const threadId = task.body.task.threadId as string;
    const model = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
    expect((await call("PATCH", `/api/bots/${sealed.id}/tasks/${threadId}`, { modelSelection: { instanceId: "verification", model } })).status).toBe(200);
    await seal(sealed, threadId);
    await turn(sealed, "WARM_OVERRIDE_TURN hello", threadId);
    await bound(sealed, "verification", threadId);
    await sleep(2_000);
    const before = starts();
    for (const refusedThread of [sealed.threadId, threadId]) {
      expect((await call("POST", `/api/bots/${sealed.id}/warm`, { threadId: refusedThread })).body).toEqual({ warming: true, started: false });
    }
    await sleep(1_000);
    expect(starts()).toBe(before);
  }, 90_000);

  it("ten turns on a sealed thread raise no reset-loop warning and only the tainted one is counted", async () => {
    const bot = bots.ten!;
    for (let n = 1; n <= 10; n++) {
      const saw = await turn(bot, `TEN_${n} again`);
      expect(saw.prompt.includes(RESTARTED), `turn ${n}`).toBe(n === 1);
      if (n === 1) await bound(bot);
    }
    const counts = (await ask({ counts: true })).counts as Array<{ threadId: string; count: number; instances: string[] }>;
    expect(counts.find((entry) => entry.threadId === bot.threadId)).toMatchObject({ count: 1, instances: ["verification"] });
    expect(serverLog()).not.toMatch(/continuation reset loop/);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
    const gauges = (await ask({ gauges: true })).gauges as { taintedFresh: number; resumedTurns: number };
    expect(gauges.taintedFresh).toBeGreaterThan(0);
    expect(gauges.resumedTurns).toBeGreaterThanOrEqual(9);
    expect((await call("GET", "/api/health")).body.warm).toMatchObject(gauges);
  }, 300_000);

  it("a seal that lands between turns (the live server's own sealThread) takes effect on the very next dispatch", async () => {
    const bot = bots.mixed!;
    // this bot was sealed on disk too; seal it once more in the running server: the number only rises, the behaviour is the same
    expect((await seal(bot)).sealed).toBe(2);
    const saw = await turn(bot, "BUMPED go on");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(taskOnDisk(bot).sealGeneration).toBe(2);
    await bound(bot);
    expect(taskOnDisk(bot).resumeSeals.verification.generation).toBe(2);
    expect(sessionOf((await turn(bot, "BUMPED_TWO go on")).argv)).toBe(sessionOf(saw.argv));
  }, 60_000);
});

posixOnly("no line is steered into a session started below the seal (S7 a to d)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    await authenticate();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  const hasChip = async (bot: Bot) => (await botView(bot)).messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok === true);
  const texts = async (bot: Bot): Promise<Array<{ role: string; text: string; steered: boolean }>> => (await botView(bot)).messages.filter((m: any) => m.kind === "text").map((m: any) => ({ role: m.role as string, text: String(m.text), steered: m.steered === true }));
  const steerEntries = () => logged().filter((entry) => entry.steer !== undefined);

  /** The shared assertions once a refused steer has run as its own turn. `steered` lines before it: what another test of this block wrote. */
  async function expectRunAsOwnSealedTurn(bot: Bot, line: string, refusalLogged = true) {
    await expect.poll(async () => (await texts(bot)).some((m) => m.role === "bot" && m.text.includes(line)), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => isIdle(bot), { timeout: 60_000 }).toBe(true);
    const all = await texts(bot);
    // the line is in the transcript once, as its own message, not a steered one
    expect(all.filter((m) => m.role === "user" && m.text === line)).toEqual([{ role: "user", text: line, steered: false }]);
    // no reply was ever folded together with a steer, and the engine was never written a steer
    expect(all.some((m) => m.text.includes("+ steered:"))).toBe(false);
    expect(steerEntries().filter((entry) => JSON.stringify(entry).includes(line))).toEqual([]);
    // its own turn opened as a restarted session
    const own = logged().find((entry) => entry.prompt !== undefined && entry.prompt.includes(line));
    expect(own?.prompt).toContain(RESTARTED);
    // an intended refusal is neither a reset nor a loop
    if (refusalLogged) {
      expect(serverLog()).toContain(`thread recall steer refused thread=${bot.threadId}`);
      expect(serverLog()).toContain("reason=steer-refused sealed");
    }
    expect(serverLog()).not.toMatch(/steer-refused session-invalid/);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
  }

  it("(a) a steer into a clean turn of a sealed thread, before any release in it, is judged by the session check as on any thread", async () => {
    const bot = await createBot("slowA", "steer a");
    await seal(bot);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "first sealed turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hasChip(bot), { timeout: 20_000 }).toBe(true);
    const second = await call("POST", `/api/bots/${bot.id}/messages`, { text: "second line a", threadId: bot.threadId });
    expect(second.status, second.text).toBe(202);
    expect(second.body.steered).toBe(true);
    await expect.poll(() => steerEntries().length, { timeout: 10_000 }).toBe(1);
    writeFileSync(file("gate-a"), "go");
    await expect.poll(() => isIdle(bot), { timeout: 60_000 }).toBe(true);
    expect((await texts(bot)).some((m) => m.text.includes("+ steered: second line a"))).toBe(true);
    expect(serverLog()).not.toContain(`thread recall steer refused thread=${bot.threadId}`);
  }, 120_000);

  it("(b) the seal lands while the recalling turn runs: a steer after the bump is refused before any write", async () => {
    const bot = await createBot("slowB", "steer b");
    // the turn is dispatched unsealed, exactly like the turn that carries the recall
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "recalling turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hasChip(bot), { timeout: 20_000 }).toBe(true);
    expect(taskOnDisk(bot).sealGeneration).toBeUndefined();
    await seal(bot);
    const second = await call("POST", `/api/bots/${bot.id}/messages`, { text: "second line b", threadId: bot.threadId });
    expect(second.status, second.text).toBe(202);
    expect(second.body.steered).not.toBe(true);
    expect(second.body.queued).toBe(true);
    writeFileSync(file("gate-b"), "go");
    await expectRunAsOwnSealedTurn(bot, "second line b");
    // the first turn's reply is the plain one: nothing was folded into it
    const first = (await texts(bot)).find((m) => m.role === "bot" && m.text.startsWith("reply to:") && m.text.includes("recalling turn"));
    expect(first?.text).not.toContain("steered");
  }, 120_000);

  it("(c) the seal lands while an accepted steer waits for the engine: the fence refuses it at the flush and nothing is written", async () => {
    const bot = await createBot("slowInitC", "steer c");
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "slow starting turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    // the engine has not handled its init yet: the steer is taken and waits (claude.ts queuedSteers)
    const waiting = call("POST", `/api/bots/${bot.id}/messages`, { text: "second line c", threadId: bot.threadId });
    await sleep(1_200);
    await seal(bot);
    const second = await waiting;
    expect(second.status, second.text).toBe(202);
    expect(second.body.steered).not.toBe(true);
    // the refusal came from the write fence at the flush, which logs nothing: the line simply ran as its own turn
    await expectRunAsOwnSealedTurn(bot, "second line c", false);
  }, 180_000);

  it("(d) a Claude engine that flushes queued steers at init: on a clean turn of a sealed thread the seal refuses nothing", async () => {
    const bot = await createBot("slowInitD", "steer d");
    await seal(bot);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "slow sealed turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    const second = await call("POST", `/api/bots/${bot.id}/messages`, { text: "second line d", threadId: bot.threadId });
    expect(second.status, second.text).toBe(202);
    await expect.poll(async () => (await texts(bot)).some((m) => m.role === "bot" && m.text.includes("second line d")), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => isIdle(bot), { timeout: 60_000 }).toBe(true);
    expect(serverLog()).not.toContain(`thread recall steer refused thread=${bot.threadId}`);
  }, 180_000);
});

posixOnly("a sealed thread on every dispatch kind, and a seal written by a real recall (S6)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    await authenticate();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  const finish = (pid: number) => writeFileSync(join(fixture.fixtureFinishGateDir, String(pid)), "finish");
  /** The fake engine's dump once it names `tag`, with this turn's MCP secrets put back. */
  async function dumpWith(tag: string) {
    let dump: any;
    await waitUntil(() => { try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (!text.includes(tag)) return false; dump = withTurnSecrets(JSON.parse(text)); return true; } catch { return false; } }, `the engine to receive ${tag}`);
    return dump as { pid: number; argv: string[]; prompt: unknown; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } };
  }
  const memoryEnv = (dump: Awaited<ReturnType<typeof dumpWith>>) => Object.values(dump.mcpConfig?.mcpServers ?? {}).map((server) => server.env).find((env) => env?.MURAGE_MEMORY_TOKEN)!;
  /** Gives a bot a first, ordinary turn so it holds a cursor a sealed dispatch could have resumed. */
  async function withCursor(bot: Bot, word: string) {
    await turn(bot, `PRE_${word} remember the word PELICAN_${word}`);
    await waitCursor(bot);
    await sleep(1_000);
    return taskOnDisk(bot).resumeCursors.verification as string;
  }
  /** What a tainted dispatch of any kind must look like: a new session, never the held cursor. */
  function expectFreshSealed(saw: { argv: string[]; prompt: string }, heldCursor: string) {
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.argv).toContain("--session-id");
    expect(saw.argv[saw.argv.indexOf("--session-id") + 1]).not.toBe(heldCursor);
    expect(saw.argv.join(" ")).not.toContain(heldCursor);
  }

  it("a routine run in a sealed routine thread never resumes the session from before the seal", async () => {
    const bot = await createBot("verification", "routine");
    const tag = mark("ROUTINE_RUN");
    const created = await call("POST", "/api/routines", { name: "Seal check", botId: bot.id, prompt: `Write the report. ${tag}`, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 } });
    expect(created.status, created.text).toBe(201);
    const routineId = created.body.routine.id as string;
    const run = async () => { rmSync(fixture.fixtureDumpPath, { force: true }); expect((await call("POST", `/api/routines/${routineId}/run`)).status).toBeLessThan(300); return engineSaw(tag); };
    const first = await run();
    expect(resumed(first.argv)).toBe(false);
    await waitUntil(async () => (await call("GET", "/api/routines")).body.runs.some((r: any) => r.routineId === routineId && ["completed", "failed"].includes(r.status)), "the first run to finish");
    const threadId = (await call("GET", "/api/routines")).body.routines.find((r: any) => r.id === routineId).threadId as string;
    expect(threadId).toBeTruthy();
    await waitUntil(() => taskOnDisk(bot, threadId)?.resumeCursors?.verification, "the routine thread's cursor", 15_000);
    await sleep(1_000);
    const held = taskOnDisk(bot, threadId).resumeCursors.verification as string;
    await seal(bot, threadId);
    await waitUntil(async () => (await call("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routineId && !["completed", "failed"].includes(r.status)).length === 0, "no live run");
    const second = await run();
    expectFreshSealed(second, held);
    await waitUntil(async () => (await call("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routineId && ["completed", "failed"].includes(r.status)).length >= 2, "the second run to finish");
    await sleep(1_500);
    // a routine run may end its session unretained (dropCursor); what it may never leave behind is the session from before the seal
    expect(taskOnDisk(bot, threadId).resumeCursors?.verification).not.toBe(held);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${threadId}`));
  }, 180_000);

  it("a project card run in a sealed desk thread never resumes the session from before the seal", async () => {
    const bot = await createBot("verification", "card");
    const group = (await call("POST", "/api/groups", { name: "Seal board", memberIds: [bot.id], setup: { bulletin: "Seal checks", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
    expect((await call("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Seal checks" } })).status).toBe(200);
    const runCard = async (title: string) => {
      const card = (await call("POST", `/api/groups/${group.id}/board/cards`, { clientId: `seal-${title}`, title, assigneeBotId: bot.id, writes: false })).body.card;
      expect(card).toBeTruthy();
      rmSync(fixture.fixtureDumpPath, { force: true });
      expect((await call("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
      const saw = await engineSaw(title);
      await waitUntil(async () => ["done", "review"].includes((await call("GET", `/api/groups/${group.id}/board`)).body.cards.find((c: any) => c.id === card.id)?.state), "the card to settle", 60_000);
      return { saw, card };
    };
    const first = await runCard(mark("SEALCARD_ONE"));
    expect(resumed(first.saw.argv)).toBe(false);
    const deskThreadId = (await call("GET", `/api/groups/${group.id}/board`)).body.cards.find((c: any) => c.id === first.card.id).deskThreadId as string;
    expect(deskThreadId).toBeTruthy();
    await waitUntil(() => taskOnDisk(bot, deskThreadId)?.resumeCursors?.verification, "the desk's cursor", 15_000);
    await sleep(1_000);
    const held = taskOnDisk(bot, deskThreadId).resumeCursors.verification as string;
    await seal(bot, deskThreadId);
    await waitUntil(() => isIdle(bot), "the desk to be idle");
    const second = await runCard(mark("SEALCARD_TWO"));
    expectFreshSealed(second.saw, held);
    await sleep(1_500);
    expect(taskOnDisk(bot, deskThreadId).resumeCursors?.verification).not.toBe(held);
  }, 240_000);

  it("a delegated turn in a sealed thread never resumes the session from before the seal", async () => {
    const asker = await createBot("verification", "asker"), peer = await createBot("verification", "peer");
    const held = await withCursor(peer, "peer");
    await seal(peer);
    const holdTag = mark("ASKER_HOLD");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${asker.id}/messages`, { text: `Hold on. __fixture_hold_authority__ ${holdTag}`, threadId: asker.threadId })).status).toBe(202);
    const holding = await dumpWith(holdTag);
    const token = Object.values(holding.mcpConfig?.mcpServers ?? {}).map((server) => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;
    expect(token).toBeTruthy();
    const tag = mark("DELEGATED");
    const asked = await call("POST", "/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: `Pass this on. ${tag}` });
    // the internal routes answer to the capability, not the desktop proof
    const delegated = await fetch(fixture.info.url + "/api/internal/delegate-bot", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: `Pass this on. ${tag}` }) });
    expect(delegated.status, await delegated.text()).toBe(200);
    expect(asked.status).toBeGreaterThanOrEqual(400);
    finish(holding.pid);
    const saw = await engineSaw(tag);
    expectFreshSealed(saw, held);
    await waitUntil(() => isIdle(peer), "the delegated turn to settle");
    await sleep(1_500);
    expect(taskOnDisk(peer).resumeCursors?.verification).not.toBe(held);
  }, 180_000);

  it("an engine command in a sealed thread never resumes the session from before the seal", async () => {
    const bot = await createBot("cmds", "command");
    await turn(bot, "PRE_command remember the word PELICAN_command");
    await waitUntil(async () => (await call("GET", `/api/bots/${bot.id}/engine-commands`)).body.status === "ready", "the engine to report its commands", 15_000);
    await waitUntil(() => taskOnDisk(bot)?.resumeCursors?.cmds, "the first cursor to be saved", 15_000);
    await sleep(1_000);
    const held = taskOnDisk(bot).resumeCursors.cmds as string;
    await seal(bot);
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "/context", threadId: bot.threadId })).status).toBeLessThan(300);
    const saw = await engineSaw("/context");
    expectFreshSealed(saw, held);
    await waitUntil(() => isIdle(bot), "the command to settle");
    await sleep(1_500);
    expect(taskOnDisk(bot).resumeCursors?.cmds).not.toBe(held);
  }, 120_000);

  /** One real recall: a held turn calls the harness's own thread_search route with its memory capability, as the engine's proxy would. */
  async function recallDuringTurn(bot: Bot, query: string) {
    const tag = mark("RECALL_HOLD");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `Hold on. __fixture_hold_authority__ ${tag}`, threadId: bot.threadId })).status).toBe(202);
    const holding = await dumpWith(tag);
    const env = memoryEnv(holding);
    expect(env, "the turn was given the memory mount").toBeTruthy();
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${env.MURAGE_HARNESS_URL}/api/internal/memory/${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.MURAGE_MEMORY_TOKEN}` }, body: JSON.stringify(body) });
      const text = await response.text(); let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: parsed, text };
    };
    return { post, holding, search: await post("thread-search", { query }) };
  }

  it("a real thread_search release seals the thread: the next turn is fresh, the one after resumes it, and a release there makes the next fresh", async () => {
    const bot = await createBot("verification", "recall");
    const held = await withCursor(bot, "real");
    expect(taskOnDisk(bot).sealGeneration ?? 0).toBe(0);
    const { search, holding } = await recallDuringTurn(bot, "PELICAN_real");
    expect(search.status, search.text).toBe(200);
    expect(search.body.hits.length).toBeGreaterThanOrEqual(1);
    await waitUntil(() => (taskOnDisk(bot)?.sealGeneration ?? 0) >= 1, "the harness to seal the thread");
    finish(holding.pid);
    await waitUntil(() => isIdle(bot), "the recalling turn to settle");
    const next = await turn(bot, "AFTER_REAL_RECALL carry on");
    expectFreshSealed(next, held);
    expect(next.prompt).toContain(RESTARTED);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
    await bound(bot);
    const clean = await turn(bot, "AFTER_REAL_RECALL_TWO carry on");
    expect(sessionOf(clean.argv)).toBe(sessionOf(next.argv));
    expect(clean.prompt).not.toContain(RESTARTED);
    // (k) a release during that resumed session: the next turn never sees it again, and the turn after resumes the new one
    const again = await recallDuringTurn(bot, "PELICAN_real");
    expect(again.search.status, again.search.text).toBe(200);
    await waitUntil(() => (taskOnDisk(bot)?.sealGeneration ?? 0) >= 2, "the second release to raise the seal");
    finish(again.holding.pid);
    await waitUntil(() => isIdle(bot), "the second recalling turn to settle");
    const fresh = await turn(bot, "AFTER_SECOND_RECALL carry on");
    expectFreshSealed(fresh, sessionOf(next.argv));
    expect(fresh.prompt).toContain(RESTARTED);
    await bound(bot);
    expect(sessionOf((await turn(bot, "AFTER_SECOND_RECALL_TWO carry on")).argv)).toBe(sessionOf(fresh.argv));
  }, 240_000);

  it("with memory off the thread tools still answer, and release and seal, while memory_* keep refusing (rule 18)", async () => {
    expect((await call("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    try {
      const bot = await createBot("verification", "recall off");
      const held = await withCursor(bot, "offmode");
      const { search, post, holding } = await recallDuringTurn(bot, "PELICAN_offmode");
      expect(search.status, search.text).toBe(200);
      expect(search.body.hits.length).toBeGreaterThanOrEqual(1);
      expect((await post("thread-list", {})).status).toBe(200);
      const refused = await post("search", { query: "PELICAN_offmode" });
      expect(refused.status).toBe(409);
      await waitUntil(() => (taskOnDisk(bot)?.sealGeneration ?? 0) >= 1, "the harness to seal the thread");
      finish(holding.pid);
      await waitUntil(() => isIdle(bot), "the recalling turn to settle");
      const next = await turn(bot, "AFTER_OFF_RECALL carry on");
      expectFreshSealed(next, held);
    } finally {
      expect((await call("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    }
  }, 180_000);
});

const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** Adds a Codex, a Pi and a Fuigo (ACP) instance, each with a log of what the harness sent its fake engine. */
const engineInstrumentation = instrumentation.replace("fs.writeFileSync(cfgFile,JSON.stringify(cfg));", `
  fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
  cfg.instances['seal-codex']={driver:'codex',displayName:'Codex fixture',environment:{FAKE_CODEX_MODE:'resume',FAKE_CODEX_UNIQUE_THREADS:'1',FAKE_CODEX_CALL_LOG:gate('codex-calls.log'),FAKE_CODEX_DUMP:gate('codex-dump.json')},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
  cfg.instances['seal-pi']={driver:'piAgent',displayName:'Pi fixture',environment:{FAKE_PI_COMMAND_LOG:gate('pi-commands.log'),FAKE_PI_UNIQUE:'1'},config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true}};
  cfg.instances['seal-acp']={driver:'fuigoAgent',displayName:'Fuigo fixture',environment:{FAKE_ACP_MCP_READY:'1',FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_RPC_LOG:gate('acp-rpc.log'),FAKE_ACP_PROMPT_DUMP:gate('acp-prompt.json')},config:{cli:${JSON.stringify(FAKE_ACP)}}};
  cfg.instances.lateInit=make({FAKE_CLAUDE_START_DELAY_MS:'6500'});
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));`);

posixOnly("a sealed thread on the Codex, Pi and ACP drivers (S6)", () => {
  interface Kind {
    key: string; instanceId: string;
    /** The lines the fake engine has logged so far. */
    log(): string[];
    resumed(lines: string[]): boolean;
    fresh(lines: string[]): boolean;
    /** What the engine received as its prompt since `from` log lines. */
    prompt(from: number): string;
  }
  const lines = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), "utf8").split("\n").filter(Boolean) : []);
  const kinds: Kind[] = [
    { key: "codex", instanceId: "seal-codex", log: () => lines("codex-calls.log"), resumed: (l) => l.some((line) => line.endsWith(" thread/resume")), fresh: (l) => l.some((line) => line.endsWith(" thread/start")),
      prompt: () => (existsSync(file("codex-dump.json")) ? readFileSync(file("codex-dump.json"), "utf8") : "") },
    { key: "pi", instanceId: "seal-pi", log: () => lines("pi-commands.log"), resumed: (l) => l.some((line) => JSON.parse(line).type === "switch_session"), fresh: (l) => l.some((line) => JSON.parse(line).type === "new_session"),
      prompt: (from) => lines("pi-commands.log").slice(from).filter((line) => JSON.parse(line).type === "prompt").join("\n") },
    { key: "acp", instanceId: "seal-acp", log: () => lines("acp-rpc.log"), resumed: (l) => l.some((line) => JSON.parse(line).method === "session/load"), fresh: (l) => l.some((line) => JSON.parse(line).method === "session/new"),
      prompt: () => (existsSync(file("acp-prompt.json")) ? readFileSync(file("acp-prompt.json"), "utf8") : "") },
  ];
  const bots: Record<string, Bot> = {};
  const cursorOf = (bot: Bot, instanceId: string) => taskOnDisk(bot)?.resumeCursors?.[instanceId] as string | undefined;

  async function engineBot(instanceId: string, name: string): Promise<Bot> {
    const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
    expect(instance, instanceId).toBeTruthy();
    const model = instance.models.options[0]?.id || instance.models.default || "fixture-model";
    const made = await call("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
    expect(made.status, made.text).toBe(201);
    const bot = made.body.bot as Bot;
    await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    return bot;
  }
  /** Sends one direct message and waits for the bot's reply to it. */
  async function converse(bot: Bot, text: string) {
    const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    expect(sent.status, sent.text).toBe(202);
    await waitUntil(async () => {
      const view = (await call("GET", "/api/bots?messages=60")).body.bots.find((entry: any) => entry.id === bot.id);
      const rows: any[] = view?.messages ?? [];
      const at = rows.findIndex((row) => row.role === "user" && row.text === text);
      return view?.busy !== true && at >= 0 && rows.slice(at + 1).some((row) => row.role === "bot" && row.kind === "text");
    }, `the reply to ${text}`, 60_000);
  }

  beforeAll(async () => {
    for (const path of [FAKE_CODEX, FAKE_PI, FAKE_ACP]) chmodSync(path, 0o755);
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: engineInstrumentation });
    await authenticate();
    // every bot first: adding a bot to the roster ends the receipts of the sessions already running
    for (const kind of kinds) for (const role of ["sealed", "open"]) bots[`${kind.key}-${role}`] = await engineBot(kind.instanceId, `${kind.key} ${role}`);
    for (const kind of kinds) {
      for (const role of ["sealed", "open"]) {
        const bot = bots[`${kind.key}-${role}`]!;
        await converse(bot, `PRE_${kind.key}_${role} remember the word PELICAN_${kind.key}_${role}`);
        await waitUntil(() => cursorOf(bot, kind.instanceId), `${kind.key} ${role}: the first cursor to be saved`, 15_000);
      }
    }
    await sleep(1_500);
  }, 300_000);
  afterAll(async () => { await fixture?.close(); });

  it.each(kinds.map((kind) => [kind.key, kind] as const))("%s: a sealed thread starts fresh once, then resumes that session until the next seal; an unsealed thread of the same engine does resume", async (_key, kind) => {
    const sealed = bots[`${kind.key}-sealed`]!, open = bots[`${kind.key}-open`]!;
    const heldCursor = cursorOf(sealed, kind.instanceId)!;
    expect(heldCursor).toBeTruthy();
    // the seal lands in the running server, as a real recall's release writes it (the live Store.sealThread)
    expect((await seal(sealed)).sealed).toBeTruthy();
    // the control first: the unsealed thread of the same engine does ask it to resume
    rmSync(file("codex-dump.json"), { force: true }); rmSync(file("acp-prompt.json"), { force: true });
    let from = kind.log().length;
    await converse(open, `OPEN_${kind.key} carry on`);
    expect(kind.resumed(kind.log().slice(from)), `${kind.key} control resumes: ${kind.log().slice(from).join("|").slice(0, 400)}`).toBe(true);
    // the sealed thread: a new session, no resume of the held cursor, the conversation replayed, nothing stored
    rmSync(file("codex-dump.json"), { force: true }); rmSync(file("acp-prompt.json"), { force: true });
    from = kind.log().length;
    await converse(sealed, `SEALED_${kind.key} carry on`);
    const sent = kind.log().slice(from);
    expect(kind.resumed(sent), `${kind.key} sealed dispatch resumed`).toBe(false);
    expect(sent.join("\n")).not.toContain(heldCursor);
    expect(kind.fresh(sent), `${kind.key} sealed dispatch started a session`).toBe(true);
    await waitUntil(() => kind.prompt(from).includes(RESTARTED), `${kind.key}: the restarted notice in the prompt`, 15_000);
    expect(kind.prompt(from)).toContain(`PELICAN_${kind.key}_sealed`);
    // (n) the session started at the current seal is bound, and it resumes
    await bound(sealed, kind.instanceId);
    const clean = cursorOf(sealed, kind.instanceId)!;
    expect(clean).not.toBe(heldCursor);
    from = kind.log().length;
    await converse(sealed, `SEALED_${kind.key} and the next`);
    expect(kind.fresh(kind.log().slice(from)), `${kind.key} clean turn started another session`).toBe(false);
    expect(cursorOf(sealed, kind.instanceId)).toBe(clean);
    // the next seal: fresh again, never the session it held
    expect((await seal(sealed)).sealed).toBe(2);
    from = kind.log().length;
    await converse(sealed, `SEALED_${kind.key} after the second seal`);
    const again = kind.log().slice(from);
    expect(kind.resumed(again), `${kind.key} resumed below the seal`).toBe(false);
    expect(again.join("\n")).not.toContain(clean);
    expect(kind.fresh(again)).toBe(true);
  }, 180_000);
});

posixOnly("a session that starts after the release is carried by the real session.started fold (rule 23)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: engineInstrumentation });
    await authenticate();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  const busy = (bot: Bot) => waitUntil(async () => (await botView(bot))?.busy === true, "the turn to begin", 20_000);

  /** The conversations that session children (kind 2) carry lines of, read from the server's own database. */
  const sessionCarryParents = (): string[] => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT p.thread_id AS t FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_kind=2").all().map((row) => String((row as any).t)); } finally { db.close(); }
  };
  /** The memory capability of the turn on `threadId`, read from the mcp config the driver wrote for the engine that is still starting. */
  function startingTurnMemoryEnv(threadId: string) {
    for (const line of execFileSync("ps", ["-axo", "args="], { encoding: "utf8" }).split("\n")) {
      if (!line.includes("fake-claude-cli")) continue;
      const path = /--mcp-config\s+(\S+)/.exec(line)?.[1];
      if (!path) continue;
      try {
        // the per-turn tokens live in the credential file each server entry names, not in the config (drivers/turn-credentials.ts)
        const entries = Object.values((JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, { env?: Record<string, string> }> }).mcpServers ?? {}).map((server) => server.env ?? {});
        const merged = entries.map((env) => {
          if (!env.MURAGE_CRED_FILE || !env.MURAGE_CRED_SERVER) return env;
          try { return { ...env, ...((JSON.parse(readFileSync(env.MURAGE_CRED_FILE, "utf8")) as Record<string, Record<string, string>>)[env.MURAGE_CRED_SERVER] ?? {}) }; } catch { return env; }
        });
        if (merged.some((env) => env.MURAGE_THREAD_ID === threadId)) { const memory = merged.find((env) => env.MURAGE_MEMORY_TOKEN && env.MURAGE_HARNESS_URL); if (memory) return memory; }
      } catch { /* not written yet */ }
    }
    return undefined;
  }

  it("the reads of a turn whose engine session had not started when it recalled are persisted onto that session when session.started folds", async () => {
    const bot = await createBot("lateInit", "late session");
    const task = (await call("POST", `/api/bots/${bot.id}/tasks`, { title: "Other chapter" })).body.task.threadId as string;
    const word = mark("PELICAN_latestart");
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `${word} the other chapter`, threadId: task })).status).toBe(202);
    await busy(bot);
    await waitUntil(() => isIdle(bot), "the other conversation's turn to settle", 60_000);
    const before = sessionCarryParents().filter((thread) => thread === task).length;
    // the first turn of the main conversation: its engine is still starting (nothing is read for 6.5 s), so no session exists yet
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "Start the main conversation", threadId: bot.threadId })).status).toBe(202);
    let env: Record<string, string> | undefined;
    await waitUntil(() => { env = startingTurnMemoryEnv(bot.threadId); return env; }, "the starting turn's memory capability", 20_000);
    const response = await fetch(`${env!.MURAGE_HARNESS_URL}/api/internal/memory/thread-search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env!.MURAGE_MEMORY_TOKEN}` }, body: JSON.stringify({ query: word }) });
    const body: any = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.hits.some((hit: any) => hit.threadId === task)).toBe(true);
    // the release happened before any session: nothing of it is on a session child yet
    expect(sessionCarryParents().filter((thread) => thread === task).length).toBe(before);
    await waitUntil(() => isIdle(bot), "the turn to settle", 60_000);
    await waitUntil(() => sessionCarryParents().filter((thread) => thread === task).length > before, "the session.started fold to persist the reads onto the session", 15_000);
    // (f) the release came before the first session.started: that session started at the old generation, so it is below the seal
    expect(taskOnDisk(bot).sealGeneration).toBe(1);
    await waitUntil(() => taskOnDisk(bot)?.resumeSeals?.lateInit !== undefined, "the session to be saved with its start", 15_000);
    expect(taskOnDisk(bot).resumeSeals.lateInit.generation).toBe(0);
    const held = taskOnDisk(bot).resumeCursors.lateInit as string;
    const next = await turn(bot, "AFTER_LATE_RECALL carry on");
    expect(resumed(next.argv)).toBe(false);
    expect(sessionOf(next.argv)).not.toBe(held);
    expect(next.prompt).toContain(RESTARTED);
  }, 240_000);
});

posixOnly("a session bound to the seal it started under (THREAD-SEAL 3.3 to 3.5)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    await authenticate();
  }, 120_000);
  afterAll(async () => { await ask({ lockFolds: false }).catch(() => undefined); await fixture?.close(); });

  const finish = (pid: number) => writeFileSync(join(fixture.fixtureFinishGateDir, String(pid)), "finish");
  const restart = async () => { await fixture.restart(); await authenticate(); };
  const interrupt = (bot: Bot) => call("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  const entryOf = (bot: Bot, instanceId: string) => taskOnDisk(bot)?.resumeSeals?.[instanceId] as { cursor: string; generation: number } | undefined;
  /** A sealed thread whose first clean turn ran: a bound session at the current seal. */
  async function sealedClean(instanceId: string, name: string) {
    const bot = await createBot(instanceId, name);
    await seal(bot);
    const saw = await turn(bot, `CLEAN_${name} remember the word PELICAN_${name.replace(/\W/g, "")}`);
    expect(resumed(saw.argv)).toBe(false);
    await bound(bot, instanceId);
    await sleep(400);
    return { bot, started: sessionOf(saw.argv) };
  }
  /** A release inside a running turn: the seal lands while the turn is held, as a recall's would. */
  async function releaseDuringTurn(bot: Bot) {
    const tag = mark("RELEASE_HOLD");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `Hold on. __fixture_hold_authority__ ${tag}`, threadId: bot.threadId })).status).toBe(202);
    const saw = await engineSaw(tag);
    await seal(bot);
    finish(saw.pid);
    await waitUntil(() => isIdle(bot), "the releasing turn to settle");
    return saw;
  }
  /** Sends a turn and leaves it inside the MCP gate: the session may have started, nothing has been written to it yet. */
  async function intoGate(bot: Bot, text: string) {
    const tag = mark("GATE");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `${text} ${tag}`, threadId: bot.threadId })).status).toBe(202);
    await sleep(1_000);
    return tag;
  }
  const settled = async (bot: Bot) => { await waitUntil(() => isIdle(bot), "the turn to settle", 60_000); await sleep(400); };

  it.each(["verification", "early"])("(a, b, c, q) %s: release, fresh, resume, release, fresh, resume, in both arrival orders", async (instanceId) => {
    const bot = await createBot(instanceId, `chain ${instanceId}`);
    const first = await releaseDuringTurn(bot);
    const second = await turn(bot, "CHAIN_2 go on");
    expect(resumed(second.argv)).toBe(false);
    expect(sessionOf(second.argv)).not.toBe(sessionOf(first.argv));
    expect(second.prompt).toContain(RESTARTED);
    await bound(bot, instanceId);
    expect(entryOf(bot, instanceId)).toEqual({ cursor: sessionOf(second.argv), generation: 1 });
    const third = await releaseDuringTurn(bot);
    expect(sessionOf(third.argv)).toBe(sessionOf(second.argv));
    await sleep(400);
    expect(entryOf(bot, instanceId)?.generation).toBe(1);
    const fourth = await turn(bot, "CHAIN_4 go on");
    expect(resumed(fourth.argv)).toBe(false);
    expect(sessionOf(fourth.argv)).not.toBe(sessionOf(second.argv));
    expect(fourth.prompt).toContain(RESTARTED);
    await bound(bot, instanceId);
    expect(entryOf(bot, instanceId)).toEqual({ cursor: sessionOf(fourth.argv), generation: 2 });
    const fifth = await turn(bot, "CHAIN_5 go on");
    expect(sessionOf(fifth.argv)).toBe(sessionOf(fourth.argv));
  }, 180_000);

  const lastDispatch = (bot: Bot) => serverLog().split("\n").filter((line) => line.includes(`claude dispatch thread=${bot.threadId}`)).at(-1) ?? "";

  it("(m8) a task patch that names resumeSeals is refused and writes nothing", async () => {
    const { bot, started } = await sealedClean("verification", "forged binding");
    const forged = await call("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { resumeSeals: { verification: { cursor: "forged", generation: 99 } } });
    expect(forged.status).toBe(400);
    expect(entryOf(bot, "verification")).toEqual({ cursor: started, generation: 1 });
  }, 90_000);

  it("(q) a held prewarm's init folds with the turn that takes the process, before acceptance, and the binding holds", async () => {
    const bot = await createBot("earlyWarm", "held prewarm");
    const first = await turn(bot, "HELD_1 hello");
    await bound(bot, "earlyWarm");
    await sleep(2_500); // the (shortened) activity window lets the idle engine go, so a warm has something to start
    const savedBefore = savesOf(sessionOf(first.argv)).length;
    const warmed = await call("POST", `/api/bots/${bot.id}/warm`, { threadId: bot.threadId });
    expect(warmed.body.started, warmed.text).toBe(true);
    await sleep(1_000);
    expect(savesOf(sessionOf(first.argv)).length).toBe(savedBefore); // the warm holds its init, so nothing folds until a turn takes the process
    const second = await turn(bot, "HELD_2 hello");
    expect(sessionOf(second.argv)).toBe(sessionOf(first.argv));
    // this rig's 250 ms activity window can let a slow runner's warmed process go first; then the turn is an ordinary resume
    if (lastDispatch(bot).includes("process=reused")) {
      await waitUntil(() => savesOf(sessionOf(first.argv)).length > savedBefore, "the held init to fold", 10_000);
      expect(savesOf(sessionOf(first.argv)).at(-1)?.sealStart).toBeNull();
    }
    await sleep(600);
    expect(entryOf(bot, "earlyWarm")).toEqual({ cursor: sessionOf(first.argv), generation: 0 });
  }, 90_000);

  it("(d, l) a server restart keeps the session resumable; audience, contract, engine and rewind still decide on a clean generation", async () => {
    const { bot, started } = await sealedClean("verification", "restarted");
    await restart();
    const after = await turn(bot, "AFTER_RESTART go on");
    expect(resumed(after.argv)).toBe(true);
    expect(sessionOf(after.argv)).toBe(started);
    expect(after.prompt).not.toContain(RESTARTED);
    await sleep(600);
    // the audience moves
    await fixture.stop();
    editDisk((rows) => { taskRow(rows, bot).resumeAudiences = { verification: "a-different-audience" }; });
    await restart();
    const moved = await turn(bot, "AUDIENCE_CLEAN go on");
    expect(resumed(moved.argv)).toBe(false);
    await bound(bot);
    await sleep(600);
    // the contract moves
    await fixture.stop();
    editDisk((rows) => { delete taskRow(rows, bot).resumeContracts; });
    await restart();
    const contract = await turn(bot, "CONTRACT_CLEAN go on");
    expect(resumed(contract.argv)).toBe(false);
    expect(contract.prompt).toContain(RESTARTED);
    await bound(bot);
    // an edit: a rewound session is never continued
    const mine = (await botView(bot)).messages.find((m: any) => m.role === "user" && m.kind === "text" && String(m.text).includes("AUDIENCE_CLEAN"));
    const tag = mark("EDITED");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages/${mine.id}/edit`, { text: `EDITED clean ${tag}` })).status).toBe(202);
    const rewound = await engineSaw(tag);
    await waitUntil(() => isIdle(bot), "the edit to settle");
    expect(resumed(rewound.argv)).toBe(false);
    expect(rewound.prompt).toContain(REWOUND);
    await sleep(800);
    // the engine moves
    const model = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "second").models.options[0].id;
    expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "second", model }, computer: "off" })).status).toBe(200);
    const switched = await turn(bot, "ENGINE_CLEAN go on");
    expect(resumed(switched.argv)).toBe(false);
    expect(switched.prompt).toContain(SWITCHED);
  }, 240_000);

  it("(e) a steer written before the release, answered by a second init in the same process: the start stays, the next turn is fresh", async () => {
    const bot = await createBot("finalSteer", "follow up");
    const tag = mark("FOLLOWUP");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `The turn ${tag}`, threadId: bot.threadId })).status).toBe(202);
    const saw = await engineSaw(tag);
    const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text: "the line before it", threadId: bot.threadId });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.body.steered).toBe(true);
    // the final answer holds on (FAKE_CLAUDE_FINAL_STEERS 2, or 3 s): the release lands after the write and before the follow-up's init
    await seal(bot);
    await settled(bot);
    expect((await botView(bot)).messages.some((m: any) => m.role === "bot" && String(m.text).includes("reply to: the line before it"))).toBe(true);
    expect(entryOf(bot, "finalSteer")).toEqual({ cursor: sessionOf(saw.argv), generation: 0 });
    const next = await turn(bot, "AFTER_FOLLOWUP go on");
    expect(resumed(next.argv)).toBe(false);
    expect(sessionOf(next.argv)).not.toBe(sessionOf(saw.argv));
  }, 120_000);

  it("(g) a fold retried after a locked database keeps the stored start, and the next turn resumes", async () => {
    const bot = await createBot("verification", "locked fold");
    await seal(bot);
    await ask({ lockFolds: true });
    const tag = mark("LOCKED");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `A locked fold ${tag}`, threadId: bot.threadId })).status).toBe(202);
    const saw = await engineSaw(tag);
    await sleep(500);
    expect(taskOnDisk(bot).resumeCursors?.verification).toBeUndefined();
    await ask({ lockFolds: false });
    await settled(bot);
    await bound(bot);
    expect(entryOf(bot, "verification")).toEqual({ cursor: sessionOf(saw.argv), generation: 1 });
    expect(sessionOf((await turn(bot, "AFTER_LOCK go on")).argv)).toBe(sessionOf(saw.argv));
  }, 120_000);

  const savesOf = (session: string) => (existsSync(file("cursor-saves.jsonl")) ? readFileSync(file("cursor-saves.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cursor: string; sealStart: number | null }) : []).filter((save) => save.cursor === session);
  /** Session A starts at seal 0 and its session.started cannot fold; the release lands; Stop ends the turn. Its fold is still waiting for the database. */
  async function stoppedWithFoldWaiting(bot: Bot) {
    await ask({ lockFolds: true });
    const tag = mark("R2A");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `Hold on. __fixture_hold_authority__ ${tag}`, threadId: bot.threadId })).status).toBe(202);
    const sessionA = sessionOf((await engineSaw(tag)).argv);
    await seal(bot);
    expect((await interrupt(bot)).status).toBe(200);
    await waitUntil(() => isIdle(bot), "the stop to settle", 30_000);
    return sessionA;
  }

  it("(g, the r2 sequence) the old session's start retried before the successor's acceptance saves unbound, and never resumes", async () => {
    const bot = await createBot("gatedLong", "r2 before");
    const sessionA = await stoppedWithFoldWaiting(bot);
    const tag = await intoGate(bot, "The successor, in its gate");
    await ask({ lockFolds: false });
    await waitUntil(() => savesOf(sessionA).length > 0, "the retried fold", 4_000);
    expect(savesOf(sessionA).every((save) => save.sealStart === null), JSON.stringify(savesOf(sessionA))).toBe(true);
    await sleep(400);
    expect(entryOf(bot, "gatedLong")?.cursor).not.toBe(sessionA);
    const saw = await engineSaw(tag);
    await settled(bot);
    expect(sessionOf(saw.argv)).not.toBe(sessionA);
    const next = await turn(bot, "AFTER_R2 go on");
    expect(sessionOf(next.argv)).not.toBe(sessionA);
    expect(savesOf(sessionA).every((save) => save.sealStart === null)).toBe(true);
  }, 120_000);

  it("(g, the r2 sequence) retried after the successor's acceptance it saves unbound too", async () => {
    const bot = await createBot("verification", "r2 after");
    const sessionA = await stoppedWithFoldWaiting(bot);
    const successor = mark("R2B");
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: `The successor ${successor}`, threadId: bot.threadId })).status).toBe(202);
    const sessionB = sessionOf((await engineSaw(successor)).argv);
    await ask({ lockFolds: false });
    await settled(bot);
    await bound(bot);
    expect(savesOf(sessionA).length).toBeGreaterThan(0);
    expect(savesOf(sessionA).every((save) => save.sealStart === null), JSON.stringify(savesOf(sessionA))).toBe(true);
    expect(entryOf(bot, "verification")).toEqual({ cursor: sessionB, generation: 1 });
  }, 120_000);

  it("(g) the successor dies before its own init: the retried cursor stays tainted", async () => {
    const bot = await createBot("gatedLong", "r2 dies");
    const sessionA = await stoppedWithFoldWaiting(bot);
    await intoGate(bot, "A successor that never writes");
    await ask({ lockFolds: false });
    await waitUntil(() => savesOf(sessionA).length > 0, "the retried fold", 4_000);
    await interrupt(bot);
    await settled(bot);
    await waitUntil(() => taskOnDisk(bot)?.resumeCursors?.gatedLong === sessionA, "the retried cursor on disk", 5_000);
    expect(entryOf(bot, "gatedLong")).toBeUndefined();
    const next = await turn(bot, "AFTER_DEATH go on");
    expect(resumed(next.argv)).toBe(false);
    expect(sessionOf(next.argv)).not.toBe(sessionA);
  }, 120_000);

  it("(h) a kept process that announces nothing on its next turn: no release resumes, a release there makes the next fresh", async () => {
    const { bot, started } = await sealedClean("noReinit", "kept");
    const second = await turn(bot, "KEPT_2 go on");
    expect(sessionOf(second.argv)).toBe(started);
    const savedSoFar = savesOf(started).length;
    const third = await releaseDuringTurn(bot);
    expect(sessionOf(third.argv)).toBe(started);
    // this rig's 250 ms activity window can let a slow runner's process go first; a kept process announces nothing, so nothing saves
    if (lastDispatch(bot).includes("process=reused")) expect(savesOf(started).length).toBe(savedSoFar);
    await sleep(400);
    expect(entryOf(bot, "noReinit")).toEqual({ cursor: started, generation: 1 });
    const fourth = await turn(bot, "KEPT_4 go on");
    expect(resumed(fourth.argv)).toBe(false);
    expect(sessionOf(fourth.argv)).not.toBe(started);
  }, 120_000);

  it("(o) a seal between the dispatch decision and the write refuses the resume, memory active and memory off", async () => {
    for (const mode of ["active", "off"]) {
      if (mode === "off") expect((await call("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
      try {
        const { bot, started } = await sealedClean("gated", `fence ${mode}`);
        await restart();
        const tag = await intoGate(bot, "Between the decision and the write");
        await seal(bot);
        const saw = await engineSaw(tag);
        await settled(bot);
        expect(resumed(saw.argv), mode).toBe(false);
        expect(sessionOf(saw.argv)).not.toBe(started);
      } finally {
        if (mode === "off") expect((await call("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
      }
    }
  }, 240_000);

  it("(o) a clean pair replacing the store slot does not authorize the older cursor this dispatch snapshotted", async () => {
    const { bot, started } = await sealedClean("gated", "slot");
    await restart();
    const tag = await intoGate(bot, "A slot replaced under the dispatch");
    const raised = (await seal(bot)).sealed as number;
    await ask({ pair: [bot.id, "gated", "a-clean-pair", bot.threadId, undefined, undefined, false, undefined, raised] });
    const saw = await engineSaw(tag);
    await settled(bot);
    expect(sessionOf(saw.argv)).not.toBe(started);
  }, 120_000);

  it("(r) a resumed spawn whose init arrives during the MCP gate keeps its entry, passes the fence, and writes the prompt", async () => {
    const { bot, started } = await sealedClean("earlyGated", "gate init");
    await restart();
    const saw = await turn(bot, "INIT_IN_GATE go on");
    expect(resumed(saw.argv)).toBe(true);
    expect(sessionOf(saw.argv)).toBe(started);
    expect(saw.prompt).not.toContain(RESTARTED);
    await sleep(600);
    expect(entryOf(bot, "earlyGated")).toEqual({ cursor: started, generation: 1 });
  }, 120_000);

  it("(s) a resume reporting another id before the last fence refuses once and rebuilds fresh; reported after the write, the new id carries the start", async () => {
    const before = await sealedClean("newIdGated", "other id");
    await restart();
    const saw = await turn(before.bot, "OTHER_ID go on");
    expect(resumed(saw.argv)).toBe(false);
    expect(sessionOf(saw.argv)).not.toBe(before.started);
    const after = await sealedClean("newIdLate", "other id late");
    await restart();
    const resumedAs = await turn(after.bot, "OTHER_ID_LATE go on");
    expect(sessionOf(resumedAs.argv)).toBe(after.started);
    await settled(after.bot);
    expect(entryOf(after.bot, "newIdLate")).toEqual({ cursor: "reported-other-id", generation: 1 });
  }, 180_000);

  it("(t) a cancelled dispatch establishes no new binding: a fresh session stays unbound, a resumed one keeps its entry, below the seal if it released", async () => {
    // a fresh session
    const bot = await createBot("earlyGated", "cancelled fresh");
    await seal(bot);
    await intoGate(bot, "Cancelled before the write");
    await waitUntil(() => taskOnDisk(bot)?.resumeCursors?.earlyGated, "the early session to fold", 10_000);
    await interrupt(bot);
    await settled(bot);
    expect(entryOf(bot, "earlyGated")).toBeUndefined();
    const held = taskOnDisk(bot).resumeCursors.earlyGated as string;
    const next = await turn(bot, "AFTER_CANCEL go on");
    expect(resumed(next.argv)).toBe(false);
    expect(sessionOf(next.argv)).not.toBe(held);
    // a resumed session, no release: it keeps its entry and resumes
    const kept = await sealedClean("earlyGated", "cancelled resume");
    await restart();
    const keptSaves = savesOf(kept.started).length;
    await intoGate(kept.bot, "Cancelled resume");
    await waitUntil(() => savesOf(kept.started).length > keptSaves, "the resumed init to fold before acceptance", 10_000);
    await interrupt(kept.bot);
    await settled(kept.bot);
    expect(entryOf(kept.bot, "earlyGated")).toEqual({ cursor: kept.started, generation: 1 });
    expect(sessionOf((await turn(kept.bot, "AFTER_KEPT go on")).argv)).toBe(kept.started);
    // a resumed session that released before the cancel: its entry is below the seal
    const released = await sealedClean("earlyGated", "cancelled release");
    await restart();
    const releasedSaves = savesOf(released.started).length;
    await intoGate(released.bot, "Cancelled after a release");
    await waitUntil(() => savesOf(released.started).length > releasedSaves, "the resumed init to fold before acceptance", 10_000);
    await seal(released.bot);
    await interrupt(released.bot);
    await settled(released.bot);
    expect(entryOf(released.bot, "earlyGated")).toEqual({ cursor: released.started, generation: 1 });
    const after = await turn(released.bot, "AFTER_RELEASED go on");
    expect(resumed(after.argv)).toBe(false);
    expect(sessionOf(after.argv)).not.toBe(released.started);
  }, 240_000);
});
