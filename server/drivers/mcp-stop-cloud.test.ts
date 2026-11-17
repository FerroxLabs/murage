// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace V1 (A1, S1, R4): the MCP Cloud stop proof is its OWN entry point (cloudProof), separate from confirmStopped and listTree. It reads the
// recursive cgroup.procs of the STORED scope path to completion and the unit state from a successful `systemctl show` of the STORED unit.
// Every case is forced by a cgroup and systemd double, not produced by the host. Turn behaviour (cloud-process-hooks.ts) is untouched and is
// pinned by server/cloud-home/cloud-process-hooks.test.ts (listTree :120-122 and the unregistered-dead-root acceptance :140 stay as they are).
import { describe, expect, it } from "vitest";
import { cloudProof, type CloudProofEnv, type StopRecord } from "./mcp-stop-proof.ts";
import { MCP_CLOUD_UNAVAILABLE_TEXT, McpScopeUnavailableError, planMcpSpawn, setCloudMcpScopeLauncher, spawnPlanned } from "./mcp-stop-runtime.ts";
import { setPlatformProcessHooks } from "../platform-process-hooks.ts";

const UNIT = "murage-mcp-0123456789abcdef.scope";
const BASE = `/sys/fs/cgroup/murage.slice/murage-turns.slice/${UNIT}`;
const err = (code: string) => Object.assign(new Error(code), { code });
const record = (over: Partial<StopRecord> = {}, cloud: Partial<NonNullable<StopRecord["cloud"]>> = {}): StopRecord => ({
  version: 1, owner: "bot-1", generation: 1, platform: "cloud", state: "STOPPING", cloud: { unit: UNIT, cgroupPath: BASE, contained: true, ...cloud }, ...over,
});

interface Dir { procs: string | Error; children: string[] }
interface World { dirs: Map<string, Dir>; show: string | Error; now: number; reads: string[] }
const world = (dirs: Record<string, Dir>, show: string | Error = "ActiveState=inactive\nLoadState=loaded\n"): World => ({ dirs: new Map(Object.entries(dirs)), show, now: 0, reads: [] });
const envOf = (w: World, extra: Partial<CloudProofEnv> = {}): CloudProofEnv => ({
  readText: async (path) => {
    w.reads.push(path);
    const dir = w.dirs.get(path.replace(/\/cgroup\.procs$/, ""));
    if (!dir) throw err("ENOENT");
    if (dir.procs instanceof Error) throw dir.procs;
    return dir.procs;
  },
  listDirs: async (path) => { const dir = w.dirs.get(path); if (!dir) throw err("ENOENT"); return dir.children; },
  systemctlShow: async () => { if (w.show instanceof Error) throw w.show; return w.show; },
  now: () => w.now,
  ...extra,
});
const empty = (children: string[] = []): Dir => ({ procs: "", children });

