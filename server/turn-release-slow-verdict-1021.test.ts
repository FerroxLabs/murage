// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// cause14 (1.0.21): a mount frame whose verdict, upstream reserve or acknowledgement is answered late by a loaded server is
// delivered late. It never seals the mount for the rest of the turn. A wait that never ends, or a lost channel, still seals.
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConsumingIngress } from "./consuming-turn-ingress.ts";
import { createProxyTurnRelease } from "./proxy-turn-release.ts";
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";
import { TURN_RELEASE_WAIT_MS } from "./turn-release-wait.ts";
import { PENDING_FENCE_WAIT_MS } from "./memory/fence-pending.ts";
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";

// The field's failing answer time: over the old 5 s guard, far under the wait.
const LATE_MS = 6000;
const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.close()); vi.useRealTimers(); });
const descriptor = registerConsumingDescriptor("test:proxy", "body");
const reply = { frame: '{"jsonrpc":"2.0","id":1,"result":{}}', refs: [], descriptor };
const ports = () => ({ seal: vi.fn(), terminal: vi.fn(), close: vi.fn() });
const lateBy = <T>(ms: number, value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), ms));

it("the wait outlasts a held reply's pending memory check and its re-armed permit, and is still bounded", () => {
  // The child waits for its acknowledgement while the parent holds a reply for PENDING_FENCE_WAIT_MS; the server's re-armed permit adds 5 s.
  expect(TURN_RELEASE_WAIT_MS).toBeGreaterThanOrEqual(PENDING_FENCE_WAIT_MS + 5000 + 15_000);
  expect(TURN_RELEASE_WAIT_MS).toBeLessThanOrEqual(120_000);
});

