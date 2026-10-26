// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Antigravity at Auto and Full access on a Cloud home (lanes/cloud-v2/AGY-RELAY-MERGE-SPEC.md). The 1.0.3 relay is
// unchanged; a home adds: the relay socket and log in the broker folder, the hook rendered by the launcher into the
// turn's own HOME, and the launcher's empty placeholders over the project hooks files, which agy counts and names.
// The hook-load check stays exact around them: one hook, every other named hooks.json path foreign, every workspace
// root scanned. Cases (a) to (g) are the spec's home cases; (h) is the log Murage makes itself.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { CLOUD_BROKER_DIR, TURN_RENDER } from "../cloud-home/turn-process.ts";
import * as procs from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import * as antigravity from "./antigravity.ts";
import { ANTIGRAVITY_HOOK_NOT_LOADED, AntigravityDriver } from "./antigravity.ts";
import {
  ANTIGRAVITY_WORKSPACE_ROOTS, antigravityLauncherMasks, antigravityRelayAsk, antigravityWorkspaceHookFiles, launcherPlaceholder,
  makeLauncherPlaceholder, openAntigravityRelay, openCloudRelay, relayHookLoadState, removeCloudRelayLog, type PlaceholderProbe,
} from "./antigravity-relay.ts";

const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const FAKE_ENV = ["FAKE_AGY_DUMP", "FAKE_AGY_TOOL_CALLS", "FAKE_AGY_RUN_HOOKS"];
const ENGINE_HOME = "/data/engine-homes/antigravity";
const ROOTS = [".agents", ".agent", "_agents", "_agent"];
const HOOKS_PATH = `${ENGINE_HOME}/.gemini/config/hooks.json`;

/** agy's start-up lines as far as the hook-load check reads them: every hooks.json it names, then its count. */
const agyLog = (named: readonly string[], hooks: number, files: number) =>
  [...named.map((path) => `hooks_manager: reading ${path}`), `hooks_manager: loaded ${hooks} named hooks from ${files} hooks.json file(s)`].join("\n") + "\n";

