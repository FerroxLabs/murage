// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { boundaryComms, boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { delegateBotRoute, type DelegateBotRouteContext } from "./handoff-boundary.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { forgetDelegationsForThreads, queueDelegation } from "./delegations.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { bindHumanThread, resolveHumanBinding, observeVerifiedHuman, linkHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { ensureScope } from "./memory/policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { PackAuthority } from "./delegation-pack/types.ts";
import { setObserveSink } from "./observe.ts";

// Only peer policy is bypassed: the claim, input rows, queue, transaction and pack table are real.
vi.mock("./host-words.ts", async original => ({
  ...await original<typeof import("./host-words.ts")>(), authorizeStatus: () => ({ ok: true }),
}));
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); });
afterEach(() => { configureBotEgress(undefined); setObserveSink(undefined); closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot({ name: "Sable" }, { seedMessages: false });
  const target = store.createBot({ name: "Ember" }, { seedMessages: false });
  const bus = { store, broadcast: () => {} };
  const caps = new InternalCapabilities();
  const generation = caps.begin(from.id, from.threadId);
  const token = caps.mint({ botId: from.id, threadId: from.threadId, generation, depth: 0, kind: "agents", skillAuthoring: false });
  const claim = caps.resolve(`Bearer ${token}`)!;
  let inputId: string | undefined;
  const input = (change: Partial<Message> = {}, thread = from.threadId) => {
    inputId = store.appendMessage(thread, { role: "user", kind: "text", text: "Ask Ember", origin: "desktop", ...change }).id;
    return inputId;
  };
  const proof = vi.fn((_thread: string, _generation: string) => inputId ? { messageId: inputId } : undefined);
  const comms = boundaryComms(bus);
  const queue = vi.spyOn(comms, "queueDelegation");
  const context = {
    MAX_COMMS_DEPTH: 4, store: boundaryStore(store), comms,
    internalCapabilities: Object.assign(caps, { turnInputOf: proof }), internalClaim: claim,
    internalOwner: {}, ownerSurfacesByThread: new Map(), isUnattended: () => false,
    connectorThread: () => true, coordinationBudget: { advance: () => undefined },
    fullAccessSkipsPeerCard: () => false, roomAskDuplicate: () => null, roomAskParent: () => undefined,
    roomAskRefused: () => undefined, routinePeerSource: () => undefined, sourceExecutionAudience: () => undefined,
    beginRoomAsk: () => "fixture-request", resultEgressDeps: {}, taskResolutionDeps: {},
    eventAction: async (_spec: unknown, run: (handle: unknown) => unknown) => run({ charge: async () => {}, record: () => {}, unrun: () => {} }),
    readInternalBody: async () => ({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "the note", packAuthority: { inputMessageId: "forged" } }), res: {},
  } as unknown as DelegateBotRouteContext;
  const packs = () => database().prepare("SELECT * FROM delegation_packs ORDER BY rowid").all();
  const run = async () => {
    configureBotEgress(() => {});
    await delegateBotRoute(context);
    expect(queue).toHaveBeenCalled();
    expect(database().prepare("SELECT count(*) AS n FROM pending_delegations").get()?.n).toBe(queue.mock.calls.length);
    return queue.mock.calls.at(-1)?.[4] as PackAuthority | undefined;
  };
  return { store, from, target, bus, caps, generation, context, input, proof, packs, run, queue };
}

it("T-P1: authenticated owner input mints frozen authority and commits only IDs with the queue", async () => {
  const w = world(), inputId = w.input();
  const authority = await w.run();
  expect(authority).toEqual({ fromBotId: w.from.id, fromThreadId: w.from.threadId, generation: w.generation, inputMessageId: inputId });
  expect(Object.isFrozen(authority)).toBe(true);
  expect(w.packs()).toHaveLength(1);
  expect(w.packs()[0]).toMatchObject({ source_bot_id: w.from.id, source_thread_id: w.from.threadId, target_bot_id: w.target.id, destination_thread_id: null, refs: JSON.stringify([inputId]), prepared: "[]" });
  expect(JSON.stringify(w.packs())).not.toContain("Ask Ember");
});

it.each(["missing proof", "missing hook", "stale generation", "missing row", "wrong thread", "wrong bot", "unproven", "automation", "bot row"])(
  "T-P1: %s stays note only; kills trusting body IDs or skipping the input guard", async guard => {
    const w = world(); w.input();
    await w.run(); expect(w.packs()).toHaveLength(1);
    if (guard === "missing proof") w.proof.mockReturnValue(undefined);
    if (guard === "missing hook") delete w.context.internalCapabilities.turnInputOf;
    if (guard === "stale generation") {
      // Reserve still succeeds so only the pack's generation guard is under test.
      vi.spyOn(w.caps, "activeGeneration").mockReturnValue("replacement");
    }
    if (guard === "missing row") w.proof.mockReturnValue({ messageId: "missing" });
    if (guard === "wrong thread") w.input({}, w.target.threadId);
    if (guard === "wrong bot") w.context.internalClaim = { ...w.context.internalClaim, botId: w.target.id };
    if (guard === "unproven") w.input({ origin: "unproven" });
    if (guard === "automation") w.input({ automation: { kind: "delegation" } });
    if (guard === "bot row") w.input({ role: "bot" });
    if (guard === "wrong bot") vi.spyOn(w.caps, "reserve").mockReturnValue({ commit: () => true, release: () => {} });
    expect(await w.run()).toBeUndefined(); expect(w.packs()).toHaveLength(1);
  });

it.each(["unattended", "audience", "routine", "shared", "excluded", "room"])(
  "T-P1: enqueue %s guard preserves the note; kills dropping that guard", async guard => {
    const w = world(); w.input(); const authority = await w.run(); expect(w.packs()).toHaveLength(1);
    const item = { toBotId: w.target.id, message: "note", depth: 0 };
    if (guard === "unattended") Object.assign(item, { unattended: true });
    if (guard === "audience") Object.assign(item, { notOwnerAudience: true });
    if (guard === "routine") Object.assign(item, { routineAuthority: {} });
    if (guard === "shared") Object.assign(w.bus, { prepareDelegation: () => "shared" });
    if (guard === "excluded") database().prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',1,'granted',?)").run(ensureScope("preferences", "owner"), JSON.stringify({ excludedThreadIds: [w.from.threadId] }));
    if (guard === "room") w.store.groups.push({ id: "room", threadId: w.from.threadId, tasks: [], memberIds: [w.from.id, w.target.id] } as never);
    expect(queueDelegation(w.bus, w.from, item, 4, w.from.threadId, authority).result).toBe("ok");
    expect(w.packs()).toHaveLength(1);
  });

it("T-P4: unresolved destination permits enqueue; a populated destination keeps its owner binding", async () => {
  const w = world(); w.input(); await w.run(); expect(w.packs()).toHaveLength(1);
  expect(w.packs()[0].destination_thread_id).toBeNull();
  const binding = observeVerifiedHuman({ platform: "slack", authorityId: "TEAM", connectionId: "fixture", userId: "PERSON" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(binding);
  bindHumanThread(w.target.threadId, person);
  await w.run(); expect(w.packs()).toHaveLength(2); // P4 waits for the resolved destination at render.
  const ownerDestination = w.store.createTask(w.target.id, "Owner job", false)!;
  w.store.appendMessage(ownerDestination.threadId, { role: "bot", kind: "text", text: "kept" });
  expect(() => bindHumanThread(ownerDestination.threadId, person)).toThrow("HUMAN_THREAD_NOT_EMPTY");
});

it.each(["person", "unknown"])("T-P5: %s source queues no pack; kills skipping the source principal", async principal => {
  const w = world(); w.input(); const authority = await w.run(); expect(w.packs()).toHaveLength(1);
  // Populated threads cannot be rebound through the API. Inject only the persisted principal for this guard pair.
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?, ?, 'human-thread', ?, 1, 'granted', ?)")
    .run(`human-thread:${w.from.threadId}`, ensureScope("conversation", w.from.threadId), w.from.threadId, JSON.stringify({ personId: principal, bindingId: "fixture", revision: 1 }));
  expect(queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "note", depth: 0 }, 4, w.from.threadId, authority).result).toBe("ok");
  expect(w.packs()).toHaveLength(1);
});

