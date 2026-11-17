// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace V3 (A2): the containment record of a server-owned MCP launch on Windows. The job is created through the existing native addon (pip-job.ts
// createPipJob -> exclusion.c job_create; procs.ts calls it where the engine job route starts). `created` runs right after the job exists (live facts,
// fsynced by the caller), `contained` runs after the launcher was put in the job and BEFORE the frame that releases it. A failed assign kills the
// blocked launcher and leaves CONTAINED clear; a record that cannot be written refuses the launch. Windows is simulated on POSIX with the same
// double the existing owned-Windows suite uses; the real native run is listed in DONE.md.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => native);
vi.mock("../shared/win-hide-child-process.mjs", () => ({ withHideInherit: <T,>(options: T) => options }));
vi.mock("./env-path.ts", () => ({ resolveCliSpawn: (command: string, args: string[]) => ({ command, args }) }));
const addon = vi.hoisted(() => ({ jobCreate: vi.fn(), jobAssign: vi.fn(), jobClose: vi.fn(), jobStop: vi.fn(), processes: vi.fn(), dropShutdownPrivileges: vi.fn(() => ({ ok: true })) }));
vi.mock("./engine-exclusion.ts", () => ({ requireWindowsAddon: () => addon, loadExclusionAddon: () => addon }));
const proxyState = vi.hoisted(() => ({ launcher: "" }));
vi.mock("./proxy-paths.ts", () => ({ SPAWNED_PROXIES: { get jobLauncher() { return proxyState.launcher; } } }));
// the shared test setup imports modules before this mock exists: load fresh copies that see the addon double
vi.resetModules();
const { cliJobRefused, engineExecutableDeps, spawnCli } = await import("./procs.ts");

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: ChildProcess;
let base: string;
const events: string[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mcp-containment-"));
  vi.spyOn(engineExecutableDeps, "executable").mockReturnValue(true);
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  child = Object.assign(new EventEmitter(), { pid: process.pid + 10_000, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }) as unknown as ChildProcess;
  events.length = 0;
  native.spawn.mockReset().mockImplementation(() => { events.push("spawn"); return child; });
  addon.jobCreate.mockReset().mockImplementation((name: string) => { events.push("jobCreate"); return { job: name }; });
  addon.jobAssign.mockReset().mockImplementation(() => { events.push("assign"); return true; });
  addon.jobClose.mockReset();
  proxyState.launcher = fileURLToPath(new URL("./job-launcher.ts", import.meta.url));
  (child.stdin as PassThrough).on("data", () => events.push("frame"));
});
afterEach(() => { Object.defineProperty(process, "platform", platformDescriptor); vi.useRealTimers(); vi.restoreAllMocks(); removeTempDirSync(base); });
const job = (hooks: { created?: () => void; contained?: () => void } = {}) => ({
  name: "Local\\murage-pip-eng-00000000-0000-0000-0000-000000000009",
  containment: { created: () => { events.push("created"); hooks.created?.(); }, contained: () => { events.push("contained"); hooks.contained?.(); } },
});
const launch = (j = job()) => spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, j);

describe("WC: the Windows MCP containment record (V3, A2)", () => {
  it("WC1 the record is written in order: job created, facts recorded, process assigned, CONTAINED recorded, and only then the release frame", () => {
    launch();
    expect(events).toEqual(["jobCreate", "created", "spawn", "assign", "contained", "frame"]);
  });
  it("WC2 a failed assign leaves CONTAINED clear, ends the blocked launcher unreleased and refuses the run", () => {
    addon.jobAssign.mockImplementation(() => { events.push("assign"); return false; });
    const owned = launch();
    expect(events).not.toContain("contained");
    expect(events).not.toContain("frame");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(cliJobRefused(owned)).toBe(true);
    expect(addon.jobClose).toHaveBeenCalledOnce();
  });
  it("WC3 an assign that throws is the same: CONTAINED clear, nothing released", () => {
    addon.jobAssign.mockImplementation(() => { throw new Error("EACCES"); });
    const owned = launch();
    expect(events).not.toContain("contained");
    expect(events).not.toContain("frame");
    expect(cliJobRefused(owned)).toBe(true);
  });
  it("WC4 facts that cannot be recorded after the job exists refuse the launch before any process starts", () => {
    const owned = launch(job({ created: () => { throw new Error("disk"); } }));
    expect(events).not.toContain("spawn");
    expect(cliJobRefused(owned)).toBe(true);
    expect(addon.jobClose).toHaveBeenCalledOnce();
  });
  it("WC5 a CONTAINED record that cannot be written ends the blocked launcher and releases nothing", () => {
    const owned = launch(job({ contained: () => { throw new Error("disk"); } }));
    expect(events).not.toContain("frame");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(cliJobRefused(owned)).toBe(true);
    expect(addon.jobClose).toHaveBeenCalledOnce();
  });
});
