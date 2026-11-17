import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect } from "vitest";
import { addTurnParents, closeTurnLineage, openTurnLineage, currentTurnLineage } from "../memory/lineage-write.ts";
import * as lineageApi from "../memory/lineage-write.ts";
import * as fenceApi from "../memory/send-fence.ts";
import { preparedInternalWritetimeFixture } from "./internal-database-fixture.ts";
import { MEMBER, WritetimeFixture } from "../memory/testing/writetime-fixture.ts";
import type { LineageReader } from "../memory/lineage-types.ts";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { TurnLineage } from "../memory/lineage-types.ts";
const responseApi = existsSync(new URL("../consuming-turn-response.ts", import.meta.url)) ? await import("../consuming-turn-response.ts") : undefined;
const inventoryApi = responseApi ? await import("../consuming-sink-inventory.ts") : undefined;
function response<K extends keyof NonNullable<typeof responseApi>>(name: K): NonNullable<typeof responseApi>[K] {
  expect(responseApi?.[name], `the consuming response boundary must provide ${name} before fixture delivery`).toBeTypeOf("function");
  return responseApi![name];
}
const bindConsumingTurn: typeof import("../consuming-turn-response.ts").bindConsumingTurn = (...args) => response("bindConsumingTurn")(...args);
const consumingHttpWriter: typeof import("../consuming-turn-response.ts").consumingHttpWriter = (...args) => response("consumingHttpWriter")(...args);
const registerConsumingDescriptor: typeof import("../consuming-turn-response.ts").registerConsumingDescriptor = (...args) => response("registerConsumingDescriptor")(...args);
const emitConsumingTurnResponse = ((...args: Parameters<typeof import("../consuming-turn-response.ts").emitConsumingTurnResponse>) => response("emitConsumingTurnResponse")(...args)) as typeof import("../consuming-turn-response.ts").emitConsumingTurnResponse;
const prepareRetainedFence: typeof fenceApi.prepareRetainedFence = (...args) => {
  expect(fenceApi.prepareRetainedFence, "the consuming turn must retain its audience fence before accepting a response").toBeTypeOf("function");
  return fenceApi.prepareRetainedFence(...args);
};
const { checkedOpenTurns, refuseRetainedTurn } = lineageApi;
import { turnToolText } from "../memory/prompt-parts.ts";
import { database } from "../database.ts";
const registeredInternalRoute: typeof import("../consuming-sink-inventory.ts").registeredInternalRoute = (...args) => {
  expect(inventoryApi?.registeredInternalRoute, "the concrete HTTP destination must be registered").toBeTypeOf("function");
  return inventoryApi!.registeredInternalRoute(...args);
};
import { projectToolHandlers } from "../project-tool-routing.ts";
const acceptedFixtureBindings = new WeakMap<TurnLineage, ReturnType<typeof bindFixtureTurn>>();

/** A handler fixture must finish the real response writer before observing
 * receipts. Merely collecting its staged body never accepts the read. */
export function acceptFixtureResponse(binding: import("../consuming-turn-response.ts").ConsumingTurnBinding,
  status: number, body: unknown, provenance?: import("../memory/lineage-types.ts").StagedResultProvenance) {
  const sink = fixtureHttp(binding);
  try {
    if (provenance) response("stageProvenance")(sink.writer, provenance);
    response("stageResultProvenance")(sink.writer, body);
    sink.writer.writeHead(status, { "content-type": "application/json" });
    sink.writer.end(JSON.stringify(body));
  } catch (error) {
    if ((error as { code?: string }).code !== "MEMORY_CONTEXT_REVOKED") throw error;
    response("denyConsumingHttp")(sink.raw, binding);
  }
  const text = sink.output.filter(part => part.body !== undefined).map(part => part.body).join("");
  let delivered: unknown;
  try { delivered = JSON.parse(text); } catch { delivered = text; }
  return { status: sink.output[0]?.status ?? 0, body: delivered, destroyed: sink.destroyed };
}

/** control: construct historical lineage for marker/differential tests. These
 * fixtures deliberately include a write crossing a pending revoke, to exercise
 * the marker's late-edge repair. They do not simulate engine delivery. Using
 * the response acceptance helper here prevents constructing that adversarial
 * history and fails before the marker assertion can run. */
export function recordFixtureToolHistory(threadId: string, text: string, refs: Parameters<typeof turnToolText>[2]) {
  const turn = currentTurnLineage(threadId);
  if (!turn) throw new Error("FIXTURE_TURN_MISSING");
  const result = turnToolText(turn, text, refs);
  addTurnParents(turn, refs);
  return result;
}

/** control migration for legacy lineage fixtures: construction is staged;
 * this explicit simulated acceptance, before their next output, adds its refs.
 * Thread lookup is test setup only, never production response authorization. */
export function acceptFixtureToolText(threadId: string, text: string, refs: Parameters<typeof turnToolText>[2]) {
  const turn = currentTurnLineage(threadId);
  if (!turn) throw new Error("FIXTURE_TURN_MISSING");
  const result = turnToolText(turn, text, refs);
  let bound = acceptedFixtureBindings.get(turn);
  if (!bound) { bound = bindFixtureTurn(database(), turn, "fixture"); acceptedFixtureBindings.set(turn, bound); }
  emitConsumingTurnResponse(bound.binding, registerConsumingDescriptor("POST /api/internal/memory/get:body", "body"), {
    bytes: Buffer.byteLength(text), refs: result.lineageOf, write: () => {},
  });
  return result;
}