describe("home relay (a): the hook-load check counts the launcher's placeholders and nothing else", () => {
  let cwd = "";
  beforeEach(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-load-"))); });
  afterEach(async () => { await removeTempDir(cwd); });
  const one = () => [join(cwd, ".agents", "hooks.json")];
  const state = (log: string, launcherMasks?: readonly string[]) => relayHookLoadState(log, { hooksPath: HOOKS_PATH, workspaceDirs: [cwd], ...(launcherMasks ? { launcherMasks } : {}) });

  it("loaded on one hook from 1 + masks files, with the mask path named", () => {
    expect(state(agyLog([HOOKS_PATH, ...one()], 1, 2), one())).toEqual({ state: "loaded" });
    expect(state(agyLog([HOOKS_PATH, ...antigravityLauncherMasks([cwd])], 1, 5), antigravityLauncherMasks([cwd]))).toEqual({ state: "loaded" });
  });

  it("refused on 1/1, 2/2 and 1/3, and on a four-mask count that is not 1/5", () => {
    for (const [hooks, files] of [[1, 1], [2, 2], [1, 3], [0, 2], [2, 5]] as const) expect(state(agyLog([HOOKS_PATH, ...one()], hooks, files), one())).toEqual({ state: "refused" });
    expect(state(agyLog([HOOKS_PATH, ...antigravityLauncherMasks([cwd])], 1, 2), antigravityLauncherMasks([cwd]))).toEqual({ state: "refused" });
    expect(state(agyLog([HOOKS_PATH], 1, 1), one())).toEqual({ state: "refused" });
  });

  it("pending until agy's count line is there", () => {
    expect(state(`hooks_manager: reading ${HOOKS_PATH}\n`, one())).toEqual({ state: "pending" });
  });

  it("foreign on any other named hooks.json, a look-alike of a mask path included", () => {
    const named = (path: string) => state(agyLog([HOOKS_PATH, ...one(), path], 1, 3), one());
    expect(named(join(cwd, ".agent", "hooks.json"))).toEqual({ state: "foreign", file: join(cwd, ".agent", "hooks.json") });
    expect(named(join(cwd, "sub", ".agents", "hooks.json"))).toMatchObject({ state: "foreign" });
    expect(named("/data/workspaces/other/.agents/hooks.json")).toMatchObject({ state: "foreign" });
    expect(named(`${ENGINE_HOME}/.gemini/hooks.json`)).toMatchObject({ state: "foreign" });
  });

  it("a failure line that names Murage's own hooks.json refuses, even on a 1/2 count", () => {
    const log = `failed to parse hooks.json at ${HOOKS_PATH}: unexpected end\n` + agyLog([HOOKS_PATH, ...one()], 1, 2);
    expect(state(log, one())).toEqual({ state: "refused" });
  });

  it("on a desktop (no launcher masks) a log that names a project hooks.json is foreign, and 1/2 is refused", () => {
    expect(state(agyLog([HOOKS_PATH, ...one()], 1, 2))).toMatchObject({ state: "foreign" });
    expect(state(agyLog([HOOKS_PATH], 1, 2))).toEqual({ state: "refused" });
    expect(state(agyLog([HOOKS_PATH], 1, 1))).toEqual({ state: "loaded" });
  });

  it("launcher masks never excuse a workspace hooks file the launcher did not place (the scan still runs)", () => {
    mkdirSync(join(cwd, ".agent"), { recursive: true });
    writeFileSync(join(cwd, ".agent", "hooks.json"), JSON.stringify({ x: { PreToolUse: [] } }));
    expect(state(agyLog([HOOKS_PATH, ...one()], 1, 2), one())).toEqual({ state: "foreign", file: join(cwd, ".agent", "hooks.json") });
  });
});

describe("home relay (b): a placeholder is ignored only when it is exactly what the launcher makes", () => {
  type Entry = { uid: number; size: number; mode: number; dir?: boolean; link?: boolean; entries?: number };
  const FILE_MODE = 0o100444, DIR_MODE = 0o40555;
  const ROOT_FILE: Entry = { uid: 0, size: 0, mode: FILE_MODE };
  /** The stat seam: what each path "is" and which folders carry the immutable flag. */
  const probeOf = (entries: Record<string, Entry>, immutable: readonly string[], platform: NodeJS.Platform = "linux"): PlaceholderProbe => ({
    platform,
    lstat: (path) => {
      const e = entries[path];
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { uid: e.uid, size: e.size, mode: e.mode, isFile: () => !e.dir && !e.link, isDirectory: () => e.dir === true };
    },
    entryCount: (path) => entries[path]?.entries ?? 0,
    attrs: (path) => (immutable.includes(path) ? "----i---------e-------" : "--------------e-------"),
  });

  let cwd = "";
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-ph-")));
    // what the launcher leaves in a folder with no project config: the four roots, each with its mask targets
    for (const root of ROOTS) {
      mkdirSync(join(cwd, root, "plugins"), { recursive: true });
      mkdirSync(join(cwd, root, "agents"), { recursive: true });
      for (const leaf of ["hooks.json", "plugins.json"]) writeFileSync(join(cwd, root, leaf), "");
    }
  });
  afterEach(async () => { await removeTempDir(cwd); });
  const launcherMade = (override: Record<string, Entry> = {}) => {
    const entries: Record<string, Entry> = {};
    for (const root of ROOTS) {
      for (const leaf of ["hooks.json", "plugins.json"]) entries[join(cwd, root, leaf)] = ROOT_FILE;
      for (const leaf of ["plugins", "agents"]) entries[join(cwd, root, leaf)] = { uid: 0, size: 4096, mode: DIR_MODE, dir: true };
    }
    return { ...entries, ...override };
  };
  const frozenRoots = () => ROOTS.map((root) => join(cwd, root));
  const scan = (entries: Record<string, Entry>, immutable: readonly string[] = frozenRoots(), platform: NodeJS.Platform = "linux") =>
    antigravityWorkspaceHookFiles([cwd], makeLauncherPlaceholder(probeOf(entries, immutable, platform)));

  it("ignores root-owned empty 0444 files and empty 0555 directories inside immutable roots", () => {
    expect(scan(launcherMade())).toEqual([]);
  });

  it("counts the same files when the turn user owns them, they hold anything, or the mode differs", () => {
    const hooks = join(cwd, ".agents", "hooks.json");
    expect(scan(launcherMade({ [hooks]: { ...ROOT_FILE, uid: 1001 } }))).toEqual([hooks]);
    expect(scan(launcherMade({ [hooks]: { ...ROOT_FILE, size: 2 } }))).toEqual([hooks]);
    expect(scan(launcherMade({ [hooks]: { ...ROOT_FILE, mode: 0o100644 } }))).toEqual([hooks]);
    expect(scan(launcherMade({ [hooks]: { ...ROOT_FILE, mode: 0o100440 } }))).toEqual([hooks]);
  });

  it("counts a hooks.json in a root that is not frozenRoots(), whichever root (a project .agent/hooks.json included)", () => {
    for (const root of ROOTS) {
      const hooks = join(cwd, root, "hooks.json");
      expect(scan(launcherMade(), frozenRoots().filter((dir) => dir !== join(cwd, root)))).toContain(hooks);
    }
    expect(scan(launcherMade({ [join(cwd, ".agent", "hooks.json")]: { ...ROOT_FILE, uid: 1000, size: 40 } }))).toEqual([join(cwd, ".agent", "hooks.json")]);
  });

  it("counts a link, a non-empty placeholder folder's contents, and anything that is not a plain file or empty folder", () => {
    const hooks = join(cwd, "_agents", "hooks.json");
    expect(scan(launcherMade({ [hooks]: { uid: 0, size: 0, mode: 0o120777, link: true } }))).toEqual([hooks]);
    mkdirSync(join(cwd, "_agent", "plugins", "p1"), { recursive: true });
    writeFileSync(join(cwd, "_agent", "plugins", "p1", "hooks.json"), "{}");
    writeFileSync(join(cwd, "_agent", "plugins", "p1", "plugin.json"), "{}");
    const plugin = join(cwd, "_agent", "plugins", "p1", "hooks.json");
    expect(scan(launcherMade())).toEqual([plugin]);
  });

  it("is never a placeholder off Linux, when the probe throws, or when lsattr cannot say", () => {
    expect(scan(launcherMade(), frozenRoots(), "darwin")).toHaveLength(8);
    expect(antigravityWorkspaceHookFiles([cwd], makeLauncherPlaceholder({ ...probeOf(launcherMade(), frozenRoots()), lstat: () => { throw new Error("EACCES"); } }))).toHaveLength(8);
    expect(antigravityWorkspaceHookFiles([cwd], makeLauncherPlaceholder({ ...probeOf(launcherMade(), frozenRoots()), attrs: () => { throw new Error("no lsattr"); } }))).toHaveLength(8);
  });

  it("the real check says no to a file made by this test (not root-owned and immutable), so nothing is excused by accident", () => {
    chmodSync(join(cwd, ".agents", "hooks.json"), 0o444);
    expect(launcherPlaceholder(join(cwd, ".agents", "hooks.json"))).toBe(false);
    expect(antigravityWorkspaceHookFiles([cwd], launcherPlaceholder)).toHaveLength(8);
  });
});