describe("CL: the MCP Cloud proof (V1)", () => {
  it("CL1 an empty scope and a recursively empty tree with the unit inactive is PROVEN GONE", async () => {
    const w = world({ [BASE]: empty(["sandbox"]), [`${BASE}/sandbox`]: empty() });
    expect(await cloudProof(record(), envOf(w))).toEqual({ v: "gone" });
  });
  it("CL2 a pid in a GRANDCHILD cgroup is not gone (the walk is recursive and reads every cgroup.procs)", async () => {
    const w = world({ [BASE]: empty(["a"]), [`${BASE}/a`]: empty(["b"]), [`${BASE}/a/b`]: { procs: "4242\n", children: [] } });
    const verdict = await cloudProof(record(), envOf(w));
    expect(verdict.v).toBe("alive");
    expect(w.reads).toContain(`${BASE}/a/b/cgroup.procs`);
  });
  it("CL3 a listed descendant that returns ENOENT is UNKNOWN, never gone", async () => {
    const w = world({ [BASE]: empty(["a"]) });
    expect((await cloudProof(record(), envOf(w))).v).toBe("unknown");
  });
  it("CL4 a short read of cgroup.procs is UNKNOWN", async () => {
    const w = world({ [BASE]: { procs: "12", children: [] } });
    expect((await cloudProof(record(), envOf(w))).v).toBe("unknown");
  });
  it("CL5 any other read error is UNKNOWN", async () => {
    const w = world({ [BASE]: { procs: err("EIO"), children: [] } });
    expect((await cloudProof(record(), envOf(w))).v).toBe("unknown");
  });
  it("CL6 ENOENT on the stored scope path itself, with the unit inactive, is PROVEN GONE", async () => {
    const w = world({});
    expect(await cloudProof(record(), envOf(w))).toEqual({ v: "gone" });
  });
  it("CL7 a systemctl that throws or times out is UNKNOWN even when the cgroup is gone", async () => {
    expect((await cloudProof(record(), envOf(world({}, new Error("timed out"))))).v).toBe("unknown");
    expect((await cloudProof(record(), envOf(world({}, "garbage without a state")))).v).toBe("unknown");
  });
  it("CL8 a unit systemd reports not-found or failed counts as inactive; an active unit with an empty cgroup stays UNKNOWN", async () => {
    expect((await cloudProof(record(), envOf(world({ [BASE]: empty() }, "ActiveState=failed\nLoadState=loaded\n")))).v).toBe("gone");
    expect((await cloudProof(record(), envOf(world({}, "ActiveState=inactive\nLoadState=not-found\n")))).v).toBe("gone");
    expect((await cloudProof(record(), envOf(world({ [BASE]: empty() }, "ActiveState=active\nLoadState=loaded\n")))).v).toBe("unknown");
  });
  it("CL9 budget exhaustion (directories, depth, time) is UNKNOWN", async () => {
    const dirs: Record<string, Dir> = { [BASE]: empty(["a", "b", "c"]), [`${BASE}/a`]: empty(), [`${BASE}/b`]: empty(), [`${BASE}/c`]: empty() };
    expect((await cloudProof(record(), envOf(world(dirs), { budget: { maxDirs: 2, maxDepth: 8, ms: 5000 } }))).v).toBe("unknown");
    const w = world(dirs);
    expect((await cloudProof(record(), envOf(w, { now: () => (w.now += 10_000), budget: { maxDirs: 256, maxDepth: 8, ms: 5000 } }))).v).toBe("unknown");
  });
  it("CL10 a unit name or path not stored for this spawn (a reconstructed one) is UNKNOWN", async () => {
    // a turn-pattern unit whose path agrees with it: only the stored-name pattern can refuse it
    const turnUnit = "murage-turn-0123456789abcdef.scope";
    expect((await cloudProof(record({}, { unit: turnUnit, cgroupPath: `/sys/fs/cgroup/murage.slice/murage-turns.slice/${turnUnit}` }), envOf(world({})))).v).toBe("unknown");
    expect((await cloudProof(record({}, { cgroupPath: "/sys/fs/cgroup/other" }), envOf(world({})))).v).toBe("unknown");
    expect((await cloudProof({ ...record(), cloud: undefined }, envOf(world({})))).v).toBe("unknown");
  });
  it("CL11 SPAWNING or later without a containment record is UNKNOWN, including an empty or missing cgroup (V2)", async () => {
    for (const state of ["SPAWNING", "RUNNING", "STOPPING"] as const) {
      expect((await cloudProof(record({ state }, { contained: false }), envOf(world({})))).v).toBe("unknown");
      expect((await cloudProof(record({ state }, { contained: false }), envOf(world({ [BASE]: empty() })))).v).toBe("unknown");
    }
  });
  it("CL12 the nothing-started proof applies ONLY to PLANNED: unit not-found and no cgroup directory", async () => {
    const planned = record({ state: "PLANNED" }, { contained: false });
    expect(await cloudProof(planned, envOf(world({}, "ActiveState=inactive\nLoadState=not-found\n")))).toEqual({ v: "gone" });
    expect((await cloudProof(planned, envOf(world({ [BASE]: empty() }, "ActiveState=inactive\nLoadState=not-found\n")))).v).toBe("unknown");
  });
  it("CL13 a listTree [] or an installed confirmStopped hook is never the MCP verdict", async () => {
    setPlatformProcessHooks({ listTree: async () => [], confirmStopped: async () => true });
    try {
      const w = world({ [BASE]: { procs: "77\n", children: [] } });
      expect((await cloudProof(record(), envOf(w))).v).toBe("alive");
    } finally { setPlatformProcessHooks({}); }
  });
  it("CL14 T4: a setsid grandchild is in the scope cgroup, so it is not gone until the scope is killed; after cgroup.kill it is", async () => {
    const w = world({ [BASE]: { procs: "10\n11\n", children: [] } });
    expect((await cloudProof(record(), envOf(w))).v).toBe("alive");
    w.dirs.set(BASE, empty()); // cgroup.kill emptied the cgroup
    expect(await cloudProof(record(), envOf(w))).toEqual({ v: "gone" });
  });
  it("CL15 an aborted proof is UNKNOWN", async () => {
    const controller = new AbortController(); controller.abort();
    expect((await cloudProof(record(), envOf(world({ [BASE]: empty() }), { signal: controller.signal }))).v).toBe("unknown");
  });
});

