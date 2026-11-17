import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ROOT_CLOSE_GRACE_MS } from "./child-teardown.ts";
import { ChatMcpDescendants, chatMcpTeardown } from "./chat-mcp-client.ts";
import type { StopTarget } from "./mcp-stop-target.ts";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
for (const [id, immediate] of [["N706", true], ["N707", false]] as const) {
  it.skipIf(process.platform === "win32")(`${id} a POSIX MCP proof cannot close a root whose pipe is still held open`, async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null });
    const target: StopTarget = {
      record: { version: 1, owner: "root-close", generation: 1, platform: "desktop", state: "STOPPING", desktop: { pairs: [], captureCompleted: true } },
      track: async () => {}, capture: async () => true, prove: async () => ({ v: "gone" }), kill: async () => {},
    };
    const descendants = new ChatMcpDescendants(child as never, "linux", target);
    vi.spyOn(descendants, "stop").mockResolvedValue(immediate);
    let prove!: (value: true) => void;
    vi.spyOn(descendants, "goneSignal").mockReturnValue(new Promise<true>(resolve => { prove = resolve; }));
    const teardown = chatMcpTeardown(child as never, descendants);
    let closed = false;
    teardown.onClosed(() => { closed = true; });
    teardown.markStopRequested();
    const wait = teardown.wait({ closeMs: 2 * ROOT_CLOSE_GRACE_MS, maxMs: 2 * ROOT_CLOSE_GRACE_MS });
    await vi.advanceTimersByTimeAsync(0);
    if (!immediate) prove(true);
    await vi.advanceTimersByTimeAsync(ROOT_CLOSE_GRACE_MS + 1);
    expect(closed, "a proof cannot substitute for the POSIX root's actual close").toBe(false);
    await vi.advanceTimersByTimeAsync(ROOT_CLOSE_GRACE_MS);
    expect(await wait).toMatchObject({ closeConfirmed: false });
    expect(teardown.closed).toBe(false);
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed, "proof and actual root close together release the teardown").toBe(true);
    expect(await teardown.wait({ closeMs: 1, maxMs: 1 })).toEqual({ closeConfirmed: true });
  });
}
