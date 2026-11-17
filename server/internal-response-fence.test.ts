import "./testing/port-integrity.ts";
import { threadHumanPrincipal as fixtureThreadHumanPrincipal } from "./human-principals.ts";
import { bindInternalDispatch, clearInternalAuthorityFixtures, fixtureObservers } from "./testing/internal-authority-fixture.ts";

import { executionStoreFixture } from "./testing/execution-store-fixture.ts";
import { executionStore, setExecutionStore } from "./execution-audience.ts";
import { completeIndexCallbackFixture, internalDispatchAuthorityFixture } from "./testing/internal-dispatch-fixture.ts";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
const responseApi = existsSync(new URL("./consuming-turn-response.ts", import.meta.url))
  ? await import("./consuming-turn-response.ts") : undefined;
const fixtureApi = responseApi ? await import("./testing/consuming-fixture.ts") : undefined;
const inventoryApi = responseApi ? await import("./consuming-sink-inventory.ts") : undefined;
const budgetApi = responseApi ? await import("./memory/release-budget.ts") : undefined;
// Keep the suite loadable at b18. Missing boundary implementation is an
// assertion in the individual case, never a module-resolution failure.
function boundary<K extends keyof typeof import("./consuming-turn-response.ts")>(name: K): NonNullable<typeof responseApi>[K] {
  expect(responseApi?.[name], `response acceptance contract ${name} must exist before any bytes or attribution can escape`).toBeTypeOf("function");
  return responseApi![name];
}
const consumingHttpWriter: typeof import("./consuming-turn-response.ts").consumingHttpWriter = (...args) => boundary("consumingHttpWriter")(...args);
const emitConsumingTurnResponse = ((...args: Parameters<typeof import("./consuming-turn-response.ts").emitConsumingTurnResponse>) => boundary("emitConsumingTurnResponse")(...args)) as typeof import("./consuming-turn-response.ts").emitConsumingTurnResponse;
const registerConsumingDescriptor: typeof import("./consuming-turn-response.ts").registerConsumingDescriptor = (...args) => boundary("registerConsumingDescriptor")(...args);
const stageConsumingResponse: typeof import("./consuming-turn-response.ts").stageConsumingResponse = (...args) => boundary("stageConsumingResponse")(...args);
const pipeConsumingStream: typeof import("./consuming-turn-response.ts").pipeConsumingStream = (...args) => boundary("pipeConsumingStream")(...args);
const consumingFixture: typeof import("./testing/consuming-fixture.ts").consumingFixture = (...args) => {
  boundary("bindConsumingTurn"); return fixtureApi!.consumingFixture(...args);
};
const consumingResponseRecorder: typeof import("./testing/consuming-fixture.ts").consumingResponseRecorder = () => {
  boundary("consumingHttpWriter");
  return fixtureApi!.consumingResponseRecorder();
};
const RELEASE_LIMITS = budgetApi?.RELEASE_LIMITS!;
const consumingSinkInventory = () => inventoryApi?.consumingSinkInventory() ?? [];
// Baseline-compatible producer invocation: before the explicit local contract,
// callers could supply [] to stageConsumingResponse on every route.
const declareNoStoredResponse = (writer: object, status: number) => {
  const declare = responseApi?.declareNoStoredResponse;
  if (declare) declare(writer, status); else stageConsumingResponse(writer, []);
};
// red-at-fc2aad5b4: a producer may throw before its first write. In that case
// the outer catch's first write refuses and propagates; if the producer itself
// attempted a write, the outer catch sees an already sealed facade and returns.
// Both paths must satisfy the same exact refusal-output and verdict assertions.
async function settleRevokedDispatch(dispatch: (scope: Record<string, unknown>) => Promise<void>, scope: Record<string, unknown>) {
  try { await dispatch(scope); }
  catch (error) { expect(error).toMatchObject({ code: "MEMORY_CONTEXT_REVOKED" }); }
}
import { addTurnParents } from "./memory/lineage-write.ts";
import { turnToolText } from "./memory/prompt-parts.ts";
const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";

// red-at-4df086541: body release after a real backpressure wait must recheck
// X; the initial headers and accepted first chunk do not authorize chunk two.
it("T-ALL-RETURNS stream drain rechecks before the next retained chunk", async () => {
  boundary("pipeConsumingStream");
  const f = consumingFixture();
  const sink = fixtureApi!.consumingResponseRecorder({ backpressure: true });
  const writer = consumingHttpWriter(sink.raw, f.binding, {
    headers: registerConsumingDescriptor("POST /api/internal/connectors/mcp:headers", "headers"),
    body: registerConsumingDescriptor("POST /api/internal/connectors/mcp:body", "body"),
    chunk: registerConsumingDescriptor("POST /api/internal/connectors/mcp:chunk", "chunk"),
  });
  try {
    stageConsumingResponse(writer, []);
    const source = Readable.from([Buffer.alloc(65537, 65)]);
    const first = new Promise<void>(resolve => sink.raw.once("fixture-written", resolve));
    const done = pipeConsumingStream(source, writer);
    await first;
    expect(sink.output.reduce((n, row) => n + (row.body?.length ?? 0), 0)).toBe(65536);
    f.flip(); sink.drain(); await done;
    expect(sink.output.reduce((n, row) => n + (row.body?.length ?? 0), 0)).toBe(65536);
    expect(source.destroyed).toBe(true); expect(f.refusals).toBe(1);
  } finally { f.close(); }
});
import { ChiefProposalTurns } from "./project-proposal-engines.ts";
import { sendDelegated } from "./route-delegation.ts";
import { Readable } from "node:stream";
import { afterCommit } from "./tx-scope.ts";
import { addSourcesToRunningTurn, addRootsToRunningTurn, type RunningTurnLineage } from "./steer-lineage.ts";

// R1 supersedes historical rollback-after-write: either result may follow
// transport acceptance. Persist attribution and one charge conservatively.
it.each(["throw", "thenable"] as const)("R1 destination %s retains possible-release attribution", failure => {
  const f = fixture(), before = f.turn.parents;
  f.f.db.exec("CREATE TABLE accepted_attribution(id INTEGER)");
  const write = vi.fn(() => { if (failure === "throw") throw new Error("destination"); return { then() {} }; });
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [{ kind: "line", threadId: "T", messageId: "Y" }],
    commitAttribution: () => { f.f.db.exec("INSERT INTO accepted_attribution VALUES(1)"); }, write,
  })).toThrow(failure === "throw" ? "destination" : "ASYNC_RELEASE_TRANSACTION");
  expect(write).toHaveBeenCalledTimes(1);
  expect(f.f.db.prepare("SELECT count(*) n FROM accepted_attribution").get()?.n).toBe(1);
  expect(f.turn.parents).not.toBe(before);
  expect(f.turn.parents).toContainEqual({ kind: "line", threadId: "T", messageId: "Y" });
  expect(f.budget.counts.attempts).toBe(1);
});

// red-at-8d3290c81: the last check preceded both attribution and commit hooks.
it.each(["attribution-replace", "attribution-revoke"])("A3-3 revalidates %s", kind => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  const change = () => kind.endsWith("replace") ? f.replace() : f.flip();
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [{ kind: "line", threadId: "T", messageId: "Y" }],
    commitAttribution: change, write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
});

// red-at-8d3290c81: commit hooks ran before destination acceptance, after the
// final authorization. R1 runs them after possible acceptance even on throw.
it.each([false, true])("A3-3 commit notifications follow acceptance, destination failure=%s", fails => {
  const f = fixture(), order: string[] = [];
  const emit = () => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [], commitAttribution: () => afterCommit(() => { order.push("committed"); f.replace(); }),
    write: () => { expect(f.binding.isCurrent()).toBe(true); order.push("accepted"); if (fails) throw new Error("destination"); },
  });
  if (fails) { expect(emit).toThrow("destination"); expect(order).toEqual(["accepted", "committed"]); }
  else { emit(); expect(order).toEqual(["accepted", "committed"]); }
});

// Pre-enqueue attribution failures still roll back every alias under R1.
it("A3-4 restores exact in-memory attribution aliases after partial preparation", () => {
  const f = fixture(), sources: RunningTurnLineage["sources"] = [], roots = { roots: new Set<string>(), over: false };
  const ranges: NonNullable<RunningTurnLineage["ranges"]> = [];
  const running: RunningTurnLineage = { sources, roots, ranges, instanceId: "fixture", generation: f.turn.turnId, turn: f.turn, startGeneration: 0 };
  const write = vi.fn();
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [], commitAttribution: () => {
      addSourcesToRunningTurn(running, [{ threadId: "T", id: "Y", role: "bot" }]);
      addRootsToRunningTurn("T", running, { roots: new Set(), over: true });
      expect(running.sources).toHaveLength(1); expect(running.roots.over).toBe(true);
      throw new Error("attribution");
    }, write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(running.sources).toBe(sources); expect(sources).toEqual([]);
  expect(running.ranges).toBe(ranges); expect(running.roots).toBe(roots);
  expect(write).not.toHaveBeenCalled();
});

// red-at-8d3290c81: a fresh writer implicitly declared empty provenance.
it("A3-7 unannotated HTTP response fails closed before result headers", () => {
  const f = fixture(), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  expect(() => writer.end("stored result without provenance")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
});

const fixtures: ReturnType<typeof consumingFixture>[] = [];
const fixtureCleanup: Array<() => void> = [];
let ambientExecutionStore:ReturnType<typeof executionStore>;
beforeEach(()=>{ambientExecutionStore=executionStore();});
afterEach(async () => {
  try { await clearInternalAuthorityFixtures(); fixtureCleanup.splice(0).reverse().forEach(close => close()); fixtures.splice(0).forEach(f => f.close()); }
  finally { setExecutionStore(ambientExecutionStore); }
});
const fixture = (empty = false, threadId = "T") => {
  const verdicts: import("./memory/lineage-types.ts").LineageVerdict[] = [];
  const f = consumingFixture(undefined, { empty, threadId, internalSchema:true, onRefused: verdict => verdicts.push(verdict) });
  fixtures.push(f); return Object.assign(f, { verdicts });
};

// Owner: sc-safety owns these isolated audience inputs; human-principals owns registration policy.
async function bindMatrixChannelPerson(f: ReturnType<typeof fixture>) {
  const databaseApi = await import("./database.ts");
  const humans = await import("./human-principals.ts");
  const { ownerMemoryTicket } = await import("./memory/authority.ts");
  const { connectedAppsAudienceRefusal, CONNECTED_APPS_OWNER_ONLY } = await import("./connector-requests.ts");
  const { turnAudienceIsOwner } = await import("./owner-audience.ts");
  const db = vi.spyOn(databaseApi, "database").mockReturnValue(f.f.db);
  const tx = vi.spyOn(databaseApi, "transaction").mockImplementation(work => work(f.f.db));
  let retained = false;
  try {
    const bindingId = humans.observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "fixture-team", userId: "fixture-person" });
    humans.linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
    humans.bindHumanThread(f.turn.threadId, humans.resolveHumanBinding(bindingId));
    expect(humans.isWorkspaceOwner(humans.threadHumanPrincipal(f.turn.threadId))).toBe(false);
    expect(turnAudienceIsOwner(f.turn.threadId)).toBe(false);
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: real surface refusal; the route has an earlier channel-person gate.
    expect(connectedAppsAudienceRefusal(f.turn.threadId)).toBe(CONNECTED_APPS_OWNER_ONLY);
    // Capability validation also reads the live principal; retain only this DB
    // I/O scope through setup and dispatch, never replace that validation.
    retained = true;
    return () => db.mockRestore();
  } finally { tx.mockRestore(); if (!retained) db.mockRestore(); }
}

const modeId = { body: "gateway:json-error-limit-done", chunk: "gateway:sse", headers: "gateway:headers", native: "native:claude:broker", request: "gateway:upstream-request" } as const;
// control: preserves the checkpoint emitter-mode test; descriptor authority is now inventory-owned.
it.each(["body", "chunk", "headers", "native", "request"] as const)("T-ALL-RETURNS gate: %s checks retained X even for empty acknowledgements", mode => {
  const f = fixture(), descriptor = registerConsumingDescriptor(modeId[mode], mode), write = vi.fn();
  emitConsumingTurnResponse(f.binding, descriptor, { bytes: 2, refs: [], write });
  expect(write).toHaveBeenCalledTimes(1);
  f.flip(); write.mockClear();
  expect(() => emitConsumingTurnResponse(f.binding, descriptor, { bytes: 0, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// control: a structurally identical descriptor is not registered authority.
it("refuses unknown descriptors before bytes and mutations", () => {
  const f = fixture(), write = vi.fn(), before = f.turn.parents;
  expect(() => emitConsumingTurnResponse(f.binding, { id: "unknown", mode: "body" }, { bytes: 1, refs: [], write })).toThrow();
  expect(write).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
});
// control: exact crossing release cannot mutate a ledger before byte reservation.
it("reserves bytes before accepting new result refs", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  f.budget.charge({ bytes: RELEASE_LIMITS.bytes });
  expect(() => emitConsumingTurnResponse(f.binding, registerConsumingDescriptor(modeId.body, "body"), {
    bytes: 1, refs: [{ kind: "line", threadId: "T", messageId: "Y" }], write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.turn.parents).toBe(before); expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// control: generation replacement cannot authorize the original response.
it("refuses an old binding after a replacement", () => {
  const f = fixture(), write = vi.fn(); f.replace();
  expect(() => emitConsumingTurnResponse(f.binding, registerConsumingDescriptor(modeId.body, "body"), { bytes: 0, refs: [], write })).toThrow();
  expect(write).not.toHaveBeenCalled();
});

const httpDescriptors = {
  get headers() { return registerConsumingDescriptor("POST /api/internal/memory/thread-read:headers", "headers"); },
  get body() { return registerConsumingDescriptor("POST /api/internal/memory/thread-read:body", "body"); },
  get chunk() { return registerConsumingDescriptor("POST /api/internal/memory/thread-read:chunk", "chunk"); },
};

// red-at-4df086541: the checkpoint exposes writeContinue, writeEarlyHints and _writeRaw.
it("T-RAW-WRITER-ESCAPE exposes only explicit gated output methods", () => {
  const f = fixture(), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  for (const name of ["socket", "connection", "writeContinue", "writeEarlyHints", "writeProcessing", "_writeRaw", "_send", "_write", "_writev", "addTrailers", "emit", "pipe"]) {
    expect((writer as unknown as Record<string, unknown>)[name]).toBeUndefined();
  }
  expect(Object.getPrototypeOf(writer)).toBeNull();
  expect(sink.output).toEqual([]);
});

// red-at-4df086541: headers escaped before result provenance and final body validation.
it.each([200, 201, 204, 400, 401, 403, 404, 405, 409, 429, 500, 503])("T-ALL-RETURNS HTTP %s stages headers and refuses benign reply after flip", status => {
  const f = fixture(), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  writer.writeHead(status, { "x-result": "not-released" });
  expect(sink.output).toEqual([]);
  f.flip();
  expect(() => writer.end("benign reply")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  expect(sink.headers.has("x-result")).toBe(false);
  expect(f.refusals).toBe(1);
});

// control: every inventoried destination retains the same full-ledger fence.
it.each(consumingSinkInventory().map(entry => [entry.id, entry.mode] as const))("T-ALL-RETURNS inventory %s", (id, mode) => {
  const f = fixture(), write = vi.fn(); f.flip();
  expect(() => emitConsumingTurnResponse(f.binding, registerConsumingDescriptor(id, mode), { bytes: 0, refs: [], write })).toThrow();
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});

// red-at-4df086541: ToolText used to mutate a newest-thread ledger at construction.
it("T-RESPONSE-PROVENANCE stages exact refs until accepted response", () => {
  const f = fixture(), before = f.turn.parents;
  const result = turnToolText(f.turn, "answer", [{ kind: "line", threadId: "T", messageId: "Y" }]);
  expect(f.turn.parents).toBe(before);
  const sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  stageConsumingResponse(writer, result.lineageOf);
  writer.end(result.text);
  expect(f.turn.parents).toContainEqual({ kind: "line", threadId: "T", messageId: "Y" });
  expect(sink.output.at(-1)?.body).toBe("answer");
});

// red-at-4df086541: source/read attribution had no response preflight stage.
it("T-RESPONSE-NO-EARLY-COMMIT refuses staged attribution before roots and bytes", () => {
  const f = fixture(), before = f.turn.parents, commit = vi.fn();
  const sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  stageConsumingResponse(writer, [{ kind: "line", threadId: "T", messageId: "Y" }], commit);
  f.flip();
  expect(() => writer.end("answer")).toThrow();
  expect(commit).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
});

// red-at-4df086541: receipt preparation is rollbackable and cannot mutate live parents.
it("T-RESPONSE-NO-EARLY-COMMIT rolls back receipt preparation on refusal", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  f.f.db.exec("CREATE TABLE staged_response_test(id INTEGER)");
  f.flip();
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 6, refs: [], prepareAttribution: () => {
      f.f.db.exec("INSERT INTO staged_response_test VALUES(1)");
      addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "Y" }]);
    }, write,
  })).toThrow();
  expect(f.f.db.prepare("SELECT count(*) AS n FROM staged_response_test").get()?.n).toBe(0);
  expect(f.turn.parents).toBe(before); expect(write).not.toHaveBeenCalled();
});

// red-at-4df086541: an arbitrary registered name used to gain output authority.
it("T-UNKNOWN-DESCRIPTOR rejects invented registrations and wrong modes", () => {
  expect(() => registerConsumingDescriptor("POST /api/internal/new-tool:body", "body")).toThrow();
  expect(() => registerConsumingDescriptor(modeId.body, "chunk")).toThrow();
});

// red-at-4df086541: proposal registry previously had no immutable response binding.
it("T-PROPOSAL-BINDING preserves identity and drops the binding at end", () => {
  const f = fixture(true), proposals = new ChiefProposalTurns();
  expect(f.turn.parents).toEqual([]);
  void proposals.begin("T", "B", f.turn.turnId, "fake", () => { throw new Error("unused"); });
  proposals.bind("T", f.turn.turnId, f.binding);
  expect(proposals.bindingFor("T", f.turn.turnId)).toBe(f.binding);
  expect(proposals.bindingFor("T", "replacement")).toBeUndefined();
  const write = vi.fn();
  emitConsumingTurnResponse(f.binding, httpDescriptors.body, { bytes: 0, refs: [], write });
  expect(write).toHaveBeenCalledTimes(1);
  expect(() => proposals.bind("T", f.turn.turnId, f.binding)).toThrow();
  proposals.end("T", f.turn.turnId);
  expect(proposals.bindingFor("T", f.turn.turnId)).toBeUndefined();
});

// red-at-4df086541: callback receivers must not recover the raw writer.
it("T-RAW-WRITER-ESCAPE completion callbacks receive the facade", () => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  let receiver: unknown;
  stageConsumingResponse(writer, []);
  writer.end("done", "utf8", function (this: unknown) { receiver = this; });
  expect(receiver).toBe(writer);
});

// red-at-4df086541: delegated unknown provenance must not be default-allowed.
it("T-RESPONSE-PROVENANCE refuses unknown delegated content", () => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  sendDelegated(writer, "POST", { status: 200, body: { result: "unknown" } });
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  expect(f.refusals).toBe(1);
});

// red-at-4df086541: the actual delegated body branches share the consuming gate.
it.each(["json", "bytes"])("T-ALL-RETURNS delegated %s refuses after flip", mode => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  f.flip();
  expect(() => sendDelegated(writer, "POST", { status: 200, provenance: { refs: [] },
    ...(mode === "json" ? { body: { ok: true } } : { bytes: Buffer.from("binary-result") }) })).toThrow();
  expect(sink.output.at(-1)?.body).toBe(LEDGER_REFUSAL_LINE);
  expect(f.refusals).toBe(1);
});

// red-at-4df086541: the actual stream pump closes upstream at the refusing chunk.
it("T-ALL-RETURNS bounded stream cancels source after flip", async () => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  let closed = false;
  stageConsumingResponse(writer, []);
  const firstWritten = new Promise<void>(resolve => sink.raw.once("fixture-written", resolve));
  const stream = Readable.from((async function* () {
    try { yield Buffer.from("first"); await firstWritten; f.flip(); yield Buffer.from("second"); }
    finally { closed = true; }
  })());
  await pipeConsumingStream(stream, writer);
  expect(sink.output.map(item => item.body).filter(Boolean)).toEqual(["first"]);
  expect(sink.destroyed).toBe(true); expect(closed).toBe(true); expect(f.refusals).toBe(1);
});

// red-at-4df086541: post-header refusal must close rather than emit another body.
it("T-ALL-RETURNS stream termination emits no content after flip", () => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  stageConsumingResponse(writer, []);
  writer.write("first"); f.flip();
  expect(() => writer.write("second")).toThrow();
  expect(sink.output.map(item => item.body).filter(Boolean)).toEqual(["first"]);
  expect(sink.destroyed).toBe(true); expect(f.refusals).toBe(1);
});

