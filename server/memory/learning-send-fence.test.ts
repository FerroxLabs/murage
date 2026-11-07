// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEM-QUEUED-LEARNING-FENCE: a learning call whose words were forgotten, deleted or edited while it waited (an engine's queue behind
// the owner's turn, the adapter's own start-up, a refused pin's fallback) sends nothing. designs/MEM-LEARNING-FENCE-R8.md: each call
// carries one gate (learning-send.ts), sampled before its words are read and released at the physical write.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import * as messages from "../message-db.ts";
import { withCliMemoryLearning, type MemorySessionRunner } from "../drivers/cli-memory-learning.ts";
import { correctMemory, ownerMemoryTicket } from "./authority.ts";
import { extractCandidates, groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { clearPinQuarantineForTests, pinnedCall, resolveLearningConnection } from "./extractor-connections.ts";
import { FLUX_PINNED_LEARNING_MODEL } from "./extraction-outcomes.ts";
import { resetFluxKeyModelsForTests, setFluxKeyCatalog } from "../flux-key-models.ts";
import { forgetMemory } from "./forget.ts";
import { isMemorySendFenced } from "./learning-send-fence.ts";
import { learningGate, sampleLearningFence, type HeldRefs, type LearningGate, type LearningPurpose } from "./learning-send.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { leasedFeedbackClassifier } from "./learning-wiring.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); clearPinQuarantineForTests(); resetFluxKeyModelsForTests(); setFluxKeyCatalog(() => ["flux-auto", "flux-fast", FLUX_PINNED_LEARNING_MODEL]); });
afterEach(() => { vi.restoreAllMocks(); });

const owner = ownerMemoryTicket();
const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
const SECRET = "SENTINEL-FENCE the owner lives at 12 Harbour Road";
function ownerMemory(text: string): string {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, text, Date.now(), Date.now());
  return id;
}

/** The call's one gate, sampled now (before the test's words are read by the call). */
const gateOver = (refs: HeldRefs = {}, purpose: LearningPurpose = "grounding"): LearningGate => learningGate(purpose, sampleLearningFence(), refs);

/** A fake engine that only offers a turn, honouring the submission fence as every adapter does: `wait` is the adapter's own wait
 * (a spawn, the warm pool) before the write; beforeSubmit (the gate's admit) runs right before the write and a refusal writes nothing. */
