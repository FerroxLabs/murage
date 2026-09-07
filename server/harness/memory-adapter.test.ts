import { describe, expect, it } from "vitest";
import { memoryRequestPrefix, type MemoryBundle } from "../../shared/memory.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

const bundle: MemoryBundle = {
  bundleId: "bundle", text: "Prior decision: use nightly backups.", policyRevision: 1, deletionEpoch: 0,
  tokenCount: 20, recordVersions: [{ id: "r", version: 1 }], sourceVersions: [{ id: "s", revision: 1 }],
};
const bridge = { command: "node", args: ["memory-proxy.js"], env: { MURAGE_MEMORY_TOKEN: "fixture-token" } };

async function fixture(kind = "fake", memoryMcp = false) {
  const fake = makeFakeDriver({ kind });
  const captured: SendTurnInput[] = [];
  let sessionId: string | null = null;
  let unsubscriptions = 0;
  let fail = false;
  let original: ProviderInstance;
  const create = fake.driver.create;
  fake.driver.create = async input => {
    original = await create(input);
    Object.assign(original.adapter.capabilities, { customMcp: true, memoryMcp });
    original.adapter.hasSession = () => sessionId !== null;
    const subscribe = original.adapter.onEvent;
    original.adapter.onEvent = listener => {
      const unsubscribe = subscribe(listener);
      return () => { unsubscriptions++; unsubscribe(); };
    };
    original.adapter.sendTurn = async function (turn) {
      expect(this).toBe(original.adapter);
      if (fail) throw new Error("fixture rejected turn");
      captured.push(turn);
      return { turnId: "turn" };
    };
    original.snapshot = async function () { expect(this).toBe(original); return { state: "available" }; };
    return original;
  };
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ instance: { driver: kind } });
  const live = registry.get("instance")!;
  const emit = (id: string | null, type: "session.started" | "session.exited" = "session.started") => {
    sessionId = type === "session.exited" ? null : id;
    fake.created.get("instance")!.emit({
      eventId: "event", provider: kind, threadId: "thread", createdAt: new Date().toISOString(),
      ...(type === "session.started" ? { type, sessionId: id } : { type }),
    } as RuntimeEvent);
  };
  return { live, registry, captured, emit, setFail: (value: boolean) => { fail = value; }, unsubscriptions: () => unsubscriptions };
}

describe("registry memory delivery contract (capturing sinks, not native runtime proof)", () => {
  it.each(BUILT_IN_DRIVERS.map(driver => driver.driverKind))("delivers reference text for registered kind %s", async kind => {
    // The registry is exercised with the actual registered kind and an inert
    // contract sink. No native driver construction, credentials or model calls.
    const f = await fixture(kind);
    try {
      const input: SendTurnInput = { threadId: "thread", text: "What should I do?", system: "persona", memoryContext: bundle };
      await f.live.adapter.sendTurn(input);
      expect(f.captured[0].text).toBe(memoryRequestPrefix(bundle.text) + input.text);
      expect(f.captured[0].text).toMatch(/Current request:\nWhat should I do\?$/);
      expect(f.captured[0].system).toBe("persona");
      expect(f.captured[0].memoryContext).toBeUndefined();
      expect(input.memoryContext).toBe(bundle);
      expect(f.live.adapter.capabilities.memoryDelivery).toBe("prefixed-reference");
    } finally { await f.registry.disposeAll(); }
  });
});

it("mounts memory separately from agent tools and rejects a reserved-name collision", async () => {
  const f = await fixture("mcp", true);
  try {
    await f.live.adapter.sendTurn({ threadId: "thread", text: "request", memoryContext: bundle, integrations: { memory: bridge, custom: { user: bridge } } });
    expect(f.captured[0].integrations?.custom).toEqual({ user: bridge });
    expect(f.captured[0].integrations?.memory).toEqual(bridge);
    expect(f.captured[0].integrations?.agents).toBeUndefined();
    expect(f.live.adapter.capabilities.memoryMcp).toBe(true);
    await expect(f.live.adapter.sendTurn({ threadId: "thread", text: "request", integrations: { memory: bridge, custom: { "murage-memory": bridge } } })).rejects.toThrow("MEMORY_MCP_NAME_COLLISION");
    expect(f.captured).toHaveLength(1);
  } finally { await f.registry.disposeAll(); }
});

it("delivers host context when the engine cannot mount memory MCP", async () => {
  const f = await fixture();
  try {
    await f.live.adapter.sendTurn({ threadId: "thread", text: "request", memoryContext: bundle, integrations: { memory: bridge } });
    expect(f.captured[0].text).toContain(bundle.text);
    expect(f.captured[0].integrations).toEqual({});
    expect(f.live.adapter.capabilities.memoryMcp).toBe(false);
  } finally { await f.registry.disposeAll(); }
});

it("deduplicates only a confirmed live session with the same content and authority revisions", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    await f.live.adapter.sendTurn(turn);
    await f.live.adapter.sendTurn(turn); // no session.started: repeat is required
    expect(f.captured[1].text).toContain(bundle.text);
    f.emit("native-one");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, bundleId: "new-receipt" } });
    expect(f.captured[2].text).toBe("request");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, policyRevision: 2 } });
    expect(f.captured[3].text).toContain(bundle.text);
    f.emit(null, "session.exited");
    await f.live.adapter.sendTurn(turn);
    expect(f.captured[4].text).toContain(bundle.text);
    f.emit("native-two");
    await f.live.adapter.sendTurn({ ...turn, memoryContext: { ...bundle, deletionEpoch: 1 } });
    expect(f.captured[5].text).toContain(bundle.text);
    await f.live.adapter.stopAll();
    await f.live.adapter.sendTurn(turn);
    expect(f.captured[6].text).toContain(bundle.text);
  } finally { await f.registry.disposeAll(); }
});

it("preserves ordinary turns and this bindings, clears failed delivery, and unsubscribes on disposal", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    const plain = { threadId: "thread", text: "ordinary", system: "persona" };
    await f.live.adapter.sendTurn(plain);
    expect(f.captured[0]).toEqual(plain);
    await expect(f.live.snapshot()).resolves.toEqual({ state: "available" });
    await f.live.adapter.sendTurn(turn); f.emit("native");
    f.setFail(true);
    await expect(f.live.adapter.sendTurn(turn)).rejects.toThrow("fixture rejected turn");
    f.setFail(false);
    await f.live.adapter.sendTurn(turn);
    expect(f.captured.at(-1)?.text).toContain(bundle.text);
  } finally { await f.registry.disposeAll(); }
  expect(f.unsubscriptions()).toBe(1);
});

it("suppresses an unchanged reference only for the confirmed native resume identity", async () => {
  const f = await fixture();
  const turn = { threadId: "thread", text: "request", memoryContext: bundle };
  try {
    await f.live.adapter.sendTurn(turn);
    f.emit("native-one");
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: "native-one" });
    expect(f.captured[1].text).toBe("request");
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: "native-other" });
    expect(f.captured[2].text).toBe(memoryRequestPrefix(bundle.text) + turn.text);
    await f.live.adapter.sendTurn({ ...turn, resumeCursor: { sessionId: "native-one" } });
    expect(f.captured[3].text).toBe(memoryRequestPrefix(bundle.text) + turn.text);
  } finally { await f.registry.disposeAll(); }
});