describe("home relay: the socket", () => {
  let broker = "";
  beforeEach(() => { broker = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-sock-"))); });
  afterEach(async () => { await removeTempDir(broker); });
  const ask = (socketPath: string, message: object) => new Promise<unknown>((done, fail) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { data += chunk; if (data.includes("\n")) { socket.destroy(); done(JSON.parse(data.slice(0, data.indexOf("\n")))); } });
    socket.on("error", fail);
  });

  it("is in the broker folder, mode 0660, answers only the turn's token, and renders no hooks.json of its own", async () => {
    const calls: string[] = [];
    const relay = await openAntigravityRelay(join(broker, "not-used"), async (delivery) => { calls.push(String(delivery.tool_name)); return { decision: "allow" }; }, process.execPath, broker);
    try {
      expect(relay.hooksJson).toBe("");
      expect(relay.cloud).toBeDefined();
      expect(relay.cloud!.socket).toMatch(new RegExp(`^${broker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agyr-[0-9a-f]{12}\\.sock$`));
      expect(relay.cloud!.token).toMatch(/^[0-9a-f]{48}$/);
      expect(relay.logPath).toBe(relay.cloud!.socket.replace(/\.sock$/, ".log"));
      expect(statSync(relay.cloud!.socket).mode & 0o777).toBe(0o660);
      // no folder of Murage's own is made for a home (the hook lives in the launcher's HOME)
      expect(existsSync(join(broker, "not-used"))).toBe(false);
      expect(await ask(relay.cloud!.socket, { kind: "pretool", token: relay.cloud!.token, tool_name: "run_command", tool_input: { CommandLine: "ls" }, tool_use_id: "c:1" })).toEqual({ decision: "allow" });
      expect(await ask(relay.cloud!.socket, { kind: "pretool", token: "0".repeat(48), tool_name: "run_command", tool_input: {}, tool_use_id: "c:2" })).toEqual({ error: "token" });
      expect(calls).toEqual(["run_command"]);
      expect(relay.answered("c:1")).toBe(true);
      expect(relay.answered("c:2")).toBe(false);
    } finally {
      relay.close();
    }
    expect(existsSync(relay.cloud!.socket)).toBe(false);
    expect(existsSync(relay.logPath)).toBe(false);
  });
});