it.each(["verdict", "acknowledgement"])("C14-1 a %s answered after 6 s delivers the frame and leaves the mount open for the next call", async stage => {
  vi.useFakeTimers();
  const p = ports(), envelopes: number[] = [];
  let calls = 0;
  const release = createProxyTurnRelease("proxy", { ...p,
    verdict: async request => {
      const envelope = { instanceId: "proxy", sequence: request.sequence, frame: request.frame, permit: "a".repeat(43) };
      return stage === "verdict" && calls++ === 0 ? lateBy(LATE_MS, () => envelope) : envelope;
    },
    envelope: async envelope => { envelopes.push(envelope.sequence); if (stage === "acknowledgement" && calls++ === 0) await lateBy(LATE_MS, () => {}); },
  });
  let first: "open" | "delivered" | "refused" = "open";
  void release.release(1, reply).then(() => { first = "delivered"; }, () => { first = "refused"; });
  await vi.advanceTimersByTimeAsync(LATE_MS - 1);
  expect(first).toBe("open"); expect(release.sealed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(first).toBe("delivered");
  // The rest of the turn: the next call on the same mount is served.
  await release.release(2, { ...reply, frame: '{"jsonrpc":"2.0","id":2,"result":{}}' });
  expect(envelopes).toEqual([1, 2]);
  expect(release.sealed).toBe(false); expect(p.seal).not.toHaveBeenCalled(); expect(p.terminal).not.toHaveBeenCalled(); expect(p.close).not.toHaveBeenCalled();
});

it.each(["verdict", "acknowledgement"])("C14-2 a %s that never arrives seals at the wait, not before, and names verdict-timeout", async stage => {
  vi.useFakeTimers();
  const p = ports(), never = () => new Promise<never>(() => {});
  const release = createProxyTurnRelease("proxy", { ...p,
    verdict: stage === "verdict" ? never : async request => ({ instanceId: "proxy", sequence: request.sequence, frame: request.frame, permit: "a".repeat(43) }),
    envelope: stage === "acknowledgement" ? never : async () => {} });
  const refused = expect(release.release(1, reply)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  await vi.advanceTimersByTimeAsync(TURN_RELEASE_WAIT_MS - 1);
  expect(release.sealed).toBe(false); expect(p.terminal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await refused;
  expect(release.sealed).toBe(true); expect(p.seal).toHaveBeenCalledTimes(1); expect(p.close).toHaveBeenCalledTimes(1);
  expect(p.terminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 1 }), "verdict-timeout");
});

it("C14-3 a lost channel seals at once while a verdict is still awaited (no wait for the deadline)", async () => {
  vi.useFakeTimers();
  const p = ports();
  const release = createProxyTurnRelease("proxy", { ...p, verdict: () => new Promise<never>(() => {}), envelope: async () => {} });
  const refused = expect(release.release(1, reply)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  await vi.advanceTimersByTimeAsync(100);
  expect(() => release.transportLost("lost:disconnect")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(release.sealed).toBe(true); expect(p.terminal).toHaveBeenCalledExactlyOnceWith(expect.anything(), "lost:disconnect");
  await vi.advanceTimersByTimeAsync(TURN_RELEASE_WAIT_MS); await refused;
  expect(p.seal).toHaveBeenCalledTimes(1);
});

const ingressWithCall = () => {
  const f = consumingFixture(); fixtures.push(f);
  const ingress = createConsumingIngress(f.binding, "proxy");
  ingress.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }), () => {});
  return { f, ingress };
};
it("C14-4 the server keeps a permit whose envelope comes back after 6 s, and delivers it once", async () => {
  vi.useFakeTimers();
  const { f, ingress } = ingressWithCall(), write = vi.fn();
  const envelope = ingress.issue({ instanceId: "proxy", sequence: 1, ...reply });
  await vi.advanceTimersByTimeAsync(LATE_MS);
  expect(ingress.sealed).toBe(false); expect(f.refusals).toBe(0);
  ingress.deliver(envelope, write);
  expect(write).toHaveBeenCalledExactlyOnceWith(reply.frame);
  await vi.advanceTimersByTimeAsync(TURN_RELEASE_WAIT_MS);
  expect(ingress.sealed).toBe(false); expect(f.refusals).toBe(0);
});
it("C14-5 a permit whose envelope never comes back seals at the wait, not before", async () => {
  vi.useFakeTimers();
  const { f, ingress } = ingressWithCall();
  ingress.issue({ instanceId: "proxy", sequence: 1, ...reply });
  await vi.advanceTimersByTimeAsync(TURN_RELEASE_WAIT_MS - 1);
  expect(ingress.sealed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(ingress.sealed).toBe(true); expect(f.refusals).toBe(1);
});
it("C14-6 a slow permit is still rechecked at delivery: a revoke during the wait refuses", async () => {
  vi.useFakeTimers();
  const { f, ingress } = ingressWithCall(), write = vi.fn();
  const envelope = ingress.issue({ instanceId: "proxy", sequence: 1, ...reply });
  await vi.advanceTimersByTimeAsync(LATE_MS);
  // Still open after the slow wait: the refusal below is the delivery recheck, not a deadline.
  expect(ingress.sealed).toBe(false); expect(f.refusals).toBe(0);
  f.flip();
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});

// The real spawned mount child, its real fetch to a real HTTP verdict endpoint, real stdout envelopes and IPC acknowledgements.
const realChild = (role: "memory" | "agents") => {
  const path = fileURLToPath(new URL(`./${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url));
  return `process.argv[1] = ${JSON.stringify(path)}; await import(${JSON.stringify(new URL(`./${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url).href)});`;
};
const calls = [1, 2, 3].map(id => JSON.stringify({ jsonrpc: "2.0", id, method: id === 1 ? "initialize" : "ping", params: {} }));
it.each([["verdict", { slowVerdictMs: LATE_MS }], ["upstream reserve", { slowUpstreamMs: LATE_MS }]] as const)(
  "C14-7 real mount child: a first %s answered after 6 s still answers that call and the two calls after it", async (_stage, slow) => {
    const started = Date.now();
    const frames = await runBoundBridge(realChild("memory"), calls, 3, false, { role: "memory", ...slow });
    expect(Date.now() - started).toBeGreaterThanOrEqual(LATE_MS - 50);
    expect(frames.map(frame => JSON.parse(frame).id)).toEqual([1, 2, 3]);
  }, 60_000);

// A wiring pin only, and named as one. Its deadline is armed when the loop reaches the handler and covers one local body read plus a
// synchronous verdict, so the behaviour that matters under load is the child's wait and the permit (C14-1, C14-4, C14-7) and the
// end-to-end rig counter, not this line. cause22 caps (1.0.21) moved the route's body, unchanged, from server/index.ts into
// server/turn-release-door.ts (handleTurnReleaseDoor) so a real proxy child can be run against it; the same line is pinned there, and
// index.ts is pinned to hand the path to that handler.
it("C14-8 the server's verdict route gives a request the same wait (wiring, read from source)", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index).toContain("if (path === TURN_RELEASE_VERDICT_PATH) return await handleTurnReleaseDoor(req, res, { capabilities: internalCapabilities, authority: proxyReleaseAuthority, json });");
  const route = readFileSync(new URL("./turn-release-door.ts", import.meta.url), "utf8");
  expect(route).toContain("setTimeout(() => { seal(); req.destroy(); }, TURN_RELEASE_WAIT_MS);");
  expect(route).not.toMatch(/setTimeout\([^;]*, 5000\)/);
});
