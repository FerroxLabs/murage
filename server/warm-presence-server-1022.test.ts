// Warm presence (designs/WARM-W1-1022-presence.md r2) and MAIN-RULING warm1022-driver-D2 through the REAL server routes: a booted
// server, fake Claude CLI engines, the real warm pool and the real driver prewarm. Times are scaled with the test-only env
// (MURAGE_WARM_ACTIVITY_WINDOW_MS = W, MURAGE_WARM_PREWARM_HOLD_MS = N). Engine starts are read from the fake CLI's start log,
// closes from the pool's own `warm pool evict ... reason=` lines in the server log.
// Needs a POSIX host (the fake CLIs are shebang scripts).
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerificationServer } from "../scripts/control-murage.ts";
import { launchMemoryVerificationServer as launchVerificationServer } from "./testing/memory-verification-fixture.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const RETAINED_PRELOAD_URL = pathToFileURL(join(SERVER_DIR, "testing", "claude-retained-session-preload.mjs")).href;
const STORE_URL = pathToFileURL(join(SERVER_DIR, "store.ts")).href;
const S2R_URL = pathToFileURL(join(SERVER_DIR, "drivers", "warm-s2r-flag.ts")).href;
const POOL_URL = pathToFileURL(join(SERVER_DIR, "drivers", "warm-pool.ts")).href;
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
const W = 6_000;
const N = 1_500;