describe("home relay (h): the log is made by Murage before agy exists, and a planted one refuses the relay", () => {
  let broker = "";
  beforeEach(() => { broker = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-log-"))); });
  afterEach(async () => { await removeTempDir(broker); });
  const answer = async () => ({ decision: "allow" as const });
  const ID = "0123456789ab";

  it("creates an empty 0660 log beside the socket, and close removes both", async () => {
    const relay = await openCloudRelay(broker, "t".repeat(48), answer, ID);
    expect(relay.logPath).toBe(join(broker, `agyr-${ID}.log`));
    const st = lstatSync(relay.logPath);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(0);
    expect(st.mode & 0o777).toBe(0o660);
    relay.close();
    expect(readdirSync(broker)).toEqual([]);
  });

  it("refuses when a file is already at the log's name, and leaves it exactly as planted", async () => {
    const planted = join(broker, `agyr-${ID}.log`);
    const forged = agyLog([HOOKS_PATH], 1, 1);
    writeFileSync(planted, forged);
    await expect(openCloudRelay(broker, "t".repeat(48), answer, ID)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(planted, "utf8")).toBe(forged);
    expect(readdirSync(broker)).toEqual([`agyr-${ID}.log`]);
  });

  it("refuses a link at the log's name (even a dangling one) and never writes through it", async () => {
    const target = join(broker, "elsewhere.txt");
    symlinkSync(target, join(broker, `agyr-${ID}.log`));
    await expect(openCloudRelay(broker, "t".repeat(48), answer, ID)).rejects.toThrow(/EEXIST/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("home relay (e): the log is removed only as one plain file in the broker folder", () => {
  let broker = "";
  let outside = "";
  beforeEach(() => {
    broker = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-rm-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-out-")));
  });
  afterEach(async () => { await removeTempDir(broker); await removeTempDir(outside); });
  const NAME = "agyr-0123456789ab.log";

  it("removes a plain agyr-<12 hex>.log in the folder, and a missing one is already done", () => {
    writeFileSync(join(broker, NAME), "x");
    removeCloudRelayLog(join(broker, NAME), broker);
    expect(existsSync(join(broker, NAME))).toBe(false);
    expect(() => removeCloudRelayLog(join(broker, NAME), broker)).not.toThrow();
  });

  it("refuses a path outside the broker folder (the default folder is /data/broker), and the file survives", () => {
    writeFileSync(join(outside, NAME), "keep");
    expect(() => removeCloudRelayLog(join(outside, NAME), broker)).toThrow(/not a cloud relay log/);
    expect(() => removeCloudRelayLog(join(outside, NAME))).toThrow(/not a cloud relay log/);
    expect(() => removeCloudRelayLog(join(broker, "..", basenameOf(outside), NAME), broker)).toThrow(/not a cloud relay log/);
    expect(() => removeCloudRelayLog(join(broker, "sub", NAME), broker)).toThrow(/not a cloud relay log/);
    expect(readFileSync(join(outside, NAME), "utf8")).toBe("keep");
  });

  it("refuses any other name in the folder", () => {
    for (const name of ["agyr-0123456789ab.sock", "agyr-0123456789a.log", "agyr-0123456789abc.log", "agyr-0123456789AB.log", "perm-abcd1234.sock", "agyr-0123456789ab.log.bak", "other.log"]) {
      writeFileSync(join(broker, name), "keep");
      expect(() => removeCloudRelayLog(join(broker, name), broker), name).toThrow(/not a cloud relay log/);
      expect(readFileSync(join(broker, name), "utf8")).toBe("keep");
    }
  });

  it("refuses a directory with the right name, and leaves it and what is in it", () => {
    mkdirSync(join(broker, NAME));
    writeFileSync(join(broker, NAME, "inner.txt"), "keep");
    expect(() => removeCloudRelayLog(join(broker, NAME), broker)).toThrow(/not a plain file/);
    expect(readFileSync(join(broker, NAME, "inner.txt"), "utf8")).toBe("keep");
  });

  it("refuses a link with the right name and never follows it", () => {
    writeFileSync(join(outside, "target.txt"), "keep");
    symlinkSync(join(outside, "target.txt"), join(broker, NAME));
    expect(() => removeCloudRelayLog(join(broker, NAME), broker)).toThrow(/not a plain file/);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("keep");
    expect(lstatSync(join(broker, NAME)).isSymbolicLink()).toBe(true);
  });
});
const basenameOf = (path: string) => path.split("/").pop()!;

describe("home relay (f): the self-guard also holds the broker folder's relay files and the turn HOME's config", () => {
  const cwd = "/data/workspaces/bot";
  const extra = [`${CLOUD_BROKER_DIR}/agyr-`, ".gemini/config"];
  const run = (CommandLine: string) => ({ tool_name: "run_command", tool_input: { CommandLine }, tool_use_id: "c:1" });
  const relayDir = "/data/native/antigravity-relay/t-1";

  it("holds a run_command that names the relay's socket or log in /data/broker, filed unread", () => {
    for (const command of [`rm ${CLOUD_BROKER_DIR}/agyr-0123456789ab.log`, `echo forged > ${CLOUD_BROKER_DIR}/agyr-0123456789ab.log`, `nc -U ${CLOUD_BROKER_DIR}/agyr-0123456789ab.sock`]) {
      const held = antigravityRelayAsk(run(command), cwd, relayDir, extra);
      expect(held.toolInputMissing, command).toMatch(/a path that holds Murage's check/);
      expect(held.tool).toBe("run_command");
    }
  });

  it("holds a call that names the turn HOME's hook files", () => {
    for (const command of [`cat ${ENGINE_HOME}/.gemini/config/murage-agy-relay.env`, `echo {} > ${HOOKS_PATH}`, "echo x > ~/.gemini/config/hooks.json"]) {
      expect(antigravityRelayAsk(run(command), cwd, relayDir, extra).toolInputMissing, command).toMatch(/a path that holds Murage's check/);
    }
    const edit = antigravityRelayAsk({ tool_name: "write_to_file", tool_input: { TargetFile: HOOKS_PATH, CodeContent: "{}" }, tool_use_id: "c:2" }, cwd, relayDir, extra);
    expect(edit.toolInputMissing).toMatch(/a path that holds Murage's check/);
  });

  it("without the home's needles the same calls are ordinary asks (the needles are what hold them), and other commands are unaffected", () => {
    expect(antigravityRelayAsk(run(`rm ${CLOUD_BROKER_DIR}/agyr-0123456789ab.log`), cwd, relayDir).toolInputMissing).toBeUndefined();
    expect(antigravityRelayAsk(run("ls -la"), cwd, relayDir, extra)).toMatchObject({ tool: "run_command", summary: "ls -la" });
    expect(antigravityRelayAsk(run("ls -la"), cwd, relayDir, extra).toolInputMissing).toBeUndefined();
    expect(antigravityRelayAsk(run(`ls ${CLOUD_BROKER_DIR}/perm-abcd1234.sock`), cwd, relayDir, extra).toolInputMissing).toBeUndefined();
  });
});

describe("home relay (c) and (d): the real driver on a home", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch = "";
  let work = "";
  let dump = "";
  let madeBroker = false;
  const scopeRoot = join(DATA_DIR, "native", "antigravity-scope");
  const scopeNow = () => (existsSync(scopeRoot) ? readdirSync(scopeRoot).sort() : []);

  interface Spawned { args: string[]; env: Record<string, string | undefined>; render: Record<string, unknown>; socketMode: number | null; logMode: number | null; logSize: number | null; scope: string[] }
  let spawned: Spawned[] = [];
  /** What the launcher-run agy writes to its log, decided per test from the spawn (the paths it names, its count). */
  let agyWrites: (spawn: Spawned, logPath: string) => string = () => "";
  let spies: Array<{ mockRestore(): void }> = [];
  /** Runs at the spawn, after Murage's start-of-turn look at the folder (a repository can change it later). */
  let onSpawn: () => void = () => {};

  beforeEach((ctx) => {
    ensureDirs();
    chmodSync(FAKE_AGY, 0o755);
    if (!existsSync(CLOUD_BROKER_DIR)) {
      try { mkdirSync(CLOUD_BROKER_DIR, { recursive: true, mode: 0o2770 }); madeBroker = true; } catch { ctx.skip(); }
    }
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-agy-cloud-drv-")));
    work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    spawned = [];
    onSpawn = () => {};
    const real = procs.spawnCli;
    const realExec = procs.execCli;
    // The launcher is not run here: the spawn is recorded exactly as the server hands it over, then the fake agy runs
    // as a plain child (the role lifted for that call only). The relay's log is what the launcher-run agy would write.
    spies.push(vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts, ...rest) => {
      const env = { ...(opts.env as Record<string, string | undefined>) };
      const render = JSON.parse(env[TURN_RENDER] ?? "{}") as Record<string, unknown>;
      const hooks = render.hooks as { socket?: string } | undefined;
      const logAt = args.indexOf("--log-file");
      const logPath = logAt >= 0 ? String(args[logAt + 1]) : "";
      const mode = (path: string | undefined) => { try { return path ? statSync(path).mode & 0o777 : null; } catch { return null; } };
      const record: Spawned = { args: [...args], env, render, socketMode: mode(hooks?.socket), logMode: mode(logPath || undefined), logSize: logPath && existsSync(logPath) ? statSync(logPath).size : null, scope: scopeNow() };
      spawned.push(record);
      onSpawn();
      const text = logPath ? agyWrites(record, logPath) : "";
      if (logPath && text) writeFileSync(logPath, text);
      const rest2 = logAt >= 0 ? args.filter((_, i) => i !== logAt && i !== logAt + 1) : [...args];
      vi.stubEnv("MURAGE_CLOUD_ROLE", "");
      try { return real(cli, rest2, { ...opts, env: { ...process.env } }, ...rest); } finally { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); }
    }));
    spies.push(vi.spyOn(procs, "execCli").mockImplementation((cli, args, opts, cb) => {
      vi.stubEnv("MURAGE_CLOUD_ROLE", "");
      try { realExec(cli, args, { ...opts, env: { ...process.env } }, cb); } finally { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); }
    }));
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    for (const spy of spies.splice(0)) spy.mockRestore();
    vi.unstubAllEnvs();
    for (const name of FAKE_ENV) delete process.env[name];
    if (scratch) await removeTempDir(scratch);
    if (madeBroker) { try { for (const name of readdirSync(CLOUD_BROKER_DIR)) rmSync(join(CLOUD_BROKER_DIR, name), { force: true }); rmdirSync(CLOUD_BROKER_DIR); } catch { /* left for the host */ } madeBroker = false; }
  });

  const turn = async (level: { routeAsks?: true; stopLine?: true; askLevel?: true }) => {
    instance = await AntigravityDriver.create({ instanceId: "agy-cloud", displayName: "Antigravity", environment: { HOME: scratch }, enabled: true, config: { cli: FAKE_AGY, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-agy-cloud", text: "do the work", cwd: work, ...level });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    return {
      done: done as Extract<RuntimeEvent, { type: "turn.completed" }>,
      notices: recorder.events.filter((e) => e.type === "item.started" && (e as { toolKind?: string }).toolKind === "notice").map((e) => (e as { title?: string }).title),
      seen: JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; prompt?: string },
    };
  };
  /** The launcher-run agy in a clean folder: the turn HOME's hook loaded, one empty placeholder per customization root. */
  const loadedLog = (spawn: Spawned) => agyLog([`${spawn.env.HOME}/.gemini/config/hooks.json`, ...antigravityLauncherMasks([work])], 1, 1 + ROOTS.length);

  it("(c) Auto and Full: the relay hook goes to the launcher as a render part, agy skips its own permissions behind it, and no scoped home is built", async () => {
    agyWrites = (spawn) => loadedLog(spawn);
    for (const [label, level] of [["Auto", { routeAsks: true }], ["Full access", { stopLine: true }]] as const) {
      spawned = [];
      const before = scopeNow();
      const r = await turn(level);
      expect(spawned, label).toHaveLength(1);
      const s = spawned[0]!;
      expect(r.done, label).toMatchObject({ ok: true });
      expect(s.args, label).toContain("--dangerously-skip-permissions");
      const logAt = s.args.indexOf("--log-file");
      expect(s.args[logAt + 1], label).toMatch(/^\/data\/broker\/agyr-[0-9a-f]{12}\.log$/);
      expect(s.render.hooks, label).toEqual({ profile: "relay", socket: expect.stringMatching(/^\/data\/broker\/agyr-[0-9a-f]{12}\.sock$/), token: expect.stringMatching(/^[0-9a-f]{48}$/) });
      expect(s.render.hooks, label).not.toBe("ask");
      expect((s.render.hooks as { socket: string }).socket.replace(/\.sock$/, ".log"), label).toBe(s.args[logAt + 1]);
      // the socket is there for the launcher-run agy, group-writable; the log was made by Murage first and is empty
      expect(s.socketMode, label).toBe(0o660);
      expect(s.logMode, label).toBe(0o660);
      expect(s.logSize, label).toBe(0);
      // no scoped home: the hook is rendered into the turn's own HOME by the launcher, and the owner's HOME is not mirrored
      expect(s.env.HOME, label).toBe(ENGINE_HOME);
      expect(s.scope, label).toEqual(before);
      expect(scopeNow(), label).toEqual(before);
      expect(r.seen.prompt, label).toBeDefined();
      // the turn's end removes the socket and the log
      await vi.waitFor(() => expect(readdirSync(CLOUD_BROKER_DIR).filter((name) => name.startsWith("agyr-")), label).toEqual([]));
      recorder!.stop();
      await instance!.dispose();
      instance = undefined;
    }
  });

  it("(c) a launcher-replaced HOME without the hook gets hook_not_loaded, and the prompt is never written", async () => {
    for (const writes of [
      (spawn: Spawned) => agyLog([`${spawn.env.HOME}/.gemini/config/hooks.json`, ...antigravityLauncherMasks([work])], 0, 1 + ROOTS.length),
      (_spawn: Spawned) => agyLog(antigravityLauncherMasks([work]), 0, ROOTS.length),
    ]) {
      agyWrites = writes;
      const r = await turn({ routeAsks: true });
      expect(r.done).toMatchObject({ ok: false, stopReason: "hook_not_loaded" });
      expect(r.seen.prompt).toBeUndefined();
      expect(r.notices).toEqual([ANTIGRAVITY_HOOK_NOT_LOADED]);
      await vi.waitFor(() => expect(readdirSync(CLOUD_BROKER_DIR).filter((name) => name.startsWith("agyr-"))).toEqual([]));
      recorder!.stop();
      await instance!.dispose();
      instance = undefined;
      rmSync(dump, { force: true });
    }
  }, 60_000);

  it("(c) a project hooks file the launcher did not place is refused before the prompt, with the foreign-file line", async () => {
    const project = join(work, ".agent", "hooks.json");
    mkdirSync(dirname(project), { recursive: true });
    // agy's log names a hook it loaded from the project, beside Murage's: the count passes, the check must not.
    // The file appears after Murage's start-of-turn look (with it there the turn runs as at Ask, see (d)).
    onSpawn = () => writeFileSync(project, JSON.stringify({ evil: { PreToolUse: [] } }));
    agyWrites = (spawn) => agyLog([`${spawn.env.HOME}/.gemini/config/hooks.json`, ...antigravityLauncherMasks([work])], 1, 1 + ROOTS.length);
    const r = await turn({ routeAsks: true });
    expect(r.done).toMatchObject({ ok: false, stopReason: "hook_not_loaded" });
    expect(r.seen.prompt).toBeUndefined();
    expect(r.notices).toEqual([antigravity.antigravityForeignHooksNote(project)]);
  }, 60_000);

  it("(d) a folder's own hooks file on a home: Ask render, no relay, no socket, and the folder's line", async () => {
    const file = join(work, ".agents", "hooks.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ "repo-allow": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true" }] }] } }));
    agyWrites = () => { throw new Error("no relay: agy gets no --log-file"); };
    const r = await turn({ routeAsks: true });
    expect(spawned).toHaveLength(1);
    const s = spawned[0]!;
    expect(r.done).toMatchObject({ ok: true });
    expect(s.render.hooks).toBe("ask");
    expect(s.args).toContain("accept-edits");
    expect(s.args).not.toContain("--dangerously-skip-permissions");
    expect(s.args).not.toContain("--log-file");
    expect(s.socketMode).toBeNull();
    expect(readdirSync(CLOUD_BROKER_DIR).filter((name) => name.startsWith("agyr-"))).toEqual([]);
    expect(r.notices).toEqual([antigravity.antigravityWorkspaceHooksNote(file)]);
    expect(r.seen.prompt).toContain("You can read files and plan, but you cannot change files or run commands.");
  });

  it("(d) the same on a home when only the Ask level is chosen: the Ask hook, never the relay", async () => {
    agyWrites = () => { throw new Error("no relay at Ask"); };
    const r = await turn({ routeAsks: true, askLevel: true });
    const s = spawned[0]!;
    expect(r.done).toMatchObject({ ok: true });
    expect(s.render.hooks).toBe("ask");
    expect(s.args).not.toContain("--log-file");
    expect(s.args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("home relay (g): the launcher refuses skip-permissions without the relay profile", () => {
  it("is pinned in server/cloud-home/agy-launcher.test.ts (\"lets agy skip its own permissions only behind the relay hook\")", () => {
    const source = readFileSync(new URL("../cloud-home/agy-launcher.test.ts", import.meta.url), "utf8");
    expect(source).toContain("lets agy skip its own permissions only behind the relay hook");
    expect(source).toContain('"Cloud engine argument is not allowed: --dangerously-skip-permissions"');
    expect(ANTIGRAVITY_WORKSPACE_ROOTS).toEqual(ROOTS);
  });
});