// red-at-4df086541: exercise the real box producer and responder, including
// errors synthesized locally, instead of emitting a primitive body directly.
it.each(["success", "validation", "transport"] as const)("T-ALL-RETURNS box real %s", async responseClass => {
  const { relayBoxCall, sendBoxRelayResult, BOX_RELAY_PREFIX } = await import("./box-relay.ts");
  const f = fixture();
  const deps = {
    resolveClaim: () => ({ botId: "B", threadId: "T", generation: f.turn.turnId, kind: "computer" as const, depth: 0, skillAuthoring: false, expiresAt: Number.MAX_SAFE_INTEGER }),
    isActive: () => true, boundBoxId: () => "box", accountToken: () => "fixture-token", enabled: () => true,
    upstreamBase: "https://fixture.invalid/api/box/v1",
    fetch: vi.fn(async () => {
      if (responseClass === "transport") throw new Error("fixture failure");
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    }), log: () => {},
  };
  const result = await relayBoxCall({ method: "POST", pathname: `${BOX_RELAY_PREFIX}/boxes/box/${responseClass === "validation" ? "unknown" : "commands"}`, search: "",
    authorization: "Bearer fixture", readJson: async () => responseClass === "validation" ? {} : { command: "echo fixture" },
  }, deps);
  const delivered = consumingResponseRecorder(), first = consumingHttpWriter(delivered.raw, f.binding, httpDescriptors);
  sendBoxRelayResult(first, result);
  expect(delivered.output.at(-1)?.body).toBe(result.body.toString());
  expect(delivered.output[0]?.status).toBe(result.status);
  f.flip();
  const refused = consumingResponseRecorder(), second = consumingHttpWriter(refused.raw, f.binding, httpDescriptors);
  expect(() => sendBoxRelayResult(second, result)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(refused.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  expect(f.refusals).toBe(1);
});

// red-at-4df086541: a commit-only response had no rollback scope. A failing
// synchronous attribution must undo both its database writes and accepted refs.
it("T-RESPONSE-NO-EARLY-COMMIT rolls back commit-only database and parents", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  f.f.db.exec("CREATE TABLE attribution_commit(id INTEGER)");
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [{ kind: "line", threadId: "T", messageId: "Y" }],
    commitAttribution: () => {
      f.f.db.exec("INSERT INTO attribution_commit VALUES(1)");
      throw new Error("fixture commit failure");
    }, write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.f.db.prepare("SELECT count(*) AS n FROM attribution_commit").get()?.n).toBe(0);
  expect(f.turn.parents).toBe(before); expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});

// red-at-4df086541: HTTP callback aggregation discarded returned promises,
// allowing asynchronous attribution to escape the synchronous preflight scope.
it.each(["prepare", "commit"] as const)("T-RESPONSE-NO-EARLY-COMMIT rejects async %s before invocation", phase => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  let invoked = false;
  const work = async () => { invoked = true; };
  stageConsumingResponse(writer, [], phase === "commit" ? work : undefined, phase === "prepare" ? work : undefined);
  expect(() => writer.end("result")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(invoked).toBe(false);
  expect(sink.output.at(-1)?.body).toBe(LEDGER_REFUSAL_LINE);
  expect(f.refusals).toBe(1);
});

// red-at-4df086541: real hand-off result and BotBody producers must retain
// their origin through the configured JSON callback until the bound release.
it.each([false, true])("T-RESPONSE-PROVENANCE hand-off producer refused=%s", async revoked => {
  const { releaseStoredResult } = await import("./result-egress.ts");
  const { botBody, bodyShown, configureBotEgress, sendBot } = await import("./bot-egress.ts");
  const { WorkerText } = await import("./released-text.ts");
  const f = fixture(), before = f.turn.parents;
  const released = releaseStoredResult({ requestId: "request", origin: { threadId: "T", messageIds: ["Y"] } },
    "worker", "T", { fromBotId: "B" }, false, new WorkerText("handoff payload"), {
      message: () => ({ id: "Y", text: "handoff payload" }), authorize: () => ({ ok: true }),
      copyOriginWithheld: () => false, capturedMessageWithheld: () => false,
      messageSourceForgotten: () => false, messageMadeWithMemory: () => false,
      partitionAllowed: () => true, ownUnsharedWork: () => false, withheldLine: "[withheld]",
    });
  expect(released.kind).toBe("text");
  if (released.kind !== "text") throw new Error("fixture producer did not release");
  const body = botBody({ text: released.text });
  expect(bodyShown(body).origins).toContainEqual({ threadId: "T", messageIds: ["Y"] });
  expect(f.turn.parents).toBe(before);
  const sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);

  const lineage: RunningTurnLineage = { sources: [], roots: { roots: new Set(), over: false },
    instanceId: "fixture", botId: "B", generation: f.binding.identity.dispatchGeneration, turn: f.turn, startGeneration: 0 };
  // Execute the production configured callback, including member/generation
  // checks and deferred source attribution, rather than replacing its logic.
  configureBotEgress(await indexCallbackFixture("configureBotEgress", {
    ...await retainedCallbackScope(f, lineage, writer),

  }));
  try {
    if (revoked) {
      f.flip();
      expect(() => sendBot(writer, 200, body)).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(f.turn.parents).toBe(before);
      expect(lineage.sources).toEqual([]);
      expect(sink.output.at(-1)?.body).toBe(LEDGER_REFUSAL_LINE);
    } else {
      sendBot(writer, 200, body);
      expect(f.turn.parents).toContainEqual({ kind: "line", threadId: "T", messageId: "Y" });
      expect(lineage.sources).toContainEqual({ threadId: "T", id: "Y", role: "bot" });
      expect(sink.output.at(-1)?.body).toContain("handoff payload");
    }
  } finally { configureBotEgress(undefined); }
});

/** Retained callback setup shares the real private lineage/caller registries. */
async function retainedCallbackScope(f: ReturnType<typeof fixture>, lineage?: RunningTurnLineage, writer?: object) {
  const {InternalCapabilities} = await import("./internal-capabilities.ts");
  const caps = new InternalCapabilities();
  caps.begin("B", "T", f.turn.turnId, fixtureThreadHumanPrincipal("T", f.f.db));
  const setup = await internalDispatchAuthorityFixture(f, caps);
  await setup.dispatchAuthoritySetup.retain(f.binding, lineage, writer);
  return {...(setup).scope};
}

let indexCallbackSource: import("typescript").SourceFile | undefined;
async function indexCallbackFixture(name: string, scope: Record<string, unknown>): Promise<any> {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const source = indexCallbackSource ??= ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback = "";
  const walk = (node: import("typescript").Node): void => {
    if (name.startsWith("projectToolHandlers.set:") && ts.isCallExpression(node)
      && node.expression.getText(source) === "projectToolHandlers.set"
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === name.slice("projectToolHandlers.set:".length)) callback = node.arguments[1]!.getText(source);
    if (ts.isCallExpression(node) && node.expression.getText(source) === name && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]) || ts.isObjectLiteralExpression(node.arguments[0]))) callback = node.arguments[0].getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) callback = node.getText(source);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) callback = node.initializer.getText(source);
    node.forEachChild(walk);
  };
  walk(source);
  // Resolve the production declaration before nested locals with the same name.
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (declaration) callback = declaration.getText(source);
  expect(callback).not.toBe("");
  return completeIndexCallbackFixture(callback,scope,source);
}

// red-at-4df086541: an attribution callback cannot append result provenance
// after preflight. Capture the forbidden addition and roll back the proposal.
it("T-RESPONSE-NO-EARLY-COMMIT rejects late parent additions from commit", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, {
    bytes: 1, refs: [], commitAttribution: () => addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "Y" }]), write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.turn.parents).toBe(before); expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});

// red-at-4df086541: receipt preparation cannot authorize a replaced request.
it("T-RESPONSE-NO-EARLY-COMMIT replacement during preparation rolls back", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn(), commit = vi.fn();
  f.f.db.exec("CREATE TABLE replacement_attribution(id INTEGER)");
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, { bytes: 1, refs: [],
    prepareAttribution: () => { f.f.db.exec("INSERT INTO replacement_attribution VALUES(1)"); f.replace(); },
    commitAttribution: commit, write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.f.db.prepare("SELECT count(*) AS n FROM replacement_attribution").get()?.n).toBe(0);
  expect(commit).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
});

/** Execute the actual index.ts dispatch and json producer as source, with an
 * isolated destination and explicit dependencies. This avoids starting the app
 * or importing its live singleton. No copied dispatch implementation is tested.
 * Type erasure happens only when the container runs this test. */
/** Roster DTOs are setup data; every lookup and write remains a Store method. */
async function fixtureRoster(bots: Array<Partial<import("./store.ts").BotRecord>>,groups: Array<Partial<import("./store.ts").GroupRecord>>=[]) {
  const {Store}=await import("./store.ts"),previous=executionStore();
  const store=new Store(undefined,undefined,true);
  setExecutionStore(previous);fixtureCleanup.push(()=>store.stopSeqStamps());
  store.bots=bots.map(row=>({id:"B",threadId:"T",name:"Fixture",title:"Fixture",description:"",notifications:false,
    color:"blue",unread:false,resumeCursors:{},createdAt:1,modelSelection:{instanceId:"fixture",model:"fixture"},
    tasks:[{threadId:row.threadId??"T",title:"Fixture",createdAt:1,resumeCursors:{}}],...row}));
  store.groups=groups.map(row=>({id:"venue",threadId:"R",name:"Fixture",memberIds:[],defaultResponder:{kind:"everyone"},bulletin:"",unread:false,createdAt:1,...row}));
  return store;
}
const dispatchBindings = new WeakMap<object, Record<string, unknown>>();
const dispatchWriters = new WeakMap<object, object>();
async function internalDispatchFixture(catchErrors = false) {
  const ts = (await import("typescript")).default;
  const { readFileSync } = await import("node:fs");
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let branch = "", json = "", localJson = "", boundaryCatch = "";
  const helpers: string[] = [];
  const admission = new Map<string, string>();
  const walk = (node: import("typescript").Node): void => {
    if (ts.isVariableDeclaration(node) && ["consumingRequest", "requestClaim", "requestBinding"].includes(node.name.getText(source)))
      admission.set(node.name.getText(source), `const ${node.getText(source)};`);
    if (ts.isIfStatement(node) && node.expression.getText(source) === 'path.startsWith("/api/internal/")') branch = node.thenStatement.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "json") json = node.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "localJson") localJson = node.getText(source);
    if (ts.isFunctionDeclaration(node) && ["serveVenuePost", "serveShareAsk", "toolJson"].includes(node.name?.text ?? "")) helpers.push(node.getText(source));
    if (ts.isCatchClause(node) && node.variableDeclaration?.name.getText(source) === "e" && node.getText(source).includes("coordinationRefusalText(e)")) boundaryCatch = node.getText(source);
    node.forEachChild(walk);
  };
  walk(source);
  expect(branch.length).toBeGreaterThan(0); expect(json.length).toBeGreaterThan(0);
  expect(branch.includes("res = consumingHttpWriter(originalResponse, responseBinding,"), "the real internal dispatcher must replace its raw response before invoking a consuming producer").toBe(true);
  if (catchErrors) expect(boundaryCatch.includes("coordinationRefusalText(e)")).toBe(true);
  expect(admission.size).toBe(3);

  const expression = `async () => { ${[...admission.values()].join("\n")}\n${json}\n${localJson}\n${helpers.join("\n")}\n${catchErrors ? `try ${branch} ${boundaryCatch}` : branch} }`;
  return async (scope: Record<string, unknown>) => {
    const setup = scope.dispatchAuthoritySetup as { run<T>(work: () => Promise<T>): Promise<T> } | undefined;
    const run = async () => {
    const writerObserver = vi.fn(responseApi!.consumingHttpWriter);
    const canonical: Record<string, unknown> = { ...scope, consumingHttpWriter: writerObserver };
    for (const name of ["consumingHttpWriter", "registerConsumingDescriptor", "stageConsumingResponse", "emitConsumingTurnResponse"]) {
      const wrapped = { consumingHttpWriter, registerConsumingDescriptor, stageConsumingResponse, emitConsumingTurnResponse }[name as "consumingHttpWriter"];
      if (canonical[name] === wrapped) canonical[name] = responseApi![name as "consumingHttpWriter"];
    }
    const { dispatch, bound, free: resolutions } = await bindInternalDispatch({ expression, scope: canonical, source });
    dispatchBindings.set(scope, bound);
    const free = new Set(resolutions.keys());
    let missing = 0, missingIndex = -1, missingName = "";
    for (const name of free) if (!Object.hasOwn(bound, name) && resolutions.get(name)?.step !== "declaration") Object.defineProperty(bound, name, {
      get() { missing++; missingName = name; missingIndex = [...free].indexOf(name); throw new Error(`dispatch dependency missing index=${missingIndex} count=${free.size}`); },
    });
    // Retain the runtime guard after construction as an independent second check.
    try { return await dispatch(); }
    finally {
      const writer = writerObserver.mock.results[0]?.value;
      if (writer) dispatchWriters.set(scope, writer);
      expect(missing, `dispatch missing dependencies name=${missingName} count index=${missingIndex} total=${free.size}`).toBe(0);
    }
    };
    return setup ? setup.run(run) : run();
  };
}

