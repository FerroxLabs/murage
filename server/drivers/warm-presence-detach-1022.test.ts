// Warm presence P-FENCE 2/3 (designs/WARM-W1-1022-presence.md r2, MAIN-RULING presence-held 2026-11-22T21:52Z) on the REAL Codex
// and Claude drivers: adapter.prewarm and adapter.sendTurn, a fake app-server whose start hangs (FAKE_CODEX_HANG_FILE) and outlives a SIGTERM.
// W-PR6 (a'): a send behind a hung prewarm is never failed and never waits for the prewarm's close: past the claim bound (counted
// from the prewarm's own start) it detaches it and dispatches cold on a NEW process; the hung process is ended on the closing path
// and never becomes the thread's engine.
// Needs a POSIX host (the fake app-server is a shebang script).
import "../testing/port-integrity.ts";
import { admittedFixtureInstance, bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import { ClaudeDriver } from "./claude.ts";
import { withClaudeFixtureCwd } from "../testing/claude-s2-wire-receipt.ts";
import { ensureDirs } from "../config.ts";
import { warmPool } from "./warm-pool.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const ENV = ["MURAGE_WARM_POOL_MIN_FREE_MB", "MURAGE_WARM_POOL_BUDGET_MB", "FAKE_CODEX_SPAWN_LOG", "FAKE_CODEX_DUMP", "FAKE_CODEX_WARM", "FAKE_CODEX_HANG_FILE", "FAKE_CODEX_HANG_TERM_MS", "MURAGE_PREWARM_WAIT_MS", "MURAGE_PREWARM_TAKEOVER_MS", "MURAGE_WARM_ACTIVITY_WINDOW_MS", "FAKE_CODEX_IGNORE_TERM", "FAKE_CODEX_RESUME_GATE"];
const WAIT = 1_500;
// A loaded shard box delays a start by seconds; the base waited the 10 s claim (or the hung process's close), so a bound under that still fails it.
const LOAD_SLACK = 4_000;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("W-PR6 (a') Codex: a send behind a hung prewarm detaches it and runs cold (real driver, fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let hangFile: string;
  let lines: Array<{ at: number; line: string }>;
  let info: ReturnType<typeof vi.spyOn>;
  let catalogSpawns = 0;
  const identity = { botId: "", audience: "owner" as const };
  const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const spawns = () => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).slice(catalogSpawns).map(Number);
  const eventually = async (check: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return check();
  };

  beforeEach(async () => {
    chmodSync(FAKE_CLI, 0o755);
    identity.botId = randomUUID();
    scratch = mkdtempSync(join(tmpdir(), "murage-presence-detach-"));
    spawnLog = join(scratch, "spawns.log");
    hangFile = join(scratch, "hang");
    writeFileSync(spawnLog, "");
    process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
    process.env.FAKE_CODEX_WARM = "1";
    process.env.FAKE_CODEX_HANG_FILE = hangFile;
    process.env.FAKE_CODEX_HANG_TERM_MS = "8000"; // the hung start also shuts down slowly
    process.env.MURAGE_PREWARM_WAIT_MS = String(WAIT);
    process.env.MURAGE_PREWARM_TAKEOVER_MS = "3000";
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
    lines = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => { if (typeof line === "string" && line.startsWith("codex ")) lines.push({ at: Date.now(), line }); });
    instance = await admittedFixtureInstance(CodexDriver.create({
      instanceId: "codex-presence-detach", displayName: "Codex Presence Detach", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    }));
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
    catalogSpawns = readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  });
  afterEach(async () => {
    rmSync(hangFile, { force: true });
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    for (const key of ENV) delete process.env[key];
    await removeTempDir(scratch);
  });

  it("past the claim bound the send dispatches at once on a new process, the reply is delivered, and the hung prewarm never becomes the engine", async () => {
    const threadId = `t-detach-${randomUUID()}`;
    const send = (text: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity } satisfies SendTurnInput);
    // one owner turn leaves the remembered inputs; its engine lapses (window 250 ms), so the thread is cold
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(await eventually(() => warmPool.idleCount() === 0)).toBe(true);
    const before = spawns().length;
    writeFileSync(hangFile, "");
    const warming = instance.adapter.prewarm!(threadId);
    expect(await eventually(() => spawns().length > before)).toBe(true);
    const spawnedAt = Date.now();
    const prewarmPid = spawns()[before]!;
    rmSync(hangFile); // the send's own process starts normally
    const sentAt = Date.now();
    let failed: unknown = null;
    const second = await send("two").catch((error) => { failed = error; return null; });
    const completed = second ? await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 20_000) : null;
    const dispatch = lines.find((l) => l.at >= sentAt && l.line.startsWith(`codex dispatch thread=${threadId} `));
    // W-PR6a'-codex:sent — the send is never failed because of the prewarm (base: takeover, TAKEOVER_FAILED_MESSAGE or a late dispatch)
    expect({ failed: failed === null ? null : String(failed), ok: (completed as { ok?: boolean } | null)?.ok ?? null }).toEqual({ failed: null, ok: true });
    // W-PR6a'-codex:at-once — dispatched by the prewarm's own start + the claim bound + 1 s, not after the hung process's slow close
    expect(dispatch!.at - spawnedAt).toBeLessThan(WAIT + 1_000 + LOAD_SLACK);
    // W-PR6a'-codex:new-pid — the turn ran on a new process; the hung one is ended on the closing path
    const after = spawns().slice(before + 1);
    expect({ newProcess: after.length >= 1 && !after.includes(prewarmPid), detached: lines.some((l) => l.line === `codex prewarm detach thread=${threadId} reason=hung`) }).toEqual({ newProcess: true, detached: true });
    expect(await warming).toBe(false);
    expect(await eventually(() => !pidAlive(prewarmPid), 15_000)).toBe(true);
  }, 60_000);

  // FABLE/OPUS 831b2c39bc H4, FABLE/OPUS/ASTRA d0f7e5e5d3 (codex.ts retain(), the abandoned-token guard): a detached prewarm whose process
  // outlives the detach kill (SIGTERM ignored until the force kill) and still finishes its start reaches the park call retain(() => {})
  // (cancelledBeforeStart reads only stopRequested). The guard in retain() is the one line that stops it writing retained.set(thread)
  // over the engine the owner's send already left warm there. Only the prewarm's process is slow and ignores SIGTERM (env read at spawn).
  it("a detached prewarm that still finishes its start never parks over the send's warm engine: the next send reuses the send's process", async () => {
    process.env.MURAGE_PREWARM_WAIT_MS = "800";
    const threadId = `t-detach-retain-${randomUUID()}`;
    const send = (text: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity } satisfies SendTurnInput);
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(await eventually(() => warmPool.idleCount() === 0)).toBe(true);
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "60000"; // from here the send's engine stays warm
    const resumeGate = join(scratch, "resume-gate");
    process.env.FAKE_CODEX_IGNORE_TERM = "1";
    process.env.FAKE_CODEX_RESUME_GATE = resumeGate; // its start (thread/resume) answers only once this file exists
    const before = spawns().length;
    const warming = instance.adapter.prewarm!(threadId).catch(() => false);
    expect(await eventually(() => spawns().length > before)).toBe(true);
    const prewarmPid = spawns()[before]!;
    for (const key of ["FAKE_CODEX_IGNORE_TERM", "FAKE_CODEX_RESUME_GATE"]) delete process.env[key]; // the send's own process is normal
    // past the 0.8 s claim the send detaches the prewarm (its SIGTERM is ignored) and runs cold (base: it fails behind it)
    let failed: string | null = null;
    const second = await send("two").catch((error) => { failed = String(error); return null; });
    const done2 = second ? await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 20_000) : null;
    const twoWarm = await eventually(() => warmPool.idleCount() === 1, 5_000); // send two's engine is parked warm
    const afterTwo = spawns().slice(before + 1);
    writeFileSync(resumeGate, ""); // now the abandoned prewarm finishes its start, before the force kill lands
    // it reaches its park call (setup for the guard: the same with and without it)
    const parked = await eventually(() => lines.some((l) => l.line === `codex prewarm thread=${threadId} parked=true`), 8_000);
    await new Promise((r) => setTimeout(r, 300));
    const threeAt = Date.now();
    const third = await send("three");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId, 20_000);
    const dispatch3 = lines.find((l) => l.at >= threeAt && l.line.startsWith(`codex dispatch thread=${threadId} `))?.line;
    // W-PR6a-codex-retain:send-engine-kept — send two ran on its own new process and send three reuses THAT process
    // (without the guard the abandoned prewarm is retained over it: send three finds the prewarm's process instead)
    expect({ failed, ok: (done2 as { ok?: boolean } | null)?.ok ?? null, twoWarm, parked, twoNewProcess: afterTwo.length === 1 && afterTwo[0] !== prewarmPid, three: dispatch3, newSpawns: spawns().length - before - 1 - afterTwo.length }).toEqual({ failed: null, ok: true, twoWarm: true, parked: true, twoNewProcess: true, three: `codex dispatch thread=${threadId} process=reused reason=unchanged`, newSpawns: 0 });
    await warming;
    expect(await eventually(() => !pidAlive(prewarmPid), 15_000)).toBe(true);
  }, 60_000);

  // MAIN-RULING presence-held ("build the real-driver Codex epoch path with its witness"; FABLE/OPUS d0f7e5e5d3 H, ASTRA index.ts:15692): the
  // exact sequence warmThread runs (index.ts: warmIntent, admitPrewarm, adapter.prewarm, unadmitPrewarm on a false answer) on the REAL
  // CodexDriver, for an unmounted Codex owner thread (the booted route fixture mounts every Codex owner turn: W-PR3g-codex guard). The
  // start outlasts MURAGE_PREWARM_WAIT_MS, so prewarm answers false and the start is given back while it still runs; then the start
  // finishes. The away edge (warmPool.ownerAway, as index.ts ownerPresence.onAway calls it) lands after the admission and before the
  // driver's start registers, so the away detach (P-FENCE 2) finds nothing to abandon: the admission epoch, kept by unadmitPrewarm
  // (P-FENCE 1), is the one guard against the late park here. (The away detach of a registered start is :136.)
  it("warmThread's Codex sequence: an away edge after admission, a prewarm given back past its wait, never parks when its start finishes; the next send runs cold", async () => {
    process.env.MURAGE_PREWARM_WAIT_MS = "500";
    const threadId = `t-epoch-${randomUUID()}`;
    const send = (text: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity } satisfies SendTurnInput);
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(await eventually(() => warmPool.idleCount() === 0)).toBe(true);
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "60000"; // a parked prewarm would stay
    const resumeGate = join(scratch, "resume-gate");
    process.env.FAKE_CODEX_RESUME_GATE = resumeGate;
    const pool = warmPool as typeof warmPool & { ownerAway?: (cause: string) => number };
    // warmThread's own tail (index.ts calls warm-pool.ts admitAndPrewarm); base d7afddbe9f has neither it nor an admission: the bare start
    const shared = (await import("./warm-pool.ts")) as { admitAndPrewarm?: (p: typeof warmPool, t: string, start: () => Promise<boolean>) => Promise<{ admitted: boolean; started?: boolean }> };
    const run = shared.admitAndPrewarm ?? ((_p: typeof warmPool, _t: string, start: () => Promise<boolean>) => start().catch(() => false).then((started) => ({ admitted: true, started })));
    const before = spawns().length;
    pool.warmIntent(threadId, identity.botId);
    // the away edge lands after the admission, as the driver's start begins
    const result = await run(warmPool, threadId, () => { pool.ownerAway?.("locked"); return instance.adapter.prewarm!(threadId); });
    const admitted = { ok: result.admitted };
    const started = result.started ?? false;
    delete process.env.FAKE_CODEX_RESUME_GATE;
    const prewarmPid = spawns()[before];
    writeFileSync(resumeGate, ""); // the given-back start finishes now
    await new Promise((r) => setTimeout(r, 1_500));
    const idleAfter = warmPool.idleCount();
    const sendAt = Date.now();
    const second = await send("two");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 20_000);
    const dispatch2 = lines.find((l) => l.at >= sendAt && l.line.startsWith(`codex dispatch thread=${threadId} `))?.line ?? "";
    // W-PR6a-codex-epoch:no-late-park — admitted, given back (false past the wait), and after the away edge nothing is parked: the next
    // send spawns its own process (base: the late start parks and the send reuses the prewarm's process)
    expect({ admitted: admitted.ok, started, prewarmSpawned: prewarmPid !== undefined, idleAfter, sendSpawned: dispatch2.includes("process=spawned") }).toEqual({ admitted: true, started: false, prewarmSpawned: true, idleAfter: 0, sendSpawned: true });
  }, 60_000);

  // ASTRA/OPUS 08c6017e2c H (codex.ts prewarm: warmPool.startStillRunning / startEnded; warm-pool.ts startsInFlight): warmThread's own
  // tail (admitAndPrewarm) on the REAL CodexDriver. The prewarm on thread B outlasts MURAGE_PREWARM_WAIT_MS, answers false and is given
  // back while its start still runs. Another bot's engine that settled an owner turn sits idle. A low-memory check then (the pressure
  // may be that start's own) never closes the owner engine: not right after the give-back, and not 61 s later either (the start is
  // still running; only a LOST entry lapses at 60 s). Once the start ends the protection ends with it: pressure closes the unclaimed
  // prewarm first, then the owner engine. Base d7afddbe9f: the first check closes the owner engine.
  it("W-PR3m7 Codex: a prewarm given back past its wait keeps another bot's owner engine safe from pressure for as long as its start runs (past 60 s), and no longer", async () => {
    process.env.MURAGE_PREWARM_WAIT_MS = "500";
    process.env.MURAGE_WARM_POOL_BUDGET_MB = "100000";
    const threadB = `t-inflight-b-${randomUUID()}`;
    const threadA = `t-inflight-a-${randomUUID()}`;
    const ownerA = { botId: randomUUID(), audience: "owner" as const };
    const send = (threadId: string, text: string, warmIdentity: typeof identity) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity } satisfies SendTurnInput);
    // B: one owner turn leaves the remembered inputs; its engine lapses (window 250 ms)
    const b1 = await send(threadB, "one", identity);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === b1.turnId);
    expect(await eventually(() => warmPool.idleCount() === 0)).toBe(true);
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "3600000";
    // A: another bot's owner turn; its engine stays warm
    const a1 = await send(threadA, "one", ownerA);
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === a1.turnId);
    const ownerIdleBefore = (await eventually(() => warmPool.idleCount() === 1)) ? 1 : warmPool.idleCount();
    const resumeGate = join(scratch, "resume-gate");
    process.env.FAKE_CODEX_RESUME_GATE = resumeGate; // B's start (thread/resume) answers only once this file exists
    const shared = (await import("./warm-pool.ts")) as { admitAndPrewarm?: (p: typeof warmPool, t: string, start: () => Promise<boolean>) => Promise<{ admitted: boolean; started?: boolean }> };
    const run = shared.admitAndPrewarm ?? ((_p: typeof warmPool, _t: string, start: () => Promise<boolean>) => start().catch(() => false).then((started) => ({ admitted: true, started })));
    const before = spawns().length;
    warmPool.warmIntent(threadB, identity.botId);
    const result = await run(warmPool, threadB, () => instance.adapter.prewarm!(threadB));
    delete process.env.FAKE_CODEX_RESUME_GATE;
    const prewarmSpawned = spawns().length > before;
    // free memory under the floor from here on
    process.env.MURAGE_WARM_POOL_MIN_FREE_MB = "1000000000";
    await warmPool.tick();
    const keptWhileRunning = warmPool.idleCount();
    // 61 s later on the pool's clock the start is still running
    const real = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + 61_000);
    try { await warmPool.tick(); } finally { clock.mockRestore(); }
    const keptPast60s = warmPool.idleCount();
    writeFileSync(resumeGate, ""); // the given-back start finishes now
    const parked = await eventually(() => lines.some((l) => l.line === `codex prewarm thread=${threadB} parked=true`), 8_000);
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 4 && warmPool.idleCount() > 0; i++) await warmPool.tick();
    const releasedAfterEnd = warmPool.idleCount() === 0;
    // W-PR3m7-codex:given-back-in-flight — one line: the owner engine is kept while the given-back start runs (base: 0), still kept
    // past 60 s (the lapse: 0), and pressure works again once the start ended (a start never marked ended: false)
    expect({ admitted: result.admitted, started: result.started ?? false, prewarmSpawned, ownerIdleBefore, keptWhileRunning, keptPast60s, parked, releasedAfterEnd }).toEqual({ admitted: true, started: false, prewarmSpawned: true, ownerIdleBefore: 1, keptWhileRunning: 1, keptPast60s: 1, parked: true, releasedAfterEnd: true });
  }, 60_000);

  // W-PR6 (a) away (P-FENCE 2 last sentence): the owner goes away (lock/sleep/idle edge: index.ts ownerPresence.onAway calls
  // warmPool.ownerAway) while the prewarm hangs at its start. The away edge abandons it at once; the next send dispatches cold
  // within 1 s on a new pid, though the claim bound here (10 s) is far off. Base d7afddbe9f has no away edge at all (no ownerAway):
  // there the lock reaches nothing, as at 831b2c39bc, and the send waits out its claim.
  it("an away edge abandons a prewarm still starting: the next send dispatches at once on a new process and the hung one exits", async () => {
    process.env.MURAGE_PREWARM_WAIT_MS = "10000";
    const threadId = `t-detach-away-${randomUUID()}`;
    const send = (text: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity } satisfies SendTurnInput);
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(await eventually(() => warmPool.idleCount() === 0)).toBe(true);
    const before = spawns().length;
    writeFileSync(hangFile, "");
    const warming = instance.adapter.prewarm!(threadId);
    expect(await eventually(() => spawns().length > before)).toBe(true);
    const prewarmPid = spawns()[before]!;
    rmSync(hangFile);
    (warmPool as { ownerAway?: (cause: string) => number }).ownerAway?.("locked");
    const sentAt = Date.now();
    let failed: unknown = null;
    const second = await send("two").catch((error) => { failed = error; return null; });
    const completed = second ? await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 30_000) : null;
    const dispatch = lines.find((l) => l.at >= sentAt && l.line.startsWith(`codex dispatch thread=${threadId} `));
    // W-PR6a-codex-away:at-once — sent, delivered, and dispatched within 1 s of the send (base / 831b2c39bc: only past the 10 s claim)
    expect({ failed: failed === null ? null : String(failed), ok: (completed as { ok?: boolean } | null)?.ok ?? null, atOnce: dispatch !== undefined && dispatch.at - sentAt < 1_000 + LOAD_SLACK }).toEqual({ failed: null, ok: true, atOnce: true });
    const after = spawns().slice(before + 1);
    expect({ newProcess: after.length >= 1 && !after.includes(prewarmPid), detached: lines.some((l) => l.line === `codex prewarm detach thread=${threadId} reason=away`) }).toEqual({ newProcess: true, detached: true });
    expect(await warming).toBe(false);
    expect(await eventually(() => !pidAlive(prewarmPid), 15_000)).toBe(true);
  }, 60_000);
});

