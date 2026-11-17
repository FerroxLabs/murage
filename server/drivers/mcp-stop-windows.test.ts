// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace V3 (A2, R5, S5, T3 replaced): the Windows MCP stop proof asks the JOB, opened by the STORED name. The job is created through the existing
// Windows native addon (server/memory/pip-job.ts createPipJob -> exclusion.c job_create, KILL_ON_JOB_CLOSE and no breakaway; procs.ts:463 is where
// the server calls it). Absent is gone only under a live-queried containment record. Every case is forced by a job-query double; a real Windows
// run of the native calls is listed in DONE.md (it cannot happen on this host).
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { windowsProof, type JobQuery, type StopRecord, type WindowsContainment } from "./mcp-stop-proof.ts";
import { ChatMcpDescendants } from "./chat-mcp-client.ts";
import { WindowsStopTarget } from "./mcp-stop-target.ts";

const NAME = "Local\\murage-pip-eng-00000000-0000-0000-0000-000000000001";
const full = (over: Partial<WindowsContainment> = {}): WindowsContainment => ({ source: "live-query", killOnClose: true, breakawayClear: true, silentBreakawayClear: true, inheritable: false, queriedAt: 1, contained: true, ...over });
const record = (over: Partial<StopRecord> = {}, windows: Partial<NonNullable<StopRecord["windows"]>> = {}): StopRecord => ({
  version: 1, owner: "bot-1", generation: 1, platform: "windows", state: "STOPPING", windows: { jobName: NAME, containment: full(), ...windows }, ...over,
});
const env = (answer: JobQuery | Error, seen: string[] = []) => ({ queryJob: async (name: string): Promise<JobQuery> => { seen.push(name); if (answer instanceof Error) throw answer; return answer; } });
const absent: JobQuery = { kind: "notFound" };

describe("WN: the Windows MCP proof (V3)", () => {
  it("WN1 absent with the live-queried record and CONTAINED set is PROVEN GONE", async () => {
    expect(await windowsProof(record(), env(absent))).toEqual({ v: "gone" });
  });
  it.each([
    ["KILL_ON_JOB_CLOSE clear", { killOnClose: false }],
    ["breakaway allowed", { breakawayClear: false }],
    ["silent breakaway allowed", { silentBreakawayClear: false }],
    ["handle inheritable", { inheritable: true }],
    ["CONTAINED clear after a spawn attempt (a failed assign)", { contained: false }],
  ] as const)("WN2 absent with the record missing a fact (%s) is UNKNOWN", async (_label, fact) => {
    expect((await windowsProof(record({}, { containment: full(fact) }), env(absent))).v).toBe("unknown");
  });
  it("WN3 absent with the flags never queried, or only an exclusion.c citation, is UNKNOWN", async () => {
    expect((await windowsProof(record({}, { containment: undefined }), env(absent))).v).toBe("unknown");
    const citation = { ...full(), source: "citation" } as unknown as WindowsContainment;
    expect((await windowsProof(record({}, { containment: citation }), env(absent))).v).toBe("unknown");
    expect((await windowsProof(record({}, { containment: full({ queriedAt: 0 }) }), env(absent))).v).toBe("unknown");
  });
  it("WN4 PLANNED with the spawn not attempted and the job absent is PROVEN GONE; absent during SPAWNING or later with CONTAINED clear is UNKNOWN", async () => {
    expect(await windowsProof(record({ state: "PLANNED" }, { containment: undefined }), env(absent))).toEqual({ v: "gone" });
    for (const state of ["SPAWNING", "RUNNING", "STOPPING"] as const) expect((await windowsProof(record({ state }, { containment: full({ contained: false }) }), env(absent))).v).toBe("unknown");
  });
  it("WN5 an opened job with an unreadable count is UNKNOWN; count 0 is gone; count above 0 is alive (also after a restart: no pid pairs are used)", async () => {
    expect((await windowsProof(record(), env({ kind: "opened", count: null }))).v).toBe("unknown");
    expect(await windowsProof(record(), env({ kind: "opened", count: 0 }))).toEqual({ v: "gone" });
    expect((await windowsProof(record(), env({ kind: "opened", count: 3 }))).v).toBe("alive");
    const restarted = record({ state: "RUNNING" }); // a record after a restart carries only the job name: no pairs exist for it
    expect((await windowsProof(restarted, env({ kind: "opened", count: 2 }))).v).toBe("alive");
  });
  it("WN6 any OpenJobObject failure other than not-found, or a throwing query, is UNKNOWN", async () => {
    expect((await windowsProof(record(), env({ kind: "error" }))).v).toBe("unknown");
    expect((await windowsProof(record(), env(new Error("boom")))).v).toBe("unknown");
  });
  it("WN7 not-found on a RECONSTRUCTED name is UNKNOWN even with a full record; restart opens the job by the STORED name", async () => {
    expect((await windowsProof(record({}, { reconstructed: true }), env(absent))).v).toBe("unknown");
    const seen: string[] = [];
    await windowsProof(record(), env({ kind: "opened", count: 1 }, seen));
    expect(seen).toEqual([NAME]);
  });
  it("WN8 an empty job during a spawn not recorded contained is UNKNOWN (nothing may be in it yet)", async () => {
    expect((await windowsProof(record({ state: "SPAWNING" }, { containment: full({ contained: false }) }), env({ kind: "opened", count: 0 }))).v).toBe("unknown");
  });
  it("WN9 a late-empty job: count above 0, then 0 on a later attempt, releases only then", async () => {
    const counts = [2, 1, 0];
    const late = { queryJob: async (): Promise<JobQuery> => ({ kind: "opened", count: counts.shift()! }) };
    expect((await windowsProof(record(), late)).v).toBe("alive");
    expect((await windowsProof(record(), late)).v).toBe("alive");
    expect(await windowsProof(record(), late)).toEqual({ v: "gone" });
  });
});

describe("WS: ChatMcpDescendants.stop() on win32 is no gone signal (R5, R1d replaced)", () => {
  const child = (): ChildProcess => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  it("WS1 a win32 child built with no job record cannot be proven gone: stop() resolves false", async () => {
    const descendants = new ChatMcpDescendants(child(), "win32");
    expect(descendants.active).toBe(true);
    expect(await descendants.stop()).toBe(false);
  }, 20_000);
  it("WS2 with a job record the stop follows the proof: a job that is absent without a full record stays false, an emptied job is true", async () => {
    const killed: string[] = [];
    const unproven = new WindowsStopTarget(record({ state: "RUNNING" }, { containment: undefined }), { store: null, windowsEnv: () => env(absent), windowsKill: async (name) => { killed.push(name); return true; } });
    expect(await new ChatMcpDescendants(child(), "win32", unproven).stop()).toBe(false);
    expect(killed).toEqual([NAME]);
    const proven = new WindowsStopTarget(record({ state: "RUNNING" }), { store: null, windowsEnv: () => env({ kind: "opened", count: 0 }), windowsKill: async () => true });
    expect(await new ChatMcpDescendants(child(), "win32", proven).stop()).toBe(true);
  }, 20_000);
});
