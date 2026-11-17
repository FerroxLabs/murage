// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace5 witnesses (Astra arev-nlrace3 findings 4, 7, 8). Each fails by assertion (never by a timeout) when its fix is removed.
//   H1-H4  finding 4: the server enumerates only through a bounded, killable helper child; no synchronous /proc read on the stop path.
//   B1-B2  finding 8: an early record carries the boot id, so a crash before tracking resolves after a reboot.
//   P1-P3  finding 7: the addon version / capability packaging (old addons refused; jobQuery/jobInspect required on Windows).
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADDON_VERSION, WINDOWS_NATIVE_FUNCTIONS, addonIsUsable } from "../engine-exclusion.ts";
import { makeHelperRunner } from "./mcp-stop-helper.ts";
import { desktopProof, type DesktopEnv, type DesktopRow, type StopRecord } from "./mcp-stop-proof.ts";
import { DesktopStopTarget } from "./mcp-stop-target.ts";
import { setProcScanSeam } from "./process-tree.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stdin = Object.assign(new EventEmitter(), { end: (_data: string) => {} });
  killed: string[] = [];
  kill(signal: string): boolean { this.killed.push(signal); return true; }
}

afterEach(() => { setProcScanSeam(); });

describe("H: bounded, interruptible enumeration (finding 4)", () => {
  it("H1 a helper that never answers is SIGKILLed alone at the cap and the call is unknown (null)", async () => {
    const children: FakeChild[] = [];
    const run = makeHelperRunner({ script: "x", capMs: 30, spawn: () => { const c = new FakeChild(); children.push(c); return c as never; } });
    expect(await run({ op: "identity", platform: "linux", pid: 5 })).toBeNull();
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toEqual(["SIGKILL"]);
  });
  it("H2 an abort kills THAT request's helper only; a later request's helper is untouched", async () => {
    const children: FakeChild[] = [];
    const run = makeHelperRunner({ script: "x", capMs: 5_000, spawn: () => { const c = new FakeChild(); children.push(c); return c as never; } });
    const first = new AbortController();
    const a = run({ op: "identity", platform: "linux", pid: 5 }, first.signal);
    const b = run({ op: "identity", platform: "linux", pid: 6 });
    first.abort();
    expect(await a).toBeNull();
    expect(children[0]!.killed).toEqual(["SIGKILL"]);
    expect(children[1]!.killed).toEqual([]);
    children[1]!.stdout.emit("data", Buffer.from('{"identity":"absent"}\n'));
    children[1]!.emit("close", 0);
    expect(await b).toEqual({ identity: "absent" });
  });
  it("H3 the server-side desktop target runs capture/prove through the helper and never reads /proc itself", async () => {
    const reads: string[] = [];
    setProcScanSeam({ fs: { readdir: (p) => { reads.push(p); throw new Error("sync read"); }, readFile: (p) => { reads.push(p); throw new Error("sync read"); }, readlink: (p) => { reads.push(p); throw new Error("sync read"); } } });
    const requests: string[] = [];
    const helper = async (request: { op: string }): Promise<unknown> => { requests.push(request.op); return null; };
    const rec: StopRecord = { version: 1, owner: "bot-h3", generation: 1, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } };
    const target = new DesktopStopTarget(rec, 4242, "linux", { store: null, helper: helper as never });
    await target.track();
    expect(await target.capture()).toBe(false); // the helper gave no answer: capture is UNKNOWN (blind), never a smaller answer
    expect((await target.prove()).v).toBe("unknown");
    expect(requests).toEqual(["capture", "capture", "desktopProof"]);
    expect(reads).toEqual([]);
  });
  it("H4 without a helper the server target fails closed (unknown) and still reads nothing", async () => {
    const reads: string[] = [];
    setProcScanSeam({ fs: { readdir: (p) => { reads.push(p); return []; }, readFile: (p) => { reads.push(p); return ""; }, readlink: (p) => { reads.push(p); return ""; } } });
    const rec: StopRecord = { version: 1, owner: "bot-h4", generation: 1, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } };
    const target = new DesktopStopTarget(rec, 4242, "linux", { store: null });
    expect(await target.capture()).toBe(false);
    expect((await target.prove()).v).toBe("unknown");
    expect(reads).toEqual([]);
  });
});

describe("B: boot context in early records (finding 8)", () => {
  const row = (pid: number): DesktopRow => ({ pid, ppid: 1, start: `proc:${pid}`, startKind: "proc", state: "S", threads: 1 });
  const env = (boot: string): DesktopEnv => ({ platform: "linux", bootId: async () => boot, pidns: async () => null, visibility: async () => ({ hidepid: false, sameNs: true }), table: async () => [row(1)] });
  const early = (state: StopRecord["state"], bootId?: string): StopRecord => ({ version: 1, owner: "bot-b", generation: 1, platform: "desktop", state, ...(bootId ? { bootId } : {}), desktop: { pairs: [], captureCompleted: false } });
  it("B1 a PLANNED/SPAWNING/RUNNING record from another boot is PROVEN GONE (a crash before tracking resolves after a reboot)", async () => {
    for (const state of ["PLANNED", "SPAWNING", "RUNNING"] as const) expect((await desktopProof(early(state, "boot-old"), env("boot-new"))).verdict.v).toBe("gone");
  });
  it("B2 the same boot stays UNKNOWN, and a record with no boot id stays UNKNOWN (V2)", async () => {
    expect((await desktopProof(early("RUNNING", "boot-old"), env("boot-old"))).verdict.v).toBe("unknown");
    expect((await desktopProof(early("RUNNING"), env("boot-new"))).verdict.v).toBe("unknown");
  });
});

describe("P: addon capability and version packaging (finding 7)", () => {
  const stub = (version: number) => ({ lock: () => true, processes: () => [], renameNoReplace: () => 0, writers: () => ({ writers: [], unreadable: [] }), fullSync: () => "full", version: () => version });
  it("P1 an addon older than the version that carries jobQuery/jobInspect is refused; the current one is accepted", () => {
    expect(ADDON_VERSION).toBeGreaterThanOrEqual(12);
    expect(addonIsUsable(stub(ADDON_VERSION - 1) as never)).toBe(false);
    expect(addonIsUsable(stub(ADDON_VERSION) as never)).toBe(true);
  });
  it("P2 Windows packaging requires jobQuery and jobInspect, and the native source reports the same version", async () => {
    expect(WINDOWS_NATIVE_FUNCTIONS).toContain("jobQuery");
    expect(WINDOWS_NATIVE_FUNCTIONS).toContain("jobInspect");
    const resource = await import("../../scripts/engine-exclusion-resource.mjs") as { WINDOWS_ADDON_FUNCTIONS: string[] };
    expect(resource.WINDOWS_ADDON_FUNCTIONS).toContain("jobQuery");
    expect(resource.WINDOWS_ADDON_FUNCTIONS).toContain("jobInspect");
    expect(readFileSync(join(root, "native/engine-exclusion/exclusion.c"), "utf8")).toContain(`#define ADDON_VERSION ${ADDON_VERSION}\n`);
    const electron = await import("../../electron/windows-native.mjs") as { WINDOWS_NATIVE_VERSION: number; windowsAddonIsUsable(addon: unknown): boolean };
    expect(electron.WINDOWS_NATIVE_VERSION).toBe(ADDON_VERSION);
    expect(electron.windowsAddonIsUsable({ version: () => ADDON_VERSION - 1 })).toBe(false);
  });
});
void vi;
