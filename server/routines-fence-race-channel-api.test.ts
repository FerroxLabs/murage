// FENCE-RACE-1018 r2 (design FENCE-RACE-1018-r2.md section 3.5): the desktop-side exits of a channel run whose turn was refused at a late
// submission, over real HTTP. A paired Telegram message (the fetch fixture of testing/telegram-fetch-preload.mjs) starts a channel run on
// a fake late-write engine (fake-late-terminal-driver.ts, gated per attempt, as direct-rebuild-hold-late-api.test.ts). A revoke landed
// in the late-write window refuses the write; the run must follow the memory rebuild, or settle by its dispatch token, and the owner
// must get exactly one Telegram message and never a false "task failed". Headless: temp HOME, fixture ports, every engine fake.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const url = (f: string) => pathToFileURL(join(SERVER_DIR, f)).href;
const TELEGRAM_OWNER = 777, TELEGRAM_TOKEN = "123:abcdefghijklmnopqrstuvwxyz123456";
const LEGACY_JOBS = 122, FIRST_LEGACY_ID = 720001;
const FAILED_TEXT = "The task failed. Review details in Murage.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ctx = Awaited<ReturnType<typeof launch>>;
let live: Ctx | undefined;
afterEach(async () => { await live?.stop(); live = undefined; });