posixOnly("W-PR6 (a') Claude: a send behind a hung prewarm detaches it and runs cold (real driver, fake CLI)", () => {
  const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
  const CLAUDE_ENV = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_DUMP_EACH_TURN", "FAKE_CLAUDE_HANG_FILE", "FAKE_CLAUDE_HANG_LOG", "FAKE_CLAUDE_HANG_TERM_MS", "CLAUDE_CONFIG_DIR", "MURAGE_PREWARM_WAIT_MS", "MURAGE_WARM_ACTIVITY_WINDOW_MS"];
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let lines: Array<{ at: number; line: string }>;
  let info: ReturnType<typeof vi.spyOn>;
  const identity = { botId: "", audience: "owner" as const };
  const eventually = async (check: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return check();
  };

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLAUDE, 0o755);
    identity.botId = randomUUID();
    scratch = mkdtempSync(join(tmpdir(), "murage-presence-detach-claude-"));
    process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude-config");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    process.env.MURAGE_PREWARM_WAIT_MS = String(WAIT);
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
    lines = [];
    info = vi.spyOn(console, "info").mockImplementation((line: unknown) => { if (typeof line === "string" && line.startsWith("claude ")) lines.push({ at: Date.now(), line }); });
    instance = await ClaudeDriver.create({
      instanceId: "claude-presence-detach", displayName: "Claude Presence Detach", environment: { FAKE_CLAUDE_MCP_STATUS: "error" }, enabled: true,
      config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" },
    });
    bindFixtureAdapter(instance.adapter);
    withClaudeFixtureCwd(instance.adapter);
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    info.mockRestore();
    recorder?.stop();
    await instance?.dispose();
    for (const key of CLAUDE_ENV) delete process.env[key];
    await removeTempDir(scratch);
  });

  // A Claude prewarm parks as soon as its CLI is spawned (it never waits for the CLI's init), so its claim window is the dispatch
  // setup before the spawn. Here the prewarm's own spawn-headroom check (warmPool.beforeSpawn, claude.ts dispatchTurn) hangs.
  it("past the claim bound the send dispatches at once on a new process, the reply is delivered, and the hung prewarm never spawns", async () => {
    const threadId = `t-detach-claude-${randomUUID()}`;
    const send = (text: string, resumeCursor?: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity, draftOnly: true, ...(resumeCursor ? { resumeCursor } : {}) } satisfies SendTurnInput); // mount-free (S1 never prewarms a mounted turn)
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const session = ([...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined)?.sessionId;
    expect(await eventually(() => warmPool.idleCount() === 0 && lines.some((l) => l.line.includes(`claude close thread=${threadId} reason=activity window`)))).toBe(true);
    const original = warmPool.beforeSpawn.bind(warmPool);
    let release = () => {};
    let hangNext = true;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(warmPool, "beforeSpawn").mockImplementation(((...args: Parameters<typeof warmPool.beforeSpawn>) => {
      if (!hangNext) return original(...args);
      hangNext = false; // the next spawn-headroom check is the prewarm's: it hangs until released
      return hang.then(() => original(...args));
    }) as typeof warmPool.beforeSpawn);
    try {
      const startedAt = Date.now();
      const warming = instance.adapter.prewarm!(threadId);
      expect(await eventually(() => !hangNext)).toBe(true);
      const sentAt = Date.now();
      let failed: unknown = null;
      const second = await send("two", session).catch((error) => { failed = error; return null; });
      const completed = second ? await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 20_000).catch(() => null) : null;
      const dispatched = () => lines.filter((l) => l.at >= sentAt && l.line.startsWith(`claude dispatch thread=${threadId} `));
      // W-PR6a'-claude:sent — never failed because of the prewarm (base: stop, wait for its close, "the stopped turn has not closed yet")
      expect({ failed: failed === null ? null : String(failed), ok: (completed as { ok?: boolean } | null)?.ok ?? null }).toEqual({ failed: null, ok: true });
      // W-PR6a'-claude:at-once — dispatched by the prewarm's own start + the claim bound + 1 s
      expect(dispatched()[0]!.at - startedAt).toBeLessThan(WAIT + 1_000 + LOAD_SLACK);
      expect(lines.some((l) => l.line === `claude prewarm detach thread=${threadId} reason=hung`)).toBe(true);
      release();
      expect(await warming).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      // W-PR6a'-claude:no-late-spawn — the released, detached prewarm starts nothing: the send's dispatch is the only one
      expect(dispatched().map((l) => l.line.replace(/ shell=.*/, ""))).toEqual([`claude dispatch thread=${threadId} process=spawned reason=no-process`]);
    } finally { release(); spy.mockRestore(); }
  }, 60_000);

  // The CLI the prewarm spawned hangs at its start (it never answers the driver's initialize): the prewarm parks unconfirmed.
  it("a send never reuses a parked prewarm whose CLI never confirmed its start: it runs cold at once and the reply is delivered", async () => {
    const threadId = `t-detach-claude-park-${randomUUID()}`;
    const hangFile = join(scratch, "hang");
    const hangLog = join(scratch, "hang.log");
    writeFileSync(hangLog, "");
    process.env.FAKE_CLAUDE_HANG_LOG = hangLog;
    process.env.FAKE_CLAUDE_HANG_TERM_MS = "8000";
    const send = (text: string, resumeCursor?: string) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, warmIdentity: identity, draftOnly: true, ...(resumeCursor ? { resumeCursor } : {}) } satisfies SendTurnInput); // mount-free (S1 never prewarms a mounted turn)
    const first = await send("one");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const session = ([...recorder.events].reverse().find((e) => e.type === "session.started" && e.threadId === threadId) as { sessionId?: string } | undefined)?.sessionId;
    expect(await eventually(() => warmPool.idleCount() === 0 && lines.some((l) => l.line.includes(`claude close thread=${threadId} reason=activity window`)))).toBe(true);
    writeFileSync(hangFile, "");
    process.env.FAKE_CLAUDE_HANG_FILE = hangFile;
    await instance.adapter.prewarm!(threadId);
    expect(await eventually(() => readFileSync(hangLog, "utf8").trim().length > 0)).toBe(true);
    const prewarmPid = Number(readFileSync(hangLog, "utf8").trim().split("\n")[0]);
    rmSync(hangFile);
    const sentAt = Date.now();
    let failed: unknown = null;
    const second = await send("two", session).catch((error) => { failed = error; return null; });
    const completed = second ? await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId, 15_000).catch(() => null) : null;
    // W-PR6a'-claude-park:sent — the reply is delivered (base: the send writes into the hung CLI and never completes)
    expect({ failed: failed === null ? null : String(failed), ok: (completed as { ok?: boolean } | null)?.ok ?? null }).toEqual({ failed: null, ok: true });
    // W-PR6a'-claude-park:cold — dispatched at once on a new process, never on the hung prewarm
    const dispatch = lines.find((l) => l.at >= sentAt && l.line.startsWith(`claude dispatch thread=${threadId} `));
    const seen = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_DUMP!, "utf8")) as { pid: number };
    expect({ reason: /process=(\S+ reason=\S+)/.exec(dispatch!.line)?.[1], newPid: seen.pid !== prewarmPid, at: dispatch!.at - sentAt < 1_000 }).toEqual({ reason: "spawned reason=prewarm-start-unconfirmed", newPid: true, at: true });
  }, 60_000);
});
