// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OPENAI-TOOLS-109 rev 5, H2: a fleet reload whose engine could not confirm a child closed keeps that thread's folder leases, its
// direct run and its local VM until the engine's own confirmed close. Before, disposeAll swallowed the unconfirmed stop and the reload
// released all three while the child (with its mount token) could still be running. Runs the production reload (index.ts) with inert
// services, as engine-swap-fold.test.ts does.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ENGINE_CLOSED_LATE_NOTE, releaseOnLateClose } from "./direct-late-close.ts";
import { RetainedCloses, unconfirmedCloses } from "./reload-retain.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const adapterWith = (open: Map<string, Promise<void>>) => ({ adapter: { awaitTurnClose: (threadId: string) => open.get(threadId) ?? Promise.resolve() } }) as never;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("unconfirmedCloses", () => {
  it("names only the threads with a child still open on an unconfirmed adapter", async () => {
    const open = deferred();
    const closes = await unconfirmedCloses(["a", "b", "a"], [adapterWith(new Map([["a", open.promise]]))]);
    expect([...closes.keys()]).toEqual(["a"]);
    let closed = false;
    void closes.get("a")!.then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false);
    open.resolve();
    await tick();
    expect(closed).toBe(true);
  });
  it("nothing unconfirmed, or an adapter that cannot observe its children, retains nothing", async () => {
    expect((await unconfirmedCloses(["a"], [])).size).toBe(0);
    expect((await unconfirmedCloses(["a"], undefined)).size).toBe(0);
    expect((await unconfirmedCloses(["a"], [{ adapter: {} } as never])).size).toBe(0);
  });
  it("a close that rejects is never taken for a confirmed one", async () => {
    const closes = await unconfirmedCloses(["a"], [{ adapter: { awaitTurnClose: () => Promise.reject(new Error("x")) } } as never]);
    expect(closes.has("a")).toBe(true);
  });
});

describe("RetainedCloses", () => {
  it("keeps a thread until every close noted for it confirmed, and never on a rejection", async () => {
    const record = new RetainedCloses();
    const first = deferred(), second = deferred();
    record.note("a", first.promise);
    record.note("a", second.promise);
    record.note("b", Promise.reject(new Error("x")));
    first.resolve();
    await tick(); await tick();
    expect([...record.snapshot().keys()].sort()).toEqual(["a", "b"]);
    second.resolve();
    await tick(); await tick();
    expect([...record.snapshot().keys()]).toEqual(["b"]);
  });
});