describe("CS: Cloud spawn is scoped or refused (A1, T14)", () => {
  it("CS1 T14: when no scope can be created the MCP server is not started and the refusal is reported", () => {
    setCloudMcpScopeLauncher(null);
    let started = 0;
    expect(() => spawnPlanned(planMcpSpawn("bot-1", { platform: "linux", cloud: true }), () => { started++; throw new Error("must not run"); })).toThrow(McpScopeUnavailableError);
    expect(started).toBe(0);
  });
  it("CS1b the refusal the owner reads is plain words, and the code stays in the code field for logs", () => {
    setCloudMcpScopeLauncher(null);
    let caught: McpScopeUnavailableError | undefined;
    try { planMcpSpawn("bot-1", { platform: "linux", cloud: true }); } catch (error) { caught = error as McpScopeUnavailableError; }
    expect(caught).toBeInstanceOf(McpScopeUnavailableError);
    expect(caught!.code).toBe("MCP_CLOUD_SCOPE_UNAVAILABLE");
    expect(caught!.message).toBe("Add-on tools (MCP servers) are not available on Murage Cloud yet. They work in the desktop app.");
    expect(caught!.message).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    expect(caught!.message).not.toMatch(/MCP_CLOUD|_/);
    expect(caught!.message).not.toMatch(/[\u2013\u2014]|\b(safe|unsafe|safety|free|forge|will fail)\b/i);
  });
  it("CS2 with a scope launcher the planned unit and cgroup path are chosen BEFORE the spawn and the server is started only through that launcher", () => {
    const seen: string[] = [];
    setCloudMcpScopeLauncher({ available: () => true, spawn: (scope) => { seen.push(scope.unit); throw new Error("stop here"); } });
    try {
      const plan = planMcpSpawn("bot-1", { platform: "linux", cloud: true });
      expect(plan.cloud?.unit).toMatch(/^murage-mcp-[0-9a-f]{16}\.scope$/);
      expect(plan.cloud?.cgroupPath.endsWith(`/${plan.cloud!.unit}`)).toBe(true);
      expect(plan.life.record.state).toBe("PLANNED");
      expect(plan.life.record.cloud?.contained).toBe(false);
      expect(() => spawnPlanned(plan, () => { throw new Error("spawn failed"); })).toThrow("spawn failed");
      expect(plan.life.record.state).toBe("SPAWNING"); // the failed spawn keeps its record: the process may exist
    } finally { setCloudMcpScopeLauncher(null); }
    expect(seen).toEqual([]);
  });
});
