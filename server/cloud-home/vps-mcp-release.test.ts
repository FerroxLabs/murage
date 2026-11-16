import { afterEach, expect, it, vi } from "vitest";
import * as relayApi from "./vps-mcp-relay.ts";
import { existsSync } from "node:fs";
const hasIngress = existsSync(new URL("../consuming-turn-ingress.ts", import.meta.url));
const fixturesApi = hasIngress ? await import("../testing/consuming-fixture.ts") : undefined;
const ingressApi = hasIngress ? await import("../consuming-turn-ingress.ts") : undefined;
const responseApi = hasIngress ? await import("../consuming-turn-response.ts") : undefined;
const { createVpsMcpRelay, VPS_MCP_RELAY_PATH } = relayApi;
const createVpsFrameFence: typeof relayApi.createVpsFrameFence = (...args) => {
  expect(relayApi.createVpsFrameFence, "§12.2 requires a final per-frame complete-ledger fence").toBeTypeOf("function");
  return relayApi.createVpsFrameFence(...args);
};
const consumingFixture: typeof import("../testing/consuming-fixture.ts").consumingFixture = (...args) => {
  expect(relayApi.createVpsFrameFence, "every ws.send and child request requires a per-frame retained-ledger fence").toBeTypeOf("function");
  expect(fixturesApi, "VPS response must bind concrete live lineage before socket release").toBeDefined(); return fixturesApi!.consumingFixture(...args);
};
const createConsumingIngress: typeof import("../consuming-turn-ingress.ts").createConsumingIngress = (...args) => {
  expect(ingressApi, "the child delivery needs its own final ingress check").toBeDefined(); return ingressApi!.createConsumingIngress(...args);
};
const registerConsumingDescriptor: typeof import("../consuming-turn-response.ts").registerConsumingDescriptor = (...args) => {
  expect(responseApi, "VPS frame destinations require exact descriptors").toBeDefined(); return responseApi!.registerConsumingDescriptor(...args);
};
import type { InternalCapability } from "../internal-capabilities.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.close()));
const setup = () => { const f = consumingFixture(); fixtures.push(f); return f; };
const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
const response = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } });
// control: both request and response have a live, exact lease and a valid empty addition.
it("T-VPS-WS-RELEASE live frame reaches ws.send", () => {
  const f = setup(), fence = createVpsFrameFence(f.binding, "relay"), stdin = vi.fn(), send = vi.fn();
  fence.request(request(1), stdin); fence.response(response(1), send);
  expect(stdin).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledExactlyOnceWith(response(1));
});
// red-at-4df086541: ws.send had only periodic bot-token liveness, no per-frame ledger fence.
it.each(["flip", "stale-generation", "unknown-id", "malformed", "binary-shape", "transport-loss", "budget"])("T-VPS-WS-RELEASE %s suppresses the next frame", mutation => {
  const f = setup(), fence = createVpsFrameFence(f.binding, "relay"), send = vi.fn();
  fence.request(request(1), () => {}); fence.response(response(1), send); expect(send).toHaveBeenCalledOnce();
  fence.request(request(2), () => {}); send.mockClear();
  if (mutation === "flip") f.flip();
  if (mutation === "stale-generation") f.replace();
  if (mutation === "transport-loss") fence.lost();
  if (mutation === "budget") f.budget.charge({ attempts: 4096 - f.budget.counts.attempts });
  const value = mutation === "unknown-id" ? response(99) : mutation === "malformed" ? "{}" : mutation === "binary-shape" ? "\u0000" : response(2);
  expect(() => fence.response(value, send)).toThrow(); expect(send).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// red-at-4df086541: the WebSocket verdict did not cover the subsequent child stdout write.
it("T-VPS-WS-RELEASE revoke between server send and final engine delivery", () => {
  const f = setup(), fence = createVpsFrameFence(f.binding, "relay"), final = createConsumingIngress(f.binding, "child"), write = vi.fn();
  fence.request(request(1), () => {}); final.request(request(1), () => {});
  let bytes = ""; fence.response(response(1), value => { bytes = value; });
  const envelope = final.issue({ instanceId: "child", sequence: 1, frame: bytes, refs: [], descriptor: registerConsumingDescriptor("proxy:vpsRelayMcp:frame", "body") });
  f.flip(); expect(() => final.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled();
});
// red-at-4df086541: missing final ingress must reject before upgrade/spawn.
it("T-VPS-WS-RELEASE admission with no downstream ingress cannot spawn", async () => {
  expect(relayApi.createVpsFrameFence, "upgrade admission must require a synchronous downstream frame fence before spawning").toBeTypeOf("function");
  const spawn = vi.fn(), end = vi.fn();
  const claim = { botId: "B", threadId: "T", generation: "G", kind: "computer" } as InternalCapability;
  const relay = createVpsMcpRelay({ resolveClaim: () => claim, isActive: () => true, boundContainer: () => ({ alias: "host", container: "container" }), spawn });
  await relay({ method: "GET", headers: { upgrade: "websocket" } } as IncomingMessage, { end, destroy: vi.fn() } as unknown as Duplex, Buffer.alloc(0), new URL(VPS_MCP_RELAY_PATH, "http://localhost"));
  expect(spawn).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledOnce(); expect(end.mock.calls[0]![0]).toContain("I stopped this turn because some of its context is no longer available.");
});
// red-at-4df086541: closure was keyed by bot, so an old connection could disturb a new lease.
it("T-VPS-WS-RELEASE old supervisor loss does not seal a replacement", () => {
  const old = setup(), next = setup(), a = createVpsFrameFence(old.binding, "old"), b = createVpsFrameFence(next.binding, "new");
  old.replace(); a.lost(); b.request(request(1), () => {}); const send = vi.fn(); b.response(response(1), send);
  expect(old.refusals).toBe(1); expect(next.refusals).toBe(0); expect(send).toHaveBeenCalledOnce();
});