describe("reloadProviders keeps a retained thread's leases until its child closes", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    return stripTypeScriptTypes(source.slice(start, source.indexOf(to, start)));
  };
  const code = [
    slice("function releaseRetainedOnClose(", "\n/** Rebuild the provider fleet after a config change"),
    slice("async function reloadProviders(", "\n/** The instance a direct run dispatched on"),
  ].join("\n");

  const harness = (open: Map<string, Promise<void>>) => {
    const log: string[] = [];
    const runs = new Map<string, { threadId: string; botId: string; generation: string; providerTurnId: string }>([
      ["kept", { threadId: "kept", botId: "bot-1", generation: "g-kept", providerTurnId: "p1" }],
      ["clean", { threadId: "clean", botId: "bot-2", generation: "g-clean", providerTurnId: "p2" }],
    ]);
    const held = new Set(runs.keys());
    const owners = new Map([["lease-kept", "kept"], ["lease-clean", "clean"], ["lease-room", "room"]]);
    // only the first fleet has unconfirmed children: a later reload disposes a replacement fleet that confirms everything
    let disposals = 0;
    const given: Record<string, unknown> = {
      providerFleetReady: true, browserSetup: undefined, browserExtension: undefined, cfg: {},
      store: {
        bots: [{ id: "bot-1", threadId: "kept", busy: true }, { id: "bot-2", threadId: "clean", busy: false }],
        taskByThread: () => ({}), appendMessage: (_thread: string, line: { tool?: { name?: string } }) => { log.push(`note:${line.tool?.name}`); },
        setTaskActivity: () => undefined, setActivity: (id: string) => { log.push(`idle:${id}`); }, activeLeaf: () => "leaf",
      },
      directRuns: {
        forBot: (botId: string) => [...runs.values()].filter((run) => run.botId === botId),
        current: (run: { threadId: string }) => held.has(run.threadId),
        get: (threadId: string) => held.has(threadId) ? runs.get(threadId) : undefined,
        release: (run: { threadId: string }) => { held.delete(run.threadId); log.push(`release:${run.threadId}`); },
      },
      projectTurnLeases: {
        generations: () => [...owners.keys()],
        generationsForThreads: (threads: Set<string>) => [...owners].filter(([, thread]) => threads.has(thread)).map(([generation]) => generation),
        disposed: (generations: string[]) => { for (const generation of generations) { owners.delete(generation); log.push(`lease:${generation}`); } },
        threadIds: () => [...new Set(owners.values())],
      },
      bus: { detachAll: () => undefined, attach: () => undefined },
      registry: { disposeAll: async () => disposals++ === 0 ? [adapterWith(open)] : [], load: async () => undefined, instances: () => [] },
      threadsWithWorkInFlight: () => new Map([["kept", "bot-1"], ["clean", "bot-2"], ["room", "bot-3"]]),
      localVmThreadTargets: new Map([["kept", "t"], ["room", "t"]]),
      releaseLocalVmThread: (threadId: string) => { log.push(`vm:${threadId}`); },
      reportUnconfirmedDirectStop: (threadId: string) => { log.push(`unconfirmed:${threadId}`); },
      unconfirmedCloses, reloadRetained: new RetainedCloses(), releaseOnLateClose, ENGINE_CLOSED_LATE_NOTE, murageLine: (line: unknown) => line,
      localVmLeaseFor: () => ({ current: () => undefined }), screenPollers: new Map(), activeVpsThreads: new Map(), coordinationSlots: new Map(), replySpeakerTurns: { ended: () => undefined },
      Set, Map, Promise, Boolean, setImmediate,
    };
    const context = new Proxy(given, {
      has: () => true,
      get: (target, key) => key in target ? target[key as string] : key === Symbol.unscopables ? undefined : (globalThis as Record<PropertyKey, unknown>)[key] ?? (() => undefined),
    });
    const { reloadProviders } = runInNewContext(code + "\n({ reloadProviders });", context) as { reloadProviders: () => Promise<void> };
    return { log, held, owners, reloadProviders };
  };

  it("a direct run and a room turn whose children are still open keep their leases, VM and run; each is released by its own close", async () => {
    const kept = deferred(), room = deferred();
    const { log, held, owners, reloadProviders } = harness(new Map([["kept", kept.promise], ["room", room.promise]]));
    await reloadProviders();
    // the thread whose child closed is released at once
    expect(log).toContain("release:clean");
    expect(log).toContain("lease:lease-clean");
    expect(log).toContain("vm:clean");
    // the retained ones are not: the run, the lease and the VM all stay
    expect(log).toContain("unconfirmed:kept");
    expect(held.has("kept")).toBe(true);
    expect([...owners.keys()].sort()).toEqual(["lease-kept", "lease-room"]);
    expect(log).not.toContain("vm:kept");
    expect(log).not.toContain("vm:room");
    // the stranded-bot sweep leaves a retained run's bot alone
    expect(log).not.toContain("idle:bot-1");
    kept.resolve();
    await tick(); await tick();
    expect(held.has("kept")).toBe(false);
    expect(log).toContain(`note:${ENGINE_CLOSED_LATE_NOTE}`);
    expect(owners.has("lease-kept")).toBe(false);
    expect(log).toContain("vm:kept");
    // the room turn's child is still open: its lease and VM stay
    expect(owners.has("lease-room")).toBe(true);
    expect(log).not.toContain("vm:room");
    room.resolve();
    await tick(); await tick();
    expect(owners.size).toBe(0);
    expect(log).toContain("vm:room");
  });

  it("a second reload keeps what the first retained: it disposed only the replacement fleet (Astra code-r1 H2)", async () => {
    const kept = deferred(), room = deferred();
    const { log, held, owners, reloadProviders } = harness(new Map([["kept", kept.promise], ["room", room.promise]]));
    await reloadProviders();
    await reloadProviders();
    expect(held.has("kept")).toBe(true);
    expect([...owners.keys()].sort()).toEqual(["lease-kept", "lease-room"]);
    expect(log).not.toContain("release:kept");
    expect(log).not.toContain("vm:kept");
    expect(log).not.toContain("vm:room");
    expect(log).not.toContain("idle:bot-1");
    // reported once, by the reload that retired it
    expect(log.filter((entry) => entry === "unconfirmed:kept")).toHaveLength(1);
    kept.resolve(); room.resolve();
    await tick(); await tick();
    expect(held.has("kept")).toBe(false);
    expect(owners.size).toBe(0);
    expect(log).toContain("vm:kept");
    expect(log).toContain("vm:room");
  });

  it("with every child confirmed closed, the reload releases everything as before", async () => {
    const { log, held, owners, reloadProviders } = harness(new Map());
    await reloadProviders();
    expect(held.size).toBe(0);
    expect(owners.size).toBe(0);
    expect(log.filter((entry) => entry.startsWith("unconfirmed:"))).toEqual([]);
  });
});