async function launch(flags: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "murage-fence-race-channel-"));
  const data = join(home, ".murage"), telegramDir = join(home, "telegram-fixture");
  mkdirSync(data, { recursive: true }); mkdirSync(telegramDir); mkdirSync(join(home, ".fuigo"), { recursive: true });
  writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
  const instr = join(home, "instrument.mjs");
  writeFileSync(instr, `
    import fs from 'node:fs'; import path from 'node:path';
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(url("drivers/builtIn.ts"))});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(url("testing/fake-late-terminal-driver.ts"))});
    const runs=await import(${JSON.stringify(url("independent-thread-runs.ts"))});
    const dir=${JSON.stringify(data)};
    const proto=runs.IndependentThreadRuns.prototype, rebuilding=proto.rebuilding;
    if(rebuilding)proto.rebuilding=function(owner){
      const held=rebuilding.call(this,owner), flag=path.join(dir,'refuse-rebuild-start'), atAdmission=String(new Error().stack).includes('startTurnAdmitting');
      if(atAdmission)fs.appendFileSync(path.join(dir,'rebuild-admissions'),owner.threadId+'\\n');
      if(!held||!atAdmission||!fs.existsSync(flag)||fs.readFileSync(flag,'utf8')!==owner.threadId)return held;
      fs.rmSync(flag,{force:true});fs.writeFileSync(flag+'.taken',owner.threadId);return false;
    };
    const storeMod=await import(${JSON.stringify(url("store.ts"))});
    const setAct=storeMod.Store.prototype.setTaskActivity;
    // FAULT_ACTIVITY: while <dir>/fault-activity exists, the next setTaskActivity throws once (the bookkeeping write of a released turn)
    storeMod.Store.prototype.setTaskActivity=function(...a){const f=path.join(dir,'fault-activity');if(fs.existsSync(f)){fs.rmSync(f,{force:true});fs.writeFileSync(f+'.fired','1');throw new Error('injected setTaskActivity fault');}return setAct.apply(this,a);};
    const driver=makeLateTerminalDriver(), create=driver.create.bind(driver);
    driver.create=async input=>{
      const instance=await create(input), env=input.environment;
      if(env.REDELIVER_REFUSED==='1'){const on=instance.adapter.onEvent.bind(instance.adapter);instance.adapter.onEvent=listener=>on(event=>{listener(event);if(event.type==='turn.completed'&&event.stopReason==='submission_refused'){fs.appendFileSync(path.join(dir,'redelivered'),event.turnId+'\\n');listener(event);}});}
      return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
  `);
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { late: { driver: "fakeLateTerminal", environment: {
    FAKE_LATE_HANDBACK: "1", FAKE_LATE_GATE_EACH: "1", FAKE_LATE_SESSION_GATE: join(data, "late-gate"), FAKE_LATE_DUMP: join(data, "late-dump"), ...flags } } } }));
  const port = await freePortBlock([0, 1], 18_999, 200);
  const base = `http://127.0.0.1:${port}`;
  let stderr = "", child: ChildProcess;
  let headers: Record<string, string> = {};
  const start = async () => {
    child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "telegram-fetch-preload.mjs")).href, "--import", pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href,
      "--import", pathToFileURL(instr).href, join(SERVER_DIR, "index.ts")], { windowsHide: true, cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"], env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "", FAKE_TELEGRAM_DIR: telegramDir } });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 60_000;
    for (;;) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up */ } if (Date.now() > deadline) throw new Error(`server never came up:\n${stderr.slice(-2000)}`); await sleep(150); }
    const proof = await (await fetch(`${base}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  await start();
  // 122 legacy audience jobs no walk can finish keep every settle waiting its full REDISPATCH_SETTLE_MS: the window a test acts in
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("PRAGMA busy_timeout=10000");
  const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
  const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
  const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
  const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
  const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
  db.exec("BEGIN");
  for (let n = 0; n < LEGACY_JOBS; n++) { const id = FIRST_LEGACY_ID + n; job.run(id, root); audience.run(id); pending.run(id); frontier.run(id); }
  db.exec("COMMIT"); db.close();
  await waitForExit(child!, { signal: "SIGTERM" });
  await start();

  const stop = async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); };
  const file = (name: string) => join(data, name);
  const lines = (name: string) => existsSync(file(name)) ? readFileSync(file(name), "utf8").trim().split("\n").filter(Boolean) : [];
  const sent = () => (existsSync(join(telegramDir, "sent.jsonl")) ? readFileSync(join(telegramDir, "sent.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string }) : []);
  const count = (needle: string) => stderr.split(needle).length - 1;
  const updates: unknown[] = [];
  const arrives = (id: number, text: string) => {
    updates.push({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: TELEGRAM_OWNER, is_bot: false }, chat: { id: TELEGRAM_OWNER, type: "private" } } });
    writeFileSync(join(telegramDir, "updates.json.tmp"), JSON.stringify(updates)); renameSync(join(telegramDir, "updates.json.tmp"), join(telegramDir, "updates.json"));
  };
  const poll = async <T,>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number): Promise<T | null> => {
    const end = Date.now() + ms; for (;;) { const v = await read(); if (v) return v as T; if (Date.now() > end) return null; await sleep(200); }
  };
  /** A paired, owner-linked bot on the late engine; returns the bot. */
  const pairedBot = async () => {
    const created = await api("POST", "/api/bots", { name: "Channel late", modelSelection: { instanceId: "late", model: "late-1" } });
    const bot = created.body.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, chiefOfStaff: true, chiefScope: "workspace" });
    await api("PATCH", "/api/config", { telegram: { botToken: TELEGRAM_TOKEN } });
    const pair = await api("POST", "/api/telegram/pair", { targetBotId: bot.id });
    arrives(1, `/pair ${pair.body.code}`);
    await poll(async () => (await api("GET", "/api/telegram/status")).body.paired, 20_000);
    const bindings = (await api("POST", "/api/memory/action", { action: "humans" })).body.bindings as Array<{ id: string; revision: number }>;
    await api("POST", "/api/memory/action", { action: "human-link", bindingId: bindings[0]!.id, expectedRevision: bindings[0]!.revision, as: "owner" });
    return bot;
  };
  const channelRuns = async (botId: string) => ((await api("GET", "/api/routines")).body.runs as any[]).filter((r) => r.triggerSource === "channel" && r.botId === botId);
  const seen = new Set<string>();
  const waiting = () => { try { return readFileSync(`${file("late-gate")}.waiting`, "utf8"); } catch { return ""; } };
  /** Let the next late write through; `revoke` lands a revoke in its window so the write is refused. */
  const pass = async (botId: string, revoke?: string) => {
    expect(await poll(() => { const id = waiting(); return id !== "" && !seen.has(id); }, 60_000), "no write waiting at the gate").not.toBeNull();
    seen.add(waiting());
    if (revoke) await api("PATCH", `/api/bots/${botId}`, { section: revoke });
    writeFileSync(file("late-gate"), "");
  };
  /** The channel message and its refused first write; resolves once the server logged the first rebuild. */
  const refuse = async (text: string, beforeRefuse?: (threadId: string) => void) => {
    const bot = await pairedBot();
    arrives(2, text);
    const run = await poll(async () => (await channelRuns(bot.id)).find((r) => r.threadId), 30_000);
    expect(run, `no channel run. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    beforeRefuse?.(run.threadId);
    const before = count("at a late submission on thread");
    await pass(bot.id, "Revoke before the channel write");
    expect(await poll(() => count("at a late submission on thread") > before, 30_000)).toBe(true);
    return { bot, runId: run.id as string, threadId: run.threadId as string };
  };
  const rebuilds = (threadId: string) => count(`at a late submission on thread ${threadId}; re-preparing`);
  const dumpSends = (threadId: string) => lines("late-dump").map((l) => JSON.parse(l)).filter((r) => r.threadId === threadId && !r.prompt).length;
  const runStatus = async (botId: string, id: string) => (await channelRuns(botId)).find((r) => r.id === id)?.status as string | undefined;
  /** Let each further (rebuilt) write through until the run is no longer live. */
  const finish = async (botId: string, runId: string) => {
    for (let i = 0; i < 4; i += 1) {
      if (!["queued", "running", "waiting"].includes((await runStatus(botId, runId)) ?? "")) break;
      if (waiting() !== "" && !seen.has(waiting())) await pass(botId);
      await sleep(400);
    }
    return poll(async () => { const s = await runStatus(botId, runId); return s && !["queued", "running", "waiting"].includes(s) ? s : null; }, 60_000);
  };
  const waitingNow = () => { const id = waiting(); return id !== "" && !seen.has(id) ? id : null; };
  const ctx = { waitingNow, api, stop, file, lines, sent, count, poll, refuse, rebuilds, dumpSends, runStatus, finish, pass, channelRuns, base, stderr: () => stderr, arrives };
  return ctx;
}
const replies = (c: Ctx) => c.sent().filter((m) => m.text.includes("Hello from late"));

