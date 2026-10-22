// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r20: what keeps an engine's file harmless to the engine when the engine starts right after Murage looked. The process check is a policy
// gate (who is running, whether a home counts as done); the safety is the HOLD on each file (guard asked inside every destructive call,
// at most 500 ms), the compare of the planned bytes before each write, and the crash journal. These tests start real second processes
// after the last check, stall Murage, replace its lock between any two calls, cut a write at every byte, and make a proof fail.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationDeletions, ownerNoticeText, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState, processState, processVerdict } from "./engine-closed.ts";
import { executeEnginePlans, HOLD_MAX_MS } from "./engine-exec.ts";
import { ADDON_VERSION, WINDOWS_NATIVE_FUNCTIONS } from "./engine-exclusion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, type Step } from "./engine-plan-core.ts";
import { redoDirectory } from "./engine-redo.ts";
import { violations } from "./engine-structure-check.ts";
import { builtAddonPath, proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { asExclusive, buildFixture, canaryHits, walDatabase, type Fixture } from "./testing/engine-history-fixtures.ts";
import { loadEngineExclusionResource, validateEngineExclusionResource, WINDOWS_ADDON_FUNCTIONS } from "../scripts/engine-exclusion-resource.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r20-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const run = (fx: Fixture, planned = planEngineHistory(job(fx)), hooks = {}) => executeEnginePlans(structuredClone(planned.plans!), undefined, hooks);
const claudeHistory = (fx: Fixture) => join(fx.homes[0]!.home, "history.jsonl");
const lockOf = (fx: Fixture) => `${claudeHistory(fx)}.lock`;

// ── T2: who counts as the engine ──────────────────────────────────────────────────────────────────────────────────────────

describe("T2: processVerdict decides from what the system can still tell", () => {
  const none = (extra: Record<string, unknown>) => ({ pid: 900, ppid: 1, mine: true, start: 1, exe: null, argv: null, comm: null, ...extra }) as Parameters<typeof processState>[1][number];
  const verdict = (engine: string, list: Array<Parameters<typeof processState>[1][number]>, identities: string[] = []) => processState(engine, list, 1, identities);

  it("nothing readable at all is unknown; a name alone is enough; another ordinary user's interpreter with no arguments is not ours", () => {
    expect(verdict("claude", [none({ mine: null })])).toBe("unknown");
    expect(verdict("claude", [none({ mine: false, comm: "claude" })])).toBe("open");
    expect(verdict("claude", [none({ uid: 0, comm: "node" })])).toBe("unknown"); // root's node with arguments we cannot read
    exclOps.ownUid = () => 1000;
    expect(verdict("claude", [none({ uid: 777, comm: "node" })])).toBe("closed"); // another ordinary user's: no contribution
    expect(verdict("claude", [none({ uid: 1000, comm: "node" })])).toBe("unknown");
    expect(verdict("claude", [none({ comm: "node-24" })])).toBe("unknown"); // a versioned interpreter
    expect(verdict("claude", [none({ comm: "python3.12" })])).toBe("unknown");
    expect(verdict("claude", [none({ pid: 901, mine: null, comm: "System" })])).toBe("closed"); // a Windows system process with no owner we can read
  });

  it("a command that runs the engine's package through a link is the engine: `node …/bin/claude` -> …/node_modules/@anthropic-ai/claude-code/cli.js", () => {
    const base = mkdtempSync(join(scratch, "node-bin-"));
    mkdirSync(join(base, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(join(base, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "// cli");
    mkdirSync(join(base, "bin"));
    // a link whose NAME is not the engine's, so only where it leads says what it runs
    symlinkSync(join(base, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), join(base, "bin", "cc"));
    expect(verdict("claude", [proc("/usr/bin/node", ["/usr/bin/node", join(base, "bin", "cc")])])).toBe("open");
    // and by its name
    mkdirSync(join(base, "bin2"));
    symlinkSync(join(base, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), join(base, "bin2", "claude"));
    expect(verdict("claude", [proc("/usr/bin/node", ["/usr/bin/node", join(base, "bin2", "claude")])])).toBe("open");
    // a node running something else is not
    expect(verdict("claude", [proc("/usr/bin/node", ["/usr/bin/node", join(base, "node_modules", "@anthropic-ai", "claude-code", "..", "other.js")])])).toBe("closed");
  });

  it("a renamed copy of the configured program is the engine; the agent SDK host, codex helpers, hermes_cli and homebrew's gemini are too", () => {
    expect(verdict("claude", [proc("/opt/tools/cc-private", ["cc-private"])], ["/opt/tools/cc-private"])).toBe("open");
    expect(verdict("claude", [proc("/opt/tools/cc-private", ["cc-private"])])).toBe("closed");
    expect(verdict("claude", [proc("/usr/bin/node", ["node", "/x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"])])).toBe("open");
    expect(verdict("codex", [proc("/usr/lib/codex/codex-code-mode-host", ["codex-code-mode-host"])])).toBe("open");
    expect(verdict("droid", [proc("/usr/lib/droid-helper", ["droid-helper"])])).toBe("open");
    expect(verdict("hermes", [proc("/usr/bin/python3", ["python3", "-m", "hermes_cli.main"])])).toBe("open");
    expect(verdict("gemini", [proc("/usr/bin/node", ["node", "/opt/homebrew/bin/gemini"])])).toBe("open");
  });

  it("the desktop application is told apart: its bundle makes the engine open and names the app; a plain program does not", () => {
    expect(processVerdict("claude", [proc("/Applications/Claude.app/Contents/MacOS/Claude")], 1)).toEqual({ state: "open", app: "Claude" });
    expect(processVerdict("claude", [proc("/Applications/Claude.app/Contents/MacOS/Claude"), proc("/usr/bin/claude", ["claude"])], 1)).toEqual({ state: "open" });
    expect(processVerdict("cursor", [proc("/Applications/Cursor.app/Contents/MacOS/Cursor")], 1)).toEqual({ state: "open", app: "Cursor" });
  });

  it("Codex's managed daemon outlives the terminal and is not the engine in use; the terminal is; the engine's own locks say when it works", () => {
    const home = "/home/u/.codex/packages/app-server-daemon/1.0/codex";
    const daemon = proc(home, ["codex", "app-server", "--listen", "unix://", "--managed-daemon"]);
    const loop = proc(home, ["codex", "app-server", "daemon", "pid-update-loop"]);
    expect(verdict("codex", [daemon, loop])).toBe("closed");
    expect(verdict("codex", [daemon, proc("/usr/bin/codex", ["codex"])])).toBe("open");
    expect(verdict("codex", [proc("/usr/bin/codex", ["codex", "app-server"])])).toBe("open"); // not a daemon
    // with only the daemon running, the thread's writer lock (held for about a minute after the terminal closes) and the history lock decide
    fake.processes = [daemon, loop];
    const fx = buildFixture("codex", scratch);
    const home1 = fx.homes[0]!.home;
    expect(engineState("codex", home1).state).toBe("closed");
    mkdirSync(join(home1, "thread-writer-locks"), { recursive: true });
    const writer = join(home1, "thread-writer-locks", "t1.lock");
    writeFileSync(writer, "");
    const release = fake.keepLock(writer);
    expect(engineState("codex", home1)).toEqual({ state: "open", via: "lock" });
    release();
    expect(engineState("codex", home1).state).toBe("closed");
    // and a deletion goes ahead while only the daemon is up
    expect(run(fx).failed).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("a list without this process, or without its parent, is no answer: unknown (via the enumeration)", () => {
    const fx = buildFixture("claude", scratch);
    const real = exclOps.processes;
    exclOps.processes = () => [proc("/usr/bin/vim")];
    try { expect(engineState("claude", fx.homes[0]!.home)).toEqual({ state: "unknown", via: "enumeration" }); } finally { exclOps.processes = real; }
    exclOps.processes = () => { throw new Error("EIO"); };
    try { expect(engineState("claude", fx.homes[0]!.home)).toEqual({ state: "unknown", via: "enumeration" }); } finally { exclOps.processes = real; }
  });
});

// ── an engine that is not seen at all is still met by the hold (R7) ───────────────────────────────────────────────────────

describe("a renamed running engine is invisible to the process check and is still met by the hold", () => {
  it("Claude copied as zzz-agent takes its history lock just after the gate: nothing is written, the home is pending, the lock is its own", () => {
    const fx = buildFixture("claude", scratch);
    const planned = planEngineHistory(job(fx));
    const before = readFileSync(claudeHistory(fx));
    fake.processes = []; // the gate sees no engine
    fake.calls.length = 0;
    const ran = run(fx, planned, { afterGate: (_key: string, _index: number, step: Step) => { if (step.k === "rewrite" && !existsSync(lockOf(fx))) { mkdirSync(lockOf(fx)); writeFileSync(join(lockOf(fx), "engine"), "zzz-agent"); } } });
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(fake.calls.includes("pwrite")).toBe(false);
    expect(readFileSync(claudeHistory(fx)).equals(before)).toBe(true);
    expect(readFileSync(join(lockOf(fx), "engine"), "utf8")).toBe("zzz-agent");
  });

  it("Codex copied as qqq-tool keeps the history lock: nothing is written and the home is pending", () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const planned = planEngineHistory(job(fx));
    const before = readFileSync(history);
    fake.calls.length = 0;
    let release = () => {};
    let taken = false;
    const ran = run(fx, planned, { afterGate: (_key: string, _index: number, step: Step) => { if (!taken && step.k === "rewrite" && step.path === history) { taken = true; release = fake.keepLock(history); } } });
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(fake.calls.includes("pwrite")).toBe(false);
    expect(readFileSync(history).equals(before)).toBe(true);
    release();
  });
});

// ── T12: the words ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("T12: each cause has its own words, and 'is open' is said only when it is open", () => {
  it("the lines", () => {
    expect(ownerNoticeText("Claude Code", "engine-open")).toBe("Claude Code is open. Close Claude Code and Murage will finish removing this conversation from it.");
    expect(ownerNoticeText("Claude Code", "engine-open", "Claude")).toBe("Claude Code or the Claude app is open. Close them and Murage will finish removing this conversation from Claude Code.");
    expect(ownerNoticeText("Claude Code", "engine-unchecked")).toBe("Murage will check again within 10 minutes whether Claude Code is open.");
    expect(ownerNoticeText("Codex", "held")).toBe("Another program is using Codex's files. Murage will try again in 10 minutes.");
    expect(ownerNoticeText("Kimi", "aside")).toBe("Kimi started a new file while Murage had the old one set aside. Murage will join them and try again in 10 minutes.");
    for (const code of ["engine-open", "engine-unchecked", "held", "aside"] as const) expect(ownerNoticeText("X", code, "Y")).not.toMatch(/—|\bunsafe\b|\bsafe\b/);
  });

  it("an enumeration that throws says it could not check, and the Claude app being open names the app", async () => {
    class Scripted extends EventEmitter {
      threadId = 12;
      postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
      terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
    }
    const make = async (setup: () => void) => {
      const fx = buildFixture("claude", scratch);
      const data = join(fx.root, "data");
      mkdirSync(data, { recursive: true });
      const db = new DatabaseSync(join(data, "messages.db"));
      openDatabases.push(db);
      const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
      engineHistoryTestHooks.createWorker = () => new Scripted() as unknown as Worker;
      setup();
      await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
      const text = deletions.notices().map((item) => item.text);
      deletions.dispose();
      return text;
    };
    expect(await make(() => { fake.processesFail = true; })).toEqual(["Murage will check again within 10 minutes whether Claude Code is open."]);
    fake.processesFail = false;
    expect(await make(() => { fake.processes = [proc("/Applications/Claude.app/Contents/MacOS/Claude")]; })).toEqual(["Claude Code or the Claude app is open. Close them and Murage will finish removing this conversation from Claude Code."]);
    fake.processes = [];
  });
});

// ── T11: no gap above ten minutes ─────────────────────────────────────────────────────────────────────────────────────────

describe("T11: the pause between tries never passes 10 minutes while an engine, a file or a new file is what is waited for", () => {
  it("attempts 0..50 for Claude and Codex", () => {
    for (const [engine, code] of [["claude", "engine-open"], ["codex", "engine-open"], ["claude", "held"], ["kimi", "aside"], ["claude", "engine-unchecked"]] as const) {
      const delays: number[] = [];
      const real = globalThis.setTimeout;
      globalThis.setTimeout = ((_fn: () => void, ms: number) => { delays.push(ms); return { unref() {}, [Symbol.toPrimitive]: () => 0 } as unknown as NodeJS.Timeout; }) as typeof setTimeout;
      const data = mkdtempSync(join(scratch, "retry-"));
      const db = new DatabaseSync(join(data, "messages.db"));
      openDatabases.push(db);
      const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
      const entry = { id: "e1", threadIds: [], owed: { since: 1, homes: [{ engine, code }] } };
      const internals = deletions as unknown as { scheduleRetry(entry: unknown): void; retries: Map<string, { attempts: number; timer?: unknown }> };
      try {
        for (let attempt = 0; attempt <= 50; attempt++) { internals.scheduleRetry(entry); const state = internals.retries.get("e1"); if (state) state.timer = undefined; }
      } finally { globalThis.setTimeout = real; deletions.dispose(); }
      expect(delays.length, `${engine}/${code}`).toBeGreaterThan(50);
      expect(Math.max(...delays), `${engine}/${code}`).toBeLessThanOrEqual(600_000);
      if (engine === "codex") expect(delays.slice(0, 6)).toEqual([30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    }
  });
});

// ── T10: the packaged addon is what it must be ────────────────────────────────────────────────────────────────────────────

describe("T10: the packaging gate loads the real addon for the target and refuses a header-only stub", () => {
  const dir = () => mkdtempSync(join(scratch, "pkg-"));
  const put = (target: string, bytes: Buffer) => { writeFileSync(join(target, "engine-exclusion.node"), bytes); return target; };
  const machoHeader = (cputype: number, filetype: number) => { const b = Buffer.alloc(4096); b.writeUInt32BE(0xcffaedfe, 0); b.writeUInt32LE(cputype, 4); b.writeUInt32LE(filetype, 12); return b; };

  it("a 2,048-byte zero Mach-O is refused; an image that is not a loadable bundle is refused; an x64 addon in an arm64 package is refused", () => {
    const zero = Buffer.alloc(2048);
    zero.writeUInt32BE(0xcffaedfe, 0); zero.writeUInt32LE(0x0100000c, 4);
    expect(() => validateEngineExclusionResource(put(dir(), zero), "darwin", "arm64")).toThrow(/INVALID|MISMATCH/);
    const big = Buffer.alloc(4096); big.writeUInt32BE(0xcffaedfe, 0); big.writeUInt32LE(0x0100000c, 4);
    expect(() => validateEngineExclusionResource(put(dir(), big), "darwin", "arm64")).toThrow(/MISMATCH/); // header only: not MH_BUNDLE
    expect(() => validateEngineExclusionResource(put(dir(), machoHeader(0x01000007, 8)), "darwin", "arm64")).toThrow(/MISMATCH/);
    expect(validateEngineExclusionResource(put(dir(), machoHeader(0x0100000c, 8)), "darwin", "arm64")).toMatch(/engine-exclusion\.node$/);
  });

  it("the real addon built here is accepted for its own architecture and refused for the other", () => {
    const built = builtAddonPath();
    if (!built) return;
    const target = dir();
    writeFileSync(join(target, "engine-exclusion.node"), readFileSync(built));
    const platform = process.platform as "linux" | "darwin" | "win32";
    const host = process.arch as "x64" | "arm64";
    expect(validateEngineExclusionResource(target, platform, host)).toMatch(/engine-exclusion\.node$/);
    if (platform === "linux") expect(() => validateEngineExclusionResource(target, platform, host === "x64" ? "arm64" : "x64")).toThrow(/MISMATCH/);
  });

  it("loading it runs the target's runtime as Node, checks the version and that it lists this process, and has no way to skip", () => {
    const built = builtAddonPath();
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const answer = (list: unknown[]) => (command: string, args: string[], env: Record<string, string>) => { calls.push({ command, args, env }); return JSON.stringify(list); };
    const host = { platform: "darwin", arch: "arm64" };
    expect(loadEngineExclusionResource("/p/engine-exclusion.node", "darwin", "arm64", 4, answer([4, "function", "function", "function", true, []]), "/App/Murage", host)).toBe("loaded");
    expect(calls[0]!.command).toBe("/App/Murage");
    expect(calls[0]!.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // the other macOS architecture is run through arch(1)
    loadEngineExclusionResource("/p/engine-exclusion.node", "darwin", "x64", 4, answer([4, "function", "function", "function", true, []]), "/App/Murage", host);
    expect(calls[1]!.command).toBe("/usr/bin/arch");
    expect(calls[1]!.args.slice(0, 2)).toEqual(["-x86_64", "/App/Murage"]);
    // a stub that cannot answer, one of another version, one that does not list this process
    expect(() => loadEngineExclusionResource("/p/x.node", "darwin", "arm64", 4, () => { throw new Error("not a loadable image"); }, "/App/Murage", host)).toThrow(/UNLOADABLE/);
    expect(() => loadEngineExclusionResource("/p/x.node", "darwin", "arm64", 4, answer([3, "function", "function", "function", true]), "/App/Murage", host)).toThrow(/VERSION/);
    expect(() => loadEngineExclusionResource("/p/x.node", "darwin", "arm64", 4, answer([4, "function", "function", "function", false]), "/App/Murage", host)).toThrow(/VERSION/);
    // a package this machine cannot run is NOT passed unchecked
    expect(() => loadEngineExclusionResource("/p/x.node", "win32", "x64", 4, answer([4, "function", "function", "function", true]), "/App/Murage.exe", host)).toThrow(/UNTESTED/);
    expect(() => loadEngineExclusionResource("/p/x.node", "linux", "arm64", 4, answer([4, "function", "function", "function", true]), "/App/murage", { platform: "linux", arch: "x64" })).toThrow(/UNTESTED/);
    expect(() => loadEngineExclusionResource("/p/x.node", "darwin", "arm64", 4, answer([4, "function", "function", "function", true]), undefined as unknown as string, host)).toThrow(/UNTESTED/);
    // a Windows package whose addon lacks a call that replaced a PowerShell start is refused, never degraded (murage-releases #1)
    const win = { platform: "win32", arch: "x64" };
    expect(loadEngineExclusionResource("/p/x.node", "win32", "x64", 4, answer([4, "function", "function", "function", true, []]), "/App/Murage.exe", win)).toBe("loaded");
    expect(() => loadEngineExclusionResource("/p/x.node", "win32", "x64", 4, answer([4, "function", "function", "function", true, ["speechToWave"]]), "/App/Murage.exe", win)).toThrow(/FUNCTIONS/);
    expect(() => loadEngineExclusionResource("/p/x.node", "win32", "x64", 4, answer([4, "function", "function", "function", true]), "/App/Murage.exe", win)).toThrow(/FUNCTIONS/);
    expect(calls.at(-1)!.args[1]).toContain(JSON.stringify(WINDOWS_ADDON_FUNCTIONS));
    expect([...WINDOWS_ADDON_FUNCTIONS].sort()).toEqual([...new Set(["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose", "removeTree", ...WINDOWS_NATIVE_FUNCTIONS])].sort());
    // for real: this machine's Node loads the built addon
    if (built && process.platform !== "win32") {
      const text = loadEngineExclusionResource(built, process.platform, process.arch, ADDON_VERSION, (command, args, env) => spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" }).stdout, process.execPath);
      expect(text).toBe("loaded");
      expect(() => loadEngineExclusionResource(built, process.platform, process.arch, 4, (command, args, env) => spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" }).stdout, process.execPath)).toThrow(/VERSION/);
    }
  });
});

// ── T13: the structure keeps the guard inside every destructive call ──────────────────────────────────────────────────────

describe("T13: structure", () => {
  const source = readFileSync(new URL("./engine-exec.ts", import.meta.url), "utf8");

  it("the executor's real source passes, and a raw destructive call, a public lock removal or a scrub export is refused", () => {
    expect(violations("engine-exec.ts", source)).toEqual([]);
    expect(violations("engine-redo.ts", readFileSync(new URL("./engine-redo.ts", import.meta.url), "utf8"))).toEqual([]);
    const bad = (line: string) => violations("engine-exec.ts", `${source}\n${line}\n`);
    expect(bad("function leak(path: string) { mutOps.unlink(path); }").some((item) => /outside a guarded primitive/.test(item))).toBe(true);
    expect(bad("function leak(path: string) { mutOps.pwrite(1, Buffer.alloc(1), 0); }").some((item) => /outside a guarded primitive/.test(item))).toBe(true);
    expect(bad("function leak(a: string, b: string) { exclOps.renameNoReplace(a, b); }").some((item) => /outside a guarded primitive/.test(item))).toBe(true);
    expect(bad("function leak(g: Guard, file: string) { const lock = `${file}.lock`; gRmdir(g, lock); }").some((item) => /public path of a lock folder/.test(item))).toBe(true);
    expect(bad("function leak(g: Guard, file: string) { gRmdir(g, `${file}.lock`); }").some((item) => /public path of a lock folder/.test(item))).toBe(true);
    expect(bad("export function scrubJsonlInPlace() { return 0; }").some((item) => /exports scrubJsonlInPlace/.test(item))).toBe(true);
    expect(bad("export function scrubFuigoSearchIndex() { return false; }").some((item) => /exports scrubFuigoSearchIndex/.test(item))).toBe(true);
    expect(violations("engine-redo.ts", `import { writeFileSync } from "node:fs";\n${readFileSync(new URL("./engine-redo.ts", import.meta.url), "utf8")}`).some((item) => /node:fs/.test(item))).toBe(true);
    expect(source).not.toMatch(/export function scrub/);
    expect(readFileSync(new URL("./conversation-deletion.ts", import.meta.url), "utf8")).not.toMatch(/scrubFuigoSearchIndex|scrubJsonlInPlace/);
  });

  it("every step keyed by the ids a state store has to vouch for waits for that proof", () => {
    const fx = codexWithUnprovenThread();
    const plan = Object.values(planEngineHistory(job(fx)).plans!)[0]!;
    const checks = plan.steps.filter((step) => step.k === "ownerCheck");
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) { expect(check.id).toMatch(/^owner:/); expect(check.needs).toBeUndefined(); expect(check.cls).toBe("content"); }
    const ids = checks.map((check) => check.id!);
    const keyed = plan.steps.filter((step) => step.k === "sqlDelete" || step.k === "checkpoint" || (step.k === "rewrite" && /history\.jsonl$|session_index\.jsonl$/.test(step.path)) || (step.k === "remove" && step.target.includes("shell_snapshots")));
    expect(keyed.length).toBeGreaterThan(3);
    for (const step of keyed) expect(step.needs, `${step.k}`).toEqual(ids);
  });
});

/** Codex whose threads are known only from its state store (no rollout names them), so their owner is checked there first. */
function codexWithUnprovenThread(): Fixture {
  const fx = buildFixture("codex", scratch);
  const home = fx.homes[0]!.home;
  const sql = fx.homes[0]!.sqliteHome!;
  for (const name of readdirSync(join(home, "sessions", "2026", "10", "11"))) if (name.includes("000000000001")) rmSync(join(home, "sessions", "2026", "10", "11", name));
  for (const name of readdirSync(join(home, "archived_sessions"))) rmSync(join(home, "archived_sessions", name));
  rmSync(join(sql, "state_1.sqlite")); rmSync(join(sql, "state_1.sqlite-wal"), { force: true });
  const tid = "019a0000-aaaa-7bbb-8ccc-000000000001", zid = "019a0000-aaaa-7bbb-8ccc-000000000002", oid = "019a0000-aaaa-7bbb-8ccc-0000000000ff";
  walDatabase(join(sql, "state_1.sqlite"), (db) => {
    db.exec("CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
    for (const id of [tid, zid]) {
      db.prepare("INSERT INTO threads VALUES(?,?,?)").run(id, C("codex"), fx.folders[0]!);
      db.prepare("INSERT INTO logs VALUES(?,?)").run(id, C("codex"));
    }
    db.prepare("INSERT INTO threads VALUES(?,?,?)").run(oid, B("codex"), "/other/folder");
    db.prepare("INSERT INTO logs VALUES(?,?)").run(oid, B("codex"));
  });
  return fx;
}

// ── T6: a proof that fails stops everything that depends on it ────────────────────────────────────────────────────────────

describe("T6: an owner check that throws (EIO, ENOENT, SQLITE_BUSY, anything) leaves every dependent step unrun", () => {
  for (const [name, make] of [
    ["EIO", () => Object.assign(new Error("read failed"), { code: "EIO" })],
    ["ENOENT", () => Object.assign(new Error("gone"), { code: "ENOENT" })],
    ["SQLITE_BUSY", () => new Error("database is locked")],
    ["an Error", () => new Error("boom")],
  ] as const) {
    it(`${name}: history, session index, snapshots and the store are byte-identical, and the home is pending`, () => {
      const fx = codexWithUnprovenThread();
      const home = fx.homes[0]!.home;
      const files = [join(home, "history.jsonl"), join(home, "session_index.jsonl"), join(home, "shell_snapshots", "019a0000-aaaa-7bbb-8ccc-000000000001.1.sh")];
      const before = files.map((file) => readFileSync(file));
      const planned = planEngineHistory(job(fx));
      expect(Object.values(planned.plans!)[0]!.steps.some((step) => step.k === "ownerCheck")).toBe(true);
      const real = mutOps.openDbWrite;
      let writes = 0;
      const pw = mutOps.pwrite;
      mutOps.pwrite = ((fd: never, bytes: Buffer, at: number) => { writes++; pw(fd, bytes, at); }) as typeof mutOps.pwrite;
      mutOps.openDbWrite = (() => { throw make(); }) as typeof mutOps.openDbWrite;
      let ran!: ReturnType<typeof run>;
      try { ran = run(fx, planned); } finally { mutOps.openDbWrite = real; mutOps.pwrite = pw; }
      expect(ran.failedHomes).toEqual([key(fx)]);
      expect(writes).toBe(0);
      files.forEach((file, index) => expect(readFileSync(file).equals(before[index]!), file).toBe(true));
      const store = new DatabaseSync(join(fx.homes[0]!.sqliteHome!, "state_1.sqlite"));
      try { expect((store.prepare("SELECT count(*) AS n FROM threads").get() as { n: number }).n).toBe(3); } finally { store.close(); }
      // and when the proof holds, everything runs
      expect(run(fx).failed).toEqual([]);
      expect(canaryHits(fx.root, [C("codex")]).filter((hit) => !hit.includes("state_1.sqlite-wal"))).toEqual([]);
    });
  }
});

// ── T4: a stalled Murage never writes under an old hold ───────────────────────────────────────────────────────────────────

/** Replaces the clock and wraps every call of the executor's layers so that a pause of `pause` ms can be injected before call number
 * `stallAt`, and every destructive call can be checked against the age of the hold it runs under. */
function instrument(options: { stallAt?: number; pause?: number } = {}) {
  const log: { ageAtDestructive: Array<{ name: string; age: number; path: string }>; calls: number; destructive: string[]; trace: string[]; acquires: number } = { ageAtDestructive: [], calls: 0, destructive: [], trace: [], acquires: 0 };
  let virtual = 0;
  let acquiredAt: number | null = null;
  const saved: Array<() => void> = [];
  const wrap = <T extends object>(layer: T, name: keyof T, kind: "other" | "destructive" | "acquire") => {
    const real = layer[name] as unknown as (...args: unknown[]) => unknown;
    (layer as Record<string, unknown>)[name as string] = (...args: unknown[]) => {
      log.trace.push(`${virtual} ${String(name)} ${typeof args[0] === "string" ? args[0].split("/").slice(-2).join("/") : args[0]}${kind === "other" && options.stallAt === log.calls + 1 ? " <== stall" : ""}`);
      if (kind === "destructive") {
        log.destructive.push(String(name));
        // Murage's own crash journal is not an engine's file: removing it asks no hold
        const journal = name === "unlink" && String(args[0]).startsWith(redoDirectory() ?? "\0");
        if (acquiredAt !== null && !journal) log.ageAtDestructive.push({ name: String(name), age: virtual - acquiredAt, path: String(args[0]) });
      } else {
        log.calls++;
        if (options.stallAt !== undefined && log.calls === options.stallAt) virtual += options.pause ?? 600;
      }
      // a hold begins when the engine's lock is taken (a lock folder made, a whole-file lock taken) and ends when it is let go
      const result = real(...args);
      // the hold begins when the call that takes it returns
      if (kind === "acquire" && (name !== "renameNoReplace" || (String(args[1]).endsWith(".lock") && result === "ok")) && acquiredAt === null) acquiredAt = virtual;
      if (kind === "acquire" && (name !== "renameNoReplace" || (String(args[1]).endsWith(".lock") && result === "ok"))) log.acquires++;
      if (name === "close" || name === "rmdir") acquiredAt = null;
      return result;
    };
    saved.push(() => { (layer as Record<string, unknown>)[name as string] = real; });
  };
  const originalNow = mutOps.now;
  mutOps.now = () => virtual;
  saved.push(() => { mutOps.now = originalNow; });
  for (const name of ["pread", "fstat", "idOf", "idOfFd", "fsync", "touch", "openRead", "close"] as const) wrap(mutOps, name, "other");
  for (const name of ["unlink", "rmdir", "link", "pwrite"] as const) wrap(mutOps, name, "destructive");
  wrap(exclOps, "renameNoReplace", "acquire"); // the lock folder takes its public name
  wrap(exclOps, "lock", "acquire");
  return { log, restore: () => { for (const undo of saved.reverse()) undo(); } };
}

describe("T4: a pause of 600 ms injected at every call of a step aborts before any destructive call made under a hold older than 500 ms", () => {
  it("HOLD_MAX_MS is 500", () => { expect(HOLD_MAX_MS).toBe(500); });

  for (const engine of ["claude", "codex", "fuigo", "kimi"] as const) {
    it(`${engine}: stall at each call in turn`, () => {
      const baseline = (() => { const fx = buildFixture(engine, scratch); const planned = asExclusive(planEngineHistory(job(fx))); const spy = instrument(); try { run(fx, planned); } finally { spy.restore(); } return spy.log; })();
      const count = baseline.calls;
      expect(count).toBeGreaterThan(10);
      let aborted = 0;
      for (let stallAt = 1; stallAt <= count; stallAt++) {
        const fx = buildFixture(engine, scratch);
        const planned = asExclusive(planEngineHistory(job(fx)));
        const spy = instrument({ stallAt, pause: 600 });
        let ran!: ReturnType<typeof run>;
        try { ran = run(fx, planned); } finally { spy.restore(); }
        for (const item of spy.log.ageAtDestructive) expect(item.age, `${engine}: stall at call ${stallAt}: ${item.name} ${item.path}\n${spy.log.trace.join("\n")}`).toBeLessThanOrEqual(HOLD_MAX_MS);
        // a hold that ran out is taken again once (more holds than in a run with no pause), or the step is stale
        if (ran.failedHomes.length || ran.staleHomes.length || spy.log.acquires > baseline.acquires) aborted++;
        // whatever happened, the files are whole: the next plan reads them and finishes the job
        expect(fx.checkBystanders(), `${engine}: stall at call ${stallAt}`).toEqual([]);
        fake.processes = [];
        const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
        expect(again.failed, `${engine}: stall at call ${stallAt}`).toEqual([]);
      }
      expect(aborted).toBeGreaterThan(0);
    }, 120_000);
  }

  it("11,001 ms pass while a paste is being removed and a cooperating Claude takes the abandoned lock and writes a reference: the paste stays and the reference opens", () => {
    const fx = buildFixture("claude", scratch);
    const hash = "ab12cd34ef56ab12";
    const paste = join(fx.homes[0]!.home, "paste-cache", `${hash}.txt`);
    const planned = planEngineHistory(job(fx));
    const lock = lockOf(fx);
    let virtual = 0;
    const originalNow = mutOps.now;
    mutOps.now = () => virtual;
    let locks = 0, stalled = false;
    const realMove = exclOps.renameNoReplace, realMtime = exclOps.mtimeOf;
    exclOps.renameNoReplace = ((from: string, to: string) => { const out = realMove(from, to); if (to === lock && out === "ok") locks++; return out; }) as typeof realMove;
    // inside the paste's lock (the second one), right after the check of what arrived: eleven seconds pass and the engine behaves as Claude
    // does with a lock untouched for 10 s: it takes it over and writes a row that names the paste
    exclOps.mtimeOf = ((path: string) => {
      if (path === lock && locks >= 2 && !stalled) {
        stalled = true;
        virtual += 11_001;
        const old = new Date(Date.now() - 11_001);
        utimesSync(lock, old, old);
        renameSync(lock, `${lock}.engine-tmp`); removeTempDirSync(`${lock}.engine-tmp`); mkdirSync(lock);
        appendFileSync(claudeHistory(fx), `${JSON.stringify({ sessionId: "sess-new", project: "/other", display: "x", pastedContents: { 1: { contentHash: hash } } })}\n`);
      }
      return realMtime(path);
    }) as typeof realMtime;
    let ran!: ReturnType<typeof run>;
    try { ran = run(fx, planned); } finally { exclOps.renameNoReplace = realMove; exclOps.mtimeOf = realMtime; mutOps.now = originalNow; }
    expect(stalled).toBe(true);
    expect(existsSync(paste)).toBe(true);
    expect(readFileSync(paste, "utf8")).toBe(C("claude"));
    expect(readFileSync(claudeHistory(fx), "utf8")).toContain(hash);
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(existsSync(lock)).toBe(true); // the engine's new lock was not touched
  });
});

// ── T5: the lock is replaced between any two calls ────────────────────────────────────────────────────────────────────────

describe("T5: a lock replaced by another between any two calls of acquiring, replacing a stale one, or releasing survives, and nothing is written under it", () => {
  const spyAll = (lock: string, replaceAt: number | null) => {
    const state = { calls: 0, replaced: false, pwritesAfter: 0, publicRmdir: 0, trace: [] as string[] };
    const saved: Array<() => void> = [];
    const maybeReplace = () => {
      state.calls++;
      if (replaceAt !== null && state.calls === replaceAt) {
        state.replaced = true;
        removeTempDirSync(lock);
        mkdirSync(lock);
        writeFileSync(join(lock, "foreign"), "foreign lock");
      }
    };
    const wrap = <T extends object>(layer: T, name: keyof T, fn?: (args: unknown[]) => void) => {
      const real = layer[name] as unknown as (...args: unknown[]) => unknown;
      (layer as Record<string, unknown>)[name as string] = (...args: unknown[]) => { state.trace.push(`${state.calls + 1} ${String(name)} ${typeof args[0] === "string" ? args[0].split("/").slice(-1)[0] : args[0]}${typeof args[1] === "string" ? ` -> ${args[1].split("/").slice(-1)[0]}` : ""}${state.replaced ? " (foreign)" : ""}`); fn?.(args); maybeReplace(); return real(...args); };
      saved.push(() => { (layer as Record<string, unknown>)[name as string] = real; });
    };
    wrap(mutOps, "mkdir"); wrap(mutOps, "touch"); wrap(mutOps, "idOf"); wrap(mutOps, "fstat"); wrap(mutOps, "pread"); wrap(mutOps, "fsync");
    wrap(mutOps, "rmdir", (args) => { if (args[0] === lock) state.publicRmdir++; });
    wrap(mutOps, "pwrite", () => { if (state.replaced) state.pwritesAfter++; });
    wrap(exclOps, "renameNoReplace");
    return { state, restore: () => { for (const undo of saved.reverse()) undo(); } };
  };

  for (const stale of [false, true]) {
    it(stale ? "an abandoned lock is being replaced by Murage" : "Murage takes and releases its own lock", () => {
      let total = 0;
      {
        const fx = buildFixture("claude", scratch);
        if (stale) { mkdirSync(lockOf(fx)); const old = new Date(Date.now() - 30_000); utimesSync(lockOf(fx), old, old); }
        const spy = spyAll(lockOf(fx), null);
        try { run(fx); } finally { spy.restore(); }
        total = spy.state.calls;
      }
      expect(total).toBeGreaterThan(5);
      let survived = 0;
      for (let at = 1; at <= total; at++) {
        const fx = buildFixture("claude", scratch);
        const lock = lockOf(fx);
        const planned = planEngineHistory(job(fx));
        if (stale) { mkdirSync(lock); const old = new Date(Date.now() - 30_000); utimesSync(lock, old, old); }
        const spy = spyAll(lock, at);
        try { run(fx, planned); } finally { spy.restore(); }
        expect(spy.state.replaced, `at ${at}`).toBe(true);
        expect(spy.state.publicRmdir, `the public lock path is never removed (at ${at})`).toBe(0);
        // the foreign lock is still at the public path, or was moved aside under a recorded private name
        const leftovers = readdirSync(fx.homes[0]!.home).filter((name) => name.startsWith("history.jsonl.lock.murage-"));
        const atPath = existsSync(join(lock, "foreign"));
        const aside = leftovers.some((name) => existsSync(join(fx.homes[0]!.home, name, "foreign")));
        expect(atPath || aside, `at ${at}`).toBe(true);
        if (atPath || aside) survived++;
        // and once it was foreign, Murage wrote nothing under it
        expect(spy.state.pwritesAfter, `writes after the replacement (at ${at})\n${spy.state.trace.join("\n")}`).toBe(0);
      }
      expect(survived).toBe(total);
    }, 120_000);
  }
});
