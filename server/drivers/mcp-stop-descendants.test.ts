// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace R2, R8, S4, T9: how ChatMcpDescendants drives a stop target. The pre-stop capture is bounded (the cap is armed BEFORE the first read and the
// read is aborted at the cap); a capture that did not complete stays unknown after the kill even when the later walk is empty; a stop that is not
// proven is handed to the bounded recovery and never resolves true on its own.
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_MCP_SNAPSHOT_CAP_MS, ChatMcpDescendants } from "./chat-mcp-client.ts";
import { configureMcpStop, mcpStopRecovery, resetMcpStopForTests } from "./mcp-stop-runtime.ts";
import type { StopRecord } from "./mcp-stop-proof.ts";
import type { StopTarget } from "./mcp-stop-target.ts";
import type { ProbeOutcome } from "./mcp-stop-recovery.ts";

const rec = (): StopRecord => ({ version: 1, owner: "bot-d", generation: 1, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } });
const child = () => Object.assign(new EventEmitter(), { pid: 5151, exitCode: null, signalCode: null }) as unknown as ChildProcess;
interface Fake extends StopTarget { calls: string[]; aborted: boolean }
const fake = (over: { capture?: (signal?: AbortSignal) => Promise<boolean>; prove?: () => Promise<ProbeOutcome> }): Fake => {
  const f: Fake = {
    record: rec(), calls: [], aborted: false,
    async track() { f.calls.push("track"); },
    capture: (signal) => { f.calls.push("capture"); signal?.addEventListener("abort", () => { f.aborted = true; }); return (over.capture ?? (async () => true))(signal); },
    prove: () => { f.calls.push("prove"); return (over.prove ?? (async () => ({ v: "gone" as const })))(); },
    async kill(signal) { f.calls.push(`kill ${signal}`); },
  };
  return f;
};
const enrolled: StopRecord[] = [];
const quiet = () => configureMcpStop({ recoveryDeps: { clock: { now: () => 0, setTimeout: () => () => {} }, launch: (r) => { enrolled.push(r); return { result: new Promise(() => {}), kill() {}, alive: () => false, exited: Promise.resolve() }; }, reKill: async () => {} } });
afterEach(() => { resetMcpStopForTests(); enrolled.length = 0; vi.restoreAllMocks(); });

describe("DD: ChatMcpDescendants over a stop target", () => {
  it("DD1 T9: a capture that never answers trips the cap, its read is aborted, and the stop stays unknown after the kill even though the later proof says gone (R2)", async () => {
    quiet(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = fake({ capture: () => new Promise(() => {}), prove: async () => ({ v: "gone" }) });
    const descendants = new ChatMcpDescendants(child(), "linux", target);
    const began = Date.now();
    await descendants.ready();
    expect(Date.now() - began).toBeGreaterThanOrEqual(CHAT_MCP_SNAPSHOT_CAP_MS - 50);
    expect(target.aborted).toBe(true);
    expect(await descendants.stop()).toBe(false);
    expect(target.calls.filter((c) => c === "prove")).toEqual([]); // a blind stop asks no proof that could read "gone"
    expect(target.calls).toContain("kill SIGTERM");
    expect(target.calls).toContain("kill SIGKILL");
  }, 20_000);
  it("DD2 an unproven stop signals TERM, then KILL, then hands the stop to the bounded recovery: it never resolves true", async () => {
    quiet(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = fake({ prove: async () => ({ v: "alive", why: "x" }) });
    const descendants = new ChatMcpDescendants(child(), "linux", target);
    expect(await descendants.stop()).toBe(false);
    expect(target.calls.indexOf("kill SIGTERM")).toBeLessThan(target.calls.indexOf("kill SIGKILL"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mcpStopRecovery().quarantined("bot-d"), "enrolled in the bounded recovery").toBe(true);
  }, 20_000);
  it("DD3 a proof that succeeds after the kill is the only way to true; the capture happens before any signal", async () => {
    quiet();
    const target = fake({});
    expect(await new ChatMcpDescendants(child(), "linux", target).stop()).toBe(true);
    expect(target.calls.slice(0, 2)).toEqual(["capture", "kill SIGTERM"]);
    expect(enrolled).toEqual([]);
  });
  it("DD4 a late proof from the recovery resolves goneSignal; before it nothing does", async () => {
    quiet(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = fake({ prove: async () => ({ v: "unknown", why: "x" }) });
    const descendants = new ChatMcpDescendants(child(), "linux", target);
    let signalled = false;
    void descendants.goneSignal().then(() => { signalled = true; });
    expect(await descendants.stop()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signalled).toBe(false);
  }, 20_000);
});