// red-at-8d3290c81 A3-8: valid capabilities reach each concrete producer.
// The fixture table is intentionally separate from the inventory: adding a
// route requires a reviewed request and a route-specific response assertion.
it("T-ALL-RETURNS valid-capability concrete local and delegated producers", async () => {
  const dispatch = await internalDispatchFixture(true);
  const { CHANNEL_PERSON_INTERNAL_REFUSAL } = await import("./internal-route-authority.ts");
  const { MCP_REMOTE_OWNER_ONLY } = await import("./mcp-relay.ts");

  const { INTERNAL_HTTP_ROUTES, PROJECT_ROUTE_NAMES, EMAIL_ROUTE_NAMES } = await import("./consuming-sink-inventory.ts");
  const { requiredInternalKind, InternalCapabilities } = await import("./internal-capabilities.ts");

  const { threadRecallRoute } = await import("./thread-recall.ts");

  const { authorizeProjectTool, projectToolHandlers: realProjectHandlers } = await import("./project-tool-routing.ts");
  const { initializeProjectTables } = await import("./project-tables.ts");
  const { initializePendingDelegations } = await import("./pending-delegations-schema.ts");
  const { insertRoomRequest } = await import("./room-requests.ts");

  const { registerProjectMemoryTools } = await import("./project-memory-tools.ts");
  const { BOX_RELAY_ALLOWLIST } = await import("./box-relay.ts");
  const { EmailRuntime } = await import("./email/runtime.ts");
  const { VENUE_READ_UNAVAILABLE } = await import("./venue-read.ts");
  const { VENUE_POST_UNAVAILABLE } = await import("./venue-post.ts");
  const { SHARE_UNAVAILABLE } = await import("./room-shares.ts");
  const { manageBot, mayInspectBot } = await import("./bot-management.ts");
  const { partitionRoster } = await import("./shared-bots-roster.ts");
  // red-at-b530c7532: Array.map reads its callback even for an empty list.

  const memoryRoutes = await import("./memory/routes.ts");
  const memoryHandler = vi.spyOn(memoryRoutes, "memoryAgentRoute");
  fixtureCleanup.push(() => memoryHandler.mockRestore());
  const { memoryAccess, reconcileMemoryRoster } = await import("./memory/policy.ts");
  const { setMemoryMode } = await import("./memory/repository.ts");
  const { ensureDirs } = await import("./config.ts");
  const { listSkills, stageSkillWrite } = await import("./skills.ts");

  const { validateProjectProposal } = await import("./project-new.ts");
  const { parseConnectorRequests } = await import("./connector-requests.ts");

  const { requestBotAccess, mayReviewAccessStatus } = await import("./bot-access.ts");
  const { permissionStatus } = await import("./permission-status.ts");
  const { proposeOutcomeFromAgent } = await import("./memory/outcomes.ts");

  // Vitest's setup owns this installation; the bound retained ledger remains
  // a separate fresh SQLite fixture for each matrix cell.
  ensureDirs();
  const { configureBotEgress } = await import("./bot-egress.ts");

  const { HighLevelHost } = await import("./highlevel/host.ts");
  const botWriterScope = {

  };
  configureBotEgress(await indexCallbackFixture("configureBotEgress", {
    ...botWriterScope,
  }));
  fixtureCleanup.push(() => configureBotEgress(undefined));
  const roster = { bots: [{ id: "B", threadId: "T", name: "fixture" }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode("active");
  type Recipe = { status: number; contains: string; body?: Record<string, unknown> };
  const recipes: Record<string, Recipe> = {
    "POST register-artifact": { status: 404, contains: "no file workspace", body: { relativePath: "fixture.txt" } },
    "POST needs-owner-now": { status: 200, contains: "Noted." },
    "POST voice-note": { status: 429, contains: "voice notes per turn", body: { text: "fixture" } },
    "POST stop-line-allowance": { status: 403, contains: "Only the owner", body: { kind: "delete", place: "fixture" } },
    "GET image-models": { status: 200, contains: "fixtureModels" },
    "GET image-prompt-block": { status: 409, contains: "Image generation is off" },
    "GET image-prompt-blocks": { status: 409, contains: "Image generation is off" },
    "POST image-prompt-blocks": { status: 409, contains: "Image generation is off" },
    "GET image-reference-packs": { status: 409, contains: "Image generation is off" },
    "POST image-reference-packs": { status: 409, contains: "Image generation is off" },
    "POST publish-site": { status: 403, contains: "Publishing is only available" },
    "POST take-down-site": { status: 403, contains: "Publishing is only available", body: { siteId: "fixture" } },
    "POST generate-image": { status: 409, contains: "Choose an image connection", body: { requestId: "fixture" } },
    "POST web-read": { status: 400, contains: "page URL", body: { input: {} } },
    "POST web-search": { status: 409, contains: "Native web search is disabled" },
    // MAIN RULING: "keep only the wipe check, everything else is NO LIMITS".
    // BASE and HEAD return the disabled phone service's explicit off envelope, not a permission card.
    "POST device/call": { status: 200, contains: '"code":"off"' },
    "POST highlevel/mcp": { status: 200, contains: '"result":{}', body: { jsonrpc: "2.0", id: 1, method: "ping" } },
    "POST host-computer": { status: 403, contains: "computer turn is no longer authorized" },
    "POST unified-browser": { status: 403, contains: "browser turn is no longer authorized" },
    "POST headless-browser": { status: 405, contains: "method not allowed" },
    "GET headless-browser": { status: 403, contains: "no authorized headless browser session" },
    "DELETE headless-browser": { status: 200, contains: '"closed":true' },
    "POST tool-result": { status: 400, contains: "Expected bounded text" },
    "GET tool-result": { status: 400, contains: "Expected a saved result id" },
    "GET skills": { status: 403, contains: "skill authoring is not enabled" },
    "POST skills/stage": { status: 403, contains: "skill authoring is not enabled" },
    "GET agents": { status: 200, contains: '"bots":[]' },
    "GET routines": { status: 200, contains: '"routines":[]' },
    "POST outcome-proposals": { status: 200, contains: "learning is off" },
    "POST routine-requests": { status: 400, contains: "invalid routine proposal" },
    "POST access-request": { status: 404, contains: "Bot not found" },
    "POST permission-status": { status: 404, contains: "Bot not found" },
    "POST create-bot": { status: 403, contains: "Chief of Staff can create" },
    "POST request-browser-connection": { status: 403, contains: "owner conversation" },
    "POST mcp-servers": { status: 409, contains: "already being updated" },
    "POST ask-user": { status: 403, contains: "fixture question refusal" },
    "POST show-widget": { status: 403, contains: "fixture widget refusal" },
    "POST update-widget": { status: 403, contains: "fixture widget refusal" },
    "POST request-credential": { status: 400, contains: "credential" },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: a genuine channel person reaches the earlier route gate.
    "POST connectors/mcp": { status: 403, contains: CHANNEL_PERSON_INTERNAL_REFUSAL },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: a genuine channel person reaches the earlier route gate.
    "POST connectors/request": { status: 403, contains: CHANNEL_PERSON_INTERNAL_REFUSAL },
    "POST computer-activity": { status: 200, contains: '"silenceMs":1234' },
    "GET computer-control": { status: 200, contains: '"held":false' },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS (1114-HOUR23-RULINGS D): the real ComputerControl producer returns B-1.
    "POST computer-control": { status: 200, contains: '"requestId":"B-1"' },
    "DELETE computer-control": { status: 200, contains: '"held":false' },
    "POST resolve-image-reference": { status: 400, contains: "invalid-request" },
    ...Object.fromEntries(["thread-search", "thread-read", "thread-list"].map(name => [`POST memory/${name}`, { status: 400, contains: "Thread request rejected", body: { unexpected: true } }])),
    ...Object.fromEntries(PROJECT_ROUTE_NAMES.map(name => [`POST project/${name}`, {
      status: name === "review-result" ? 409 : 400,
      contains: name === "review-result" ? '"ok":false' : "error",
      body: { cardId: "fixture-card", unexpected: true },
    }])),
    ...Object.fromEntries(EMAIL_ROUTE_NAMES.map(name => [`POST email/${name}`, { status: 403, contains: "Email is not available" }])),
    ...Object.fromEntries(BOX_RELAY_ALLOWLIST.map(route => [`${route.method} box/v1/boxes/box${route.tail}`, { status: 404, contains: "not found" }])),
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: non-owner delegated turn registered by the real producer.
    "POST mcp-remote/approved": { status: 403, contains: MCP_REMOTE_OWNER_ONLY },
    "POST project/propose": { status: 403, contains: "proposal turn has ended" },
    "POST venue/read-messages": { status: 403, contains: VENUE_READ_UNAVAILABLE },
    "POST venue/post": { status: 403, contains: VENUE_POST_UNAVAILABLE },
    "POST room-share/ask": { status: 403, contains: SHARE_UNAVAILABLE },
    "POST bot-management": { status: 400, contains: "Invalid bot-management request" },
    "POST ask-bot": { status: 400, contains: "error", body: { toBotId: "B" } },
    "POST delegate-bot": { status: 400, contains: "error", body: { toBotId: "B" } },
    "GET delegations/known": { status: 403, contains: "error" },
    ...Object.fromEntries(["search", "get", "save", "propose-correction"].map(name => [`POST memory/${name}`, { status: 400, contains: "INVALID_MEMORY_ARGUMENTS" }])),
  };
  const inline = [...INTERNAL_HTTP_ROUTES,
    ...PROJECT_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/project/${name}` })),
    ...EMAIL_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/email/${name}` })),
    ...BOX_RELAY_ALLOWLIST.map(route => ({ method: route.method, path: `/api/internal/box/v1/boxes/box${route.tail}` })),
    { method: "POST", path: "/api/internal/mcp-remote/approved" },
    { method: "GET", path: "/api/internal/delegations/known" },
  ];
  expect(inline.map(route => `${route.method} ${route.path.slice("/api/internal/".length)}`).sort()).toEqual(Object.keys(recipes).sort());
  let cell = 0;
  for (const route of inline) for (const authorizedDelegate of /^\/api\/internal\/(?:(?:box|email|mcp-remote|delegations)\/|skills(?:\/stage)?$|project\/propose$|connectors\/(?:request|mcp)$|access-request$|permission-status$|outcome-proposals$|routine-requests$|bot-management$)/.test(route.path) ? [false, true] : [false]) for (const delegatedStage of authorizedDelegate && route.path.endsWith("/skills/stage") ? [false, true] : [false]) for (const revoked of [false, true]) {
    cell++;
    let closeChannelDatabase: (() => void) | undefined;
    try {
    const authorizedBox = authorizedDelegate && route.path.startsWith("/api/internal/box/");
    const authorizedEmail = authorizedDelegate && route.path.startsWith("/api/internal/email/");
    const authorizedSkills = authorizedDelegate && route.path.startsWith("/api/internal/skills");
    const authorizedProposal = authorizedDelegate && route.path === "/api/internal/project/propose";
    const authorizedConnectorMcp = authorizedDelegate && route.path === "/api/internal/connectors/mcp";
    const authorizedConnectorRequest = authorizedDelegate && route.path === "/api/internal/connectors/request";
    const authorizedRemote = authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/");
    const authorizedAccess = authorizedDelegate && route.path.endsWith("/access-request");
    const authorizedPermission = authorizedDelegate && route.path.endsWith("/permission-status");
    const authorizedOutcome = authorizedDelegate && route.path.endsWith("/outcome-proposals");
    const authorizedRoutine = authorizedDelegate && route.path.endsWith("/routine-requests");
    const authorizedDelegation = authorizedDelegate && route.path.includes("/delegations/");
    const authorizedManagement = authorizedDelegate && route.path.endsWith("/bot-management");
    const recipe = delegatedStage ? { status: 422, contains: "SKILL.md has no YAML frontmatter", body: { action: "create", skill_md: "Fixture without frontmatter", source: "conversation" } }
      : authorizedEmail ? { status: 200, contains: "takes only", body: { unexpected: true } }
      : authorizedBox ? { status: 200, contains: "fixture upstream", body: { command: "fixture command" } }
      : authorizedSkills ? { status: route.method === "GET" ? 200 : 400, contains: route.method === "GET" ? '"skills":' : "action must be", body: {} }
      : authorizedProposal ? { status: 400, contains: "Check the proposal", body: {} }
      // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: owner control reaches the real delegate's request validation.
      : authorizedConnectorMcp ? { status: 200, contains: "An app action needs a request id", body: { jsonrpc: "2.0", method: "tools/call", params: { name: "FIXTURE_ACTION", arguments: {} } } }
      : authorizedConnectorRequest ? { status: 400, contains: "invalid resume key", body: {} }
      : authorizedRemote ? { status: 400, contains: "Send one JSON-RPC message", body: {} }
      : authorizedAccess ? { status: 409, contains: "Access changed", body: { targetBotId: "B", revision: 1, grants: [{ toolkit: "fixture", accountId: "fixture", tools: ["fixture"] }] } }
      : authorizedPermission ? { status: 200, contains: '"canApprove":false', body: { targetBotId: "B" } }
      : authorizedOutcome ? { status: 400, contains: "note", body: { note: "x".repeat(141) } }
      : authorizedRoutine ? { status: 400, contains: "routine.", body: { action: "create", routine: {} } }
      : authorizedDelegation ? { status: 200, contains: '"status":"queued"', body: {} }
      : authorizedManagement ? { status: 200, contains: '"revision"', body: { targetBotId: "B", action: "get" } }
      : recipes[`${route.method} ${route.path.slice("/api/internal/".length)}`]!;
    const channelPerson = !authorizedDelegate && route.path.startsWith("/api/internal/connectors/");
    const threadId = channelPerson ? "fixture-contact" : "T";
    const f = fixture(false, threadId), sink = consumingResponseRecorder();
    if (channelPerson) closeChannelDatabase = await bindMatrixChannelPerson(f);
    const capabilities = new InternalCapabilities(); capabilities.begin("B", threadId, f.turn.turnId, fixtureThreadHumanPrincipal(threadId,f.f.db));
    const token = capabilities.mint({ botId: "B", threadId, generation: f.turn.turnId, kind: requiredInternalKind(route.path), depth: 0, humanPrincipal: fixtureThreadHumanPrincipal(threadId,f.f.db), skillAuthoring: authorizedSkills, ...(/\/(?:publish-site|take-down-site)$/.test(route.path) ? { notOwnerAudience: true as const } : {}) });
    const claim = capabilities.resolve(`Bearer ${token}`)!;
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: preserve exact claim equality for the real audience thread.
    expect(claim).toMatchObject({ botId: "B", threadId, generation: f.turn.turnId });
    const bot = { id: "B", threadId, name: "fixture", tasks: [{ threadId, title: "Fixture", createdAt: 1, resumeCursors: {}, cwd: null }], chiefOfStaff: authorizedAccess, learning: { enabled: authorizedOutcome, askFirst: false, prospectLearning: false, revision: 0 }, modelSelection: { instanceId: "fixture", model: "fixture" } };
    const managementHandler = vi.fn(manageBot);
    const rosterHandler = vi.fn(partitionRoster);
    const skillStageHandler = vi.fn(stageSkillWrite);
    const skillListHandler = vi.fn(listSkills);
    const connectorRequestParser = vi.fn(parseConnectorRequests);
    const recallHandler = vi.fn(threadRecallRoute);
    memoryHandler.mockClear();
    const memoryAuthorization = vi.fn(memoryAccess);
    if (authorizedManagement) expect(mayInspectBot(bot as never, bot as never)).toBe(true);
    const accessHandler = vi.fn(requestBotAccess), permissionHandler = vi.fn(permissionStatus), outcomeHandler = vi.fn(proposeOutcomeFromAgent);
    let routineHandler:ReturnType<ReturnType<typeof fixtureObservers>["spy"]>|undefined;
    if (authorizedAccess || authorizedPermission) expect(mayReviewAccessStatus(bot as never, bot as never)).toBe(true);
    const proposals = new ChiefProposalTurns();
    const validateProposal = vi.fn((raw: unknown) => validateProjectProposal(raw, []));
    if (authorizedProposal) {
      void proposals.begin(threadId, "B", f.turn.turnId, "fixture", validateProposal);
      proposals.bind(threadId, f.turn.turnId, f.binding);
      fixtureCleanup.push(() => { proposals.end(threadId, f.turn.turnId); });
    } else if (route.path === "/api/internal/project/propose") {
      // Exercise the real ended-proposal branch, rather than bypassing its admission check.
      void proposals.begin(threadId, "B", f.turn.turnId, "fixture", validateProposal);
      proposals.end(threadId, f.turn.turnId);

    }
    initializePendingDelegations(f.f.db);
    // Seed a readable real queue item; the negative status control belongs to another conversation.
    const delegationSourceThread = route.path.includes("/delegations/") && !authorizedDelegation ? "fixture-other-thread" : threadId;
    f.f.db.prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,phase,item) VALUES('known',?,'B','busy',?)")
      .run(delegationSourceThread, JSON.stringify({ id: "known", fromBotId: "B", toBotId: "B", sourceThreadId: delegationSourceThread, attempts: 0, message: "Fixture handoff", depth: 0 }));
    const projectName = route.path.match(/^\/api\/internal\/project\/([^/]+)$/)?.[1];
    const isProjectHandler = !!projectName && PROJECT_ROUTE_NAMES.includes(projectName);
    const group = { id: "fixture-project", threadId, memberIds: ["B"], channelProject: {goal:"Fixture work",status:"active" as const,startedAt:1,updatedAt:1} };
    const requests = new Map<string, string>();
    let handlerCalls = 0;
    const projectObservation=isProjectHandler?fixtureObservers([`projectToolHandlers.${projectName}`]):authorizedRoutine?fixtureObservers(["routineRequests.propose"]):undefined;
    if (isProjectHandler) {
      initializeProjectTables(f.f.db);
      f.f.db.exec("INSERT INTO project_settings(group_id,lead_bot_id,updated_at) VALUES('fixture-project','B',1); INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('fixture-goal','fixture-project','Fixture','working',0,1,1)");
      const root = insertRoomRequest(f.f.db, { groupId: group.id, verb: "owner_send", fromKind: "owner", admissionKey: "root",
        lineage: { rootThreadId: threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, now: 1 }).request;
      const request = insertRoomRequest(f.f.db, { groupId: group.id, verb: projectName === "review-result" ? "review" : projectName === "card-update" ? "assign" : "room_turn",
        fromKind: "owner", toBotId: "B", targetThreadId:threadId, parentId: root.id, admissionKey: "handler", state: "running", now: Date.now(),
        ...(projectName === "review-result" || projectName === "card-update" ? { workItemId: "fixture-card", cardGeneration: 1 } : {}) }).request;
      f.f.db.prepare("INSERT INTO project_work_items(id,group_id,number,title,state,position,assignee_bot_id,generation,review_request_id,created_by,created_at,updated_at) VALUES('fixture-card','fixture-project',1,'Fixture','review',1,'B',1,?,'B',1,1)").run(request.id);
      requests.set(f.turn.turnId, request.id);
      registerProjectMemoryTools({ roster: () => ({ bots: [bot], groups: [group] }), note: () => { throw new Error("validation must not publish a note"); } });
      for (const name of ["card-update", "review-result"]) realProjectHandlers.set(name, await indexCallbackFixture(`projectToolHandlers.set:${name}`, {
          transaction: (work: (db: typeof f.f.db) => unknown) => work(f.f.db),
      }));
      expect([...realProjectHandlers.keys()].sort()).toEqual([...PROJECT_ROUTE_NAMES].sort());
      expect(authorizeProjectTool(f.f.db, { name: projectName!, botId: "B", request, body: recipe.body!, memberIds: ["B"], ownerAudience: true })).toMatchObject({ ok: true });
    }
    let restricted: object | undefined;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emailRoute = route.path.startsWith("/api/internal/email/");
    const emailHome = emailRoute ? mkdtempSync(join(tmpdir(), "murage-email-dispatch-")) : undefined;
    if (emailHome) fixtureCleanup.push(() => rmSync(emailHome, { recursive: true, force: true }));
    const emailRuntime = new EmailRuntime({ accountKey: () => emailRoute ? "fixture-account" : null,
      database: () => f.f.db, transaction: work => work(), workspaceRoot: () => undefined, bot: () => bot as unknown as import("./store.ts").BotRecord,
      ...(emailHome ? { capsFile: join(emailHome, "capabilities.json") } : {}),
      fetch: async () => Response.json({ enabled: true, available: true, data: [] }) });
    fixtureCleanup.push(() => emailRuntime.stop());
    let emailHandler: { mockRestore(): void } | undefined;
    if (emailRoute) {
      const { forgetEmailTurn } = await import("./email/email-turns.ts");
      // Persisted capability state is isolated as well as the mailbox tables.
      fixtureCleanup.push(() => forgetEmailTurn(f.turn.turnId));
      await emailRuntime.start(); emailRuntime.stop();
      const services = emailRuntime.services()!;
      expect(services).not.toBeNull();
      services.store.insertBinding({ botId: "B", inboxId: "fixture-inbox", address: "fixture@murage.email", username: "fixture", displayName: "Fixture", emailKeyRef: "fixture-key", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: 1 });
      emailRuntime.secrets.setBotKey("B", { token: "fixture-bot-token", keyId: "fixture-key" });
      // An unavailable turn has a configured mailbox but no generation-bound mount.
      // This reaches the real authorization refusal, rather than the feature-off protocol response.
      if (authorizedEmail) expect(emailRuntime.mount(f.turn.turnId, { driverKind: "claudeAgent", agentsMcp: true, surfacesForOwner: true, directOwnerAudience: true,
        origin: "desktop", automationThread: false, bot, threadId: "T" })).toMatchObject({ mounted: true, mode: "send" });
      emailHandler = realMethodObserver(services.tools, "handle");
    }
    const boxRoute = BOX_RELAY_ALLOWLIST.find(candidate => route.method === candidate.method && route.path === `/api/internal/box/v1/boxes/box${candidate.tail}`);
    const boxFetch = vi.fn(async () => new Response("fixture upstream", { headers: { "content-type": "text/plain" } }));
    const scope = {
      // These observations exercise lower-level role/attendance/card guards.
      // Authenticate the owner while keeping that explicit lower posture.
      ...(await internalDispatchAuthorityFixture(f, capabilities, {...(route.path.endsWith("/computer-activity") ? { activityStallMs: 1234 } : {}),...(channelPerson || !authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/") ? { roomOwnerOnly: false, initiator: { k: "delegation" as const } } : {}),box:boxRoute?{id:"box",...(authorizedBox?{fetch:boxFetch}:{})}:undefined,observers:projectObservation,requestId:requests.get(f.turn.turnId),store:await fixtureRoster([bot],isProjectHandler?[group]:[]),
        ...(authorizedConnectorRequest || route.path.startsWith("/api/internal/email/")
          || /\/(?:create-bot|request-browser-connection|ask-user|show-widget|update-widget|agents)$/.test(route.path)
          ? { revoke: revoked, settings: { autoApprove: true, fullAccess: true, noLimits: false }, unattended: /\/(?:request-browser-connection|ask-user|show-widget|update-widget)$/.test(route.path) } : {mcpConfigurationBusy:route.path.endsWith("/mcp-servers"),revoke: revoked, unattended: route.path.endsWith("/stop-line-allowance"), voiceQuotaExhausted: route.path.endsWith("/voice-note")})})).scope,
      path: route.path, method: route.method, url: new URL(`${route.path}?${authorizedBox ? boxRoute!.queries[0] : `self=B&fromBotId=B&fromThreadId=${threadId}&botId=B`}`, "http://fixture.invalid"),
      req: Object.assign(new (await import("node:events")).EventEmitter(), { method: route.method, headers: { authorization: `Bearer ${token}` } }), res: sink.raw,
      internalCapabilities: capabilities,
      ...(emailRoute?{emailRuntime}:{}),
      highlevel: { host: new HighLevelHost({ capabilities, bot: () => bot,
        signals: { onEnd: () => () => {} } as any,
        get leases(): never { throw new Error("unexpected HighLevel lease use"); },
        get client(): never { throw new Error("unexpected HighLevel client use"); },
        get actions(): never { throw new Error("unexpected HighLevel action use"); },
      }) },
      chiefProposals: proposals,

      cfg: { features: { skillRecorder: authorizedSkills,cloudBoxComputers:authorizedBox },box:authorizedBox?{token:"fixture-box-account"}:{}, imageGen: { enabled: false }, webSearch: { provider: "off" }, mcpServers: { approved: { url: "https://fixture.invalid/mcp", enabled: true } } },

      consumingHttpWriter,

      readBody: async () => route.path.endsWith("/mcp-servers") ? {fromBotId:"B",fromThreadId:threadId,...recipe.body} : recipe.body ?? {},
        imageSettings: async () => ({ fixtureModels: [] }),

        partitionRoster: rosterHandler,


      requestBotAccess: accessHandler, permissionStatus: permissionHandler,  proposeOutcomeFromAgent: outcomeHandler,

       listSkills: skillListHandler,   stageSkillWrite: skillStageHandler,

      parseConnectorRequests: connectorRequestParser,
        ASK_USER_REFUSED: "fixture question refusal", WIDGET_REFUSED: "fixture widget refusal",

      threadRecallRoute: recallHandler, memoryAccess: memoryAuthorization,

       manageBot: managementHandler,

    };
    if(authorizedRoutine)routineHandler=projectObservation!.spy("routineRequests.propose");
    if (revoked || !/\/(?:show-widget|update-widget)$/.test(route.path)) Reflect.deleteProperty(scope,"WIDGET_REFUSED");
    if (revoked) {
      await settleRevokedDispatch(dispatch, scope);
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
      expect(f.verdicts).toEqual([{ state: "withheld", reason: "deny-line" }]);
    } else {
      await dispatch(scope);
      expect(sink.output[0]?.status, `route=${inline.indexOf(route)} cell=${cell} frames=${sink.output.length}`).toBe(recipe.status);
      expect(sink.output.at(-1)?.body, route.path).toContain(recipe.contains);
      if (channelPerson || !authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/")) {
        // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: exact production audience denial, beyond the original reachability check.
        expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ error: recipe.contains });
      }
      expect(f.refusals).toBe(0);
    }
    restricted = dispatchWriters.get(scope) as typeof restricted;
    expect(restricted).not.toBe(sink.raw); expect(Object.getPrototypeOf(restricted)).toBe(null); expect(Object.isFrozen(restricted)).toBe(true);
    if(isProjectHandler&&projectObservation)handlerCalls=projectObservation.spy(`projectToolHandlers.${projectName}`).mock.calls.length;
    if (isProjectHandler) expect(handlerCalls, `${projectName} must reach its actual delegated effect after authorization`).toBe(1);
    if (authorizedBox) expect(boxFetch, `${route.method} ${route.path} must pass relay authorization and call its external port`).toHaveBeenCalledTimes(1);
    if (authorizedEmail) expect(emailHandler, `${route.path} must pass email authorization and reach the real tool handler`).toHaveBeenCalledTimes(1);
    if (authorizedProposal) expect(validateProposal).toHaveBeenCalledTimes(1);
    if (authorizedAccess) expect(accessHandler).toHaveBeenCalledTimes(1);
    if (authorizedPermission) expect(permissionHandler).toHaveBeenCalledTimes(1);
    if (authorizedOutcome) expect(outcomeHandler).toHaveBeenCalledTimes(1);
    if (authorizedRoutine) expect(routineHandler).toHaveBeenCalledTimes(1);
    if (authorizedManagement) expect(managementHandler).toHaveBeenCalledTimes(1);
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: retain the exact owner positive-delegate call arguments.
    if (authorizedConnectorRequest) expect(connectorRequestParser).toHaveBeenCalledExactlyOnceWith({ ...recipe.body, botId: "B", threadId: "T" });
    if (authorizedSkills && route.method === "GET") expect(skillListHandler).toHaveBeenCalledTimes(1);
    if (route.path === "/api/internal/agents") expect(rosterHandler).toHaveBeenCalledTimes(1);
    if (delegatedStage) expect(skillStageHandler).toHaveBeenCalledExactlyOnceWith("B", expect.objectContaining({ action: "create", source: "learn:conversation", threadId: "T" }));
    if (route.path.startsWith("/api/internal/memory/")) {
      expect(memoryAuthorization).toHaveReturnedTimes(1);
      expect(route.path.includes("/thread-") ? recallHandler : memoryHandler).toHaveBeenCalledTimes(1);
    }
    } catch (error) {
      // Numeric matrix coordinates identify the first failing producer without
      // copying any response, credential, request or assertion payload to logs.
      console.warn(`delegated-matrix failures=1 route=${inline.indexOf(route)} cell=${cell} authorized=${Number(authorizedDelegate)} staged=${Number(delegatedStage)} revoked=${Number(revoked)}`);
      throw error;
    } finally { closeChannelDatabase?.(); }
  }
});