describe.skipIf(process.platform === "win32")("FENCE-RACE-1018 r2: a channel run follows its refused turn's memory rebuild", () => {
  it("E10 / 3.4 setup+late path: refused at the late write, rebuilt, answered: Telegram gets the answer once and never the failed notice", async () => {
    live = await launch({}); const c = live;
    const { bot, runId, threadId } = await c.refuse("what is the answer");
    expect(await c.poll(async () => (await c.runStatus(bot.id, runId)) === "running" || (await c.runStatus(bot.id, runId)) === "queued", 5_000)).toBe(true); // the run followed the rebuild, it did not end at the refusal
    expect(await c.finish(bot.id, runId)).toBe("completed");
    await c.poll(() => replies(c).length >= 1, 30_000);
    await sleep(1500);
    expect(replies(c)).toHaveLength(1);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
    expect(c.dumpSends(threadId)).toBe(1 + c.rebuilds(threadId));
  }, 240_000);

  it("H1 redelivery (I-K): a redelivered terminal of the refused write rebuilds once, completes the run once, sends one message and no failed notice", async () => {
    live = await launch({ REDELIVER_REFUSED: "1" }); const c = live;
    const { bot, runId, threadId } = await c.refuse("redelivered question");
    await c.poll(() => c.lines("redelivered").length >= 1, 10_000);
    await sleep(1000);
    expect(["running", "queued"]).toContain(await c.runStatus(bot.id, runId));
    expect(await c.finish(bot.id, runId)).toBe("completed");
    await c.poll(() => replies(c).length >= 1, 30_000); await sleep(1500);
    expect(replies(c)).toHaveLength(1);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
    expect(c.dumpSends(threadId)).toBe(1 + c.rebuilds(threadId));
    expect(c.lines("rebuild-admissions").filter((l) => l === threadId)).toHaveLength(c.rebuilds(threadId));
  }, 240_000);

  it("E4 / H2d: with a confirmed teardown (late-close watch) the run still follows the rebuild and completes once", async () => {
    live = await launch({ FAKE_LATE_TEARDOWN: "1" }); const c = live;
    const { bot, runId } = await c.refuse("question with a teardown");
    expect(await c.finish(bot.id, runId)).toBe("completed");
    await c.poll(() => replies(c).length >= 1, 30_000); await sleep(1500);
    expect(replies(c)).toHaveLength(1);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
  }, 240_000);

  it("E2: a Stop (routine-run cancel) while the refused turn waits to be rebuilt settles the run cancelled, starts no rebuild and never hangs", async () => {
    live = await launch({}); const c = live;
    const { bot, runId, threadId } = await c.refuse("question to stop");
    const sends = c.dumpSends(threadId);
    expect(["running", "queued"], "the run ended at the refusal instead of following its rebuild").toContain(await c.runStatus(bot.id, runId));
    expect((await c.api("POST", `/api/routine-runs/${runId}/cancel`)).status).toBeLessThan(300);
    expect(await c.poll(async () => { const s = await c.runStatus(bot.id, runId); return s && !["queued", "running", "waiting"].includes(s) ? s : null; }, 20_000)).toBe("cancelled");
    await sleep(7_000);
    expect(c.dumpSends(threadId)).toBe(sends);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
  }, 240_000);

  it("E5/E6: a rebuild refused before its admission settles the channel run by token (it does not hang live)", async () => {
    live = await launch({}); const c = live;
    // the flag is set before the refusal: the rebuild meets its admission check with the hold gone
    const bot = await c.refuse("question whose rebuild is refused", (threadId) => writeFileSync(c.file("refuse-rebuild-start"), threadId));
    const taken = await c.poll(() => existsSync(c.file("refuse-rebuild-start.taken")), 40_000);
    expect(taken).toBe(true);
    const status = await c.poll(async () => { const s = await c.runStatus(bot.bot.id, bot.runId); return s && !["queued", "running", "waiting"].includes(s) ? s : null; }, 40_000);
    expect(status, "the run stayed live after its rebuild was refused (a hang)").not.toBeNull();
    expect(["failed", "cancelled", "stopped"]).toContain(status);
  }, 240_000);

  it("E3: a refusal after a tool already started cards the turn and never rebuilds it", async () => {
    live = await launch({ FAKE_LATE_TOOL_FIRST: "1" }); const c = live;
    const { bot, runId, threadId } = await c.refuse("question after a tool");
    await sleep(2_000);
    expect(c.lines("rebuild-admissions").filter((l) => l === threadId)).toHaveLength(0); // no rebuild reached its admission: the turn is carded
    const status = await c.runStatus(bot.id, runId);
    expect(status).not.toBeUndefined();
  }, 240_000);

  it("E2 + setTaskActivity fault: a Stop during the rebuild wait while the bookkeeping save throws still settles the run (ticket none), no hang, no failed notice", async () => {
    live = await launch({}); const c = live;
    const { bot, runId } = await c.refuse("question to stop under a fault");
    writeFileSync(c.file("fault-activity"), "1");
    await c.api("POST", `/api/routine-runs/${runId}/cancel`);
    const status = await c.poll(async () => { const s = await c.runStatus(bot.id, runId); return s && !["queued", "running", "waiting"].includes(s) ? s : null; }, 30_000);
    expect(status, "the run hung live after a Stop under a save fault").not.toBeNull();
    await sleep(3_000);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
  }, 240_000);

  it("last rebuild: a Stop that wins over the last rebuild's refusal (ticket none) settles by token and writes no card and no desktop notification", async () => {
    live = await launch({}); const c = live;
    const { bot, runId, threadId } = await c.refuse("question refused every time");
    // refuse the next rebuild; the second (last) rebuild's write is then waiting: a Stop lands before it is refused
    for (let i = 0; i < 1; i += 1) { await c.pass(bot.id, "Revoke before the channel write " + i); await sleep(1_500); }
    expect(await c.poll(() => c.waitingNow(), 60_000), "the last rebuild's write never waited").not.toBeNull();
    await c.api("POST", `/api/routine-runs/${runId}/cancel`);
    await c.pass(bot.id, "Revoke before the last write");
    const status = await c.poll(async () => { const s = await c.runStatus(bot.id, runId); return s && !["queued", "running", "waiting"].includes(s) ? s : null; }, 30_000);
    expect(status).not.toBeNull();
    await sleep(2_000);
    const messages = ((await c.api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
    const cards = messages.filter((m) => m.card || String(m.tool?.name ?? "").startsWith("error:"));
    expect(cards).toEqual([]);
    expect(c.sent().filter((m) => m.text.includes(FAILED_TEXT))).toHaveLength(0);
  }, 300_000);

  it.todo("E1 fold: a newer run owns the thread -> take('none') + settle STOPPED only if owed (needs a second channel run racing the held run)");
  it.todo("E11 a Stop/host interrupt releases the generation between the fold and the awaited teardown -> settle STOPPED, no ticket left owed (needs a teardown seam)");
  it.todo("E12 retain with !current / no lateClose; closed rejects, owns() false, note() throws -> each settles STOPPED once (needs a late-close fault seam in index.ts)");
  it.todo("E13 setup catch returns at !ownsLatestGeneration (terminal before handback released the generation) -> settleDispatch(token) (needs FAKE_LATE_PRE_HANDBACK_GATE + terminal injection)");
  it.todo("E14 retain: reportUnconfirmedDirectStop throws -> the watch is still installed and the ticket decided; install throws -> decideOwedNone (needs a throwing store seam)");
  it.todo("E7/E8 rebuild admitted then its detached setup fails / acceptedTurnCleanupFailed -> settle by token (needs a setup-failure seam)");
});
