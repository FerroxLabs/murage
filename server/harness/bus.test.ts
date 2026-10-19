// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  beforeEach(() => {
    removeTempDirSync(EVENTS_DIR);
    ensureDirs();
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("reports an incomplete log once while continuing live delivery", () => {
    removeTempDirSync(EVENTS_DIR);
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.slice(1).map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("writes the incomplete marker before the first event after logging recovers", () => {
    let failing = true;
    const writes: string[] = [];
    const append: typeof appendFileSync = vi.fn((...args: Parameters<typeof appendFileSync>) => {
      if (failing) throw new Error("disk full");
      writes.push(String(args[1]));
    });
    const bus = new EventBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent());
    failing = false;
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    bus.publish(testEvent({ eventId: "ev-3" }));

    const recovered = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(recovered.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(recovered[0].message).toContain("event history is incomplete");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
  });

  it("one thread's backlog (events or bytes) closes that thread's intake, never the global cap, so another bot is not paused", async () => {
    const bus = new EventBus();
    bus.omitLog(() => true);
    bus.setDeliveryLimits({ maxEvents: 100, maxBytes: 10_000, batch: 5, retryMinMs: 10, retryMaxMs: 20 });
    let gateHeld = true;
    bus.gateDeliveries({ held: () => gateHeld, wait: async () => { await new Promise(r => setTimeout(r, 20)); }, isBusy: () => false });
    bus.subscribe(() => {});
    // a few huge events from one thread: under the event share, over the byte share
    for (let i = 0; i < 3; i++) bus.publish(testEvent({ eventId: `big-${i}`, threadId: "noisy", type: "item.completed", text: "x".repeat(2_500) } as unknown as Partial<RuntimeEvent>));
    expect(bus.valve.isOpen("noisy")).toBe(false);
    expect(bus.valve.isOpen("quiet")).toBe(true); // another bot's stream keeps flowing
    expect(bus.valve.isOpen(null)).toBe(true); // and the global cap was never reached
    gateHeld = false;
    await vi.waitFor(() => expect(bus.valve.isOpen("noisy")).toBe(true), { timeout: 3000 });
  });

  it("a gate whose wait returns at once while still held does not spin the delivery loop", async () => {
    const bus = new EventBus();
    bus.omitLog(() => true);
    bus.setDeliveryLimits({ maxEvents: 100, maxBytes: 10_000, batch: 5, retryMinMs: 10, retryMaxMs: 20 });
    let gateHeld = true, waits = 0;
    bus.gateDeliveries({ held: () => gateHeld, wait: () => { waits++; return Promise.resolve(); }, isBusy: () => false });
    const seen: string[] = [];
    bus.subscribe(e => { seen.push(e.eventId); }, { durable: true });
    bus.publish(testEvent({ eventId: "held-1" }));
    // a timer-drift probe: the loop stays free, and the drain makes few calls rather than millions
    const t0 = performance.now(); let worstGap = 0, last = t0;
    await new Promise<void>(resolve => { const iv = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; if (now - t0 > 400) { clearInterval(iv); resolve(); } }, 10); });
    expect(waits).toBeLessThan(40);
    expect(worstGap).toBeLessThan(150);
    expect(seen).toHaveLength(0);
    gateHeld = false;
    await vi.waitFor(() => expect(seen).toEqual(["held-1"]), { timeout: 3000 });
  });
});