// MAIN RULING 1114-SC-SAFETY-HSCOPE4: added assertions use a separate ID.
it("SC-SAFETY added assertions: T-ALL-RETURNS valid-capability concrete local and delegated producers", async () => {
  const dispatch = await internalDispatchFixture(true);
  const { CHANNEL_PERSON_INTERNAL_REFUSAL } = await import("./internal-route-authority.ts");
  const { MCP_REMOTE_OWNER_ONLY } = await import("./mcp-relay.ts");

  const { INTERNAL_HTTP_ROUTES, PROJECT_ROUTE_NAMES, EMAIL_ROUTE_NAMES } = await import("./consuming-sink-inventory.ts");
  const { requiredInternalKind, InternalCapabilities } = await import("./internal-capabilities.ts");

  const { threadRecallRoute } = await import("./thread-recall.ts");

  const { authorizeProjectTool, projectToolHandlers: realProjectHandlers } = await import("./project-tool-routing.ts");
  const { initializeProjectTables } = await import("./project-tables.ts");
  const { initializePendingDelegations } = await import("./pending-delegations-schema.ts");
  const { insertRoomRequest } = await import("./room-requests.ts");

  const { registerProjectMemoryTools } = await import("./project-memory-tools.ts");
  const { BOX_RELAY_ALLOWLIST } = await import("./box-relay.ts");
  const { EmailRuntime } = await import("./email/runtime.ts");
  const { VENUE_READ_UNAVAILABLE } = await import("./venue-read.ts");
  const { VENUE_POST_UNAVAILABLE } = await import("./venue-post.ts");
  const { SHARE_UNAVAILABLE } = await import("./room-shares.ts");
  const { manageBot, mayInspectBot } = await import("./bot-management.ts");
  const { partitionRoster } = await import("./shared-bots-roster.ts");
  // red-at-b530c7532: Array.map reads its callback even for an empty list.

  const memoryRoutes = await import("./memory/routes.ts");
  const memoryHandler = vi.spyOn(memoryRoutes, "memoryAgentRoute");
  fixtureCleanup.push(() => memoryHandler.mockRestore());
  const { memoryAccess, reconcileMemoryRoster } = await import("./memory/policy.ts");
  const { setMemoryMode } = await import("./memory/repository.ts");
  const { ensureDirs } = await import("./config.ts");
  const { listSkills, stageSkillWrite } = await import("./skills.ts");

  const { validateProjectProposal } = await import("./project-new.ts");
  const { parseConnectorRequests } = await import("./connector-requests.ts");

  const { requestBotAccess, mayReviewAccessStatus } = await import("./bot-access.ts");
  const { permissionStatus } = await import("./permission-status.ts");
  const { proposeOutcomeFromAgent } = await import("./memory/outcomes.ts");

  // Vitest's setup owns this installation; the bound retained ledger remains
  // a separate fresh SQLite fixture for each matrix cell.
  ensureDirs();
  const { configureBotEgress } = await import("./bot-egress.ts");

  const { HighLevelHost } = await import("./highlevel/host.ts");
  const botWriterScope = {

  };
  configureBotEgress(await indexCallbackFixture("configureBotEgress", {
    ...botWriterScope,
  }));
  fixtureCleanup.push(() => configureBotEgress(undefined));
  const roster = { bots: [{ id: "B", threadId: "T", name: "fixture" }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode("active");
  type Recipe = { status: number; contains: string; body?: Record<string, unknown> };
  const recipes: Record<string, Recipe> = {
    "POST register-artifact": { status: 404, contains: "no file workspace", body: { relativePath: "fixture.txt" } },
    "POST needs-owner-now": { status: 200, contains: "Noted." },
    "POST voice-note": { status: 429, contains: "voice notes per turn", body: { text: "fixture" } },
    "POST stop-line-allowance": { status: 403, contains: "Only the owner", body: { kind: "delete", place: "fixture" } },
    "GET image-models": { status: 200, contains: "fixtureModels" },
    "GET image-prompt-block": { status: 409, contains: "Image generation is off" },
    "GET image-prompt-blocks": { status: 409, contains: "Image generation is off" },
    "POST image-prompt-blocks": { status: 409, contains: "Image generation is off" },
    "GET image-reference-packs": { status: 409, contains: "Image generation is off" },
    "POST image-reference-packs": { status: 409, contains: "Image generation is off" },
    "POST publish-site": { status: 403, contains: "Publishing is only available" },
    "POST take-down-site": { status: 403, contains: "Publishing is only available", body: { siteId: "fixture" } },
    "POST generate-image": { status: 409, contains: "Choose an image connection", body: { requestId: "fixture" } },
    "POST web-read": { status: 400, contains: "page URL", body: { input: {} } },
    "POST web-search": { status: 409, contains: "Native web search is disabled" },
    // MAIN RULING: "keep only the wipe check, everything else is NO LIMITS".
    // BASE and HEAD return the disabled phone service's explicit off envelope, not a permission card.
    "POST device/call": { status: 200, contains: '"code":"off"' },
    "POST highlevel/mcp": { status: 200, contains: '"result":{}', body: { jsonrpc: "2.0", id: 1, method: "ping" } },
    "POST host-computer": { status: 403, contains: "computer turn is no longer authorized" },
    "POST unified-browser": { status: 403, contains: "browser turn is no longer authorized" },
    "POST headless-browser": { status: 405, contains: "method not allowed" },
    "GET headless-browser": { status: 403, contains: "no authorized headless browser session" },
    "DELETE headless-browser": { status: 200, contains: '"closed":true' },
    "POST tool-result": { status: 400, contains: "Expected bounded text" },
    "GET tool-result": { status: 400, contains: "Expected a saved result id" },
    "GET skills": { status: 403, contains: "skill authoring is not enabled" },
    "POST skills/stage": { status: 403, contains: "skill authoring is not enabled" },
    "GET agents": { status: 200, contains: '"bots":[]' },
    "GET routines": { status: 200, contains: '"routines":[]' },
    "POST outcome-proposals": { status: 200, contains: "learning is off" },
    "POST routine-requests": { status: 400, contains: "invalid routine proposal" },
    "POST access-request": { status: 404, contains: "Bot not found" },
    "POST permission-status": { status: 404, contains: "Bot not found" },
    "POST create-bot": { status: 403, contains: "Chief of Staff can create" },
    "POST request-browser-connection": { status: 403, contains: "owner conversation" },
    "POST mcp-servers": { status: 409, contains: "already being updated" },
    "POST ask-user": { status: 403, contains: "fixture question refusal" },
    "POST show-widget": { status: 403, contains: "fixture widget refusal" },
    "POST update-widget": { status: 403, contains: "fixture widget refusal" },
    "POST request-credential": { status: 400, contains: "credential" },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: a genuine channel person reaches the earlier route gate.
    "POST connectors/mcp": { status: 403, contains: CHANNEL_PERSON_INTERNAL_REFUSAL },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: a genuine channel person reaches the earlier route gate.
    "POST connectors/request": { status: 403, contains: CHANNEL_PERSON_INTERNAL_REFUSAL },
    "POST computer-activity": { status: 200, contains: '"silenceMs":1234' },
    "GET computer-control": { status: 200, contains: '"held":false' },
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS (1114-HOUR23-RULINGS D): the real ComputerControl producer returns B-1.
    "POST computer-control": { status: 200, contains: '"requestId":"B-1"' },
    "DELETE computer-control": { status: 200, contains: '"held":false' },
    "POST resolve-image-reference": { status: 400, contains: "invalid-request" },
    ...Object.fromEntries(["thread-search", "thread-read", "thread-list"].map(name => [`POST memory/${name}`, { status: 400, contains: "Thread request rejected", body: { unexpected: true } }])),
    ...Object.fromEntries(PROJECT_ROUTE_NAMES.map(name => [`POST project/${name}`, {
      status: name === "review-result" ? 409 : 400,
      contains: name === "review-result" ? '"ok":false' : "error",
      body: { cardId: "fixture-card", unexpected: true },
    }])),
    ...Object.fromEntries(EMAIL_ROUTE_NAMES.map(name => [`POST email/${name}`, { status: 403, contains: "Email is not available" }])),
    ...Object.fromEntries(BOX_RELAY_ALLOWLIST.map(route => [`${route.method} box/v1/boxes/box${route.tail}`, { status: 404, contains: "not found" }])),
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: non-owner delegated turn registered by the real producer.
    "POST mcp-remote/approved": { status: 403, contains: MCP_REMOTE_OWNER_ONLY },
    "POST project/propose": { status: 403, contains: "proposal turn has ended" },
    "POST venue/read-messages": { status: 403, contains: VENUE_READ_UNAVAILABLE },
    "POST venue/post": { status: 403, contains: VENUE_POST_UNAVAILABLE },
    "POST room-share/ask": { status: 403, contains: SHARE_UNAVAILABLE },
    "POST bot-management": { status: 400, contains: "Invalid bot-management request" },
    "POST ask-bot": { status: 400, contains: "error", body: { toBotId: "B" } },
    "POST delegate-bot": { status: 400, contains: "error", body: { toBotId: "B" } },
    "GET delegations/known": { status: 403, contains: "error" },
    ...Object.fromEntries(["search", "get", "save", "propose-correction"].map(name => [`POST memory/${name}`, { status: 400, contains: "INVALID_MEMORY_ARGUMENTS" }])),
  };
  const inline = [...INTERNAL_HTTP_ROUTES,
    ...PROJECT_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/project/${name}` })),
    ...EMAIL_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/email/${name}` })),
    ...BOX_RELAY_ALLOWLIST.map(route => ({ method: route.method, path: `/api/internal/box/v1/boxes/box${route.tail}` })),
    { method: "POST", path: "/api/internal/mcp-remote/approved" },
    { method: "GET", path: "/api/internal/delegations/known" },
  ];
  expect(inline.map(route => `${route.method} ${route.path.slice("/api/internal/".length)}`).sort()).toEqual(Object.keys(recipes).sort());
  let cell = 0;
  for (const route of inline) for (const authorizedDelegate of /^\/api\/internal\/(?:(?:box|email|mcp-remote|delegations)\/|skills(?:\/stage)?$|project\/propose$|connectors\/(?:request|mcp)$|access-request$|permission-status$|outcome-proposals$|routine-requests$|bot-management$)/.test(route.path) ? [false, true] : [false]) for (const delegatedStage of authorizedDelegate && route.path.endsWith("/skills/stage") ? [false, true] : [false]) for (const revoked of [false, true]) {
    cell++;
    let closeChannelDatabase: (() => void) | undefined;
    try {
    const authorizedBox = authorizedDelegate && route.path.startsWith("/api/internal/box/");
    const authorizedEmail = authorizedDelegate && route.path.startsWith("/api/internal/email/");
    const authorizedSkills = authorizedDelegate && route.path.startsWith("/api/internal/skills");
    const authorizedProposal = authorizedDelegate && route.path === "/api/internal/project/propose";
    const authorizedConnectorMcp = authorizedDelegate && route.path === "/api/internal/connectors/mcp";
    const authorizedConnectorRequest = authorizedDelegate && route.path === "/api/internal/connectors/request";
    const authorizedRemote = authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/");
    const authorizedAccess = authorizedDelegate && route.path.endsWith("/access-request");
    const authorizedPermission = authorizedDelegate && route.path.endsWith("/permission-status");
    const authorizedOutcome = authorizedDelegate && route.path.endsWith("/outcome-proposals");
    const authorizedRoutine = authorizedDelegate && route.path.endsWith("/routine-requests");
    const authorizedDelegation = authorizedDelegate && route.path.includes("/delegations/");
    const authorizedManagement = authorizedDelegate && route.path.endsWith("/bot-management");
    const recipe = delegatedStage ? { status: 422, contains: "SKILL.md has no YAML frontmatter", body: { action: "create", skill_md: "Fixture without frontmatter", source: "conversation" } }
      : authorizedEmail ? { status: 200, contains: "takes only", body: { unexpected: true } }
      : authorizedBox ? { status: 200, contains: "fixture upstream", body: { command: "fixture command" } }
      : authorizedSkills ? { status: route.method === "GET" ? 200 : 400, contains: route.method === "GET" ? '"skills":' : "action must be", body: {} }
      : authorizedProposal ? { status: 400, contains: "Check the proposal", body: {} }
      // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: owner control reaches the real delegate's request validation.
      : authorizedConnectorMcp ? { status: 200, contains: "An app action needs a request id", body: { jsonrpc: "2.0", method: "tools/call", params: { name: "FIXTURE_ACTION", arguments: {} } } }
      : authorizedConnectorRequest ? { status: 400, contains: "invalid resume key", body: {} }
      : authorizedRemote ? { status: 400, contains: "Send one JSON-RPC message", body: {} }
      : authorizedAccess ? { status: 409, contains: "Access changed", body: { targetBotId: "B", revision: 1, grants: [{ toolkit: "fixture", accountId: "fixture", tools: ["fixture"] }] } }
      : authorizedPermission ? { status: 200, contains: '"canApprove":false', body: { targetBotId: "B" } }
      : authorizedOutcome ? { status: 400, contains: "note", body: { note: "x".repeat(141) } }
      : authorizedRoutine ? { status: 400, contains: "routine.", body: { action: "create", routine: {} } }
      : authorizedDelegation ? { status: 200, contains: '"status":"queued"', body: {} }
      : authorizedManagement ? { status: 200, contains: '"revision"', body: { targetBotId: "B", action: "get" } }
      : recipes[`${route.method} ${route.path.slice("/api/internal/".length)}`]!;
    const channelPerson = !authorizedDelegate && route.path.startsWith("/api/internal/connectors/");
    const threadId = channelPerson ? "fixture-contact" : "T";
    const f = fixture(false, threadId), sink = consumingResponseRecorder();
    if (channelPerson) closeChannelDatabase = await bindMatrixChannelPerson(f);
    const capabilities = new InternalCapabilities(); capabilities.begin("B", threadId, f.turn.turnId, fixtureThreadHumanPrincipal(threadId,f.f.db));
    const token = capabilities.mint({ botId: "B", threadId, generation: f.turn.turnId, kind: requiredInternalKind(route.path), depth: 0, humanPrincipal: fixtureThreadHumanPrincipal(threadId,f.f.db), skillAuthoring: authorizedSkills, ...(/\/(?:publish-site|take-down-site)$/.test(route.path) ? { notOwnerAudience: true as const } : {}) });
    const claim = capabilities.resolve(`Bearer ${token}`)!;
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: preserve exact claim equality for the real audience thread.
    expect(claim).toMatchObject({ botId: "B", threadId, generation: f.turn.turnId });
    const bot = { id: "B", threadId, name: "fixture", tasks: [{ threadId, title: "Fixture", createdAt: 1, resumeCursors: {}, cwd: null }], chiefOfStaff: authorizedAccess, learning: { enabled: authorizedOutcome, askFirst: false, prospectLearning: false, revision: 0 }, modelSelection: { instanceId: "fixture", model: "fixture" } };
    const managementHandler = vi.fn(manageBot);
    const rosterHandler = vi.fn(partitionRoster);
    const skillStageHandler = vi.fn(stageSkillWrite);
    const skillListHandler = vi.fn(listSkills);
    const connectorRequestParser = vi.fn(parseConnectorRequests);
    const recallHandler = vi.fn(threadRecallRoute);
    memoryHandler.mockClear();
    const memoryAuthorization = vi.fn(memoryAccess);
    if (authorizedManagement) expect(mayInspectBot(bot as never, bot as never)).toBe(true);
    const accessHandler = vi.fn(requestBotAccess), permissionHandler = vi.fn(permissionStatus), outcomeHandler = vi.fn(proposeOutcomeFromAgent);
    let routineHandler:ReturnType<ReturnType<typeof fixtureObservers>["spy"]>|undefined;
    if (authorizedAccess || authorizedPermission) expect(mayReviewAccessStatus(bot as never, bot as never)).toBe(true);
    const proposals = new ChiefProposalTurns();
    const validateProposal = vi.fn((raw: unknown) => validateProjectProposal(raw, []));
    if (authorizedProposal) {
      void proposals.begin(threadId, "B", f.turn.turnId, "fixture", validateProposal);
      proposals.bind(threadId, f.turn.turnId, f.binding);
      fixtureCleanup.push(() => { proposals.end(threadId, f.turn.turnId); });
    } else if (route.path === "/api/internal/project/propose") {
      // Exercise the real ended-proposal branch, rather than bypassing its admission check.
      void proposals.begin(threadId, "B", f.turn.turnId, "fixture", validateProposal);
      proposals.end(threadId, f.turn.turnId);
      expect(proposals.ignores("T")).toBe(true);
    }
    initializePendingDelegations(f.f.db);
    // Seed a readable real queue item; the negative status control belongs to another conversation.
    const delegationSourceThread = route.path.includes("/delegations/") && !authorizedDelegation ? "fixture-other-thread" : threadId;
    f.f.db.prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,phase,item) VALUES('known',?,'B','busy',?)")
      .run(delegationSourceThread, JSON.stringify({ id: "known", fromBotId: "B", toBotId: "B", sourceThreadId: delegationSourceThread, attempts: 0, message: "Fixture handoff", depth: 0 }));
    const projectName = route.path.match(/^\/api\/internal\/project\/([^/]+)$/)?.[1];
    const isProjectHandler = !!projectName && PROJECT_ROUTE_NAMES.includes(projectName);
    const group = { id: "fixture-project", threadId, memberIds: ["B"], channelProject: {goal:"Fixture work",status:"active" as const,startedAt:1,updatedAt:1} };
    const requests = new Map<string, string>();
    let handlerCalls = 0;
    const projectObservation=isProjectHandler?fixtureObservers([`projectToolHandlers.${projectName}`]):authorizedRoutine?fixtureObservers(["routineRequests.propose"]):undefined;
    if (isProjectHandler) {
      initializeProjectTables(f.f.db);
      f.f.db.exec("INSERT INTO project_settings(group_id,lead_bot_id,updated_at) VALUES('fixture-project','B',1); INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('fixture-goal','fixture-project','Fixture','working',0,1,1)");
      const root = insertRoomRequest(f.f.db, { groupId: group.id, verb: "owner_send", fromKind: "owner", admissionKey: "root",
        lineage: { rootThreadId: threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, now: 1 }).request;
      const request = insertRoomRequest(f.f.db, { groupId: group.id, verb: projectName === "review-result" ? "review" : projectName === "card-update" ? "assign" : "room_turn",
        fromKind: "owner", toBotId: "B", targetThreadId:threadId, parentId: root.id, admissionKey: "handler", state: "running", now: Date.now(),
        ...(projectName === "review-result" || projectName === "card-update" ? { workItemId: "fixture-card", cardGeneration: 1 } : {}) }).request;
      f.f.db.prepare("INSERT INTO project_work_items(id,group_id,number,title,state,position,assignee_bot_id,generation,review_request_id,created_by,created_at,updated_at) VALUES('fixture-card','fixture-project',1,'Fixture','review',1,'B',1,?,'B',1,1)").run(request.id);
      requests.set(f.turn.turnId, request.id);
      registerProjectMemoryTools({ roster: () => ({ bots: [bot], groups: [group] }), note: () => { throw new Error("validation must not publish a note"); } });
      for (const name of ["card-update", "review-result"]) realProjectHandlers.set(name, await indexCallbackFixture(`projectToolHandlers.set:${name}`, {
          transaction: (work: (db: typeof f.f.db) => unknown) => work(f.f.db),
      }));
      expect([...realProjectHandlers.keys()].sort()).toEqual([...PROJECT_ROUTE_NAMES].sort());
      expect(authorizeProjectTool(f.f.db, { name: projectName!, botId: "B", request, body: recipe.body!, memberIds: ["B"], ownerAudience: true })).toMatchObject({ ok: true });
    }
    let restricted: object | undefined;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emailRoute = route.path.startsWith("/api/internal/email/");
    const emailHome = emailRoute ? mkdtempSync(join(tmpdir(), "murage-email-dispatch-")) : undefined;
    if (emailHome) fixtureCleanup.push(() => rmSync(emailHome, { recursive: true, force: true }));
    const emailRuntime = new EmailRuntime({ accountKey: () => emailRoute ? "fixture-account" : null,
      database: () => f.f.db, transaction: work => work(), workspaceRoot: () => undefined, bot: () => bot as unknown as import("./store.ts").BotRecord,
      ...(emailHome ? { capsFile: join(emailHome, "capabilities.json") } : {}),
      fetch: async () => Response.json({ enabled: true, available: true, data: [] }) });
    fixtureCleanup.push(() => emailRuntime.stop());
    let emailHandler: { mockRestore(): void } | undefined;
    if (emailRoute) {
      const { forgetEmailTurn } = await import("./email/email-turns.ts");
      // Persisted capability state is isolated as well as the mailbox tables.
      fixtureCleanup.push(() => forgetEmailTurn(f.turn.turnId));
      await emailRuntime.start(); emailRuntime.stop();
      const services = emailRuntime.services()!;
      expect(services).not.toBeNull();
      services.store.insertBinding({ botId: "B", inboxId: "fixture-inbox", address: "fixture@murage.email", username: "fixture", displayName: "Fixture", emailKeyRef: "fixture-key", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: 1 });
      emailRuntime.secrets.setBotKey("B", { token: "fixture-bot-token", keyId: "fixture-key" });
      // An unavailable turn has a configured mailbox but no generation-bound mount.
      // This reaches the real authorization refusal, rather than the feature-off protocol response.
      if (authorizedEmail) expect(emailRuntime.mount(f.turn.turnId, { driverKind: "claudeAgent", agentsMcp: true, surfacesForOwner: true, directOwnerAudience: true,
        origin: "desktop", automationThread: false, bot, threadId: "T" })).toMatchObject({ mounted: true, mode: "send" });
      emailHandler = realMethodObserver(services.tools, "handle");
    }
    const boxRoute = BOX_RELAY_ALLOWLIST.find(candidate => route.method === candidate.method && route.path === `/api/internal/box/v1/boxes/box${candidate.tail}`);
    const boxFetch = vi.fn(async () => new Response("fixture upstream", { headers: { "content-type": "text/plain" } }));
    const scope = {
      // These observations exercise lower-level role/attendance/card guards.
      // Authenticate the owner while keeping that explicit lower posture.
      ...(await internalDispatchAuthorityFixture(f, capabilities, {
        ...(route.path.endsWith("/computer-activity") ? { activityStallMs: 1234 } : {}),
        ...(channelPerson || !authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/") ? { roomOwnerOnly: false, initiator: { k: "delegation" as const } } : {}),
        box:boxRoute?{id:"box",...(authorizedBox?{fetch:boxFetch}:{})}:undefined,observers:projectObservation,requestId:requests.get(f.turn.turnId),store:await fixtureRoster([bot],isProjectHandler?[group]:[]),
        ...(authorizedConnectorRequest || route.path.startsWith("/api/internal/email/")
          || /\/(?:create-bot|request-browser-connection|ask-user|show-widget|update-widget|agents)$/.test(route.path)
          ? { revoke: revoked, settings: { autoApprove: true, fullAccess: true, noLimits: false }, unattended: /\/(?:request-browser-connection|ask-user|show-widget|update-widget)$/.test(route.path) } : {mcpConfigurationBusy:route.path.endsWith("/mcp-servers"),revoke: revoked, unattended: route.path.endsWith("/stop-line-allowance"), voiceQuotaExhausted: route.path.endsWith("/voice-note")}),
      })).scope,
      path: route.path, method: route.method, url: new URL(`${route.path}?${authorizedBox ? boxRoute!.queries[0] : `self=B&fromBotId=B&fromThreadId=${threadId}&botId=B`}`, "http://fixture.invalid"),
      req: Object.assign(new (await import("node:events")).EventEmitter(), { method: route.method, headers: { authorization: `Bearer ${token}` } }), res: sink.raw,
      internalCapabilities: capabilities,
      ...(emailRoute?{emailRuntime}:{}),
      highlevel: { host: new HighLevelHost({ capabilities, bot: () => bot,
        signals: { onEnd: () => () => {} } as any,
        get leases(): never { throw new Error("unexpected HighLevel lease use"); },
        get client(): never { throw new Error("unexpected HighLevel client use"); },
        get actions(): never { throw new Error("unexpected HighLevel action use"); },
      }) },
      chiefProposals: proposals,

      cfg: { features: { skillRecorder: authorizedSkills,cloudBoxComputers:authorizedBox },box:authorizedBox?{token:"fixture-box-account"}:{}, imageGen: { enabled: false }, webSearch: { provider: "off" }, mcpServers: { approved: { url: "https://fixture.invalid/mcp", enabled: true } } },

      consumingHttpWriter,

      readBody: async () => route.path.endsWith("/mcp-servers") ? {fromBotId:"B",fromThreadId:threadId,...recipe.body} : recipe.body ?? {},
        imageSettings: async () => ({ fixtureModels: [] }),

        partitionRoster: rosterHandler,


      requestBotAccess: accessHandler, permissionStatus: permissionHandler,  proposeOutcomeFromAgent: outcomeHandler,

       listSkills: skillListHandler,   stageSkillWrite: skillStageHandler,

      parseConnectorRequests: connectorRequestParser,
        ASK_USER_REFUSED: "fixture question refusal", WIDGET_REFUSED: "fixture widget refusal",

      threadRecallRoute: recallHandler, memoryAccess: memoryAuthorization,

       manageBot: managementHandler,

    };
    if(authorizedRoutine)routineHandler=projectObservation!.spy("routineRequests.propose");
    if (revoked || !/\/(?:show-widget|update-widget)$/.test(route.path)) Reflect.deleteProperty(scope,"WIDGET_REFUSED");
    if (revoked) {
      await settleRevokedDispatch(dispatch, scope);
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
      expect(f.verdicts).toEqual([{ state: "withheld", reason: "deny-line" }]);
    } else {
      await dispatch(scope);
      expect(sink.output[0]?.status, `route=${inline.indexOf(route)} cell=${cell} frames=${sink.output.length}`).toBe(recipe.status);
      expect(sink.output.at(-1)?.body, route.path).toContain(recipe.contains);
      if (channelPerson || !authorizedDelegate && route.path.startsWith("/api/internal/mcp-remote/")) {
        // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: exact production audience denial, beyond the original reachability check.
        expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ error: recipe.contains });
      }
      expect(f.refusals).toBe(0);
      if (route.path === "/api/internal/device/call") expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({
        ok: false, code: "off", text: "Phone tools are off. Turn them on in Settings → Feature previews → Phone tools.",
      });
    }
    restricted = dispatchWriters.get(scope) as typeof restricted;
    expect(restricted).not.toBe(sink.raw); expect(Object.getPrototypeOf(restricted)).toBe(null); expect(Object.isFrozen(restricted)).toBe(true);
    if(isProjectHandler&&projectObservation)handlerCalls=projectObservation.spy(`projectToolHandlers.${projectName}`).mock.calls.length;
    if (isProjectHandler) expect(handlerCalls, `${projectName} must reach its actual delegated effect after authorization`).toBe(1);
    if (authorizedBox) expect(boxFetch, `${route.method} ${route.path} must pass relay authorization and call its external port`).toHaveBeenCalledTimes(1);
    if (authorizedEmail) expect(emailHandler, `${route.path} must pass email authorization and reach the real tool handler`).toHaveBeenCalledTimes(1);
    else if (emailRoute) expect(emailHandler, `${route.path} without a turn mount must stop before the tool handler`).not.toHaveBeenCalled();
    if (authorizedProposal) expect(validateProposal).toHaveBeenCalledTimes(1);
    if (authorizedAccess) expect(accessHandler).toHaveBeenCalledTimes(1);
    if (authorizedPermission) expect(permissionHandler).toHaveBeenCalledTimes(1);
    if (authorizedOutcome) expect(outcomeHandler).toHaveBeenCalledTimes(1);
    if (authorizedRoutine) expect(routineHandler).toHaveBeenCalledTimes(1);
    if (authorizedManagement) expect(managementHandler).toHaveBeenCalledTimes(1);
    // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: retain the exact owner positive-delegate call arguments.
    if (authorizedConnectorRequest) expect(connectorRequestParser).toHaveBeenCalledExactlyOnceWith({ ...recipe.body, botId: "B", threadId: "T" });
    if (authorizedSkills && route.method === "GET") expect(skillListHandler).toHaveBeenCalledTimes(1);
    if (route.path === "/api/internal/agents") expect(rosterHandler).toHaveBeenCalledTimes(1);
    if (delegatedStage) expect(skillStageHandler).toHaveBeenCalledExactlyOnceWith("B", expect.objectContaining({ action: "create", source: "learn:conversation", threadId: "T" }));
    if (route.path.startsWith("/api/internal/memory/")) {
      expect(memoryAuthorization).toHaveReturnedTimes(1);
      expect(route.path.includes("/thread-") ? recallHandler : memoryHandler).toHaveBeenCalledTimes(1);
    }
    } catch (error) {
      // Numeric matrix coordinates identify the first failing producer without
      // copying any response, credential, request or assertion payload to logs.
      console.warn(`delegated-matrix failures=1 route=${inline.indexOf(route)} cell=${cell} authorized=${Number(authorizedDelegate)} staged=${Number(delegatedStage)} revoked=${Number(revoked)}`);
      throw error;
    } finally { closeChannelDatabase?.(); }
  }
});