const instrumentation = `
  await import(${JSON.stringify(RETAINED_PRELOAD_URL)});
  const fs=await import('node:fs');const path=await import('node:path');
  const dir=process.env.MURAGE_DATA_DIR;
  const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
  const base=cfg.instances.verification;
  cfg.instances.warmable={...base,environment:{...(base.environment??{}),FAKE_CLAUDE_START_DELAY_MS:'1',FAKE_CLAUDE_START_LOG:path.join(dir,'warm-starts.log')}};
  // a real Codex driver on the fake app-server (W-PR3g-codex)
  cfg.instances.codexWarm={driver:'codex',displayName:'Codex warm fixture',config:{cli:${JSON.stringify(FAKE_CODEX)}},environment:{FAKE_CODEX_WARM:'1',FAKE_CODEX_SPAWN_LOG:path.join(dir,'codex-spawns.log')}};
  cfg.instances.slowTurn={...base,environment:{...(base.environment??{}),FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_REPLY_GATE:path.join(dir,'slow-gate')}};
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS='${W}';process.env.MURAGE_WARM_PREWARM_HOLD_MS='${N}';
  const {Store}=await import(${JSON.stringify(STORE_URL)});
  let store;
  for(const name of ['taskByThread','bot']){const original=Store.prototype[name];Store.prototype[name]=function(...args){store=this;return original.apply(this,args);};}
  const ctl=path.join(dir,'pr-ctl.json');const out=path.join(dir,'pr-out.json');
  setInterval(()=>{
    let command;try{command=JSON.parse(fs.readFileSync(ctl,'utf8'));}catch{return;}
    fs.rmSync(ctl,{force:true});
    const result={id:command.id};
    (async()=>{
      try{
        if(command.nativeWarm)store.patchBot(command.nativeWarm,{draftOnly:true,computer:'off',browser:false});
        if(command.prewarmHold!==undefined){if(command.prewarmHold)process.env.MURAGE_PREWARM_HOLD='1';else delete process.env.MURAGE_PREWARM_HOLD;result.prewarmHold=process.env.MURAGE_PREWARM_HOLD==='1';}
        // W-PR6 (a) Claude: the NEXT spawn-headroom check (warmPool.beforeSpawn, the prewarm's own, claude.ts dispatchTurn) hangs
        // until released: fault injection on the pool helper only; the lock route, ownerAway and the driver are the real ones
        if(command.hangSpawn){const {warmPool}=await import(${JSON.stringify(POOL_URL)});const original=warmPool.beforeSpawn;let release;const gate=new Promise(r=>{release=r;});globalThis.__prHang={hit:false,release:()=>{warmPool.beforeSpawn=original;release();}};warmPool.beforeSpawn=function(...args){warmPool.beforeSpawn=original;globalThis.__prHang.hit=true;return gate.then(()=>original.apply(this,args));};}
        if(command.hangHit)result.hit=globalThis.__prHang?.hit===true;
        if(command.releaseSpawn)globalThis.__prHang?.release();
        if(command.s2r!==undefined){const flag=await import(${JSON.stringify(S2R_URL)});flag.setWarmS2rSource(()=>({warmS2r:command.s2r}));result.s2r=flag.warmS2rOn();}
      }catch(error){result.error=String(error);}
      fs.writeFileSync(out,JSON.stringify(result));
    })();
  },30).unref();
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...extra, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check: () => unknown | Promise<unknown>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const starts = () => (existsSync(file("warm-starts.log")) ? readFileSync(file("warm-starts.log"), "utf8").split("\n").filter(Boolean).length : 0);
const evictions = (threadId: string) => serverLog().split("\n").filter((l) => l.includes("warm pool evict") && l.includes(`thread=${threadId} `)).map((l) => /reason=(.*?) poolMB=/.exec(l)?.[1]);
let control = 0;
async function controlCall(command: Record<string, unknown>) {
  const id = ++control;
  rmSync(file("pr-out.json"), { force: true });
  writeFileSync(file("pr-ctl.json"), JSON.stringify({ ...command, id }));
  await waitUntil(() => readJson(file("pr-out.json"))?.id === id, "the control response", 10_000);
  const result = readJson(file("pr-out.json"));
  expect(result.error).toBeUndefined();
  return result;
}
const nativeWarm = (botId: string) => controlCall({ nativeWarm: botId });
/** warm.s2r through the server's own flag module (server/drivers/warm-s2r-flag.ts), read live at every dispatch. */
async function setS2r(on: boolean) { expect((await controlCall({ s2r: on })).s2r).toBe(on); }
interface Bot { id: string; threadId: string }
async function createBot(name: string, instanceId = "warmable", mounted = false): Promise<Bot> {
  const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
  const modelSelection = { instanceId, model: instance.models.options[0].id };
  const created = await call("POST", "/api/bots", { name, modelSelection, requireAvailableModel: true });
  expect(created.status, created.text).toBe(201);
  const bot = created.body.bot as Bot;
  expect((await call("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
  // a bot with its tools on (not draft-only) has a mounted turn: the S1 guard never prewarms it (claude.ts prewarm)
  if (!mounted) await nativeWarm(bot.id);
  return bot;
}
const isIdle = async (bot: Bot) => (await call("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id)?.busy === false;
async function turn(bot: Bot, text: string) {
  const before = starts();
  const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status, sent.text).toBe(202);
  await waitUntil(() => starts() > before || serverLog().includes(`thread=${bot.threadId}`), "the turn's engine");
  await waitUntil(() => isIdle(bot), "the turn to settle");
}
let seq = 0;
/** When the last cell's prewarm was admitted: the W-PR6a cells wait out the real start limit (P-PRE 3, 3 per 60 s) after it. */
let lastAdmittedAt = 0;
/** When bot E (one owner turn, in beforeAll) is asleep: no owner turn in the window. */
let eAsleepAt = 0;
/** Waits out the real prewarm start limit (P-PRE 3: 3 per 60 s across bots) after the last admitted start. */
const rateWindow = () => sleep(Math.max(0, lastAdmittedAt + 61_000 - Date.now()));
const deskReport = (body: Record<string, unknown>) => call("POST", "/api/presence", { clientId: "desk-fixture-01", seq: ++seq, ...body });

posixOnly("warm presence through the real server routes", () => {
  let a: Bot, b: Bot, c: Bot, d: Bot, e: Bot, m: Bot, o: Bot, slow: Bot, k: Bot, x: Bot;
  beforeAll(async () => {
    chmodSync(FAKE_CODEX, 0o755);
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret };
    a = await createBot("presence-a");
    b = await createBot("presence-b");
    c = await createBot("presence-c");
    d = await createBot("presence-d");
    e = await createBot("presence-e"); // the D2 cell's own bot: no earlier cell warms it
    m = await createBot("presence-m", "warmable", true); // W-PR3 (g): a mounted bot
    o = await createBot("presence-o"); // the chat-open cell's own bot
    slow = await createBot("presence-slow", "slowTurn");
    k = await createBot("presence-k"); // W-PR6 (a) Claude: its own bot
    x = await createBot("presence-x", "codexWarm", true); // W-PR3g-codex: its own bot on the real Codex driver (draft-only is Claude-only)
    // one turn each: the driver remembers how to start a thread's engine only after one (claude.ts lastTurns)
    await turn(a, "PRESENCE_A hello");
    await turn(b, "PRESENCE_B hello");
    await turn(c, "PRESENCE_C hello");
    await turn(d, "PRESENCE_D hello");
    await turn(e, "PRESENCE_E hello");
    eAsleepAt = Date.now() + W + 500;
    await turn(m, "PRESENCE_M hello");
    await turn(o, "PRESENCE_O hello");
    await turn(k, "PRESENCE_K hello");
    await turn(x, "PRESENCE_X hello");
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  it("W-PR1b (route): the desktop's lock report retires the idle owner engine at once (`owner away locked`)", async () => {
    await turn(a, "PRESENCE_A again");
    expect(evictions(a.threadId).at(-1)).not.toBe("owner away locked");
    const reported = await deskReport({ visible: false, state: "locked" });
    await waitUntil(() => evictions(a.threadId).includes("owner away locked"), "the lock to retire A's engine", 5_000).catch(() => {});
    expect(evictions(a.threadId)).toContain("owner away locked"); // W-PR1b-route:lock-retires
    expect(reported.status, reported.text).toBe(204);
  }, 60_000);

  it("W-PR1e (route): away, a /warm without a gesture starts nothing and logs `prewarm skipped reason=away`", async () => {
    await deskReport({ visible: false, state: "locked" });
    const before = starts();
    const warmed = await call("POST", `/api/bots/${b.id}/warm`, { threadId: b.threadId, gesture: false });
    expect(warmed.status).toBe(200);
    await sleep(1_000);
    expect({ started: warmed.body.started, starts: starts() - before }).toEqual({ started: false, starts: 0 }); // W-PR1e-route:no-start
    expect(serverLog()).toContain("prewarm skipped reason=away");
  }, 30_000);

  it("D2 (route): opening an ASLEEP bot's chat with a gesture starts its engine, and the hold is released at N, not at W", async () => {
    await sleep(W + 2_500); // every bot asleep (no owner turn in the window) and its idle engine retired by the window check
    const before = starts();
    lastAdmittedAt = Date.now();
    const warmed = await call("POST", `/api/bots/${e.id}/warm`, { threadId: e.threadId, gesture: true });
    expect(warmed.body.started, warmed.text).toBe(true);
    await waitUntil(() => starts() > before, "the prewarm's engine start", 15_000);
    const startedAt = Date.now();
    await waitUntil(() => evictions(e.threadId).includes("prewarm unused"), "the prewarm hold to lapse", N + 3_000).catch(() => {});
    expect({ reason: evictions(e.threadId).at(-1), withinWindow: Date.now() - startedAt < W }).toEqual({ reason: "prewarm unused", withinWindow: true }); // D2-route:released-at-N
  }, 60_000);

  // P-PRE 1b (MAIN-RULING presence-held: 1.0.22 ships OPEN; OPUS 08c6017e2c H2, ASTRA :181): a typing beat starts its own thread's
  // engine. With a thread of ANOTHER bot it starts nothing and takes no hold on that thread: A's engine belongs to awake bot A; a
  // beat that took A's thread for asleep bot E would hand the engine to E and release it at N (1.5 s), long before A's window ends.
  it("W-PR3b (route): a typing beat on its own thread starts that thread's engine; with a thread of another bot it starts nothing and leaves that thread's engine alone", async () => {
    await sleep(Math.max(0, eAsleepAt - Date.now())); // bot E is asleep
    await deskReport({ visible: false, state: "locked" }); // every engine retired first, so this cell does not depend on earlier ones
    await deskReport({ visible: true });
    await turn(a, "PRESENCE_A typing cell"); // he is present; A's engine is idle and bot A is awake for W
    const closedBefore = evictions(a.threadId).length;
    const before = starts();
    const wrong = await call("POST", `/api/bots/${e.id}/typing`, { threadId: a.threadId });
    expect(wrong.status).toBe(200);
    await sleep(N + 1_500);
    expect({ starts: starts() - before, aClosed: evictions(a.threadId).slice(closedBefore) }).toEqual({ starts: 0, aClosed: [] }); // W-PR3b2-route:other-bot-thread
    lastAdmittedAt = Date.now();
    const typed = await call("POST", `/api/bots/${c.id}/typing`, { threadId: c.threadId });
    await waitUntil(() => starts() > before, "the typing beat's engine start", 10_000).catch(() => {});
    expect({ status: typed.status, starts: starts() - before }).toEqual({ status: 200, starts: 1 }); // W-PR3b1-route:typing-starts
    // no send follows: the unclaimed engine is released at N (and is gone before the next cell's lock)
    await waitUntil(() => evictions(c.threadId).at(-1) === "prewarm unused", "the typing prewarm to lapse", N + 5_000);
  }, 60_000);

  it("W-PR1a (route): an idle renderer's own writes (a chat marked read, the resource ticket) never make him present", async () => {
    await deskReport({ visible: false, state: "locked" });
    expect((await call("POST", `/api/bots/${d.id}/read`, { threadId: d.threadId })).status).toBeLessThan(500);
    await call("POST", "/api/desktop/resource-ticket", {});
    const before = starts();
    const warmed = await call("POST", `/api/bots/${d.id}/warm`, { threadId: d.threadId, gesture: false });
    await sleep(1_000);
    expect({ started: warmed.body.started, starts: starts() - before }).toEqual({ started: false, starts: 0 }); // W-PR1a-route:background-writes
  }, 30_000);

  it("W-PR1f' (route): an owner turn still running past W keeps him present: a no-gesture /warm then still warms", async () => {
    await deskReport({ visible: false, state: "locked" });
    rmSync(file("slow-gate"), { force: true });
    const sent = await call("POST", `/api/bots/${slow.id}/messages`, { text: "PRESENCE_SLOW a long turn", threadId: slow.threadId });
    expect(sent.status, sent.text).toBe(202);
    await sleep(W + 1_000); // no input since the send: only the turn in flight can keep him present
    expect(await isIdle(slow)).toBe(false);
    const before = starts();
    lastAdmittedAt = Date.now();
    const warmed = await call("POST", `/api/bots/${d.id}/warm`, { threadId: d.threadId, gesture: false });
    await waitUntil(() => starts() > before, "the in-flight-presence prewarm", 10_000).catch(() => {});
    expect({ started: warmed.body.started, starts: starts() - before }).toEqual({ started: true, starts: 1 }); // W-PR1f2-route:in-flight
    writeFileSync(file("slow-gate"), "go");
    await waitUntil(() => isIdle(slow), "the slow turn to settle", 30_000);
  }, 60_000);

  it("W-PR6b (route): a write from a non-owner surface (no desktop proof, no launch proof) never makes him present", async () => {
    await deskReport({ visible: false, state: "locked" });
    await call("POST", `/api/bots/${d.id}/typing`, { threadId: d.threadId }, {}); // remote surface: whatever the route answers
    const before = starts();
    const warmed = await call("POST", `/api/bots/${d.id}/warm`, { threadId: d.threadId, gesture: false });
    await sleep(1_000);
    expect({ started: warmed.body.started, starts: starts() - before }).toEqual({ started: false, starts: 0 }); // W-PR6b-route:non-owner
  }, 30_000);

  it.each([false, true])("W-PR3g (route): present, opening a MOUNTED bot's chat starts nothing and logs `prewarm skipped reason=mounted` (warm.s2r %s)", async (s2r) => {
    await rateWindow(); // within the start limit (3 per 60 s), so the admission reaches the driver's own mounted check
    await deskReport({ visible: true }); // unlock: no state, so he is judged again
    await setS2r(s2r);
    try {
      const skipped = () => serverLog().split("\n").filter((l) => l.includes("prewarm skipped reason=mounted")).length;
      const [before, logged] = [starts(), skipped()];
      const warmed = await call("POST", `/api/bots/${m.id}/warm`, { threadId: m.threadId, gesture: true });
      expect(warmed.status, warmed.text).toBe(200);
      await waitUntil(() => skipped() > logged, "the mounted skip line", 3_000).catch(() => {});
      expect({ started: warmed.body.started, starts: starts() - before }).toEqual({ started: false, starts: 0 }); // W-PR3g-route:no-start
      expect(skipped() - logged).toBe(1); // W-PR3g-route:logged
    } finally { await setS2r(false); }
  }, 120_000);

  it("W-PR7b (route): a lock report from the phone app (companion proof) never retires the owner's idle engine; only the desktop's does", async () => {
    // the suite hands every fixture server this launch secret (testing/setup.ts): it is the companion's proof here
    const companion = { "x-test-bare-loopback": "1", "x-murage-companion": "1", "x-murage-companion-token": "c".repeat(64) };
    await deskReport({ visible: true });
    await turn(c, "PRESENCE_C kept");
    expect(evictions(c.threadId).at(-1) ?? "none").not.toMatch(/^owner away/);
    const reported = await call("POST", "/api/presence", { clientId: "phone-fixture-01", seq: ++seq, visible: false, state: "locked" }, companion);
    expect(reported.status, reported.text).toBe(204); // the companion reaches the route (its visibility counts)
    await sleep(1_000);
    expect(evictions(c.threadId)).not.toContain("owner away locked"); // W-PR7b-route:companion-state
  }, 60_000);

  // P-PRE 1a (MAIN-RULING presence-held: 1.0.22 ships OPEN; OPUS 08c6017e2c H2): opening a chat starts THAT chat's engine. An open
  // that names another bot's thread starts nothing (base: it fell back to the bot's main thread and started that).
  it("W-PR3a (route): opening a chat (`open`, with a gesture, he is present) starts that chat's engine; an open naming another bot's thread starts nothing", async () => {
    await rateWindow();
    await deskReport({ visible: true });
    await waitUntil(() => evictions(b.threadId).length > 0 && evictions(o.threadId).length > 0, "B's and O's engines to close", W + 15_000);
    await turn(a, "PRESENCE_A present"); // an owner turn: he is present
    const before = starts();
    const foreign = await call("POST", `/api/bots/${o.id}/warm`, { threadId: b.threadId, gesture: true, open: true });
    await sleep(1_000);
    const foreignStarts = starts() - before;
    lastAdmittedAt = Date.now();
    const opened = await call("POST", `/api/bots/${b.id}/warm`, { threadId: b.threadId, gesture: true, open: true });
    await waitUntil(() => starts() - before > foreignStarts, "the chat-open engine start", 10_000).catch(() => {});
    expect({ foreign: foreign.body.started, foreignStarts, started: opened.body.started, starts: starts() - before }).toEqual({ foreign: false, foreignStarts: 0, started: true, starts: 1 }); // W-PR3a-route:open-starts
  }, 150_000);

  it("W-PR6a-open (route, MAIN-RULING presence-held 21:52Z: 1.0.22 ships OPEN): at the production default a focus /warm (gesture, he is present) starts the thread's engine; the HELD kill switch (MURAGE_PREWARM_HOLD=1) renews the hold and starts nothing", async () => {
    await rateWindow(); // the start limit (3 per 60 s) after the chat-open cell's start
    await deskReport({ visible: true });
    await waitUntil(() => evictions(o.threadId).length > 0, "O's engine to close", W + 15_000);
    await turn(a, "PRESENCE_A present again"); // an owner turn: he is present
    expect((await controlCall({ prewarmHold: false })).prewarmHold).toBe(false);
    const before = starts();
    lastAdmittedAt = Date.now();
    const focused = await call("POST", `/api/bots/${o.id}/warm`, { threadId: o.threadId, gesture: true });
    expect(focused.status, focused.text).toBe(200);
    await waitUntil(() => starts() - before > 0, "the focus prewarm to start O's engine", 15_000).catch(() => {});
    expect({ started: focused.body.started, starts: starts() - before > 0 }).toEqual({ started: true, starts: true }); // W-PR6a-open:default-starts
    expect(serverLog()).not.toContain("prewarm skipped reason=held");
    await waitUntil(() => evictions(o.threadId).length > 1, "O's unclaimed prewarm to lapse", W + 15_000);
    expect((await controlCall({ prewarmHold: true })).prewarmHold).toBe(true);
    try {
      const held = starts();
      const again = await call("POST", `/api/bots/${o.id}/warm`, { threadId: o.threadId, gesture: true });
      expect(again.status, again.text).toBe(200);
      await sleep(1_500);
      expect({ started: again.body.started, starts: starts() - held }).toEqual({ started: false, starts: 0 }); // W-PR6a-open:kill-switch
      expect(serverLog()).toContain("prewarm skipped reason=held");
    } finally { await controlCall({ prewarmHold: false }); }
  }, 180_000);
  // W-PR6 (a), P-FENCE 2 last sentence: the desktop's lock (POST /api/presence, index.ts ownerPresence.onAway -> warmPool.ownerAway)
  // ABANDONS a prewarm still starting; it never spawns or parks after the lock. The owner's next send then runs cold.
  const codexSpawns = () => (existsSync(file("codex-spawns.log")) ? readFileSync(file("codex-spawns.log"), "utf8").split("\n").filter(Boolean).map(Number) : []);
  async function presentAgain() {
    await sleep(Math.max(0, lastAdmittedAt + 61_000 - Date.now()));
    await deskReport({ visible: true });
    await turn(a, "PRESENCE_A present for W-PR6a");
    expect((await controlCall({ prewarmHold: false })).prewarmHold).toBe(false);
  }

  it("W-PR6a-claude (route): a lock while the Claude prewarm is still starting abandons it; released, it spawns nothing; the send then runs cold", async () => {
    await waitUntil(() => evictions(k.threadId).length > 0, "K's engine to close", W + 15_000);
    await presentAgain();
    await controlCall({ hangSpawn: true });
    const before = starts();
    const focus = call("POST", `/api/bots/${k.id}/warm`, { threadId: k.threadId, gesture: true });
    let locked: Awaited<ReturnType<typeof call>>;
    try {
      await waitUntil(async () => (await controlCall({ hangHit: true })).hit, "K's prewarm to reach its spawn check", 15_000);
      locked = await deskReport({ visible: false, state: "locked" });
      await sleep(300);
    } finally { await controlCall({ releaseSpawn: true }); }
    const focused = await focus;
    await sleep(1_500);
    // W-PR6a-claude:no-late-spawn — the abandoned prewarm, released after the lock, starts no engine (base and 831b2c39bc: it spawns)
    expect({ lateStarts: starts() - before, detached: serverLog().includes(`claude prewarm detach thread=${k.threadId} reason=away`) }).toEqual({ lateStarts: 0, detached: true });
    expect(locked.status, locked.text).toBe(204);
    expect(focused.body?.started).toBe(false);
    const sent = await call("POST", `/api/bots/${k.id}/messages`, { text: "PRESENCE_K after the lock", threadId: k.threadId });
    expect(sent.status, sent.text).toBe(202);
    await waitUntil(() => starts() > before, "K's cold engine", 15_000);
    await waitUntil(() => isIdle(k), "K's send to settle", 30_000);
  }, 150_000);

  // Codex through warmThread (MAIN-RULING presence-held "real-driver Codex epoch path"): every Codex owner turn mounts the agents tools
  // (index.ts turn setup, agentsMcp), so the S1 guard (codex.ts prewarm) skips every Codex prewarm from /warm: no Codex prewarm process
  // can exist in production for a send to wait behind or a lock to race. GUARD cell (the same on base, which skips it silently).
  it("W-PR3g-codex (route, real Codex driver through warmThread): present, a focus /warm on a Codex owner thread starts no process and logs `prewarm skipped reason=mounted`", async () => {
    await presentAgain();
    const skipped = () => serverLog().split("\n").filter((l) => l.includes("prewarm skipped reason=mounted")).length;
    const before = codexSpawns().length;
    const mountedBefore = skipped();
    expect(serverLog()).toContain(`codex close thread=${x.threadId} reason=mounted-single-use`);
    const focused = await call("POST", `/api/bots/${x.id}/warm`, { threadId: x.threadId, gesture: true });
    expect(focused.status, focused.text).toBe(200);
    await sleep(1_000);
    expect({ started: focused.body.started, spawns: codexSpawns().length - before, mountedSkip: skipped() - mountedBefore }).toEqual({ started: false, spawns: 0, mountedSkip: 1 }); // W-PR3g-codex:route
  }, 60_000);
});