it.each(["source", "destination"])("T-GONE: owner deletion of %s removes packs in the same transaction", async side => {
  const w = world(); w.input(); await w.run(); expect(w.packs()).toHaveLength(1);
  database().prepare("UPDATE delegation_packs SET destination_thread_id=?").run(w.target.threadId);
  const thread = side === "source" ? w.from.threadId : w.target.threadId;
  expect(() => transaction(() => { recordOwnerDeletion(database(), thread); expect(w.packs()).toHaveLength(0); throw new Error("rollback"); })).toThrow("rollback");
  expect(w.packs()).toHaveLength(1);
  transaction(() => recordOwnerDeletion(database(), thread)); expect(w.packs()).toHaveLength(0);
});

it.each(["source", "destination"])("T-GONE: delegation cleanup of %s removes packs and preserves unrelated packs", async side => {
  const w = world(); w.input(); await w.run(); expect(w.packs()).toHaveLength(1);
  database().prepare("UPDATE delegation_packs SET destination_thread_id=?").run(w.target.threadId);
  forgetDelegationsForThreads(["unrelated"]); expect(w.packs()).toHaveLength(1);
  forgetDelegationsForThreads([side === "source" ? w.from.threadId : w.target.threadId]); expect(w.packs()).toHaveLength(0);
});