/** Bind an existing isolated producer fixture without substituting its database. */
export function bindFixtureTurn(db: DatabaseSync, turn: TurnLineage, botId: string, generation = turn.turnId,
  reader: LineageReader = { audience: null }) {
  let current = true, refusals = 0;
  prepareRetainedFence(turn, reader, () => { refusals++; }, db);
  const members = checkedOpenTurns(turn);
  const binding = bindConsumingTurn({
    identity: { botId, threadId: turn.threadId, dispatchGeneration: generation, lineageTurnIds: members.map(m => m.turnId), adapterLeaseId: generation },
    turn, db, isCurrent: () => current,
    onLedgerRefused: verdict => { for (const member of members) refuseRetainedTurn(member, verdict); },
  });
  return { binding, get refusals() { return refusals; }, replace: () => { current = false; } };
}

export function fixtureHttp(binding: import("../consuming-turn-response.ts").ConsumingTurnBinding,
  route = "POST /api/internal/memory/thread-read") {
  const [method, path] = route.split(" ");
  if (!registeredInternalRoute(method!, path!, { project: name => projectToolHandlers.has(name), email: () => false,
    mcp: () => false, delegation: () => false, box: () => false })) throw new Error("FIXTURE_ROUTE_NOT_ADMITTED");
  const sink = consumingResponseRecorder();
  const writer = consumingHttpWriter(sink.raw, binding, {
    headers: registerConsumingDescriptor(`${route}:headers`, "headers"),
    body: registerConsumingDescriptor(`${route}:body`, "body"),
    chunk: registerConsumingDescriptor(`${route}:chunk`, "chunk"),
  });
  // Spreading the recorder snapshots its getter before the writer runs.
  // Teardown assertions must observe the actual transport after delivery.
  return { ...sink, writer, get destroyed() { return sink.destroyed; } };
}

/** Fresh temporary SQLite fixture; never consults the application's database. */
export function consumingFixture(reader: LineageReader = MEMBER, options: { empty?: boolean; internalSchema?:boolean; threadId?: string; botId?: string;
  onRefused?: (verdict: import("../memory/lineage-types.ts").LineageVerdict) => void;
  /** A real lease behind the binding: the cause and the frozen result travel through it, as in index.ts. */
  lease?: { noteCause(cause: import("../turn-end.ts").TurnCause): unknown; end(): import("../turn-end.ts").TurnEnd; engineEnded?(input: { readonly engineText?: string }): unknown };
  /** Filled with a switch that makes the binding stale, as the index does when a turn's generation is revoked. */
  control?: { replace?: () => void } } = {}) {
  const f = options.internalSchema?preparedInternalWritetimeFixture():new WritetimeFixture().reply("T", "X", 1).reply("T", "Y", 2);
  const turn = openTurnLineage(f.db, { threadId: options.threadId ?? "T", turnId: randomUUID() });
  let current = true, refusals = 0;
  prepareRetainedFence(turn, reader, verdict => { refusals++; options.onRefused?.(verdict); }, f.db);
  if (!options.empty) addTurnParents(turn, [{ kind: "line", threadId: "T", messageId: "X" }]);
  const members = checkedOpenTurns(turn);
  const binding = bindConsumingTurn({
    identity: { botId: options.botId ?? "B", threadId: turn.threadId, dispatchGeneration: turn.turnId, lineageTurnIds: [turn.turnId], adapterLeaseId: turn.turnId },
    turn, db: f.db, isCurrent: () => current,
    onLedgerRefused: verdict => { for (const member of members) refuseRetainedTurn(member, verdict); },
    ...(options.lease ? { noteCause: (cause: import("../turn-end.ts").TurnCause) => { options.lease!.noteCause(cause); }, turnEnd: () => options.lease!.end(), engineEnded: (text: string) => { options.lease!.engineEnded?.({ engineText: text }); } } : {}),
  });
  if (options.control) options.control.replace = () => { current = false; };
  return {
    f, turn, binding, budget: members[0]!.budget!,
    get refusals() { return refusals; },
    replace: () => { current = false; },
    flip: () => { f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run(); f.denyLine("T", 1, 7); },
    close: () => { closeTurnLineage(turn); f.close(); },
  };
}

/** Isolated destination captures all output classes, including header-only
 * writes. No listener, socket, app database or provider process is opened. */
export function consumingResponseRecorder(options: { backpressure?: boolean } = {}) {
  const events = new EventEmitter();
  const headers = new Map<string, unknown>();
  const output: Array<{ status: number; body?: string }> = [];
  let headersSent = false, writableEnded = false, destroyed = false, status = 200;
  let backpressure = Boolean(options.backpressure);
  const raw = Object.assign(events, {
    getHeaderNames: () => [...headers.keys()],
    removeHeader: (name: string) => headers.delete(name),
    writeHead: (code: number, values: object = {}) => { status = code; headersSent = true; for (const [name, value] of Object.entries(values)) headers.set(name, value); output.push({ status }); return raw; },
    write: (data: string | Uint8Array) => { output.push({ status, body: typeof data === "string" ? data : Buffer.from(data).toString() }); events.emit("fixture-written"); return !backpressure; },
    end: (data?: string | Uint8Array, _encoding?: BufferEncoding, callback?: () => void) => { if (data !== undefined) output.push({ status, body: typeof data === "string" ? data : Buffer.from(data).toString() }); writableEnded = true; events.emit("finish"); callback?.call(raw); return raw; },
    destroy: () => { destroyed = true; events.emit("close"); return raw; },
    writeContinue: () => output.push({ status: 100 }),
    writeEarlyHints: () => output.push({ status: 103 }),
    _writeRaw: () => output.push({ status: 299, body: "escape" }),
  });
  Object.defineProperties(raw, {
    headersSent: { get: () => headersSent }, writableEnded: { get: () => writableEnded }, destroyed: { get: () => destroyed },
  });
  return { raw: raw as unknown as ServerResponse, output, headers, drain: () => { backpressure = false; return events.emit("drain"); }, get destroyed() { return destroyed; } };
}