// control: isolate the A3c installation fix from the multi-route matrix. This
// proves the missing-writer failure class, not the missing historical stack.
it("T-ALL-RETURNS bot-egress installation reaches retained refusal", async () => {
  const { configureBotEgress, botBody, sendBot } = await import("./bot-egress.ts");
  const { status } = await import("./murage-status.ts");
  const f = fixture(), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  const body = botBody({ text: status("withheld") });
  configureBotEgress(undefined);
  fixtureCleanup.push(() => configureBotEgress(undefined));
  expect(() => sendBot(writer, 200, body)).toThrow("the bot reply writer is not configured");
  expect(sink.output).toEqual([]);
  expect(f.refusals).toBe(0);
  const { Store } = await import("./store.ts");
  const { initializeMessageTables } = await import("./message-tables.ts");
  initializeMessageTables(f.f.db);
  // This callback observes a retained fixture, so constructing its Store must
  // not reconcile an empty installation over that retained memory roster.
  const callbackStore = new Store(undefined, undefined, true);
  callbackStore.bots = [{ id: "B", threadId: "T", name: "Fixture", title: "Fixture", description: "", notifications: false, color: "blue", unread: false, resumeCursors: {}, createdAt: 1, modelSelection: { instanceId: "fixture", model: "fixture" } }];
  callbackStore.groups = [];
  fixtureCleanup.push(() => callbackStore.stopSeqStamps());
  const scope = {
    store: callbackStore, database: () => f.f.db,

  };
  configureBotEgress(await indexCallbackFixture("configureBotEgress", {
    ...scope,
  }));
  sendBot(writer, 200, body);
  expect(sink.output).toEqual([{ status: 200 }, { status: 200, body: JSON.stringify(body) }]);
  const refused = consumingResponseRecorder();
  const refusedWriter = consumingHttpWriter(refused.raw, f.binding, httpDescriptors);
  f.flip();
  expect(() => sendBot(refusedWriter, 200, body)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(refused.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  expect(f.refusals).toBe(1);
});

// control: capability-denied response coverage across the registry. This does
// not establish success/validation/exception coverage of the route producers.
it("T-ALL-RETURNS capability denial across static and registered dynamic routes", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES, PROJECT_ROUTE_NAMES, EMAIL_ROUTE_NAMES } = await import("./consuming-sink-inventory.ts");
  // Registration is a prerequisite of this wrong-capability control, even
  // when a previous matrix aborts before its own registration step.
  const {registerProjectMemoryTools}=await import("./project-memory-tools.ts");
  registerProjectMemoryTools({roster:()=>({bots:[],groups:[]}),note:()=>{throw new Error("capability denial must not publish a project note");}});

  const routes = [...INTERNAL_HTTP_ROUTES,
    ...PROJECT_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/project/${name}` })),
    ...EMAIL_ROUTE_NAMES.map(name => ({ method: "POST", path: `/api/internal/email/${name}` })),
    { method: "POST", path: "/api/internal/mcp-remote/approved" },
    { method: "GET", path: "/api/internal/delegations/known" },
    ...[["GET", ""], ["GET", "/artifacts"], ["GET", "/files"], ["POST", "/resume"], ["POST", "/commands"]]
      .map(([method, tail]) => ({ method: method!, path: `/api/internal/box/v1/boxes/box${tail}` })),
  ];
  for (const route of routes) {
    const f = fixture();
    const {InternalCapabilities}=await import("./internal-capabilities.ts");
    const caps=new InternalCapabilities();caps.begin("B","T",f.turn.turnId,fixtureThreadHumanPrincipal("T",f.f.db));
    const token=caps.mintReleaseControl(f.binding,"fixture-engine");
    const setup=await internalDispatchAuthorityFixture(f,caps,{box:route.path.startsWith("/api/internal/box/")?{id:"box"}:undefined});
    if(/\/project\/(?:card-update|review-result)$/.test(route.path)) {
      const {projectToolHandlers}=await import("./project-tool-routing.ts");
      for(const name of ["card-update","review-result"])projectToolHandlers.set(name,await indexCallbackFixture(`projectToolHandlers.set:${name}`,{...setup.scope}));
    }
    if (route.path === "/api/internal/delegations/known") {
      f.f.db.prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,phase,item) VALUES(?,?,?,?,?)")
        .run("known", "T", "B", "fresh", "{}");
    }
    const scope = {
      ...(setup).scope,
      path: route.path, method: route.method, req: { headers: { authorization: `Bearer ${token}` } },

      internalCapabilities: caps, chiefProposals: new ChiefProposalTurns(),

      cfg: { mcpServers: { approved: {} } },

      consumingHttpWriter,

    };
    const first = consumingResponseRecorder();
    await dispatch({ ...scope, res: first.raw });
    expect(first.output[0]?.status, route.path).toBe(403);
    expect(first.output.at(-1)?.body).toContain("capability cannot access this service");
    f.flip();
    const second = consumingResponseRecorder();
    await expect(dispatch({ ...scope, res: second.raw })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(second.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    expect(f.refusals).toBe(1);
  }
});

// R1: headers do not accept body attribution. A later body invocation can have
// accepted bytes even if it throws, so retain that attribution conservatively.
it("A3-2 headers do not accept pending body attribution", () => {
  const f = fixture(), sink = consumingResponseRecorder(), before = f.turn.parents;
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors), commit = vi.fn();
  stageConsumingResponse(writer, [{ kind: "line", threadId: "T", messageId: "Y" }], commit);
  writer.flushHeaders();
  expect(commit).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
  sink.raw.end = () => { throw new Error("body destination"); };
  expect(() => writer.end("body")).toThrow("body destination");
  expect(f.turn.parents).toContainEqual({ kind: "line", threadId: "T", messageId: "Y" });
  expect(commit).toHaveBeenCalledTimes(1); expect(sink.destroyed).toBe(true);
  expect(f.refusals).toBe(0);
  expect(sink.output).toEqual([{ status: 200 }]);
});

// control: declaration is required even with an empty, valid retained ledger.
it("A3-7 explicit no-new-stored-content response delivers", () => {
  const f = fixture(true), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  stageConsumingResponse(writer, []); writer.end("ack");
  expect(sink.output.at(-1)?.body).toBe("ack"); expect(f.refusals).toBe(0);
});

// red-at-8d3290c81 A3-3: HTTP aggregation ran later attribution callbacks after
// an earlier callback replaced the bound generation, then released its body.
it("A3-3 stops an HTTP attribution callback chain on lost authorization", () => {
  const f = fixture(), sink = consumingResponseRecorder(), writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  const later = vi.fn();
  stageConsumingResponse(writer, [], () => f.replace());
  stageConsumingResponse(writer, [], later);
  expect(() => writer.end("result")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(later).not.toHaveBeenCalled();
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
});

// red-at-8d3290c81 A3-7: there was no enforced producer policy; a local helper
// could declare [] for a successful stored-content read on an existing route.
it("A3-7 stored-content success cannot use the local-only producer contract", () => {
  const f = fixture(), sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, f.binding, httpDescriptors);
  expect(() => declareNoStoredResponse(writer, 200)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
});

// control: execute the actual shared-owner wrapper across its awaited adapter
// hand-back, supplementing the separate symbol/identity structural assertions.
it("T-SHARED-OWNER-BINDING actual wrapper awaits acceptance with the same binding", async () => {
  const f = fixture(true);

  const observations=fixtureObservers(["sharedOwnerUsage.begin","sharedOwnerUsage.accepted","sharedOwnerUsage.end"]);
  const {realStore}=await import("./testing/index-ports.ts");
  const store=realStore();
  store.bots=[{id:"B",threadId:"T",name:"Fixture",title:"Fixture",description:"",notifications:false,color:"blue",unread:false,resumeCursors:{},createdAt:1,
    modelSelection:{instanceId:"fixture",model:"fixture"},tasks:[{threadId:"T",title:"Fixture",createdAt:1,resumeCursors:{},sharedWork:{teamId:"team",createdAt:1}}]}];
  const wrapper = await indexCallbackFixture("sharedOwnerUsageTurn", {
    store, fixtureObservers: observations, database:()=>f.f.db,
  });
  const accepted=observations.spy("sharedOwnerUsage.accepted"),begin=observations.spy("sharedOwnerUsage.begin"),end=observations.spy("sharedOwnerUsage.end");
  let deliver!: (value: { turnId: string }) => void;
  const turn = { threadId: "T", text: "owner input", model: "fixture" };
  const sendTurn = vi.fn((input: unknown) => { expect(input).toBe(turn); return new Promise(resolve => { deliver = resolve; }); });
  const pending = wrapper({ driverKind: "fixture", adapter: { sendTurn } }, turn,
    { botId: "B", generation: f.binding.identity.dispatchGeneration }, { retained: f.turn }, f.binding);
  expect(begin).toHaveBeenCalledOnce(); expect(sendTurn).toHaveBeenCalledOnce(); expect(accepted).not.toHaveBeenCalled();
  deliver({ turnId: "provider-turn" });
  await expect(pending).resolves.toEqual({ turnId: "provider-turn" });
  expect(accepted).toHaveBeenCalledExactlyOnceWith("T", f.binding.identity.dispatchGeneration, "provider-turn");
  expect(end).not.toHaveBeenCalled();
});

// control: real proposal registration, valid agents capability, actual dispatch,
// validation and successful submit, then a retained refusal and ended binding.
it("T-PROPOSAL-BINDING actual proposal dispatch lifecycle", async () => {
  const dispatch = await internalDispatchFixture(), f = fixture(true), proposals = new ChiefProposalTurns();
  const { PROJECT_PROPOSE_ROUTE } = await import("./project-proposal-engines.ts");

  const validated = { proposal: { marker: "validated proposal" } };
  const outcome = proposals.begin("T", "B", f.turn.turnId, "fixture", raw => {
    if (!(raw as { valid?: boolean }).valid) throw new Error("fixture validation");
    return validated as never;
  });
  proposals.bind("T", f.turn.turnId, f.binding);
  let input: unknown = {};
  const base = await validDispatchScope(f, PROJECT_PROPOSE_ROUTE, "POST");
  const scope = {
    ...base,
    path: PROJECT_PROPOSE_ROUTE,  method: "POST", chiefProposals: proposals,
       readBody: async () => input,
    cfg: { mcpServers: {} },
    consumingHttpWriter,

  };
  const invalid = consumingResponseRecorder(); await dispatch({ ...scope, res: invalid.raw });
  expect(invalid.output.at(-1)).toMatchObject({ status: 400, body: JSON.stringify({ error: "fixture validation" }) });
  input = { valid: true };
  const success = consumingResponseRecorder(); await dispatch({ ...scope, res: success.raw });
  expect(success.output.at(-1)?.status).toBe(200); expect(JSON.parse(success.output.at(-1)!.body!)).toHaveProperty("ok", true);
  await expect(outcome).resolves.toEqual(validated);
  addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "X" }]); f.flip();
  const refused = consumingResponseRecorder();
  await expect(dispatch({ ...scope, res: refused.raw })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(refused.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  proposals.end("T", f.turn.turnId); expect(proposals.bindingFor("T", f.turn.turnId)).toBeUndefined();
});

// red-at-8d3290c81 A3-3: checking AsyncFunction alone missed a synchronous
// callback returning a thenable; its work could escape the acceptance interval.
it("A3-3 rejects a non-async attribution callback returning a thenable", () => {
  const f = fixture(), before = f.turn.parents, write = vi.fn();
  const callback = vi.fn(() => ({ then() {} }));
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, { bytes: 1,
    refs: [{ kind: "line", threadId: "T", messageId: "Y" }], commitAttribution: callback, write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(callback).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled(); expect(f.turn.parents).toBe(before);
});

// Record calls while retaining the exact unbound production implementation.
// Vitest spyOn may install a forwarding implementation, which is not an
// identity-preserving authority observer.
function realMethodObserver<T extends object, K extends keyof T>(service: T, name: K) {
  const implementation = service[name];
  if (typeof implementation !== "function") throw new Error("Fixture observer requires a production method");
  const observer = vi.fn(implementation as (...args: any[]) => any);
  Object.defineProperty(service, name, { value: observer, writable: true, configurable: true });
  return observer;
}

async function validDispatchScope(f: ReturnType<typeof fixture>, path: string, method: string,
  authority: Parameters<typeof internalDispatchAuthorityFixture>[2] = {}) {
  const { requiredInternalKind, InternalCapabilities } = await import("./internal-capabilities.ts");

  const { threadHumanPrincipal } = await import("./human-principals.ts");
  const { internalRouteRefusal } = await import("./internal-route-authority.ts");
  const { ensureDirs } = await import("./config.ts");
  ensureDirs();
  const caps = new InternalCapabilities(); caps.begin("B", "T", f.turn.turnId, fixtureThreadHumanPrincipal("T",f.f.db));
  const token = caps.mint({ botId: "B", threadId: "T", generation: f.turn.turnId, kind: requiredInternalKind(path)!, depth: 0, humanPrincipal: fixtureThreadHumanPrincipal("T",f.f.db), skillAuthoring: false });
  const claim = caps.resolve(`Bearer ${token}`)!;
  expect(caps.isActive(claim)).toBe(true);
  expect(internalRouteRefusal({ path, kind: claim.kind, principal: threadHumanPrincipal("T") })).toBeNull();
  return {
    ...(await internalDispatchAuthorityFixture(f, caps, authority)).scope,
    path, method, url: new URL(path, "http://fixture"), req: Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${token}` } }),
    internalCapabilities: caps, chiefProposals: new ChiefProposalTurns(),

      cfg: {},
     database: () => f.f.db,


  };
}

// red-at-fc2aad5b4: the rebased inventory includes the native HighLevel host.
// Revoke inside the real host's authorized bot lookup, before its final return.
it("T-ALL-RETURNS inventory HighLevel delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { HighLevelHost } = await import("./highlevel/host.ts");
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/highlevel/mcp"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const base = await validDispatchScope(f, route.path, route.method);
    const bot = vi.fn(() => { if (revoked) f.flip(); return { id: "B" }; });
    const host = new HighLevelHost({ capabilities: base.internalCapabilities, bot,
      signals: { onEnd: () => () => {} } as any,
      get leases(): never { throw new Error("unexpected HighLevel lease use"); },
      get client(): never { throw new Error("unexpected HighLevel client use"); },
      get actions(): never { throw new Error("unexpected HighLevel action use"); },
    });
    const handle = realMethodObserver(host, "handle");
    const scope = { ...base, res: sink.raw, highlevel: { host },
      readBody: async () => ({ jsonrpc: "2.0", id: 1, method: "ping" }) };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      // Host refusal precedes HTTP serialization; no result has been released.
      expect(sink.output).toEqual([]);
    } else {
      await dispatch(scope);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    }

    expect(handle).toHaveBeenCalledOnce(); expect(bot).toHaveBeenCalledOnce();
    expect(f.refusals).toBe(revoked ? 1 : 0);
  }
});

