// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall, design S (the seal), tests S6 and S7, through the real server and the fake Claude CLI.
// Once recall output was released on a thread (task.sealGeneration above 0), that thread never resumes an
// engine session again: every dispatch takes the fresh path with sessionReset true and no cursor, stores no
// cursor, is never warmed, and no line is steered into a running turn.
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
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS='250';
  const {Store}=await import(${JSON.stringify(STORE_URL)});
  const watch=await import(${JSON.stringify(WATCH_URL)});
  let store;
  for(const name of ['taskByThread','bot']){const original=Store.prototype[name];Store.prototype[name]=function(...args){store=this;return original.apply(this,args);};}
  const ctl=gate('seal-ctl.json');const out=gate('seal-out.json');
  setInterval(()=>{
    let command;try{command=JSON.parse(fs.readFileSync(ctl,'utf8'));}catch{return;}
    fs.rmSync(ctl,{force:true});
    const result={id:command.id};
    try{
      if(command.seal)result.sealed=store.sealThread(command.seal[0],command.seal[1]);
      if(command.counts)result.counts=watch.sealedTurnCounts();
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
async function ask(command: { seal?: [string, string]; counts?: true }) {
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
const waitCursor = (bot: Bot) => waitUntil(() => taskOnDisk(bot)?.resumeCursors?.verification && taskOnDisk(bot)?.resumeContracts?.verification !== undefined, "the first cursor to be saved", 15_000);

posixOnly("thread recall seal at dispatch (S2, S3, S4)", () => {
  const bots: Record<string, Bot> = {};
  let preSealMeta = "";
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
    preSealMeta = sessionMeta(taskOnDisk(bots.cursor!));
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
    const one = await call("GET", `/api/bots/${bots.cursor!.id}/tasks/${bots.cursor!.threadId}`);
    expect(one.status).toBe(200);
    expect(one.body.task.threadId).toBe(bots.cursor!.threadId);
    expect(one.text).not.toContain("sealGeneration");
    const list = await call("GET", `/api/bots/${bots.cursor!.id}/tasks`);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("sealGeneration");
    const patched = await call("PATCH", `/api/bots/${bots.cursor!.id}/tasks/${bots.cursor!.threadId}`, { unread: false });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain("sealGeneration");
  });

  it("three consecutive sealed turns each send no cursor, reset the session, open as restarted, and leave the pre-seal cursor and its records byte for byte", async () => {
    const bot = bots.cursor!;
    const seen = [];
    for (const n of [1, 2, 3]) {
      const saw = await turn(bot, `SEALED_${n} what was the word`);
      seen.push(saw);
      expect(resumed(saw.argv), `turn ${n}`).toBe(false);
      expect(saw.argv).toContain("--session-id");
      expect(saw.argv[saw.argv.indexOf("--session-id") + 1]).not.toBe(preSealCursor);
      expect(saw.prompt).toContain(RESTARTED);
      expect(saw.prompt).not.toContain(SWITCHED);
      // the replay carries the conversation, the earlier sealed turns included
      expect(saw.prompt).toContain("PELICAN_cursor");
      if (n > 1) expect(saw.prompt).toContain(`SEALED_${n - 1} what was the word`);
    }
    // every turn on its own process: the retained one was closed each time
    expect(new Set(seen.map((s) => s.pid)).size).toBe(3);
    // the session.started of those turns folded and wrote no cursor, and nothing refreshed the pre-seal records
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot))).toBe(preSealMeta);
    expect(taskOnDisk(bot).resumeCursors.verification).toBe(preSealCursor);
    expect(serverLog()).not.toMatch(/continuation reset/);
  }, 120_000);

  it("a sealed thread with no pre-seal cursor at all opens as restarted on every turn", async () => {
    const bot = bots.stripped!;
    for (const n of [1, 2, 3]) {
      const saw = await turn(bot, `STRIPPED_${n} go on`);
      expect(resumed(saw.argv)).toBe(false);
      expect(saw.prompt).toContain(RESTARTED);
      expect(saw.prompt).not.toContain(SWITCHED);
      expect(saw.prompt).toContain("PELICAN_stripped");
    }
    await sleep(1_500);
    // no cursor was ever stored for the thread
    expect(taskOnDisk(bot).resumeCursors ?? {}).toEqual({});
  }, 120_000);

  it("a sealed thread that never ran starts fresh with the conversation replayed and no cursor", async () => {
    const bot = bots.fresh!;
    await seal(bot);
    const saw = await turn(bot, "FIRST_EVER hello");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.argv).toContain("--session-id");
    await sleep(1_500);
    expect(taskOnDisk(bot).resumeCursors ?? {}).toEqual({});
    expect(taskOnDisk(bot).sealGeneration).toBe(1);
  }, 60_000);

  it("a sealed thread on a second engine instance behaves the same, after a restart", async () => {
    const bot = bots.second!;
    const before = sessionMeta(taskOnDisk(bot));
    for (const n of [1, 2]) {
      const saw = await turn(bot, `SECOND_${n} carry on`);
      expect(resumed(saw.argv)).toBe(false);
      expect(saw.prompt).toContain(RESTARTED);
      expect(saw.prompt).toContain("PELICAN_second");
    }
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot))).toBe(before);
  }, 120_000);

  it("a sealed turn after an engine switch opens as a switch (the fresh preamble), then as restarted again on the new engine", async () => {
    const bot = bots.switch!;
    const model = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "second").models.options[0].id;
    expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "second", model }, computer: "off" })).status).toBe(200);
    const switched = await turn(bot, "AFTER_SWITCH who are you");
    expect(resumed(switched.argv)).toBe(false);
    expect(switched.prompt).toContain(SWITCHED);
    expect(switched.prompt).not.toContain(RESTARTED);
    const again = await turn(bot, "AFTER_SWITCH_TWO and again");
    expect(resumed(again.argv)).toBe(false);
    expect(again.prompt).toContain(RESTARTED);
    expect(again.prompt).not.toContain(SWITCHED);
    await sleep(1_500);
    expect(taskOnDisk(bot).resumeCursors?.second).toBeUndefined();
  }, 120_000);

  it("a sealed rewind (an edit) opens as rewound, and the turn after it as restarted", async () => {
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
    const after = await turn(bot, "AFTER_REWIND next");
    expect(resumed(after.argv)).toBe(false);
    expect(after.prompt).toContain(RESTARTED);
  }, 120_000);

  it("a sealed turn after an audience move opens as restarted (not a switch), notes no reset, and never refreshes the frozen record", async () => {
    const bot = bots.aud!;
    const before = sessionMeta(taskOnDisk(bot));
    expect(before).toContain("a-different-audience");
    const saw = await turn(bot, "AUDIENCE_MOVED continue");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(saw.prompt).not.toContain(SWITCHED);
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot))).toBe(before);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
  }, 60_000);

  it("a sealed turn after a contract move opens as restarted (not a switch), notes no reset, and never refreshes the frozen record", async () => {
    const bot = bots.con!;
    const before = sessionMeta(taskOnDisk(bot));
    expect(taskOnDisk(bot).resumeContracts).toBeUndefined();
    const saw = await turn(bot, "CONTRACT_MOVED continue");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(saw.prompt).not.toContain(SWITCHED);
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot))).toBe(before);
    expect(taskOnDisk(bot).resumeContracts).toBeUndefined();
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
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
  }, 90_000);

  it("ten sealed turns raise no reset-loop warning and are counted ten times", async () => {
    const bot = bots.ten!;
    for (let n = 1; n <= 10; n++) {
      const saw = await turn(bot, `TEN_${n} again`);
      expect(resumed(saw.argv)).toBe(false);
      expect(saw.prompt).toContain(RESTARTED);
    }
    const counts = (await ask({ counts: true })).counts as Array<{ threadId: string; count: number; instances: string[] }>;
    expect(counts.find((entry) => entry.threadId === bot.threadId)).toMatchObject({ count: 10, instances: ["verification"] });
    expect(serverLog()).not.toMatch(/continuation reset loop/);
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${bot.threadId}`));
  }, 300_000);

  it("a seal that lands between turns (the live server's own sealThread) takes effect on the very next dispatch", async () => {
    const bot = bots.mixed!;
    // this bot was sealed on disk too; seal it once more in the running server: the number only rises, the behaviour is the same
    expect((await seal(bot)).sealed).toBe(2);
    const saw = await turn(bot, "BUMPED go on");
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.prompt).toContain(RESTARTED);
    expect(taskOnDisk(bot).sealGeneration).toBe(2);
  }, 60_000);
});

posixOnly("a sealed thread is never steered into (S7 a to d)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    await authenticate();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  const hasChip = async (bot: Bot) => (await botView(bot)).messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash" && m.tool.ok === true);
  const texts = async (bot: Bot): Promise<Array<{ role: string; text: string; steered: boolean }>> => (await botView(bot)).messages.filter((m: any) => m.kind === "text").map((m: any) => ({ role: m.role as string, text: String(m.text), steered: m.steered === true }));
  const steerEntries = () => logged().filter((entry) => entry.steer !== undefined);

  /** The shared assertions once a refused steer has run as its own turn. */
  async function expectRunAsOwnSealedTurn(bot: Bot, line: string, refusalLogged = true) {
    await expect.poll(async () => (await texts(bot)).some((m) => m.role === "bot" && m.text.includes(line)), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => isIdle(bot), { timeout: 60_000 }).toBe(true);
    const all = await texts(bot);
    // the line is in the transcript once, as its own message, not a steered one
    expect(all.filter((m) => m.role === "user" && m.text === line)).toEqual([{ role: "user", text: line, steered: false }]);
    // no reply was ever folded together with a steer, and the engine was never written a steer
    expect(all.some((m) => m.text.includes("+ steered:"))).toBe(false);
    expect(steerEntries()).toEqual([]);
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

  it("(a) a steer into a turn running on a sealed thread is not written, runs as its own sealed turn, reads no cursor and notes no reset", async () => {
    const bot = await createBot("slowA", "steer a");
    await seal(bot);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "first sealed turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hasChip(bot), { timeout: 20_000 }).toBe(true);
    const second = await call("POST", `/api/bots/${bot.id}/messages`, { text: "second line a", threadId: bot.threadId });
    expect(second.status, second.text).toBe(202);
    expect(second.body.steered).not.toBe(true);
    expect(second.body.queued).toBe(true);
    writeFileSync(file("gate-a"), "go");
    await expectRunAsOwnSealedTurn(bot, "second line a");
    // a sealed thread never held a cursor for this to read or write
    expect(taskOnDisk(bot).resumeCursors ?? {}).toEqual({});
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

  it("(d) a Claude engine that flushes queued steers at init: on a sealed thread nothing is queued or flushed into the running turn", async () => {
    const bot = await createBot("slowInitD", "steer d");
    await seal(bot);
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "slow sealed turn", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await botView(bot)).busy, { timeout: 20_000 }).toBe(true);
    const startedAt = Date.now();
    const second = await call("POST", `/api/bots/${bot.id}/messages`, { text: "second line d", threadId: bot.threadId });
    expect(second.status, second.text).toBe(202);
    // refused at once: no wait for the engine's init, no bound
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(second.body.steered).not.toBe(true);
    expect(second.body.queued).toBe(true);
    await expectRunAsOwnSealedTurn(bot, "second line d");
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
  /** What a sealed dispatch of any kind must look like: a new session, never the held cursor. */
  function expectFreshSealed(saw: { argv: string[]; prompt: string }, heldCursor: string) {
    expect(resumed(saw.argv)).toBe(false);
    expect(saw.argv).toContain("--session-id");
    expect(saw.argv[saw.argv.indexOf("--session-id") + 1]).not.toBe(heldCursor);
    expect(saw.argv.join(" ")).not.toContain(heldCursor);
  }

  it("a routine run in a sealed routine thread sends no cursor and stores none", async () => {
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
    const meta = sessionMeta(taskOnDisk(bot, threadId));
    await seal(bot, threadId);
    await waitUntil(async () => (await call("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routineId && !["completed", "failed"].includes(r.status)).length === 0, "no live run");
    const second = await run();
    expectFreshSealed(second, held);
    await waitUntil(async () => (await call("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routineId && ["completed", "failed"].includes(r.status)).length >= 2, "the second run to finish");
    await sleep(1_500);
    // a routine run ends its session unretained, which drops the cursor (dropCursor): a sealed thread may lose its old cursor this way but
    // never gains a new one, and the other pre-seal records are left as they were
    expect([undefined, held]).toContain(taskOnDisk(bot, threadId).resumeCursors?.verification);
    expect(JSON.stringify(JSON.parse(meta).slice(1))).toBe(JSON.stringify(JSON.parse(sessionMeta(taskOnDisk(bot, threadId))).slice(1)));
    expect(serverLog()).not.toMatch(new RegExp(`continuation reset thread=${threadId}`));
  }, 180_000);

  it("a project card run in a sealed desk thread sends no cursor and stores none", async () => {
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
    const meta = sessionMeta(taskOnDisk(bot, deskThreadId));
    await seal(bot, deskThreadId);
    await waitUntil(() => isIdle(bot), "the desk to be idle");
    const second = await runCard(mark("SEALCARD_TWO"));
    expectFreshSealed(second.saw, held);
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot, deskThreadId))).toBe(meta);
  }, 240_000);

  it("a delegated turn in a sealed thread sends no cursor and stores none", async () => {
    const asker = await createBot("verification", "asker"), peer = await createBot("verification", "peer");
    const held = await withCursor(peer, "peer");
    const meta = sessionMeta(taskOnDisk(peer));
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
    expect(sessionMeta(taskOnDisk(peer))).toBe(meta);
  }, 180_000);

  it("an engine command in a sealed thread sends no cursor and stores none", async () => {
    const bot = await createBot("cmds", "command");
    await turn(bot, "PRE_command remember the word PELICAN_command");
    await waitUntil(async () => (await call("GET", `/api/bots/${bot.id}/engine-commands`)).body.status === "ready", "the engine to report its commands", 15_000);
    await waitUntil(() => taskOnDisk(bot)?.resumeCursors?.cmds, "the first cursor to be saved", 15_000);
    await sleep(1_000);
    const held = taskOnDisk(bot).resumeCursors.cmds as string;
    const meta = sessionMeta(taskOnDisk(bot));
    await seal(bot);
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await call("POST", `/api/bots/${bot.id}/messages`, { text: "/context", threadId: bot.threadId })).status).toBeLessThan(300);
    const saw = await engineSaw("/context");
    expectFreshSealed(saw, held);
    await waitUntil(() => isIdle(bot), "the command to settle");
    await sleep(1_500);
    expect(sessionMeta(taskOnDisk(bot))).toBe(meta);
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

  it("a real thread_search release makes the harness seal the thread: the next dispatch resets the session and sends no cursor", async () => {
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
  }, 180_000);

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
  cfg.instances['seal-codex']={driver:'codex',displayName:'Codex fixture',environment:{FAKE_CODEX_MODE:'resume',FAKE_CODEX_CALL_LOG:gate('codex-calls.log'),FAKE_CODEX_DUMP:gate('codex-dump.json')},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
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

  it.each(kinds.map((kind) => [kind.key, kind] as const))("%s: the next dispatch of a sealed thread sends no cursor and resets the session; an unsealed thread of the same engine does resume", async (_key, kind) => {
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
    await sleep(1_000);
    expect(cursorOf(sealed, kind.instanceId)).toBe(heldCursor);
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
  }, 240_000);
});