function fakeEngine(wait: () => Promise<void> = async () => undefined) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const written: string[] = [];
  const emitFor = (threadId: string) => (event: Record<string, unknown>) =>
    listeners.forEach(listener => listener({ eventId: "e", provider: "codex", threadId, createdAt: "now", ...event } as RuntimeEvent));
  const adapter = {
    provider: "codex", capabilities: { sessionModelSwitch: "unsupported" },
    onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async (input: SendTurnInput) => {
      await wait();
      input.beforeSubmit?.();
      written.push(input.text);
      emitFor(input.threadId)({ type: "turn.started" });
      emitFor(input.threadId)({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: JSON.stringify({ supported: true }) });
      emitFor(input.threadId)({ type: "turn.completed", ok: true });
      return { turnId: "turn" };
    },
    respondToRequest: async () => "rejected", interruptTurn: async () => undefined, resetSession: async () => undefined,
  };
  const instance = { instanceId: "codex-fixture", driverKind: "codex", displayName: "Codex", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance;
  return { instance: withCliMemoryLearning(instance), written, emitFor };
}
const extractorOf = (instance: ProviderInstance) => resolveLearningConnection({ selected: instance.instanceId, instances: [instance], readKey: () => null, defaultOn: true }).extractor!;
const signal = () => new AbortController().signal;
const grounding = (previousClaim: string) => ({ text: "The owner moved to Lisbon.", quote: "moved to Lisbon", claimType: "owner-statement", speaker: "owner", outcome: "sent", previousClaim });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe("the learning send fence", () => {
  it("T1: a Forget during the queued wait sends nothing, and the drop logs no words", async () => {
    const id = ownerMemory(SECRET);
    const engine = fakeEngine();
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const log = vi.spyOn(console, "info");
    const gate = gateOver({ records: [{ id, version: 1 }] });
    const queued = extractorOf(engine.instance).ground!(grounding(SECRET), 64, signal(), gate);
    await tick();
    forgetMemory(owner, { kind: "record", id });
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    const error = await queued.then(() => null, (failure: unknown) => failure);
    expect(isMemorySendFenced(error)).toBe(true);
    expect(engine.written).toEqual([]);
    expect(gate.released).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Harbour");
  });

  it("T1b: a conversation delete during the queued wait drops a call fenced on the generation", async () => {
    setMemoryMode("capture");
    messages.appendMessage("gone", { id: "m1", text: "my bank PIN is 4455", parentId: null, at: 1, role: "user", kind: "text" });
    const engine = fakeEngine();
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const queued = engine.instance.extractMemory!("my bank PIN is 4455", 2000, signal(), { policyRevision: "p", messages: [{ role: "user", content: "my bank PIN is 4455" }], fence: gateOver({}, "extraction") });
    await tick();
    messages.deleteThread("gone");
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    expect(isMemorySendFenced(await queued.then(() => null, (failure: unknown) => failure))).toBe(true);
    expect(engine.written).toEqual([]);
  });

  it("T2: an owner edit during the queued wait sends nothing (the held version is no longer the latest)", async () => {
    const id = ownerMemory(SECRET);
    const engine = fakeEngine();
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const queued = extractorOf(engine.instance).ground!(grounding(SECRET), 64, signal(), gateOver({ records: [{ id, version: 1 }] }));
    await tick();
    correctMemory(owner, id, 1, "The owner lives somewhere else now.");
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    expect(isMemorySendFenced(await queued.then(() => null, (failure: unknown) => failure))).toBe(true);
    expect(engine.written).toEqual([]);
  });

  it("T3: a Forget inside the adapter's own wait, after the queue, is refused at the submission fence", async () => {
    const id = ownerMemory(SECRET);
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const engine = fakeEngine(() => held);
    const queued = extractorOf(engine.instance).ground!(grounding(SECRET), 64, signal(), gateOver({ records: [{ id, version: 1 }] }));
    await tick();
    forgetMemory(owner, { kind: "record", id });
    release();
    expect(isMemorySendFenced(await queued.then(() => null, (failure: unknown) => failure))).toBe(true);
    expect(engine.written).toEqual([]);
  });

  it("T4: an engine's own runner (Claude's) admits through the gate before its write and writes nothing when it refuses", async () => {
    const id = ownerMemory(SECRET);
    const writes: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    // the shape of claude.ts memorySession: waits (one-shot pause, version probe, env), then admits through the gate and writes stdin
    const run = (): MemorySessionRunner => async (prompt, _signal, { gate }) => { await held; gate?.admit(); writes.push(prompt); gate?.wrote(); return JSON.stringify({ supported: true }); };
    const adapter = { onEvent: () => () => undefined };
    const instance = withCliMemoryLearning({ instanceId: "claude-fixture", driverKind: "claude", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance, { run });
    const gate = gateOver({ records: [{ id, version: 1 }] });
    const queued = instance.groundMemory!(grounding(SECRET), 64, signal(), gate);
    await tick();
    forgetMemory(owner, { kind: "record", id });
    release();
    expect(isMemorySendFenced(await queued.then(() => null, (failure: unknown) => failure))).toBe(true);
    expect(writes).toEqual([]);
    expect(gate.released).toBe(0);
  });

  it("T5: with nothing forgotten the queued call sends once, as before", async () => {
    const id = ownerMemory(SECRET);
    const engine = fakeEngine();
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const gate = gateOver({ records: [{ id, version: 1 }] });
    const queued = extractorOf(engine.instance).ground!(grounding(SECRET), 64, signal(), gate);
    await tick();
    expect(engine.written).toEqual([]);
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    expect(JSON.parse(await queued)).toEqual({ supported: true });
    expect(engine.written).toHaveLength(1);
    expect(engine.written[0]).toContain("Harbour");
    expect(gate.released).toBe(1);
    expect(database().isTransaction).toBe(false);
  });

  it("T6: a refused pin's fallback is a second release of the same gate after a wait: a Forget meanwhile drops it", async () => {
    const id = ownerMemory(SECRET);
    const sent: string[] = [];
    const gate = gateOver({ records: [{ id, version: 1 }] });
    // invoke stands for requestMemoryTransport: its only send is at the physical fetch, through the call's one gate
    const invoke = async (model: string) => {
      gate.send(() => { sent.push(model); });
      if (model === FLUX_PINNED_LEARNING_MODEL) { forgetMemory(owner, { kind: "record", id }); throw Object.assign(new Error("refused"), { status: 404 }); }
      return "{}";
    };
    const error = await pinnedCall("flux-fast", "test-key-not-real", "grounding", signal(), invoke).then(() => null, (failure: unknown) => failure);
    expect(isMemorySendFenced(error)).toBe(true);
    expect(sent).toEqual([FLUX_PINNED_LEARNING_MODEL]);
    expect(gate.released).toBe(1);
    expect(database().isTransaction).toBe(false);
  });

  it("T7: a grounding or extraction whose fence already refuses is not dispatched or charged", async () => {
    const id = ownerMemory(SECRET);
    const fence = gateOver({ records: [{ id, version: 1 }] });
    forgetMemory(owner, { kind: "record", id });
    let called = 0;
    const extractor = Object.assign(async () => { called++; return "[]"; }, { ground: async () => { called++; return "{}"; } }) as TextOnlyExtractor;
    expect(await groundMemoryClaim(grounding(SECRET), extractor, signal(), undefined, fence)).toEqual({ supported: false, reason: "grounding-fenced" });
    expect(await extractCandidates("The owner reads reports daily.", extractor, signal(), undefined, undefined, { fence })).toMatchObject({ status: "deferred", reason: "extraction-fenced", noReply: true });
    expect(called).toBe(0);
  });

  it("T8: a slice whose source is forgotten while its extraction waits sends nothing and keeps all its attempts", async () => {
    reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor();
    const TEXT = "SENTINEL-SLICE I prefer green tea in the morning.";
    storeAnchorMessage(database(), "thread", "m-src", TEXT);
    captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: TEXT, occurredAt: 1000 } as never);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    const engine = fakeEngine();
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const running = consolidateMemorySource(work.id, extractorOf(engine.instance), signal()).then(value => value, (failure: unknown) => failure);
    await tick();
    forgetMemory(owner, { kind: "source", id: "src" });
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    await running;
    expect(engine.written).toEqual([]);
    const intents = database().prepare("SELECT intent FROM memory_scope_bindings WHERE intent LIKE ?").all(`%"jobId":"${work.id}"%`).map(row => JSON.parse(String(row.intent)));
    for (const intent of intents) { expect(Number(intent.extractionAttempts) || 0).toBe(0); expect(Number(intent.sliceCalls) || 0).toBe(0); }
    const day = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'extract-budget:%'").all().map(row => JSON.parse(String(row.intent)));
    for (const row of day) expect(Number(row.calls) || 0).toBe(0);
  });

  it("T9: the feedback classifier holding an owner message deleted during its wait sends nothing", async () => {
    setMemoryMode("capture");
    messages.appendMessage("chat", { id: "m1", text: "great job, keep it short", parentId: null, at: 1, role: "user", kind: "text" });
    const fence = gateOver({}, "extraction");
    messages.deleteThread("chat");
    let called = 0;
    const extractor = (async () => { called++; return "{}"; }) as unknown as TextOnlyExtractor;
    await expect(leasedFeedbackClassifier(extractor, () => fence).classify({ turn: null, message: "great job, keep it short" }, signal())).rejects.toThrow();
    expect(called).toBe(0);
  });
});