// MAIN RULING 1114-SC-SAFETY-HSCOPE4: added assertions use a separate ID.
it("SC-SAFETY added assertions: T-ALL-RETURNS inventory HighLevel delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { HighLevelHost } = await import("./highlevel/host.ts");
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/highlevel/mcp"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const base = await validDispatchScope(f, route.path, route.method);
    const bot = vi.fn(() => { if (revoked) f.flip(); return { id: "B" }; });
    const host = new HighLevelHost({ capabilities: base.internalCapabilities, bot,
      signals: { onEnd: () => () => {} } as any,
      get leases(): never { throw new Error("unexpected HighLevel lease use"); },
      get client(): never { throw new Error("unexpected HighLevel client use"); },
      get actions(): never { throw new Error("unexpected HighLevel action use"); },
    });
    const handle = realMethodObserver(host, "handle");
    const scope = { ...base, res: sink.raw, highlevel: { host },
      readBody: async () => ({ jsonrpc: "2.0", id: 1, method: "ping" }) };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      // Host refusal precedes HTTP serialization; no result has been released.
      expect(sink.output).toEqual([]);
    } else {
      await dispatch(scope);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    }
    expect((dispatchBindings.get(scope)?.decisionAuthorities as Map<string, unknown>)?.get("T")).toMatchObject({ identity: { threadId: "T", generation: f.turn.turnId }, claim: expect.any(Object) });
    expect(handle).toHaveBeenCalledOnce(); expect(bot).toHaveBeenCalledOnce();
    expect(f.refusals).toBe(revoked ? 1 : 0);
  }
});

// red-at-4df086541 A3-8: exercise nonempty scheduler/webhook projections after
// sender authorization, using the real managers and the production callbacks.
it("T-ALL-RETURNS inventory routines delegate projects only the authorized sender", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { RoutineManager } = await import("./routines.ts");
  const { WebhookManager } = await import("./webhooks.ts");

  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTempDirSync } = await import("./testing/cleanup.ts");

  const projections = {   };
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.method === "GET" && route.path === "/api/internal/routines");
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder(), home = mkdtempSync(join(tmpdir(), "murage-routine-release-"));
    const startTurn = vi.fn(async () => {}), enqueue = vi.fn(() => ({ id: "unused" }));
    const routines = new RoutineManager({ file: join(home, "routines.json"), now: () => 1_000,
      botState: () => "ready", createTask: () => ({ threadId: "T" }), startTurn });
    const webhooks = new WebhookManager({ file: join(home, "webhooks.json"), now: () => 1_000, botState: () => "ready", enqueue });
    try {
      const owned = routines.create({ name: "Owned routine", prompt: "Owned instructions", botId: "B", target: "bot",
        runOn: "ember", enabled: false, durationMinutes: 15, schedule: { type: "interval", everyMinutes: 30, anchorAt: 1_000 } });
      routines.create({ name: "Other routine", prompt: "Other instructions", botId: "C", target: "bot",
        runOn: "ember", enabled: false, durationMinutes: 15, schedule: { type: "interval", everyMinutes: 30, anchorAt: 1_000 } });
      const hook = webhooks.create({ name: "Owned hook", prompt: "Owned webhook instructions", botId: "B", runOn: "ember" });
      webhooks.create({ name: "Other hook", prompt: "Other webhook instructions", botId: "C", runOn: "ember" });
      const agentRoutine = vi.fn(await indexCallbackFixture("agentRoutine", projections));
      const actualWebhook = await indexCallbackFixture("agentWebhook", projections);
      const agentWebhook = vi.fn(actualWebhook);
      const listRuns = realMethodObserver(routines, "latestRunsForOwner"), listRoutines = realMethodObserver(routines, "listRoutines"), listHooks = realMethodObserver(webhooks, "list");
      const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke}), res: sink.raw,
        url: new URL(`${route.path}?fromBotId=B&fromThreadId=T`, "http://fixture"), routines, webhooks,
        agentRoutine, agentWebhook,  };
      if (revoke) {
        await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      } else {
        await dispatch(scope);
        const result = JSON.parse(sink.output.at(-1)!.body!);
        expect(result.routines).toEqual([expect.objectContaining({ id: owned.id, name: "Owned routine", instructions: "Owned instructions", latestRun: null })]);
        expect(result.webhooks).toEqual([expect.objectContaining({ webhookId: hook.webhook.id, name: "Owned hook", instructions: "Owned webhook instructions" })]);
        expect(Object.keys(result.webhooks[0]).sort()).toEqual(["deliveryCount", "enabled", "eventTypes", "instructions", "instructionsTruncated", "lastReceivedAt", "name", "updatedAt", "webhookId"]);
      }

      expect(listRuns).toHaveBeenCalledOnce(); expect(listRoutines).toHaveBeenCalledOnce(); expect(listHooks).toHaveBeenCalledOnce();
      expect(agentRoutine).toHaveBeenCalledOnce(); expect(agentWebhook).toHaveBeenCalledOnce();
      expect(startTurn).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
    } finally { routines.stop(); removeTempDirSync(home); }
  }
});

// MAIN RULING 1114-SC-SAFETY-HSCOPE4: added assertions use a separate ID.
it("SC-SAFETY added assertions: T-ALL-RETURNS inventory routines delegate projects only the authorized sender", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { RoutineManager } = await import("./routines.ts");
  const { WebhookManager } = await import("./webhooks.ts");

  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTempDirSync } = await import("./testing/cleanup.ts");

  const projections = {   };
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.method === "GET" && route.path === "/api/internal/routines");
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder(), home = mkdtempSync(join(tmpdir(), "murage-routine-release-"));
    const startTurn = vi.fn(async () => {}), enqueue = vi.fn(() => ({ id: "unused" }));
    const routines = new RoutineManager({ file: join(home, "routines.json"), now: () => 1_000,
      botState: () => "ready", createTask: () => ({ threadId: "T" }), startTurn });
    const webhooks = new WebhookManager({ file: join(home, "webhooks.json"), now: () => 1_000, botState: () => "ready", enqueue });
    try {
      const owned = routines.create({ name: "Owned routine", prompt: "Owned instructions", botId: "B", target: "bot",
        runOn: "ember", enabled: false, durationMinutes: 15, schedule: { type: "interval", everyMinutes: 30, anchorAt: 1_000 } });
      routines.create({ name: "Other routine", prompt: "Other instructions", botId: "C", target: "bot",
        runOn: "ember", enabled: false, durationMinutes: 15, schedule: { type: "interval", everyMinutes: 30, anchorAt: 1_000 } });
      const hook = webhooks.create({ name: "Owned hook", prompt: "Owned webhook instructions", botId: "B", runOn: "ember" });
      webhooks.create({ name: "Other hook", prompt: "Other webhook instructions", botId: "C", runOn: "ember" });
      const agentRoutine = vi.fn(await indexCallbackFixture("agentRoutine", projections));
      const actualWebhook = await indexCallbackFixture("agentWebhook", projections);
      const agentWebhook = vi.fn(actualWebhook);
      const listRuns = realMethodObserver(routines, "latestRunsForOwner"), listRoutines = realMethodObserver(routines, "listRoutines"), listHooks = realMethodObserver(webhooks, "list");
      const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke}), res: sink.raw,
        url: new URL(`${route.path}?fromBotId=B&fromThreadId=T`, "http://fixture"), routines, webhooks,
        agentRoutine, agentWebhook,  };
      if (revoke) {
        await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      } else {
        await dispatch(scope);
        const result = JSON.parse(sink.output.at(-1)!.body!);
        expect(result.routines).toEqual([expect.objectContaining({ id: owned.id, name: "Owned routine", instructions: "Owned instructions", latestRun: null })]);
        expect(result.webhooks).toEqual([expect.objectContaining({ webhookId: hook.webhook.id, name: "Owned hook", instructions: "Owned webhook instructions" })]);
        expect(Object.keys(result.webhooks[0]).sort()).toEqual(["deliveryCount", "enabled", "eventTypes", "instructions", "instructionsTruncated", "lastReceivedAt", "name", "updatedAt", "webhookId"]);
      }
      expect((dispatchBindings.get(scope)?.decisionAuthorities as Map<string, unknown>)?.get("T")).toMatchObject({ identity: { threadId: "T", generation: f.turn.turnId }, claim: expect.any(Object) });
      expect(listRuns).toHaveBeenCalledOnce(); expect(listRoutines).toHaveBeenCalledOnce(); expect(listHooks).toHaveBeenCalledOnce();
      expect(agentRoutine).toHaveBeenCalledOnce(); expect(agentWebhook).toHaveBeenCalledOnce();
      expect(startTurn).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
    } finally { routines.stop(); removeTempDirSync(home); }
  }
});

// red-at-4df086541 A3-8: workspace, owner-origin and browser-owner admission
// precede the real delegated producers, including their validation responses.
it("T-ALL-RETURNS inventory artifact, allowance and browser-setup delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture(true);
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { registerArtifact } = await import("./artifacts.ts");
  const { chatAllowance } = await import("./stop-line-state.ts");
    const { isOwnerOrigin } = await import("./store.ts");

  const { join } = await import("node:path");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/(register-artifact|stop-line-allowance|request-browser-connection)$/.test(route.path));
  expect(routes).toHaveLength(3);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const home = mkdtempSync(join(tmpdir(), "murage-delegated-owner-"));
    fixtureCleanup.push(() => rmSync(home, { recursive: true, force: true }));

    const ownerLine = { id: "owner-line", role: "user", kind: "text", text: "Connect a browser", origin: "desktop" } as const;
    expect(isOwnerOrigin(ownerLine.origin as never)).toBe(true);

    const bot={id:"B",threadId:"T",name:"Fixture",tasks:[{threadId:"T",title:"Fixture",createdAt:1,resumeCursors:{},cwd:home}]};
    const store=await fixtureRoster([bot]);
    const observations=fixtureObservers(["store.appendMessage","browserSetup.request"]);
    const ids=vi.spyOn(await import("./contracts.ts"),"newId").mockReturnValue("setup-card" as ReturnType<typeof import("./contracts.ts").newId>);
    fixtureCleanup.push(()=>ids.mockRestore());
    const artifact = vi.fn(registerArtifact), allowance = vi.fn(chatAllowance);
    const browser = route.path.endsWith("request-browser-connection"), file = route.path.endsWith("register-artifact");
    const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke: revoked,store,observers:observations,
      messages:[{threadId:"T",message:ownerLine,id:ownerLine.id}]}), res: sink.raw,  store,
      readBody: async () => browser ? { reason: "Fixture task" } : file ? { relativePath: "../outside.txt" } : { kind: "delete", place: "relative-folder" },
       registerArtifact: artifact,
        chatAllowance: allowance,
      consumingHttpWriter,

    };
    if (revoked) await settleRevokedDispatch(dispatch, scope);
    else await dispatch(scope);
    ids.mockRestore();
    const request=browser?observations.spy("browserSetup.request"):undefined,append=observations.spy("store.appendMessage");
    expect(browser ? request : file ? artifact : allowance).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(browser ? 1 : 0);
    if (revoked) {
      expect(f.verdicts).toEqual([{ state: "withheld", reason: "deny-line" }]);
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      expect(sink.output[0]?.status).toBe(browser ? 201 : 400);
      expect(sink.output.at(-1)?.body).toContain(browser ? '"messageId":"setup-card"' : file ? "Use a relative file path inside this task's workspace." : "Give the folder as a full path or starting with ~/.");
      expect(f.refusals).toBe(0);
    }
  }
});

// red-at-4df086541 A3-8: a valid owner-notice fact reaches the real rule
// matcher; its acknowledgement is still a consuming response.
it("T-ALL-RETURNS inventory owner-notice delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");

  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/needs-owner-now"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const observations=fixtureObservers(["botCalls.fact","botCalls.warn"]);
    const base = await validDispatchScope(f, route.path, route.method, {revoke: revoked, observers: observations});
    const fact=observations.spy("botCalls.fact"),warn=observations.spy("botCalls.warn");
    const scope = { ...base, res: sink.raw,
      readBody: async () => ({ line: "Fixture owner notice" }),

      consumingHttpWriter,
    };
    if (revoked) await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    else await dispatch(scope);
    expect(fact).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "needs_owner_now", botId: "B", threadId: "T", runId: `turn:${f.turn.turnId}`, line: "Fixture owner notice" }));
    expect(fact.mock.results[0]?.value).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(sink.output).toEqual(revoked ? [{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }] : [{ status: 200 }, { status: 200, body: '{"text":"Noted."}' }]);
    expect(f.refusals).toBe(revoked ? 1 : 0);
  }
});

// red-at-4df086541 A3-8: the actual event admission, team gate and Store birth
// run after chief authorization; the resulting response cannot escape a revoke.
it("T-ALL-RETURNS inventory bot-creation delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { Store, isWorkspaceChief } = await import("./store.ts");

  const { ensureDirs } = await import("./config.ts");
  ensureDirs();

  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/create-bot"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const actual = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    fixtureCleanup.push(() => actual.stopSeqStamps());
    const lead = actual.createBot({ name: `Lead ${f.turn.turnId}`, section: f.turn.turnId }, { seedMessages: false });
    const chief = { ...lead, id: "B", threadId: "T", chiefOfStaff: true, chiefScope: undefined, autoApprove: false };
    expect(isWorkspaceChief(chief as never)).toBe(false);
    actual.bots=[chief,...actual.bots.filter(bot=>bot.id!==lead.id)];
    const store=actual,observations=fixtureObservers(["store.createBot"]);
    const scope = { ...await validDispatchScope(f, route.path, route.method,
      { revoke: revoked, store, observers: observations, settings: { autoApprove: false, fullAccess: false, noLimits: false, section: chief.section, chiefOfStaff: true, chiefScope: undefined },
        ownerBotApproval: { tool: "create_bot", input: { name: `Operator ${f.turn.turnId}`, role: "Fixture", instructions: "Fixture work" } } }), res: sink.raw, store,
      readBody: async () => ({ name: `Operator ${f.turn.turnId}`, role: "Fixture", instructions: "Fixture work" }),

      consumingHttpWriter,
    };
    const ownerAnswer=scope.dispatchAuthoritySetup.approveOwnerWrite();
    // Observe rejection immediately; the explicit owner operation is awaited below.
    void ownerAnswer.catch(() => {});
    if (revoked) await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    else await dispatch(scope);
    await ownerAnswer;
    const create=observations.spy("store.createBot");
    expect(create).toHaveBeenCalledTimes(1);
    const made = create.mock.results[0]!.value;
    expect(actual.bot(made.id)).toMatchObject({ name: `Operator ${f.turn.turnId}`, composio: false, autoApprove: false, approvePeerComms: false, computer: "off", createdByBotId: "B" });
    if (revoked) expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    else {
      expect(sink.output[0]?.status).toBe(201);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toMatchObject({ id: made.id, model: "fixture", lead: false, auto: false, engineChanges: [] });
    }
    expect(f.refusals).toBe(revoked ? 1 : 0);
  }
});

// red-at-4df086541 A3-8: the real operation invokes the real image service
// after feature/audience admission; provider configuration failure is fenced.
it("T-ALL-RETURNS inventory image-generation delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture(true);
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { ImageOperations } = await import("./image-operations.ts");
  const { ImageGenerationService } = await import("./image-generation.ts");

  const { ensureDirs } = await import("./config.ts");

  ensureDirs();
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/generate-image"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const store = { bot: () => ({ id: "B", name: "Fixture", threadId: "T" }) };
    const imageOperations = new ImageOperations({ store: store as unknown as import("./store.ts").Store, waiting: () => {} });
    const fetcher = vi.fn(() => { throw new Error("configuration failure must precede provider fetch"); });
    const imageService = new ImageGenerationService({ resolveConnection: () => null, connectionIds: () => [], fetch: fetcher, log: () => {} });
    const execute = realMethodObserver(imageOperations, "execute"), generate = realMethodObserver(imageService, "generate");
    const base = await validDispatchScope(f, route.path, route.method, {revoke: revoked});
    const scope = { ...base, res: sink.raw,   cfg: { imageGen: { enabled: true } },
      internalCapabilities: base.internalCapabilities,
      readBody: async () => ({ requestId: "fixture", prompt: "fixture image", model: "fixture-model" }),

      imageSettings: async () => ({ selected: { connectionId: "fixture" } }), imageOperations, imageService,

      consumingHttpWriter,
    };
    if (revoked) await settleRevokedDispatch(dispatch, scope);
    else await dispatch(scope);
    expect(execute).toHaveBeenCalledOnce(); expect(generate).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
    if (revoked) {
      expect(f.verdicts).toEqual([{ state: "withheld", reason: "deny-line" }]);
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      expect(sink.output.at(-1)).toEqual({ status: 500, body: JSON.stringify({ error: "Choose a configured image connection in Settings." }) });
      expect(f.refusals).toBe(0);
    }
  }
});

// red-at-4df086541 A3-8: enabled image libraries reach their concrete SQL
// producers and validators, including the awaited attachment reader.
it("T-ALL-RETURNS inventory image-library delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture(true);
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const library = await import("./image-library.ts");

  const { imageLibraryOwnerAudience } = await import("./image-library-audience.ts");

  const { imageReferences } = await import("./image-operations.ts");
  const { ensureDirs } = await import("./config.ts");
  const { saveImage } = await import("./attachments.ts");
  const { basename } = await import("node:path");

  ensureDirs();
  expect(imageLibraryOwnerAudience({ threadId: "T" })).toBe(true);
  const picture = saveImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S9sAAAAASUVORK5CYII=", "base64"), "image/png");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/image-(prompt-blocks?|reference-packs)$/.test(route.path));
  expect(routes).toHaveLength(5);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    if (route.path.endsWith("/image-prompt-block")) library.savePromptBlock(f.f.db, { scope: "workspace", name: "fixture", text: "fixture image guidance", createdBy: "owner" });
    const calls = {
      listPromptBlocksForBot: vi.fn(library.listPromptBlocksForBot), getPromptBlock: vi.fn(library.getPromptBlock),
      savePromptBlock: vi.fn(library.savePromptBlock), listReferencePacksForBot: vi.fn(library.listReferencePacksForBot),
      saveReferencePack: vi.fn(library.saveReferencePack), imageReferences: vi.fn(imageReferences),
    };

    const store=await fixtureRoster([{id:"B",threadId:"T"}]);
    const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke: revoked,store,
      messages:[{threadId:"T",id:"fixture-picture",message:{role:"user",kind:"text",attachments:[{kind:"image",path:picture.path,mime:picture.mime}],origin:"desktop"}}]}), ...calls, res: sink.raw,
      url: new URL(`${route.path}?name=fixture`, "http://fixture"), cfg: { imageGen: { enabled: true } },


      readBody: async () => ({ name: "INVALID NAME", ...(route.path.endsWith("reference-packs") ? { referenceIds: [basename(picture.path)] } : { text: "fixture" }) }),

      consumingHttpWriter,
    };
    if (revoked) await settleRevokedDispatch(dispatch, scope);
    else await dispatch(scope);
    const producer = route.path.endsWith("/image-prompt-block") ? calls.getPromptBlock
      : route.path.endsWith("/image-prompt-blocks") ? route.method === "GET" ? calls.listPromptBlocksForBot : calls.savePromptBlock
      : route.method === "GET" ? calls.listReferencePacksForBot : calls.saveReferencePack;
    expect(producer).toHaveBeenCalledOnce();
    if (route.method === "POST" && route.path.endsWith("reference-packs")) expect(calls.imageReferences).toHaveBeenCalledOnce();
    if (revoked) {
      expect(f.verdicts).toEqual([{ state: "withheld", reason: "deny-line" }]);
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      expect(sink.output.at(-1)?.status).toBe(route.method === "POST" ? 400 : 200);
      if (route.method === "POST") expect(JSON.parse(sink.output.at(-1)!.body!).error).toBe("A name is 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit.");
      else if (route.path.endsWith("reference-packs")) expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ packs: [] });
      else if (route.path.endsWith("prompt-blocks")) expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ blocks: [] });
      else expect(sink.output.at(-1)!.body).toContain("fixture image guidance");
      expect(f.refusals).toBe(0);
    }
  }
});

// red-at-4df086541 A3-8: admission succeeds before the real voice producer
// rejects whitespace; its business error cannot bypass the final fence.
it("T-ALL-RETURNS inventory voice delegate after admission", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const voice = await import("./voice/voice-notes.ts");

  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/voice-note"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder(), producer = vi.fn(voice.createVoiceNote);
    const base = await validDispatchScope(f, route.path, route.method, {revoke: revoked});
    const scope = { ...base, res: sink.raw,
      internalCapabilities: base.internalCapabilities,
      readBody: async () => ({ text: "   " }),
       createVoiceNote: producer,
      consumingHttpWriter,
    };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      await dispatch(scope);
      expect(sink.output.at(-1)).toEqual({ status: 400, body: JSON.stringify({ error: "A voice note needs something to say." }) });
      expect(f.refusals).toBe(0);
    }
    expect(producer).toHaveBeenCalledOnce();
  }
});

// red-at-4df086541 A3-8: publishing's real operations run after the owner
// audience check. Their business refusals must use the same restricted writer.
it("T-ALL-RETURNS inventory publishing delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { PublishOperations } = await import("./publish/publish-ops.ts");

  const { imageLibraryOwnerAudience } = await import("./image-library-audience.ts");

  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/(publish-site|take-down-site)$/.test(route.path));
  expect(routes).toHaveLength(2);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const bot = { id: "B", threadId: "T", name: "Fixture", publishedSites: [] };
    const store = { bot: () => bot };
    const remote = vi.fn(() => { throw new Error("validation must not publish"); });
    const publishOperations = new PublishOperations({ store: store as unknown as import("./store.ts").Store,
      token: () => "fixture", workspaceFor: () => undefined, waiting: () => {}, fetchImpl: remote });
    const takeDown = route.path.endsWith("/take-down-site");
    const producer = realMethodObserver(publishOperations, takeDown ? "takeDown" : "publish");
    const base = await validDispatchScope(f, route.path, route.method, {revoke: revoked});
    expect(imageLibraryOwnerAudience({ threadId: "T" })).toBe(true);
    const scope = { ...base, res: sink.raw,    publishOperations,
      internalCapabilities: base.internalCapabilities,
       readBody: async () => takeDown ? { siteId: "invalid/id" } : {},
      consumingHttpWriter,
    };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      await dispatch(scope);
      expect(sink.output.at(-1)?.status).toBe(409);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toMatchObject({ code: takeDown ? "bad-id" : "no-folder" });
      expect(f.refusals).toBe(0);
    }
    expect(producer).toHaveBeenCalledOnce(); expect(remote).not.toHaveBeenCalled();
  }
});