it("T-P1: pack insert failure keeps the note; queue failure rolls back the pack", async () => {
  const w = world(); w.input(); await w.run(); expect(w.packs()).toHaveLength(1);
  const observed: string[] = []; setObserveSink(line => observed.push(line));
  database().exec("CREATE TRIGGER refuse_pack BEFORE INSERT ON delegation_packs BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await w.run(); expect(w.packs()).toHaveLength(1);
  expect(observed.some(line => /^\[deleg.pack.unrecorded\] count=\d+$/.test(line))).toBe(true);
  database().exec("DROP TRIGGER refuse_pack");
  database().exec("CREATE TRIGGER refuse_queue BEFORE INSERT ON pending_delegations BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await expect(w.run()).rejects.toThrow("DELEGATION_PERSISTENCE_FAILED"); expect(w.packs()).toHaveLength(1);
});

it.each(["bot", "thread", "absent"])("T-P1: enqueue requires matching separate authority (%s); kills trusting item JSON", async guard => {
  const w = world(); w.input(); const authority = (await w.run())!; expect(w.packs()).toHaveLength(1);
  const changed = guard === "absent" ? undefined : { ...authority, ...(guard === "bot" ? { fromBotId: w.target.id } : { fromThreadId: w.target.threadId }) };
  expect(queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "note", depth: 0, authority } as never, 4, w.from.threadId, changed).result).toBe("ok");
  expect(w.packs()).toHaveLength(1);
});

it("T-P1: live unattended state at enqueue keeps only the note", async () => {
  const w = world(); w.input(); await w.run(); expect(w.packs()).toHaveLength(1);
  w.context.isUnattended = () => true;
  expect(await w.run()).toBeUndefined(); expect(w.packs()).toHaveLength(1);
  expect(w.queue.mock.calls.at(-1)?.[1].unattended).toBe(true);
});

it("T-P1: an isolated source keeps only the note; kills skipping the source partition", async () => {
  const w = world(); w.input(); w.from.partitionedAt = 1;
  const authority = await w.run(); expect(w.packs()).toHaveLength(1);
  w.from.tasks!.find(task => task.threadId === w.from.threadId)!.sharedWork = { teamId: "fixture-team", quarantined: true } as never;
  expect(queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "note", depth: 0 }, 4, w.from.threadId, authority).result).toBe("ok");
  expect(w.packs()).toHaveLength(1);
});

it("T-P1: packs and queue rows roll back together with the enclosing transaction", async () => {
  const w = world(); w.input(); const authority = await w.run(); expect(w.packs()).toHaveLength(1);
  expect(() => transaction(() => {
    queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "note", depth: 0 }, 4, w.from.threadId, authority);
    expect(w.packs()).toHaveLength(2);
    expect(database().prepare("SELECT count(*) AS n FROM pending_delegations").get()?.n).toBe(2);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(w.packs()).toHaveLength(1);
  expect(database().prepare("SELECT count(*) AS n FROM pending_delegations").get()?.n).toBe(1);
});

it.each([30, 200])("T-OLDER-LEND: %i text rows lend at most the newest 160 before the cutoff", async count => {
  const w = world();
  const root = w.input({ at: 1 });
  const abandoned = w.store.appendMessage(w.from.threadId, { role: "bot", kind: "text", text: "other branch", at: 2 }).id;
  w.store.setActiveLeaf(w.from.threadId, root);
  const wanted: string[] = [];
  for (let i = 0; i < count - 1; i++) wanted.push(w.store.appendMessage(w.from.threadId, { role: "bot", kind: "text", text: `line ${i}`, at: 3 + i, parentId: wanted.at(-1) ?? root }).id);
  const future = w.store.appendMessage(w.from.threadId, { role: "bot", kind: "text", text: "future", at: Date.now() + 60_000 }).id;
  await w.run();
  const refs = JSON.parse(String(w.packs()[0].refs));
  expect(refs).toEqual([root, ...wanted].slice(-160)); expect(refs).not.toContain(abandoned); expect(refs).not.toContain(future);
});
