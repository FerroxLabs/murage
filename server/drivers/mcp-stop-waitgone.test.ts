// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// nlrace finding 4 (V4): ChatMcpDescendants.#waitGone puts every live proof under its own budget. A target whose proof never answers is
// aborted at the cap, read as UNKNOWN, and the stop ends false (handed to the recovery) inside the stop's own waits; it never holds the
// stop open. Fake timers, so the bound is asserted on the clock, not on wall time.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_FORCE_WAIT_MS, CLI_TERM_GRACE_MS } from "../procs.ts";
import type { StopRecord } from "./mcp-stop-proof.ts";
import type { StopTarget } from "./mcp-stop-target.ts";

const enrolled: StopRecord[] = [];
vi.mock("./mcp-stop-runtime.ts", async (original) => ({
  ...(await original<typeof import("./mcp-stop-runtime.ts")>()),
  enrollUnprovenStop: (record: StopRecord) => { enrolled.push(record); return new Promise<void>(() => {}); },
}));
const { ChatMcpDescendants } = await import("./chat-mcp-client.ts");

const record: StopRecord = { version: 1, owner: "waitgone-witness", generation: 1, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } };
class FakeChild extends EventEmitter { pid = 4242; stdout = new EventEmitter(); stdin = Object.assign(new EventEmitter(), { end: () => {} }); kill(): boolean { return true; } }

afterEach(() => { vi.useRealTimers(); enrolled.length = 0; });

describe("W: the live proof is bounded inside #waitGone (finding 4)", () => {
  it("W1 a proof that never answers is aborted at its budget, read as unknown, and the stop ends false inside TERM grace + FORCE wait", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const kills: string[] = [];
    const target: StopTarget = {
      record,
      track: async () => {},
      capture: async () => true,
      prove: (signal) => { if (signal) signals.push(signal); return new Promise(() => {}); },
      kill: async (sig) => { kills.push(sig); },
    };
    const d = new ChatMcpDescendants(new FakeChild() as never, "linux", target);
    let settled: boolean | null = null;
    const stop = d.stop().then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS - 1);
    expect(settled, "still inside the TERM grace").toBeNull();
    expect(kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(CLI_FORCE_WAIT_MS + 1000);
    expect(settled, "the stop ended (a stalled proof must not hold it open)").toBe(false);
    await stop;
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals.length, "one hanging proof per phase, none stacked behind another").toBe(2);
    expect(signals.every((s) => s.aborted), "every hanging proof was aborted at its cap").toBe(true);
    expect(enrolled.map((r) => r.owner)).toEqual(["waitgone-witness"]);
  });
});