// red-at-4df086541 A3-8: owner-facing delegates are reached after audience
// authorization; their actual validators produce the response being fenced.
it("T-ALL-RETURNS inventory question widget and MCP delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { fromAskUser } = await import("./question-normalize.ts");
  const { showWidget, updateWidget } = await import("./chat-widgets.ts");
  const { addBotMcpServer } = await import("./mcp-bot-add.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/(ask-user|show-widget|update-widget|mcp-servers)$/.test(route.path));
  expect(routes).toHaveLength(4);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const question = vi.fn(fromAskUser), show = vi.fn(showWidget), update = vi.fn(updateWidget), add = vi.fn(addBotMcpServer);

    const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke: revoked}), res: sink.raw,
       readBody: async () => ({}),

      fromAskUser: question, showWidget: show, updateWidget: update, addBotMcpServer: add,

      consumingHttpWriter,
    };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      await dispatch(scope);
      expect(sink.output.at(-1)?.status).toBe(400);
      expect(JSON.parse(sink.output.at(-1)!.body!).error).toBeTypeOf("string");
      expect(f.refusals).toBe(0);
    }
    const called = route.path.endsWith("/ask-user") ? question : route.path.endsWith("/show-widget") ? show : route.path.endsWith("/update-widget") ? update : add;
    expect(called).toHaveBeenCalledOnce();
  }
});

// red-at-4df086541 A3-8: the registered remote destination reaches its real
// guarded HTTP relay after both recorded-turn and bot authorization.
it("T-ALL-RETURNS registered remote-MCP delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { registeredInternalRoute } = await import("./consuming-sink-inventory.ts");
  const { startFakeRemoteMcp } = await import("./testing/fake-remote-mcp.ts");
  const { RemoteSseSessions } = await import("./remote-mcp-sse-sessions.ts");
  const { relayMcpCall, relayAudienceRefusal } = await import("./mcp-relay.ts");

  const path = "/api/internal/mcp-remote/approved";
  expect(registeredInternalRoute("POST", path, { project: () => false, email: () => false, mcp: name => name === "approved", delegation: () => false, box: () => false })).toBe(true);
  const peer = await startFakeRemoteMcp({ auth: "none" });
  const remoteSseSessions = new RemoteSseSessions();
  try {
    for (const revoked of [false, true]) {
      const f = fixture(), sink = consumingResponseRecorder(), relay = vi.fn(relayMcpCall);
      const base = await validDispatchScope(f, path, "POST", {revoke: revoked});
      const owner = { generation: f.turn.turnId, ownerAudience: true };
      expect(relayAudienceRefusal({ threadId: "T" }, owner, () => true)).toBeNull();
      const before = peer.requests.length;
      const scope = { ...base, res: sink.raw,
        cfg: { mcpServers: { approved: { url: peer.mcpUrl, auth: "none", headers: {}, enabled: true, local: "this-computer" } } },

           relayMcpCall: relay,
        readBody: async () => ({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        consumingHttpWriter,
      };
      if (revoked) await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      else await dispatch(scope);
      expect(relay).toHaveBeenCalledOnce();
      expect(peer.requests.slice(before)).toHaveLength(1);
      if (revoked) expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      else {
        expect(sink.output[0]?.status).toBe(200);
        expect(JSON.parse(sink.output.at(-1)!.body!)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } });
      }
      expect(f.refusals).toBe(revoked ? 1 : 0);
    }
  } finally { remoteSseSessions.closeAll(); await peer.close(); }
});

// red-at-4df086541 A3-8: credential requests pass sender/thread ownership and
// invoke the real declared-target producer before their response is fenced.
it("T-ALL-RETURNS inventory credential delegate after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { CREDENTIAL_TARGETS, credentialIsConfigured } = await import("../shared/credential-request.ts");

  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path.endsWith("/request-credential"));
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const configured of [false, true]) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const bot = { id: "B", threadId: "T", name: "Fixture" };
    const observations=fixtureObservers(["store.appendMessage"]);
    // Message identity is entropy I/O; the real Store append and query run unchanged.
    const ids=vi.spyOn(await import("./contracts.ts"),"newId").mockReturnValue("credential-card" as ReturnType<typeof import("./contracts.ts").newId>);
    fixtureCleanup.push(()=>ids.mockRestore());
    const configuredProducer = vi.fn(credentialIsConfigured);
    const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke: revoked, settings:bot, observers:observations}), res: sink.raw,
      cfg: { xai: { key: configured ? "fixture-configured-key" : "" } },
      readBody: async () => ({ credentialId: "xaiApiKey", reason: "Fixture credential" }),
       credentialIsConfigured: configuredProducer,
      consumingHttpWriter,
    };
    if (revoked) await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    else await dispatch(scope);
    ids.mockRestore();
    const append=observations.spy("store.appendMessage");
    expect(configuredProducer).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(configured ? 0 : 1);
    if (!configured) expect(append.mock.calls[0]?.[1]).toMatchObject({ kind: "secret", secret: { target: "xaiApiKey", label: CREDENTIAL_TARGETS.xaiApiKey.label } });
    if (revoked) expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    else {
      expect(sink.output[0]?.status).toBe(configured ? 200 : 201);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toMatchObject(configured ? { alreadyConfigured: true, label: CREDENTIAL_TARGETS.xaiApiKey.label } : { messageId: "credential-card", label: CREDENTIAL_TARGETS.xaiApiKey.label });
    }
    expect(f.refusals).toBe(revoked ? 1 : 0);
  }
});

// red-at-4df086541 A3-8: actual saved-result producers, both writes and reads,
// are reached with the bound owner; the read imports its real prefix provenance.
it("T-ALL-RETURNS inventory saved-result delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { ToolResults } = await import("./tool-results.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/tool-result");
  expect(routes.map(route => route.method).sort()).toEqual(["GET", "POST"]);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder(), toolResults = new ToolResults();
    const saved = toolResults.save({ botId: "B", threadId: "T" }, "fixture saved output");
    const producer = realMethodObserver(toolResults, route.method === "GET" ? "read" : "save");
    const scope = { ...await validDispatchScope(f, route.path, route.method, {revoke: revoked}), res: sink.raw,
      url: new URL(`${route.path}?id=${saved.id}`, "http://fixture"), toolResults,
      readBody: async () => ({ text: "fixture saved output" }),
      consumingHttpWriter,
    };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      expect(f.refusals).toBe(1);
    } else {
      await dispatch(scope);
      expect(sink.output.at(-1)?.status).toBe(route.method === "GET" ? 200 : 201);
      expect(JSON.parse(sink.output.at(-1)!.body!).id).toMatch(/^r-[0-9a-f-]{36}$/);
      if (route.method === "GET") expect(JSON.parse(sink.output.at(-1)!.body!).text).toBe("fixture saved output");
      expect(f.refusals).toBe(0);
    }
    expect(producer).toHaveBeenCalledOnce();
  }
});

// red-at-4df086541 A3-8: both handoff delegates pass the real peer and
// source-thread checks before producing an already-queued business response.
it("T-ALL-RETURNS inventory handoff delegates after peer authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const handoff = await import("./handoff-boundary.ts");
  const { askBotRoute } = handoff;
  const delegateObserver = vi.fn(handoff.delegateBotRoute);
  const { executionStore, setExecutionStore, authorizeWork } = await import("./execution-audience.ts");
  const { configureBotEgress } = await import("./bot-egress.ts");

  const { ensureDirs } = await import("./config.ts");
  ensureDirs();
  const previous = executionStore();
  const bots = [{ id: "B", threadId: "T", name: "Sender", tasks: [], messageAllow: { mode: "all" as const } },
    { id: "C", threadId: "U", name: "Recipient", tasks: [], busy: true }];
  const store = executionStoreFixture({ bots: bots.map(bot => ({ ...bot, title: "", description: "", notifications: true, color: "blue", unread: false, resumeCursors: {}, createdAt: 0, modelSelection: { instanceId: "fixture", model: "fixture" }, tasks: [{ threadId: bot.threadId, title: bot.name, createdAt: 0, resumeCursors: {} }] })), groups: [] });
  setExecutionStore(store);
  const writerScope = {

  };
  configureBotEgress(await indexCallbackFixture("configureBotEgress", { ...writerScope }));
  try {
    expect(authorizeWork({ edge: "peer", requesterBotId: "B", requesterThreadId: "T", targetBotId: "C", verb: "ask", tag: null, ownerAudience: true })).toMatchObject({ ok: true });
    const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/(ask-bot|delegate-bot)$/.test(route.path));
    expect(routes.map(route => route.path).sort()).toEqual(["/api/internal/ask-bot", "/api/internal/delegate-bot"]);
    for (const route of routes) for (const revoked of [false, true]) {
      const f = fixture(), sink = consumingResponseRecorder();
      const {initializeInternalFixtureDatabase}=await import("./testing/index-ports.ts");initializeInternalFixtureDatabase(f.f.db);
      const {insertRoomRequest}=await import("./room-requests.ts");
      insertRoomRequest(f.f.db,{id:"fixture-parent",groupId:"fixture-room",verb:"room_turn",fromKind:"owner",toBotId:"B",targetThreadId:"T",admissionKey:`parent:${f.turn.turnId}`,state:"running",now:Date.now(),
        lineage:{rootThreadId:"T",origin:"desktop",audienceFingerprint:"fixture-owner",notOwnerAudience:false,unattended:false}});
      insertRoomRequest(f.f.db,{id:"fixture-duplicate",parentId:"fixture-parent",groupId:"fixture-room",verb:"ask",fromKind:"bot",fromBotId:"B",toBotId:"C",targetThreadId:"U",payloadText:"fixture request",admissionKey:`duplicate:${f.turn.turnId}`,state:"queued",now:Date.now()});
      const setup=await validDispatchScope(f,route.path,route.method,{revoke:revoked,requestId:"fixture-parent",settings:{autoApprove:true,fullAccess:true,noLimits:false}});
      const duplicate = vi.fn(await indexCallbackFixture("roomAskDuplicate",setup));
      const ask = vi.fn(askBotRoute), delegate = delegateObserver.mockClear();
      const scope = {
        ...setup,

        res: sink.raw, store,
        readBody: async () => ({ toBotId: "C", message: "fixture request" }),
        askBotRoute: ask,delegateBotRoute:delegate,

         roomAskDuplicate: duplicate,

        consumingHttpWriter,
      };
      if (revoked) await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      else await dispatch(scope);
      expect(route.path.endsWith("/ask-bot") ? ask : delegate).toHaveBeenCalledOnce();
      expect(duplicate).toHaveBeenCalledExactlyOnceWith("B", "C", "T", "fixture request");
      if (revoked) {
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
        expect(f.refusals).toBe(1);
      } else {
        expect(sink.output.at(-1)?.status).toBe(200);
        expect(JSON.parse(sink.output.at(-1)!.body!)).toMatchObject(route.path.endsWith("/ask-bot")
          ? { busy: true, toBotName: "Recipient" } : { queued: true, taskId: "fixture-duplicate" });
        expect(f.refusals).toBe(0);
      }
    }
  } finally { configureBotEgress(undefined); setExecutionStore(previous); }
});

// red-at-4df086541 A3-8: generate every venue/share delegate from the inventory,
// establish its real authorization, and observe its underlying handler before
// checking the final response. The store below is the isolated fixture port.
it("T-ALL-RETURNS inventory venue and share delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const read = await import("./venue-read.ts"), post = await import("./venue-post.ts"), share = await import("./room-shares.ts");
  const { registerProjectMemoryTools, venueToolHandlers } = await import("./project-memory-tools.ts");
  const { executionStore, setExecutionStore } = await import("./execution-audience.ts");
  const { createHash } = await import("node:crypto");
  const beforeStore = executionStore();
  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/api\/internal\/(venue\/|room-share\/)/.test(route.path));
  expect(routes.map(route => route.path).sort()).toEqual(["/api/internal/room-share/ask", "/api/internal/venue/post", "/api/internal/venue/read-messages"]);
  try {
    for (const route of routes) for (const revoke of [false, true]) {
      const f = fixture(), sink = consumingResponseRecorder(), isShare = route.path.endsWith("/ask"), isPost = route.path.endsWith("/post");
      const bot = { id: "B", name: "Fixture", threadId: isShare ? "direct" : "T", section: "Fixture", tasks: [] } as unknown as import("./store.ts").BotRecord;
      const group = { id: "venue", name: "Fixture venue", threadId: isShare ? "T" : "R", section: "Fixture", memberIds: ["B"], tasks: [] } as unknown as import("./store.ts").GroupRecord;
      const roster = { bots: [bot], groups: [group] };
      const store = await fixtureRoster([bot],[group]);
      setExecutionStore(executionStoreFixture(store));
      const claim = { botId: "B", threadId: "T", generation: f.turn.turnId };
      const request = { id: "owner-request", role: "user", kind: "text", text: "Post the fixture", origin: "desktop", at: 1, postTo: { venueId: "venue" } } as const;
      f.f.owner("T", request.id, 3);
      const live = { ownerSurface: () => true, notOwnerAudience: () => false, roster: () => roster, message: () => request };
      read.setVenueReadLive(live); post.setVenuePostLive(live);
      read.recordVenueReadTurn(f.turn.turnId, { ...claim, origin: "desktop" });
      const mount = post.venuePostMounts({ botId: "B", bot, threadId: "T", message: request, origin: "desktop", surfacesForOwner: true,
        directOwnerAudience: true, automationThread: false, agentsMcp: true });
      if (isPost) { expect(mount).not.toBeNull(); post.recordVenuePostTurn(f.turn.turnId, mount!); }
      registerProjectMemoryTools({ roster: () => roster, note: () => { throw new Error("fixture cannot publish notes"); } });
      const handler = venueToolHandlers.get("read-messages")!;
      const readHandler = vi.fn(handler), shareHandler = vi.fn(share.askOwnerToShare);
      venueToolHandlers.set("read-messages", readHandler);
      const setup=await validDispatchScope(f, route.path, route.method, {revoke,store,
        messages:isPost?[{threadId:"R",id:"accepted-post",message:{role:"bot",kind:"text",text:"fixture post"}}]:[]});
      const existingPost = vi.fn(await indexCallbackFixture("venuePostStored", setup));
      if (isPost) {
        const id = `vpost-${createHash("sha256").update(`${f.turn.turnId}\u0000R\u0000fixture post`, "utf8").digest("hex").slice(0, 32)}`;
        post.holdVenuePost(f.f.db, { id, stableId: "accepted-post", botId: "B", threadId: "T", origin: "desktop",
          requestMessageId: request.id, requestHash: createHash("sha256").update(request.text).digest("hex"),
          venueId: "venue", targetThreadId: "R", text: "fixture post", lineage: "[]" });
        f.f.db.prepare("UPDATE venue_posts SET state='posted' WHERE id=?").run(id);
      }
      const body = isShare ? { query: "" } : isPost ? { venueId: "venue", text: "fixture post" } : { venueId: "venue", limit: 0 };
      if (isShare) expect(share.shareMounts(f.f.db, roster, "B", "T")).toEqual(group);
      else if (isPost) expect(post.authorizeVenuePost(f.f.db, claim, body)).toMatchObject({ ok: true, target: "R" });
      else expect(read.authorizeVenueRead(f.f.db, claim, body)).toMatchObject({ ok: true, venueId: "venue" });
      const scope = { ...setup, res: sink.raw, store, readBody: async () => body,
        consumingHttpWriter,

         venuePostStored: existingPost,
           askOwnerToShare: shareHandler,
      };
      try {
        if (revoke) {
          await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
          expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
          expect(f.refusals).toBe(1);
        } else {
          await dispatch(scope);
          expect(sink.output[0]?.status).toBe(isShare ? 403 : isPost ? 200 : 400);
          expect(sink.output.at(-1)?.body).toContain(isShare ? "Give what you are looking for" : isPost ? '"messageId":"accepted-post"' : "limit is 1 to");
          expect(f.refusals).toBe(0);
        }
        if (isShare) expect(shareHandler).toHaveBeenCalledTimes(1);
        else if (isPost) expect(existingPost).toHaveBeenCalledTimes(1);
        else expect(readHandler).toHaveBeenCalledTimes(1);
      } finally {
        venueToolHandlers.set("read-messages", handler);
        read.forgetVenueReadTurn(f.turn.turnId); post.forgetVenuePostTurn(f.turn.turnId);
      }
    }
  } finally { read.setVenueReadLive(null); post.setVenuePostLive(null); setExecutionStore(beforeStore!); }
});

// red-at-4df086541 A3-8: the connector destination reaches the actual relay
// after bot access authorization; only the remote broker is a fixture.
it("T-ALL-RETURNS inventory connector relay after authorization", async () => {
  const { createServer } = await import("node:http");
  const composio = await import("./composio.ts");

  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const dispatch = await internalDispatchFixture();
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/connectors/mcp");
  expect(routes).toHaveLength(1);
  let onReply = () => {}, calls = 0;
  const broker = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/health")) return res.end('{"service":"flux-composio","ready":true,"claims":true}');
      const rpc = JSON.parse(raw); calls++; onReply();
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { fixture: "authorized relay" } }));
    });
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(broker.address() as import("node:net").AddressInfo).port}/composio`;
  try {
    for (const route of routes) for (const revoke of [false, true]) {
      composio.resetManagedBrokerState();
      composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: base,
        fluxAccess: { url: base, token: "b".repeat(64) }, legacyUntil: "", legacyClaim: { state: "claimed" }, accountKind: null, tokenError: null });
      await composio.primeBrokerReadiness();
      const f = fixture(), sink = consumingResponseRecorder(), before = calls;
      onReply = () => { if (revoke) f.flip(); };
      const admitted = await validDispatchScope(f, route.path, route.method);
      const scope = { ...admitted, res: sink.raw,
         readBody: async () => ({ jsonrpc: "2.0", id: 1, method: "ping" }),

        internalCapabilities: admitted.internalCapabilities,
      };
      if (revoke) {
        await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
        expect(f.refusals).toBe(1);
      } else {
        await dispatch(scope);
        expect(sink.output[0]?.status).toBe(200);
        expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ jsonrpc: "2.0", id: 1, result: { fixture: "authorized relay" } });
      }
      expect(calls - before).toBe(1);
    }
  } finally { composio.resetManagedBrokerState(); broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => resolve())); }
});

// red-at-4df086541 A3-8: a valid connected-app request reaches the actual
// status producer, beyond audience, owner, access-role and shape checks.
it("T-ALL-RETURNS inventory connector request after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const composio = await import("./composio.ts");

  const { botAccessPolicy } = await import("./bot-access-role.ts");
  const { createServer } = await import("node:http");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/connectors/request");
  expect(routes).toHaveLength(1);
  let onStatus = () => {};
  const requested: string[] = [];
  const broker = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/health")) return res.end('{"service":"flux-composio","ready":true,"claims":true}');
      requested.push(req.url!); onStatus(); res.end('{"services":{}}');
    });
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(broker.address() as import("node:net").AddressInfo).port}/composio`;
  try {
    for (const route of routes) for (const revoked of [false, true]) {
      composio.resetManagedBrokerState();
      composio.applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: base,
        fluxAccess: { url: base, token: "b".repeat(64) }, legacyUntil: "", legacyClaim: { state: "claimed" }, accountKind: null, tokenError: null });
      await composio.primeBrokerReadiness();
      const f = fixture(), sink = consumingResponseRecorder(), before = requested.length;
      const bot = { id: "B", threadId: "T", composio: true };
      expect(botAccessPolicy(bot as never).mode).not.toBe("restricted");
      onStatus = () => { if (revoked) f.flip(); };
      const resumeKey = "fixture-resume";
      const observations=fixtureObservers(["store.rowsOfKind"]);
      const setup=await validDispatchScope(f, route.path, route.method,
        { settings: { ...bot,autoApprove: true, fullAccess: true, noLimits: false },observers:observations,
          messages:[{threadId:"T",id:"existing-connector-card",message:{role:"bot",kind:"connector",connector:{resumeKey,slug:"gmail",status:"required",label:"Gmail",description:"Fixture connector"}}}] });
      const rowsOfKind=observations.spy("store.rowsOfKind"),maybeResumeConnectors=vi.fn(await indexCallbackFixture("maybeResumeConnectors",setup));
      const scope = { ...setup, res: sink.raw,

        readBody: async () => ({ resumeKey, slugs: ["gmail"] }),
         maybeResumeConnectors,
      };
      if (revoked) {
        await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      } else {
        await dispatch(scope);
        expect(sink.output).toEqual([{ status: 200 }, { status: 200, body: '{"messageIds":["existing-connector-card"]}' }]);
      }
      expect(requested.slice(before)).toEqual(["/composio/v1/connectors?services=gmail"]);
      expect(rowsOfKind).toHaveBeenCalledExactlyOnceWith("T", "connector");
      expect(maybeResumeConnectors).toHaveBeenCalledExactlyOnceWith("B", "T", resumeKey);
      expect(f.refusals).toBe(revoked ? 1 : 0);
    }
  } finally { composio.resetManagedBrokerState(); broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => resolve())); }
});

// red-at-4df086541 A3-8: the real catalog service and production projections
// run after admission; only the provider's HTTP port is substituted.
it("T-ALL-RETURNS inventory image catalogue reaches the real service", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { ImageGenerationService } = await import("./image-generation.ts");

  const {database}=await import("./database.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/image-models");
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const connection = { id: "openrouter", provider: "openrouter" as const, apiKey: "FIXTURE_IMAGE_KEY", revision: "fixture" };
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (revoked) f.flip();
      return Response.json({ data: [{ id: "vendor/fixture-image", name: "Fixture image model",
        architecture: { output_modalities: ["image"] }, supported_parameters: {
          output_format: { type: "enum", values: ["png"] }, size: { type: "enum", values: ["1024x1024"] },
        } }] });
    });
    const imageService = new ImageGenerationService({ resolveConnection: () => connection, connectionIds: () => [connection.id], fetch: fetcher });
    const getCatalog = realMethodObserver(imageService, "getCatalog");

    const cfg = { imageGen: { enabled: true, connectionId: connection.id, model: "vendor/fixture-image" } };
    const labelledImageConnections = await indexCallbackFixture("labelledImageConnections", {
      imageService,
    });
    const defaultImageConnection = await indexCallbackFixture("defaultImageConnection", { cfg });
    const imageSettings = vi.fn(await indexCallbackFixture("imageSettings", {
      cfg, labelledImageConnections:vi.fn(labelledImageConnections), defaultImageConnection:vi.fn(defaultImageConnection), imageConnection: () => connection,
      imageService,   database,
    }));
    const scope = { ...await validDispatchScope(f, route.path, route.method), res: sink.raw, imageSettings,  };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      const result = JSON.parse(sink.output.at(-1)!.body!);
      expect(result.selected).toEqual({ connectionId: "openrouter", model: "vendor/fixture-image" });
      expect(result.catalog.models).toEqual([expect.objectContaining({ id: "vendor/fixture-image", generate: true })]);
      expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    }
    expect(imageSettings).toHaveBeenCalledExactlyOnceWith(undefined, { availability: true });
    expect(getCatalog).toHaveBeenCalledExactlyOnceWith("openrouter", { offered: true, refresh: undefined });
    expect(fetcher).toHaveBeenCalledOnce();
  }
});

// red-at-4df086541 A3-8: actual search validation, protocol decoding and
// provider failure run behind the dispatcher. No search result is synthesized.
it.each(["success", "validation", "exception"] as const)("T-ALL-RETURNS inventory real web-search %s delegate", async kind => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const { searchFreeWeb } = await import("./free-web-search.ts");

  const {FreeWebSearchError}=await import("./free-web-search.ts");
  const {SearchError}=await import("./web-search.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/web-search");
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (kind === "exception") return new Response("", { status: 503 });
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize" ? {} : {
        structuredContent: { results: [{ title: "Fixture result", url: "https://fixture.invalid/result", excerpts: ["Fixture excerpt"] }] },
      } });
    });
    const producer = vi.fn(async (input: Parameters<typeof searchFreeWeb>[0]) => {
      try { return await searchFreeWeb(input, { fetch: fetcher }); }
      finally { if (revoked) f.flip(); }
    });
    const scope = { ...await validDispatchScope(f, route.path, route.method), res: sink.raw,
      readBody: async () => ({ query: kind === "validation" ? "" : "fixture query" }), searchFreeWeb: producer, FreeWebSearchError, SearchError };
    if (revoked) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      expect(sink.output[0]?.status).toBe(kind === "success" ? 200 : kind === "validation" ? 400 : 502);
      const result = JSON.parse(sink.output.at(-1)!.body!);
      if (kind === "success") expect(result).toMatchObject({ provider: "parallel", routing: "engine-fallback", untrusted: true,
        results: [{ title: "Fixture result", url: "https://fixture.invalid/result", snippet: "Fixture excerpt" }] });
      else expect(result).toEqual({ code: kind === "validation" ? "invalid-request" : "unavailable",
        error: kind === "validation" ? "Free web search request is invalid." : "Free web search is unavailable." });
    }
    expect(producer).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(kind === "success" ? 3 : kind === "validation" ? 0 : 2);
  }
});

// control A3-8: actual valid-capability dispatch reaches the awaited producer,
// rather than the capability-denial branch. Only external services are fixtures.
it("T-ALL-RETURNS actual image-model catalogue after await", async () => {
  const dispatch = await internalDispatchFixture();
  const { builtInImageCapabilities } = await import("../shared/image-capabilities.ts");
  const capabilities = builtInImageCapabilities("flux", "flux-image-gpt25")!;
  const model: import("./image-generation.ts").ImageModelOption = {
    id: "fixture-model", label: "Fixture model", generate: true, edit: true, availability: "catalog-listed",
    qualities: capabilities.qualities, sizes: [], maxReferences: capabilities.maxReferences, capabilities,
  };
  const catalog: import("./image-generation.ts").ImageCatalog = {
    connectionId: "fixture-images", provider: "flux", defaultModel: "fixture-model", models: [model],
  };
  const { qualityAliases, sizeAliases, ...compactCapabilities } = capabilities;
  expect(Object.keys(qualityAliases!)).not.toHaveLength(0);
  expect(Object.keys(sizeAliases!)).not.toHaveLength(0);
  for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const producer = vi.fn(async () => { if (revoke) f.flip(); return { catalog }; });
    const scope = { ...await validDispatchScope(f, "/api/internal/image-models", "GET"), res: sink.raw,
      imageSettings: producer,  };
    if (revoke) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: only the positive oracle follows the real compact DTO producer.
      expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ catalog: {
        connectionId: "fixture-images", provider: "flux", defaultModel: "fixture-model",
        models: [{ id: "fixture-model", label: "Fixture model", generate: true, edit: true, availability: "catalog-listed", capabilities: compactCapabilities }],
      } });
      // MAIN RULING 1114-SC-SAFETY-REAL-PRODUCERS: independently exclude real private alias maps.
      const projected = JSON.parse(sink.output.at(-1)!.body!).catalog.models[0].capabilities;
      expect(Object.hasOwn(projected, "qualityAliases")).toBe(false);
      expect(Object.hasOwn(projected, "sizeAliases")).toBe(false);
    }
    expect(producer).toHaveBeenCalledExactlyOnceWith(undefined, { availability: true });
  }
});

// control A3-8: execute the real successful, validation and caught-exception
// producers with the correct capability, then mutate inside their actual await.
it("T-ALL-RETURNS outer error response contains revocation after an awaited body", async () => {
  const dispatch = await internalDispatchFixture(true);
  const f = fixture(), sink = consumingResponseRecorder();
  const readBody = vi.fn(async () => {
    f.flip();
    throw Object.assign(new Error("fixture generation ended"), { status: 401 });
  });
  await expect(dispatch({ ...await validDispatchScope(f, "/api/internal/web-search", "POST"),
    res: sink.raw, readBody,

  })).resolves.toBeUndefined();
  expect(readBody).toHaveBeenCalledOnce();
  expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
  expect(f.refusals).toBe(1);
});

it.each(["success", "validation", "exception"] as const)("T-ALL-RETURNS actual web-search %s producer", async kind => {
  const dispatch = await internalDispatchFixture();
  class SearchFailure extends Error { constructor(readonly code: string) { super("fixture provider refusal"); } }
  for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const producer = vi.fn(async () => {
      if (revoke) f.flip();
      if (kind !== "success") throw new SearchFailure(kind === "validation" ? "invalid-request" : "provider-failure");
      return { hits: [{ title: "fixture result", url: "https://fixture.invalid/result" }] };
    });
    const scope = { ...await validDispatchScope(f, "/api/internal/web-search", "POST"), res: sink.raw,
      readBody: async () => ({ query: "fixture query" }), searchFreeWeb: producer, FreeWebSearchError: SearchFailure, SearchError: SearchFailure };
    if (revoke) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      expect(sink.output.at(-1)?.status).toBe(kind === "success" ? 200 : kind === "validation" ? 400 : 502);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual(kind === "success"
        ? { hits: [{ title: "fixture result", url: "https://fixture.invalid/result" }], routing: "engine-fallback" }
        : { error: "fixture provider refusal", code: kind === "validation" ? "invalid-request" : "provider-failure" });
    }
    expect(producer).toHaveBeenCalledOnce();
  }
});

// red-at-4df086541 A3-8: computer state and activity replies call the actual
// per-bot controller/watchdog, including a help lease created and expired here.
it("T-ALL-RETURNS inventory computer-control and activity delegates", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const routes = INTERNAL_HTTP_ROUTES.filter(route => /\/computer-(control|activity)$/.test(route.path));
  expect(routes).toHaveLength(4);
  for (const route of routes) for (const revoked of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const observations=fixtureObservers(["computerControl.snapshot","computerControl.requestHelpLease","computerControl.expireHelp","watchdog.touch","watchdog.silenceLimitMs","watchdog.opts.onStall"]);
    const setup=await validDispatchScope(f, route.path, route.method, {revoke:revoked,observers:observations,
      activityStallMs:1234,computerHelp:route.method==="DELETE"?"Fixture help":undefined});
    const prior=setup.dispatchAuthoritySetup.priorHelp;
    const snapshot=observations.spy("computerControl.snapshot"),help=observations.spy("computerControl.requestHelpLease"),expire=observations.spy("computerControl.expireHelp");
    const touch=observations.spy("watchdog.touch"),silence=observations.spy("watchdog.silenceLimitMs"),stalled=observations.spy("watchdog.opts.onStall");
    const notify=vi.fn(await indexCallbackFixture("notify",setup));
    const scope = { ...setup, res: sink.raw,
      url: new URL(`${route.path}?botId=B`, "http://fixture"),
      readBody: async () => ({ reason: "Fixture help", requestId: prior?.requestId }),
      notify,
      consumingHttpWriter,
    };
    try {
      if (revoked) {
        await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
        expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
      } else {
        await dispatch(scope);
        expect(sink.output[0]?.status).toBe(200);
        expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual(route.path.endsWith("activity") ? { silenceMs: 1234 }
          : route.method === "POST" ? { held: false, helpOpen: true, requestId: "B-1" } : { held: false, helpOpen: false });
      }
      if (route.path.endsWith("activity")) {
        expect(touch).toHaveBeenCalledExactlyOnceWith("T"); expect(silence).toHaveBeenCalledExactlyOnceWith("T");
      } else if (route.method === "POST") {
        expect(help).toHaveBeenCalledExactlyOnceWith("B", "Fixture help"); expect(notify).toHaveBeenCalledOnce();
      } else if (route.method === "DELETE") expect(expire).toHaveBeenCalledExactlyOnceWith("B", prior!.requestId);
      else expect(snapshot).toHaveBeenCalledExactlyOnceWith("B");
      expect(stalled).not.toHaveBeenCalled();
    } finally { /* The fixture stops its own real watchdog. */ }
  }
});

// red-at-4df086541: real computer/browser delegates after capability and
// ownership checks must return through the restricted destination. Only the
// external device port is substituted; both broker implementations run.
it("T-ALL-RETURNS inventory computer delegates after authorization", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");
  const browserProcessIo = await import("./browser-engine.ts");
  const closeBrowserProcess = vi.spyOn(browserProcessIo,"closeAgentBrowserSession").mockResolvedValue(undefined);
  fixtureCleanup.push(() => closeBrowserProcess.mockRestore());
  const engineStatus=vi.spyOn(browserProcessIo,"settledBrowserEngineStatus").mockResolvedValue({kind:"ready",binaryPath:"fixture-browser",version:"fixture",runtimeVerified:false});
  const verifyBinary=vi.spyOn(browserProcessIo,"verifyAgentBrowserBinary").mockResolvedValue(undefined);
  fixtureCleanup.push(()=>engineStatus.mockRestore(),()=>verifyBinary.mockRestore());
  const { HostComputerBroker } = await import("./host-computer-broker.ts");
  const { UnifiedBrowserController } = await import("./browser-control.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const routes = INTERNAL_HTTP_ROUTES.filter(route => ["/api/internal/host-computer", "/api/internal/unified-browser", "/api/internal/headless-browser"].includes(route.path));
  expect(routes).toHaveLength(5);
  for (const route of routes) for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    const dir = mkdtempSync(join(tmpdir(), "murage-dispatch-browser-"));
    fixtureCleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const external = vi.fn(async (method: string) => method === "tools/list" ? { tools: [{ name: "agent_browser_snapshot" }] } : {});
    const host = new HostComputerBroker(() => ({ request: external, notify: async () => {}, close: async () => {} }) as import("./drivers/headless-browser-proxy.ts").EngineClient);
    const browser = new UnifiedBrowserController({ stateFile: join(dir, "state.json"), createNative: () => ({
      request: external, protected: async () => false, command: async () => ({}), connect: async () => "fixture-stream",
      input: () => {}, resetStream: () => {}, close: async () => {},
    }) });
    const spec = { command: "fixture", args: [], env: {} };
    browser.register("fixture-profile", spec);

    const setup=await validDispatchScope(f, route.path, route.method, {revoke,
      config:{features:{browser:true}},computer:{hostComputer:host,unifiedBrowser:browser,connection:spec,mode:route.path.endsWith("host-computer")?"host":route.path.endsWith("headless-browser")?"legacy":"browser",io:{agentBrowserIntegration:()=>spec,settledBrowserEngineStatus:engineStatus,verifyAgentBrowserBinary:verifyBinary}}});
    const release=vi.fn(await indexCallbackFixture("releaseBrowserCapabilityForThread",setup));
    const scope = { ...setup,res:sink.raw,readBody:async()=>({method:"tools/list"}),releaseBrowserCapabilityForThread:release,consumingHttpWriter };
    if (revoke) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      expect(sink.output[0]?.status).toBe(route.path.endsWith("headless-browser") && route.method === "POST" ? 405 : 200);
      if (!route.path.endsWith("headless-browser")) {
        const result = JSON.parse(sink.output.at(-1)!.body!);
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].name).toBe("agent_browser_snapshot");
        if (route.path.endsWith("unified-browser")) expect(result.tools[0].inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      }
    }
    if (!route.path.endsWith("headless-browser")) expect(external.mock.calls.map(([method]) => method)).toContain("tools/list");
    if (route.method === "DELETE") expect(release).toHaveBeenCalledExactlyOnceWith("T", f.turn.turnId);
    await host.drain();await browser.close();
  }
});

// red-at-4df086541: the delegated phone RPC must retain the HTTP release
// boundary after its own authority, grant and argument checks have succeeded.
it("T-ALL-RETURNS inventory phone delegate opens an authorized job", async () => {
  const dispatch = await internalDispatchFixture();
  const { INTERNAL_HTTP_ROUTES } = await import("./consuming-sink-inventory.ts");

  const {PhoneJobs}=await import("./phones/jobs.ts");
  const {producerAuthorityFor}=await import("./decision/index.ts");
  const { PhoneAuthorities } = await import("./phones/authority.ts");
  const { PhoneRegistry, initializePhones } = await import("./phones/registry.ts");

  const { readFileSync } = await import("node:fs");

  const registration = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8")).registration.valid;
  const routes = INTERNAL_HTTP_ROUTES.filter(route => route.path === "/api/internal/device/call");
  expect(routes).toHaveLength(1);
  for (const route of routes) for (const revoke of [false, true]) {
    const f = fixture(), sink = consumingResponseRecorder();
    initializePhones(f.f.db);
    const registry = new PhoneRegistry(f.f.db, () => 1000), authorities = new PhoneAuthorities();
    expect(registry.put("11111111-1111-4111-8111-111111111111", registration).ok).toBe(true);
    authorities.mint({ threadId: "T", turnId: f.turn.turnId, generation: f.turn.turnId, origin: "desktop", botId: "B" });
    const jobs=new PhoneJobs({authorityFor:producerAuthorityFor,now:Date.now,ids:()=>crypto.randomUUID(),leaseToken:()=>crypto.randomUUID().replaceAll("-","").padEnd(43,"x"),
      setTimer:(ms,fn)=>{const timer=setTimeout(fn,ms);timer.unref?.();return()=>clearTimeout(timer);},push:{park:()=>{},withdraw:()=>{}}});
    fixtureCleanup.push(()=>jobs.shutdown());
    const observations=fixtureObservers(["phoneJobs.request","store.markPhoneUsed"]);
    const setup=await validDispatchScope(f,route.path,route.method,{observers:observations,
      settings:{name:"Fixture",phoneApps:{calendar:"read"}},phone:{phoneRegistryOnce:registry,phoneAuthorities:authorities,phoneJobs:jobs},
      engine:{profile:{instanceId:"fixture",driverKind:"fixture",adapter:{capabilities:{}},models:{default:"fixture",options:[]}},model:"fixture"}});
    const job=observations.spy("phoneJobs.request"),mark=observations.spy("store.markPhoneUsed");
    const controller=new AbortController();fixtureCleanup.push(()=>controller.abort());
    const device=(async()=>{const [offer]=await jobs.poll("11111111-1111-4111-8111-111111111111",controller.signal);
      if(!offer)throw new Error("FIXTURE_PHONE_OFFER_MISSING");
      const lease=jobs.lease("11111111-1111-4111-8111-111111111111",offer.operationId,offer.offerId,
        ()=>authorities.live(f.turn.turnId)!==null&&registry.get("11111111-1111-4111-8111-111111111111")!==null);
      if(!lease.active)throw new Error("FIXTURE_PHONE_LEASE_REFUSED");
      if(revoke)f.flip();
      const status=jobs.result("11111111-1111-4111-8111-111111111111",offer.operationId,{leaseToken:lease.leaseToken,ok:true,result:{events:[],truncated:false}});
      if(status!==200)throw new Error("FIXTURE_PHONE_RESULT_REFUSED");})();
    void device.catch(()=>{});
    const scope = { ...setup, res: sink.raw, cfg:{features:{phoneTools:true}},

      readBody: async () => ({ tool: "phone_calendar_read", args: { start: "2026-10-01T09:00:00Z", end: "2026-10-02T09:00:00Z" } }),

    };
    if (revoke) {
      await expect(dispatch(scope)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
      expect(sink.output).toEqual([{ status: 409 }, { status: 409, body: LEDGER_REFUSAL_LINE }]);
    } else {
      await dispatch(scope);
      expect(JSON.parse(sink.output.at(-1)!.body!)).toEqual({ ok: true, text: JSON.stringify({ result: { events: [], truncated: false }, phone: registration.name }) });
    }
    await device;
    expect(job).toHaveBeenCalledOnce(); expect(mark).toHaveBeenCalledExactlyOnceWith("B", "T");
  }
});

// red-at-8d3290c81 A3-4: production project callbacks looked up mutable thread
// state at commit and attributed the old response to the replacement member.
it("A3-4 production project attribution never retargets a replacement", async () => {
  const f = fixture(), next = fixture(), write = vi.fn();
  const before = f.turn.parents;
  const oldLineage: RunningTurnLineage = { sources: [], roots: { roots: new Set(), over: false },
    instanceId: "old", botId: "B", generation: f.turn.turnId, turn: f.turn, startGeneration: 0 };
  const nextLineage: RunningTurnLineage = { ...oldLineage, sources: [], instanceId: "next", generation: next.turn.turnId, turn: next.turn };
  const setup = await retainedCallbackScope(f, oldLineage);
  const configured = await indexCallbackFixture("registerProjectMemoryTools", {
    ...setup,

  });
  const attribution = configured.captureAttribution?.("T", "B", f.turn) ?? configured;
  await setup.dispatchAuthoritySetup.retain(next.binding, nextLineage);
  expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, { bytes: 1,
    refs: [{ kind: "line", threadId: "T", messageId: "Y" }],
    commitAttribution: () => attribution.read("T", "B", [{ threadId: "T", id: "Y", role: "bot" }]), write,
  })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(oldLineage.sources).toEqual([]); expect(nextLineage.sources).toEqual([]);
  expect(f.turn.parents).toBe(before);
});

// red-at-8d3290c81 A3-4: extending a held range mutates its existing object;
// adding another range mutates the same array. Both aliases survived rollback.
it("A3-4 restores mutated held-range objects and appended ranges before enqueue", async () => {
  const positions = await import("./turn-source-holds.ts");
  const { addRangesToRunningTurn } = await import("./steer-lineage.ts");
  const lookup = vi.spyOn(positions, "storedPosition").mockReturnValue(4);
  try {
    const f = fixture(), held = { threadId: "T", upTo: "X", since: 0, position: 1 }, ranges = [held];
    const running: RunningTurnLineage = { sources: [], roots: { roots: new Set(), over: false }, ranges,
      instanceId: "fixture", generation: f.turn.turnId, turn: f.turn, startGeneration: 0 };
    const write = vi.fn();
    expect(() => emitConsumingTurnResponse(f.binding, httpDescriptors.body, { bytes: 1, refs: [],
      commitAttribution: () => {
        addSourcesToRunningTurn(running, [{ threadId: "T", id: "Y", role: "bot" }]);
        addRangesToRunningTurn(running, [{ threadId: "other", upTo: "Z", since: 0 }]);
        expect(held).toMatchObject({ upTo: "Y", position: 4 }); expect(ranges).toHaveLength(2);
        throw new Error("attribution");
      }, write,
    })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(running.ranges).toBe(ranges); expect(ranges).toHaveLength(1); expect(ranges[0]).toBe(held);
    expect(held).toEqual({ threadId: "T", upTo: "X", since: 0, position: 1 });
    expect(write).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); }
});
