import { assertNoFluxMemoryForDowngrade, downgradeFluxMemoryTables, FLUX_MEMORY_TABLES_AFTER_118 } from "./installation-app-schema-downgrade.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FLUX-SPACES-CAPTURE-FORGET-106 R4 against a fake Flux shaped on the FluxMain contract (no real key, no network): one space per
// bot, each capture naming its conversation in metadata.thread; deleting a conversation forgets that thread (or, while that is not
// live, the receipted captures by id), deleting a bot deletes its space; 409 / 429 / 404 answers latch calmly; tombstones keep a
// deleted thread or space from ever being captured again; every obligation survives a crash.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { FluxMemoryCapture } from "./flux-memory-capture.ts";
import { setFluxExternalMemory } from "./flux-memory-envelope.ts";
import { FluxMemoryForget } from "./flux-memory-forget.ts";
import { fluxMemoryContextForTurn, fluxMemoryDecision, setFluxMemorySettings } from "./flux-memory-headers.ts";
import { FLUX_CODEX_TABLE_HEADERS } from "./flux-memory-wire.ts";
import {
  allFluxForgets, fluxBotSpace, fluxForgetsWaitingForKey, fluxKeyFingerprint, fluxKeyOff, fluxKeyOffReason, fluxLimitedBots, fluxRouteProven, fluxSpacesGone, fluxThreadTag,
  initializeFluxSpaces, noteFluxCaptureAccepted, noteFluxSpaceUsed, setFluxKeyOff, setFluxSpaceLimit, tombstoneFluxSpace, tombstoneFluxThread,
  withdrawFluxForget, type FluxForgetRow,
} from "./flux-memory-spaces.ts";
import { threadMemoryCaptures } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { ownerDeletedThread, recordOwnerDeletion } from "./owner-deletions.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const KEY_A = "sk-flux-spaces-fake-key-a";
const KEY_B = "sk-flux-spaces-fake-key-b";
const BASE = "https://api.fluxrouter.ai/v1/memory";
const roster = { bots: [{ id: "moss", threadId: "t1" }, { id: "fern", threadId: "t2" }], groups: [] as never[] };
const owner = (botId = "moss") => ({ botId, audience: "owner" as const, decidedOwner: true });
const HOUR = 60 * 60_000;

type Call = { method: string; url: string; key: string | null; idem: string | null; body: Record<string, unknown> | null };
type Event = { space: string; tag: string; sourceId: string; key: string };

/** A fake Flux Memory on the FluxMain contract (R4.1). Captures need Idempotency-Key; a shredded space refuses capture with 404
 * memory_not_found; a forgotten thread refuses with 409 memory_thread_forgotten; past `maxSpaces` a new space is refused with 429
 * memory_end_user_limit. POST {space}/forget {"thread"} answers 202 {operation_id} (or 404 while `threadForgetLive` is false);
 * POST {space}/forget {"source_ids"} (<=100) answers 200, or 410 already_deleted when none is known; DELETE {space} answers 202
 * {operation_id}, 200 already_deleted for a shredded space, 404 memory_not_found for one never made; GET /operations/{id} answers
 * 'pending' until `pollsToComplete`, then 'done'. */
class FakeFlux {
  events: Event[] = [];
  spaces = new Set<string>();
  shredded = new Set<string>();
  forgotten = new Set<string>();
  ops = new Map<string, { polls: number }>();
  calls: Call[] = [];
  forced: Record<string, Array<{ status: number; body?: unknown; headers?: Record<string, string> }>> = {};
  keyOff = new Map<string, string>();
  maxSpaces = Infinity;
  threadForgetLive = true;
  pollsToComplete = 1;
  /** The next capture answers 202 with no source_id (a receipt that is never written). */
  noSourceIdOnce = false;
  /** The next ids forget is applied at Flux, then the connection drops before the answer (a crash after the ids were sent). */
  dropIdsAnswerOnce = false;
  /** Holds capture POSTs: the request settles when released. `ignoreAbort`: the answer lands even after an abort. */
  hold: { ignoreAbort: boolean; release?: () => void } | null = null;
  onPost?: () => void;
  private next = 0;
  private src = 0;
  fetch = (async (input: string, init: RequestInit) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    const headers = new Headers(init.headers);
    expect(headers.get("x-flux-feature")).toBe("memory");
    const key = headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    let body: Record<string, unknown> | null = null;
    try { body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null; } catch { body = null; }
    this.calls.push({ method, url, key, idem: headers.get("idempotency-key"), body });
    const forced = this.forced[method]?.shift();
    if (forced) return json(forced.status, forced.body ?? null, forced.headers);
    if (key && this.keyOff.has(key)) return json(409, { error: { code: this.keyOff.get(key) } });
    const events = url.match(/^https:\/\/api\.fluxrouter\.ai\/v1\/memory\/spaces\/([^/]+)\/events$/);
    if (method === "POST" && events) {
      this.onPost?.();
      const space = decodeURIComponent(events[1]!);
      if (!headers.get("idempotency-key")) return json(400, { error: { code: "idempotency_key_required" } });
      const answer = () => {
        const tag = String((body?.metadata as Record<string, unknown> | undefined)?.thread ?? "");
        if (this.shredded.has(space)) return json(404, { error: { code: "memory_not_found" } });
        if (this.forgotten.has(`${space}|${tag}`)) return json(409, { error: { code: "memory_thread_forgotten" } });
        if (!this.spaces.has(space) && this.spaces.size >= this.maxSpaces) return json(429, { error: { code: "memory_end_user_limit" } }, { "retry-after": "1" });
        this.spaces.add(space);
        const sourceId = `src_${++this.src}`;
        this.events.push({ space, tag, sourceId, key: key ?? "" });
        if (this.noSourceIdOnce) { this.noSourceIdOnce = false; return json(202, { revision: 1, operation_id: "op_capture", status: "committed" }); }
        return json(202, { source_id: sourceId, revision: 1, operation_id: "op_capture", status: "committed" });
      };
      if (!this.hold) return answer();
      const hold = this.hold;
      return new Promise<Response>((resolve, reject) => {
        hold.release = () => resolve(answer());
        if (!hold.ignoreAbort) init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const forget = url.match(/^https:\/\/api\.fluxrouter\.ai\/v1\/memory\/spaces\/([^/]+)\/forget$/);
    if (method === "POST" && forget) {
      const space = decodeURIComponent(forget[1]!);
      if (Array.isArray(body?.source_ids)) {
        const ids = body!.source_ids as string[];
        if (ids.length > 100) return json(400, { error: { code: "too_many" } });
        const known = this.events.filter((e) => e.space === space && ids.includes(e.sourceId));
        this.events = this.events.filter((e) => !(e.space === space && ids.includes(e.sourceId)));
        if (this.dropIdsAnswerOnce) { this.dropIdsAnswerOnce = false; throw new Error("connection lost"); }
        if (known.length === 0) return json(410, { error: { code: "already_deleted" } });
        return json(200, { forgotten: known.length });
      }
      if (!this.threadForgetLive) return json(404, { error: { code: "not_found" } });
      const tag = String(body?.thread ?? "");
      this.forgotten.add(`${space}|${tag}`);
      this.events = this.events.filter((e) => !(e.space === space && e.tag === tag));
      const id = `op_${++this.next}`;
      this.ops.set(id, { polls: 0 });
      return json(202, { operation_id: id });
    }
    const del = url.match(/^https:\/\/api\.fluxrouter\.ai\/v1\/memory\/spaces\/([^/]+)$/);
    if (method === "DELETE" && del) {
      const space = decodeURIComponent(del[1]!);
      if (this.shredded.has(space)) return json(200, { status: "already_deleted" });
      if (!this.spaces.has(space)) return json(404, { error: { code: "memory_not_found" } });
      this.shredded.add(space);
      this.spaces.delete(space);
      this.events = this.events.filter((e) => e.space !== space);
      const id = `op_${++this.next}`;
      this.ops.set(id, { polls: 0 });
      return json(202, { operation_id: id });
    }
    const op = url.match(/^https:\/\/api\.fluxrouter\.ai\/v1\/memory\/operations\/([^/]+)$/);
    if (method === "GET" && op) {
      const entry = this.ops.get(decodeURIComponent(op[1]!));
      if (!entry) return json(404, { error: { code: "memory_not_found" } });
      if (++entry.polls < this.pollsToComplete) return json(200, { status: "pending" });
      return json(200, { operation_id: op[1], status: "done" });
    }
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
  of = (method: string, part?: string) => this.calls.filter((c) => c.method === method && (!part || c.url.includes(part)));
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let clock = 1_000_000;
let key: string | null = KEY_A;
let asksFirst = new Set<string>();
let extraThreads = new Set<string>();
let sleeps = 0;

function captureRig(flux: FakeFlux, onReowe?: () => void) {
  return new FluxMemoryCapture({
    key: () => key,
    threadCaptures: (threadId) => extraThreads.has(threadId) || threadMemoryCaptures(database(), threadId),
    userText: () => "my sister is called Ana",
    asksFirst: (botId) => asksFirst.has(botId),
    ledger: {
      noteUsed: (threadId, botId, fp) => noteFluxSpaceUsed(database(), threadId, botId, fp, clock),
      keyOff: (fp) => fluxKeyOff(database(), fp, clock),
      setKeyOff: (fp, code) => setFluxKeyOff(database(), fp, code, clock),
      accepted: (input) => noteFluxCaptureAccepted(database(), input, clock),
      routeProven: (space, fp) => fluxRouteProven(database(), space, fp),
      threadForgotten: (threadId, code) => tombstoneFluxThread(database(), threadId, code, clock),
      spaceGone: (space, fp, code) => tombstoneFluxSpace(database(), space, fp, code, clock),
      limit: (space, fp) => setFluxSpaceLimit(database(), space, fp, clock),
    },
    ...(onReowe ? { onReowe } : {}),
    fetch: flux.fetch,
    sleep: async () => { sleeps++; },
    log: () => {},
    now: () => clock,
  });
}

function forgetRig(flux: FakeFlux, capture?: FluxMemoryCapture, busy?: (row: FluxForgetRow) => boolean) {
  return new FluxMemoryForget({
    db: () => database(),
    key: () => key,
    busy: busy ?? ((row) => capture ? (row.kind === "bot" ? capture.botBusy(row.botId) : capture.busy(row.threadId)) : false),
    fetch: flux.fetch,
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
  });
}

let turnNo = 0;
function startTurn(capture: FluxMemoryCapture, threadId: string, botId = "moss") {
  const turnId = `u-${++turnNo}`;
  capture.begin({ threadId, warmIdentity: owner(botId) });
  capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Noted.", threadId, turnId });
  capture.observe({ type: "turn.completed", ok: true, threadId, turnId });
}
async function turn(capture: FluxMemoryCapture, threadId: string, botId = "moss") {
  startTurn(capture, threadId, botId);
  await Promise.all([...capture.inflight]);
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deleteConversation = (threadId: string, attempt?: string) => transaction((db) => recordOwnerDeletion(db, threadId, clock, attempt));
const deleteBotRecords = (botId: string, threadIds: string[], attempt = `bot-${botId}`) =>
  transaction((db) => { for (const t of threadIds) recordOwnerDeletion(db, t, clock, attempt); recordOwnerDeletion(db, `bot:${botId}`, clock, attempt); });
const afterGrace = () => { clock += 11_000; };
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const tombstones = () => database().prepare("SELECT kind, subject, key_fp, attempt FROM flux_mem_tombstone ORDER BY kind, subject, key_fp").all() as Array<{ kind: string; subject: string; key_fp: string; attempt: string | null }>;
/** Runs the worker until nothing is due within `ms` (each pass moves the clock to the next due row). */
async function drain(forget: FluxMemoryForget, ms = 2 * HOUR, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await forget.tick();
    const rows = allFluxForgets(database());
    if (rows.length === 0) return;
    const at = Math.min(...rows.map((r) => r.nextAt));
    if (at - clock > ms) return;
    clock = Math.max(clock, at) + 1;
  }
}

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  setFluxMemorySettings({}); setFluxExternalMemory(undefined);
  clock = 1_000_000; key = KEY_A; asksFirst = new Set(); extraThreads = new Set(["g1"]); sleeps = 0;
});
afterEach(() => { setMemoryCaptureRoster(null); setFluxMemorySettings({}); setFluxExternalMemory(undefined); vi.restoreAllMocks(); });

describe("capture goes to the bot's space and names its conversation", () => {
  it("POST /spaces/bot:<hmac>/events with metadata.thread and an Idempotency-Key; the ledger row before the request, the receipt after the 202", async () => {
    const flux = new FakeFlux();
    let ledgerAtSend = -1, receiptsAtSend = -1;
    flux.onPost = () => {
      ledgerAtSend = count("SELECT COUNT(*) AS n FROM flux_mem_used WHERE thread_id='t1'");
      receiptsAtSend = count("SELECT COUNT(*) AS n FROM flux_mem_receipt");
    };
    const capture = captureRig(flux);
    await turn(capture, "t1");
    const space = fluxBotSpace(database(), "moss");
    const tag = fluxThreadTag(database(), "t1");
    expect(space).toMatch(/^bot:[0-9a-f]{64}$/);
    expect(space).toHaveLength(68);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    expect(flux.calls).toHaveLength(1);
    const call = flux.calls[0]!;
    expect(call.url).toBe(`${BASE}/spaces/${encodeURIComponent(space)}/events`);
    expect(call.idem).toMatch(/^[0-9a-f]{64}$/);
    expect(call.body).toMatchObject({ client_event_id: call.idem, metadata: { app: "murage", kind: "turn", thread: tag } });
    expect(JSON.stringify(call)).not.toMatch(/"t1"|moss/);
    expect([ledgerAtSend, receiptsAtSend]).toEqual([1, 0]);
    expect(database().prepare("SELECT space, key_fp, thread_id, source_id FROM flux_mem_receipt").all()).toEqual([{ space, key_fp: fluxKeyFingerprint(KEY_A), thread_id: "t1", source_id: "src_1" }]);
    expect(database().prepare("SELECT thread_id, space, bot_id, thread_tag FROM flux_mem_used").all()).toEqual([{ thread_id: "t1", space, bot_id: "moss", thread_tag: tag }]);
    // the same bot's other conversation goes to the same space with its own tag; another bot has its own space
    await turn(capture, "t3");
    await turn(capture, "t2", "fern");
    expect(flux.calls[1]!.url).toBe(call.url);
    expect((flux.calls[1]!.body!.metadata as { thread: string }).thread).toBe(fluxThreadTag(database(), "t3"));
    expect(flux.calls[2]!.url).toBe(`${BASE}/spaces/${encodeURIComponent(fluxBotSpace(database(), "fern"))}/events`);
  });

  it("a retried capture keeps its Idempotency-Key", async () => {
    const flux = new FakeFlux();
    flux.forced.POST = [{ status: 503 }, { status: 503 }];
    await turn(captureRig(flux), "t1");
    expect(flux.calls).toHaveLength(3);
    expect(new Set(flux.calls.map((c) => c.idem)).size).toBe(1);
    expect(flux.events).toHaveLength(1);
  });

  for (const status of [404, 405]) {
    it(`an older proxy answering ${status}: not available, nothing is sent anywhere else, probed again after 6 hours`, async () => {
      const flux = new FakeFlux();
      flux.forced.POST = [{ status, body: { error: { code: "not_found" } } }];
      const capture = captureRig(flux);
      await turn(capture, "t1");
      await turn(capture, "t1");
      await turn(capture, "t2", "fern");
      expect(flux.calls.map((c) => c.method)).toEqual(["POST"]);
      expect(count("SELECT COUNT(*) AS n FROM flux_mem_tombstone")).toBe(0);
      clock += 6 * HOUR + 1;
      await turn(capture, "t2", "fern");
      expect(flux.calls).toHaveLength(2);
    });
  }

  it("\"Ask me before it changes anything\": that bot sends nothing; an owner turn with no bot sends nothing; switching it off captures again", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    asksFirst.add("moss");
    await turn(capture, "t1", "moss");
    capture.begin({ threadId: "t2", warmIdentity: { audience: "owner", decidedOwner: true } as never });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "x", threadId: "t2" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "t2" });
    await Promise.all([...capture.inflight]);
    expect(flux.calls).toEqual([]);
    asksFirst.delete("moss");
    await turn(capture, "t1", "moss");
    expect(flux.calls).toHaveLength(1);
  });

  it("the server reads askFirst from the bot's learning settings and refuses an unknown bot", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).toContain("asksFirst: (botId) => { const bot = store.bot(botId); return !bot || readBotLearning(bot).askFirst; }");
  });

  it("no capture request starts once the deletion is recorded, even mid-turn", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    capture.begin({ threadId: "t1", warmIdentity: owner() });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "x", threadId: "t1" });
    deleteConversation("t1");
    capture.observe({ type: "turn.completed", ok: true, threadId: "t1" });
    await Promise.all([...capture.inflight]);
    expect(flux.calls).toEqual([]);
  });
});

describe("409 and 429: no memory, a calm Settings line, a recheck with one real turn", () => {
  it("409 memory_account_not_enabled: one request, no retry, looked at again after 30 minutes; Settings says not_enabled", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.keyOff.set(KEY_A, "memory_account_not_enabled");
    await turn(capture, "t1");
    await turn(capture, "t2", "fern");
    expect(flux.calls).toHaveLength(1);
    expect(sleeps).toBe(0);
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("not_enabled");
    clock += 29 * 60_000;
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(1);
    clock += 60_001;
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBeNull();
    flux.keyOff.delete(KEY_A); // FluxMain auto-enabled the key
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(2);
    expect(flux.events).toHaveLength(1);
  });

  it("409 memory_consent_disabled: off for this key, looked at again after 24 hours; Settings says consent", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.keyOff.set(KEY_A, "memory_consent_disabled");
    await turn(capture, "t1");
    clock += 60 * 60_000;
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(1);
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("consent");
    clock += 23 * HOUR + 1;
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(2); // one real turn looks again, and latches again
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("consent");
  });

  it("409 key_unenrolled_no_auto_reenroll is final for that key; another key captures afresh", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.keyOff.set(KEY_A, "key_unenrolled_no_auto_reenroll");
    await turn(capture, "t1");
    clock += 365 * 24 * HOUR;
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(1);
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("final");
    key = KEY_B;
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(2);
    expect(flux.events).toHaveLength(1);
  });

  it("429 memory_end_user_limit: one request (no retry, Retry-After ignored), that bot sends nothing, others do; Settings counts it; one turn looks again after 24 hours", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t2", "fern");
    flux.maxSpaces = 1;
    await turn(capture, "t1");
    expect(flux.of("POST", "/events")).toHaveLength(2);
    expect(sleeps).toBe(0);
    expect(fluxLimitedBots(database(), fluxKeyFingerprint(KEY_A))).toBe(1);
    await turn(capture, "t1");
    await turn(capture, "t3");
    expect(flux.of("POST", "/events")).toHaveLength(2);
    await turn(capture, "t2", "fern"); // fern's space exists: not refused
    expect(flux.of("POST", "/events")).toHaveLength(3);
    // a full account is not a key that is off, and a limit is never a tombstone
    expect(fluxKeyOff(database(), fluxKeyFingerprint(KEY_A), clock)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_tombstone")).toBe(0);
    clock += 24 * HOUR + 1;
    await turn(capture, "t1");
    expect(flux.of("POST", "/events")).toHaveLength(4); // one look, still full
    await turn(capture, "t1");
    expect(flux.of("POST", "/events")).toHaveLength(4);
    flux.maxSpaces = Infinity; // another bot was deleted, room again
    clock += 24 * HOUR + 1;
    await turn(capture, "t1");
    expect(flux.of("POST", "/events")).toHaveLength(5);
    expect(fluxLimitedBots(database(), fluxKeyFingerprint(KEY_A))).toBe(0);
  });

  it("a 429 that is not memory_end_user_limit is retried with the same key", async () => {
    const flux = new FakeFlux();
    flux.forced.POST = [{ status: 429, body: { error: { code: "rate_limited" } } }];
    await turn(captureRig(flux), "t1");
    expect(flux.of("POST", "/events")).toHaveLength(2);
    expect(fluxLimitedBots(database(), fluxKeyFingerprint(KEY_A))).toBe(0);
  });

  it("the settings route returns keyOff {reason}|null, limitedBots and forgetsWaiting; Settings shows one calm line for each, no toast", () => {
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain("keyOff:fluxKeyOffNow,limitedBots:fluxLimited,forgetsWaiting:fluxForgetsWaiting");
    expect(index).toContain("fluxKeyOffNow=reason?{reason}:null");
    const settings = readFileSync(join(import.meta.dirname, "..", "src", "components", "MemorySettings.tsx"), "utf8");
    expect(settings).toContain("Flux memory is not switched on for this Flux account yet, so new turns are not saved there. Murage's own memory keeps working.");
    expect(settings).toContain("Flux memory is full for this Flux account (1,000 bots), so");
    expect(settings).toContain('data-testid="flux-memory-limited-bots"');
    expect(settings).toContain('data-testid="flux-memory-forgets-waiting"');
    const capture = readFileSync(join(import.meta.dirname, "flux-memory-capture.ts"), "utf8");
    expect(capture).not.toMatch(/toast/i);
  });
});

describe("404 memory_not_found and 409 memory_thread_forgotten tombstone what Flux refused", () => {
  it("404 memory_not_found tombstones the space for this key; the next turn sends nothing; another bot still captures", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    const space = fluxBotSpace(database(), "moss");
    flux.shredded.add(space); // a restored pre-delete copy: no local tombstone, Flux shredded the space
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(1);
    expect(tombstones()).toEqual([{ kind: "space", subject: space, key_fp: fluxKeyFingerprint(KEY_A), attempt: null }]);
    await turn(capture, "t1");
    await turn(capture, "t3");
    expect(flux.calls).toHaveLength(1);
    await turn(capture, "t2", "fern");
    expect(flux.calls).toHaveLength(2);
    // the tombstone is not withdrawn by any attempt
    transaction((db) => withdrawFluxForget(db, "anything"));
    expect(tombstones()).toHaveLength(1);
  });

  it("409 memory_thread_forgotten tombstones the thread (a restored pre-delete copy); the bot keeps capturing its other conversations", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.forgotten.add(`${fluxBotSpace(database(), "moss")}|${fluxThreadTag(database(), "t1")}`);
    await turn(capture, "t1");
    expect(tombstones()).toEqual([{ kind: "thread", subject: "t1", key_fp: "", attempt: null }]);
    expect(fluxKeyOff(database(), fluxKeyFingerprint(KEY_A), clock)).toBe(false);
    await turn(capture, "t1");
    expect(flux.calls).toHaveLength(1);
    await turn(capture, "t3");
    expect(flux.calls).toHaveLength(2);
    expect(sleeps).toBe(0);
  });
});

describe("forget a deleted conversation", () => {
  it("the deletion owes a thread forget in its own transaction: POST {space}/forget {thread}, poll, then done; the tombstone stays", async () => {
    const flux = new FakeFlux();
    flux.pollsToComplete = 2;
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t3");
    const space = fluxBotSpace(database(), "moss");
    const tag = fluxThreadTag(database(), "t1");
    deleteConversation("t1");
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", space, threadId: "t1", threadTag: tag, state: "owed" }]);
    expect(tombstones()).toMatchObject([{ kind: "thread", subject: "t1", key_fp: "" }]);
    const forget = forgetRig(flux, capture);
    await forget.tick();
    expect(flux.of("POST", "/forget")).toEqual([]); // inside the grace
    afterGrace();
    await forget.tick();
    expect(flux.of("POST", "/forget")).toMatchObject([{ url: `${BASE}/spaces/${encodeURIComponent(space)}/forget`, key: KEY_A, body: { thread: tag } }]);
    expect(allFluxForgets(database())).toMatchObject([{ state: "polling", opId: "op_1" }]);
    clock += 5_001; await forget.tick();
    expect(allFluxForgets(database())).toMatchObject([{ state: "polling", polls: 1 }]);
    clock += 15_001; await forget.tick();
    expect(allFluxForgets(database())).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_used WHERE thread_id='t1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_used WHERE thread_id='t3'")).toBe(1);
    expect(tombstones()).toMatchObject([{ kind: "thread", subject: "t1" }]);
    // only that conversation is gone at Flux; the bot's other conversation stays
    expect(flux.events.map((e) => e.tag)).toEqual([fluxThreadTag(database(), "t3")]);
    expect(flux.of("DELETE")).toEqual([]);
  });

  it("a channel conversation two bots replied in is in two spaces: deleting it owes a thread forget in each", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "g1", "moss");
    await turn(capture, "g1", "fern");
    const spaces = [fluxBotSpace(database(), "moss"), fluxBotSpace(database(), "fern")].sort();
    deleteConversation("g1");
    expect(allFluxForgets(database()).map((r) => [r.kind, r.space, r.threadId]).sort()).toEqual(spaces.map((s) => ["thread", s, "g1"]));
    afterGrace();
    await drain(forgetRig(flux, capture));
    expect(flux.of("POST", "/forget").map((c) => decodeURIComponent(c.url).split("/spaces/")[1]).sort()).toEqual(spaces.map((s) => `${s}/forget`));
    expect(allFluxForgets(database())).toEqual([]);
    expect(flux.events).toEqual([]);
  });

  it("a conversation never captured owes nothing and makes no call", async () => {
    const flux = new FakeFlux();
    deleteConversation("t2");
    afterGrace();
    await forgetRig(flux).start();
    expect(allFluxForgets(database())).toEqual([]);
    expect(flux.calls).toEqual([]);
  });

  it("forget-by-thread not live: the receipts go by id in batches of 100, the row stays owed, a later thread forget finishes it", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    for (let i = 0; i < 150; i++) { clock++; await turn(capture, "t1"); }
    await turn(capture, "t3");
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(150);
    deleteConversation("t1");
    afterGrace();
    flux.threadForgetLive = false;
    const forget = forgetRig(flux, capture);
    await forget.tick();
    const ids = flux.of("POST", "/forget").filter((c) => Array.isArray(c.body?.source_ids)).map((c) => (c.body!.source_ids as string[]).length);
    expect(ids).toEqual([100, 50]);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(0);
    expect(flux.events.filter((e) => e.tag === fluxThreadTag(database(), "t1"))).toEqual([]);
    const [row] = allFluxForgets(database());
    expect(row).toMatchObject({ kind: "thread", state: "owed", threadId: "t1", fallbackAt: clock });
    expect(row!.nextAt).toBe(clock + HOUR);
    // still not live an hour later: asked again, nothing left to send by id, still owed
    clock += HOUR + 1; await forget.tick();
    expect(allFluxForgets(database())).toHaveLength(1);
    flux.threadForgetLive = true;
    clock += HOUR + 1; await forget.tick();
    clock += 5_001; await forget.tick();
    expect(allFluxForgets(database())).toEqual([]);
    expect(flux.events.map((e) => e.tag)).toEqual([fluxThreadTag(database(), "t3")]);
  });

  it("the receipt gap: a capture whose receipt was never written is forgotten only by the thread forget; the row is never done from the ids fallback", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    flux.noSourceIdOnce = true;
    await turn(capture, "t1");
    expect(flux.events).toHaveLength(2);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(1);
    deleteConversation("t1");
    afterGrace();
    flux.threadForgetLive = false;
    const forget = forgetRig(flux, capture);
    await forget.tick();
    clock += HOUR + 1; await forget.tick();
    expect(flux.events).toHaveLength(1); // the unreceipted capture is still at Flux
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", state: "owed" }]);
    flux.threadForgetLive = true;
    clock += HOUR + 1; await forget.tick();
    clock += 5_001; await forget.tick();
    expect(flux.events).toEqual([]);
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("409 memory_thread_forgotten answered to a thread forget is done and never latches key-off; another 409 latches and keeps the row", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t3");
    deleteConversation("t1");
    deleteConversation("t3");
    afterGrace();
    flux.forced.POST = [{ status: 409, body: { error: { code: "memory_thread_forgotten" } } }, { status: 409, body: { error: { code: "memory_consent_disabled" } } }];
    const forget = forgetRig(flux, capture);
    await forget.tick();
    const left = allFluxForgets(database());
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ state: "owed", lastStatus: 409 });
    expect(left[0]!.nextAt - clock).toBe(6 * HOUR);
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("consent");
  });

  it("a 2xx with no operation id is not done; the thread forget is sent again", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    deleteConversation("t1");
    afterGrace();
    flux.forced.POST = [{ status: 202, body: { status: "accepted" } }];
    const forget = forgetRig(flux, capture);
    await forget.tick();
    expect(allFluxForgets(database())).toMatchObject([{ state: "owed", attempts: 1 }]);
    clock += 30_001; await forget.tick();
    clock += 5_001; await forget.tick();
    expect(flux.of("POST", "/forget")).toHaveLength(2);
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("a poll answering 404 returns the row to owed with one forget backoff step, never a spin", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    deleteConversation("t1");
    afterGrace();
    const forget = forgetRig(flux, capture);
    await forget.tick();
    flux.forced.GET = [{ status: 404, body: { error: { code: "not_found" } } }];
    clock += 5_001; await forget.tick();
    const [row] = allFluxForgets(database());
    expect(row).toMatchObject({ state: "owed", opId: null, attempts: 1, lastStatus: 404 });
    expect(row!.nextAt - clock).toBe(30_000);
    await forget.tick();
    expect(flux.of("POST", "/forget")).toHaveLength(1);
  });

  it("a deletion that rolls back owes nothing and leaves no tombstone", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    expect(() => transaction((db) => { recordOwnerDeletion(db, "t1", clock); throw new Error("save failed"); })).toThrow("save failed");
    expect(allFluxForgets(database())).toEqual([]);
    expect(tombstones()).toEqual([]);
  });
});

describe("delete a deleted bot's space", () => {
  it("bot deletion: DELETE {space}, poll, done; its thread rows, used rows and receipts go; its tombstones stay and it never captures again", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t3");
    await turn(capture, "t2", "fern");
    const space = fluxBotSpace(database(), "moss");
    deleteBotRecords("moss", ["t1", "t3"]);
    expect(allFluxForgets(database()).map((r) => r.kind).sort()).toEqual(["bot", "thread", "thread"]);
    expect(tombstones().filter((t) => t.kind === "space")).toEqual([
      { kind: "space", subject: space, key_fp: "", attempt: "bot-moss" },
      { kind: "space", subject: space, key_fp: fluxKeyFingerprint(KEY_A), attempt: "bot-moss" },
    ].sort((a, b) => a.key_fp.localeCompare(b.key_fp)));
    afterGrace();
    const forget = forgetRig(flux, capture, (row) => row.kind === "thread"); // the bot row goes first
    await forget.tick();
    expect(flux.of("DELETE")).toMatchObject([{ url: `${BASE}/spaces/${encodeURIComponent(space)}`, key: KEY_A }]);
    clock += 5_001; await forget.tick();
    expect(allFluxForgets(database())).toEqual([]); // the shred covered the thread rows
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_used WHERE space=?", space)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE space=?", space)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_used WHERE bot_id='fern'")).toBe(1);
    expect(flux.of("POST", "/forget")).toEqual([]);
    expect(tombstones().filter((t) => t.kind === "space")).toHaveLength(2);
    // a turn of the deleted bot (a stale dispatch) sends nothing
    extraThreads.add("t5");
    await turn(capture, "t5", "moss");
    expect(flux.of("POST", "/events")).toHaveLength(3);
  });

  it("a bot that never captured: its space is tombstoned for every key, and no call is made", async () => {
    const flux = new FakeFlux();
    deleteBotRecords("moss", ["t1"]);
    afterGrace();
    await forgetRig(flux).start();
    expect(flux.calls).toEqual([]);
    expect(tombstones()).toMatchObject([{ kind: "space", subject: fluxBotSpace(database(), "moss"), key_fp: "" }, { kind: "thread", subject: "t1" }]);
    expect(noteFluxSpaceUsed(database(), "t9", "moss", fluxKeyFingerprint(KEY_B), clock)).toBeNull();
  });

  it("a channel capture in flight across a bot deletion is aborted, the DELETE waits until it settles; a late 2xx re-owes the shred", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    // (1) an abortable request: forgetBot aborts it in the channel, and the DELETE waits for it to settle and the grace
    flux.hold = { ignoreAbort: false };
    startTurn(capture, "g1", "moss");
    await flush();
    expect(capture.botBusy("moss")).toBe(true);
    deleteBotRecords("moss", ["t1"]);
    capture.forgetBot("moss");
    const forget = forgetRig(flux, capture);
    afterGrace();
    await Promise.all([...capture.inflight]);
    expect(flux.events.filter((e) => e.tag === fluxThreadTag(database(), "g1"))).toEqual([]);
    expect(capture.botBusy("moss")).toBe(true); // settled just now: the grace runs
    await forget.tick();
    expect(flux.of("DELETE")).toEqual([]);
    clock += 10_001;
    expect(capture.botBusy("moss")).toBe(false);
    await drain(forget);
    expect(flux.of("DELETE")).toHaveLength(1);
    expect(allFluxForgets(database())).toEqual([]);
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain('onOwnerDeletion((key) => { if (key.startsWith("bot:")) fluxMemoryCapture.forgetBot(key.slice(4)); fluxMemoryForget.poke(); });');
  });

  it("a late 2xx that lands after the shred finished re-owes it at once; DONE never stands on a forget sent before a late capture", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    flux.hold = { ignoreAbort: true };
    startTurn(capture, "g1", "moss");
    await flush();
    deleteBotRecords("moss", ["t1"]);
    afterGrace();
    // another process's worker (no view of this capture) shreds and finishes
    const blind = forgetRig(flux, undefined, () => false);
    await drain(blind);
    expect(allFluxForgets(database())).toEqual([]);
    // Flux accepted the late capture before its shred fence: the answer lands now
    flux.shredded.delete(fluxBotSpace(database(), "moss"));
    flux.hold.release!();
    await Promise.all([...capture.inflight]);
    expect(allFluxForgets(database())).toMatchObject([{ kind: "bot", space: fluxBotSpace(database(), "moss"), state: "owed", opId: null }]);
    await drain(blind);
    expect(flux.of("DELETE")).toHaveLength(2);
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("busy holds until send() settles: forgetThread aborts but the thread forget still waits for the answer and the grace; a late 2xx re-owes the thread", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    flux.hold = { ignoreAbort: true };
    startTurn(capture, "t1");
    await flush();
    deleteConversation("t1");
    capture.forgetThread("t1");
    expect(capture.busy("t1")).toBe(true);
    afterGrace();
    const forget = forgetRig(flux, capture);
    await forget.tick();
    expect(flux.of("POST", "/forget")).toEqual([]);
    flux.hold.release!();
    await Promise.all([...capture.inflight]);
    expect(capture.busy("t1")).toBe(true);
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", threadId: "t1", state: "owed" }]);
    clock += 10_001;
    await drain(forget);
    expect(flux.events).toEqual([]);
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("a legacy thread: space row (this branch's unreleased tables) becomes a DELETE of that stored space; the old tables go in one step", async () => {
    const flux = new FakeFlux();
    const db = database();
    const legacy = `thread:${"9".repeat(64)}`;
    const fp = fluxKeyFingerprint(KEY_A);
    db.exec("CREATE TABLE flux_space_used (thread_id TEXT NOT NULL, key_fp TEXT NOT NULL, space TEXT NOT NULL, first_at INTEGER NOT NULL, PRIMARY KEY(thread_id, key_fp, space))");
    db.exec("CREATE TABLE flux_space_gen (thread_id TEXT PRIMARY KEY, gen INTEGER NOT NULL)");
    db.exec("CREATE TABLE flux_forget_owed (space TEXT NOT NULL, key_fp TEXT NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, op_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, polls INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_status INTEGER, attempt TEXT NOT NULL, PRIMARY KEY(space, key_fp))");
    db.prepare("INSERT INTO flux_space_used VALUES('t1', ?, ?, 1)").run(fp, legacy);
    flux.spaces.add(legacy);
    initializeFluxSpaces(db, clock);
    expect(allFluxForgets(db)).toMatchObject([{ kind: "bot", space: legacy, keyFp: fp, threadTag: "", state: "owed" }]);
    for (const table of ["flux_space_used", "flux_space_gen", "flux_forget_owed"]) {
      expect(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name=?").get(table)).toBeUndefined();
    }
    await drain(forgetRig(flux));
    expect(flux.of("DELETE")).toMatchObject([{ url: `${BASE}/spaces/${encodeURIComponent(legacy)}` }]);
    expect(allFluxForgets(db)).toEqual([]);
  });

  it("a replaced salt still shreds the stored space, never a recomputed name", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    const stored = fluxBotSpace(database(), "moss");
    database().prepare("UPDATE flux_space_meta SET salt=? WHERE id=1").run("f".repeat(64));
    expect(fluxBotSpace(database(), "moss")).not.toBe(stored);
    deleteBotRecords("moss", ["t1"]);
    afterGrace();
    await drain(forgetRig(flux, capture));
    expect(flux.of("DELETE").map((c) => c.url)).toEqual([`${BASE}/spaces/${encodeURIComponent(stored)}`]);
    expect(flux.of("POST", "/forget").every((c) => c.url.includes(encodeURIComponent(stored)))).toBe(true);
    expect(flux.events).toEqual([]);
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("a 2xx DELETE with no operation id stays owed; 409 latches key-off and keeps the row; 404 without memory_not_found is not done", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    deleteBotRecords("moss", []);
    afterGrace();
    flux.forced.DELETE = [{ status: 202, body: { status: "accepted" } }, { status: 409, body: { error: { code: "memory_consent_disabled" } } }, { status: 404, body: { error: { code: "not_found" } } }];
    const forget = forgetRig(flux, capture);
    await forget.tick();
    expect(allFluxForgets(database())).toMatchObject([{ kind: "bot", state: "owed", attempts: 1 }]);
    clock += 30_001; await forget.tick();
    expect(fluxKeyOff(database(), fluxKeyFingerprint(KEY_A), clock)).toBe(true);
    expect(allFluxForgets(database())).toMatchObject([{ state: "owed", lastStatus: 409 }]);
    clock += 6 * HOUR + 1; await forget.tick();
    expect(allFluxForgets(database())).toMatchObject([{ state: "owed", lastStatus: 404 }]);
    clock += 6 * HOUR + 1; await forget.tick();
    clock += 5_001; await forget.tick();
    expect(allFluxForgets(database())).toEqual([]);
    expect(flux.of("DELETE")).toHaveLength(4);
  });
});

describe("every obligation survives a crash; only its own key finishes it", () => {
  it("a crash after the deletion commits: a new worker at start sends the forget", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    deleteConversation("t1");
    afterGrace();
    const restarted = forgetRig(flux);
    await restarted.start();
    expect(flux.of("POST", "/forget")).toHaveLength(1);
    clock += 5_001; await restarted.tick();
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("a crash while polling: the new worker polls the saved operation and sends no second request", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    deleteBotRecords("moss", ["t1"]);
    afterGrace();
    await forgetRig(flux, undefined, (row) => row.kind === "thread").tick();
    expect(allFluxForgets(database()).find((r) => r.kind === "bot")).toMatchObject({ state: "polling", opId: "op_1" });
    clock += 5_001;
    const restarted = forgetRig(flux, undefined, (row) => row.kind === "thread");
    await restarted.start();
    expect(flux.of("DELETE")).toHaveLength(1);
    expect(flux.calls.at(-1)).toMatchObject({ method: "GET", url: `${BASE}/operations/op_1` });
    expect(allFluxForgets(database())).toEqual([]);
  });

  it("a crash after the ids were sent: the new worker resends them, 410 already_deleted counts, and the receipts go", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    await turn(captureRig(flux), "t1");
    deleteConversation("t1");
    afterGrace();
    flux.threadForgetLive = false;
    flux.dropIdsAnswerOnce = true;
    await forgetRig(flux).tick();
    expect(flux.events).toEqual([]); // Flux applied them
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(2); // the answer never came
    clock += 30_001;
    await forgetRig(flux).start();
    expect(flux.of("POST", "/forget").filter((c) => Array.isArray(c.body?.source_ids))).toHaveLength(2);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(0);
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", state: "owed" }]);
  });

  it("another key sends nothing: the row waits for its own key, and Settings counts the deleted bots and conversations waiting", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t2", "fern");
    deleteConversation("t1");
    deleteBotRecords("fern", ["t2"]);
    afterGrace();
    key = KEY_B;
    const forget = forgetRig(flux, capture);
    await forget.tick();
    expect(flux.calls.filter((c) => !c.url.endsWith("/events"))).toEqual([]);
    expect(fluxForgetsWaitingForKey(database(), fluxKeyFingerprint(KEY_B))).toBe(3); // t1, t2, fern's space
    expect(fluxForgetsWaitingForKey(database(), null)).toBe(3);
    // with the second key the first key's tombstoned bot space still refuses (key_fp '')
    expect(noteFluxSpaceUsed(database(), "t2", "fern", fluxKeyFingerprint(KEY_B), clock)).toBeNull();
    key = KEY_A;
    clock += 6 * HOUR + 1;
    await drain(forget);
    expect(allFluxForgets(database())).toEqual([]);
    expect(fluxForgetsWaitingForKey(database(), fluxKeyFingerprint(KEY_A))).toBe(0);
  });
});

describe("a failed bot save withdraws only what its own attempt wrote (R4.8, R4.12.2)", () => {
  it("an earlier conversation deletion keeps its owner-deletion record and its Flux tombstone; this attempt's bot rows are withdrawn", async () => {
    const flux = new FakeFlux();
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    extraThreads.add(bot.threadId);
    const capture = captureRig(flux);
    await turn(capture, bot.threadId, bot.id);
    deleteConversation(bot.threadId, "earlier"); // committed earlier
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(true);
    vi.spyOn(store as unknown as { saveBots(b: unknown): void }, "saveBots").mockImplementation(() => { throw new Error("disk"); });
    expect(() => store.deleteBot(bot.id)).toThrow("disk");
    expect(store.bot(bot.id)).toBeTruthy();
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(true);
    expect(ownerDeletedThread(database(), `bot:${bot.id}`)).toBe(false);
    expect(tombstones()).toEqual([{ kind: "thread", subject: bot.threadId, key_fp: "", attempt: "earlier" }]);
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", threadId: bot.threadId }]);
    // the bot is still there: its space is not tombstoned, it captures in another conversation
    extraThreads.add("t-new");
    await turn(capture, "t-new", bot.id);
    expect(flux.of("POST", "/events")).toHaveLength(2);
    const source = readFileSync(join(import.meta.dirname, "store.ts"), "utf8");
    const deleteBot = source.slice(source.indexOf("  deleteBot(id: string,")).slice(0, 4000);
    expect(deleteBot).toContain("for (const key of [...botThreadIds, botDeletionKey(id)]) if (recordOwnerDeletion(db, key, now, fluxAttempt)) recorded.push(key);");
    expect(deleteBot).toContain("for (const key of recorded) withdrawOwnerDeletion(db, key); withdrawFluxForget(db, fluxAttempt);");
  });

  it("withdraw takes back only owed rows never sent, and never a tombstone Flux's own answer wrote", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t3");
    tombstoneFluxThread(database(), "t7", "memory_thread_forgotten", clock);
    deleteBotRecords("moss", ["t1", "t3"], "attempt-1");
    afterGrace();
    // one thread row already sent (polling): it stands
    await forgetRig(flux, capture, (row) => row.kind === "bot" || row.threadId === "t3").tick();
    transaction((db) => withdrawFluxForget(db, "attempt-1"));
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", threadId: "t1", state: "polling" }]);
    expect(tombstones()).toEqual([{ kind: "thread", subject: "t7", key_fp: "", attempt: null }]);
  });
});

describe("explicit-only capture: every Flux-routed request says capture off; only Murage's own POST captures", () => {
  // the wire decision is per audience (fluxMemoryContextForTurn reads background/prewarm/warmIdentity); the thread is the capture's
  const wire = (_threadId: string, botId = "moss") => fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: owner(botId) }));

  it("an owner memory-on turn carries capture off on the wire (inject unchanged) and is captured once, by Murage's POST", async () => {
    const decision = wire("t1");
    expect(decision.capture).toBe("on");
    expect(decision.headers["x-flux-memory-capture"]).toBe("off");
    expect(decision.headers["x-flux-memory-inject"]).toBeUndefined();
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    expect(flux.of("POST", "/events")).toHaveLength(1);
  });

  it("a memory-off owner turn carries capture off and makes no POST", async () => {
    setMemoryMode("off");
    expect(wire("t1").headers["x-flux-memory-capture"]).toBe("off");
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    expect(flux.calls).toEqual([]);
  });

  it("an excluded conversation's owner turn carries capture off and makes no POST", async () => {
    const db = database();
    expect(threadMemoryCaptures(db, "t1")).toBe(true); // the memory schema is ready, and the conversation captures before it is excluded
    // the owner's settings binding, shaped as Murage writes it (server/memory/feedback.test.ts bind)
    db.exec("INSERT OR IGNORE INTO memory_scopes VALUES('s-excluded','conversation','t-excluded','[]',0)");
    db.prepare("INSERT OR REPLACE INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('memory-owner-settings','s-excluded','owner-settings','x',1,'granted',?)").run(JSON.stringify({ excludedThreadIds: ["t1"] }));
    expect(threadMemoryCaptures(db, "t1")).toBe(false);
    expect(wire("t1").headers["x-flux-memory-capture"]).toBe("off");
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    expect(flux.calls).toEqual([]);
  });

  it("every codex provider table says capture off", () => {
    for (const headers of Object.values(FLUX_CODEX_TABLE_HEADERS)) expect(headers["x-flux-memory-capture"]).toBe("off");
  });
});

describe("106 fix round 1 (Grok M, Astra M1 to M3, L1)", () => {
  it("once the route is proven for this space and key, ANY 404 to a capture tombstones the space; the 6 h latch never starts", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    const space = fluxBotSpace(database(), "moss");
    await turn(capture, "t1");
    expect(fluxRouteProven(database(), space, fluxKeyFingerprint(KEY_A))).toBe(true);
    flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }];
    await turn(capture, "t1");
    expect(tombstones()).toEqual([{ kind: "space", subject: space, key_fp: fluxKeyFingerprint(KEY_A), attempt: null }]);
    // moss sends nothing again; another bot still captures at once (no "older proxy" latch)
    await turn(capture, "t3");
    await turn(capture, "t2", "fern");
    expect(flux.of("POST", "/events")).toHaveLength(3);
    expect(flux.events.map((e) => e.space)).toEqual([space, fluxBotSpace(database(), "fern")]);
  });

  it("the proof is durable: a new process (same DB) treats a bare 404 on that space as gone; a 404 with no body too", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    const space = fluxBotSpace(database(), "moss");
    flux.forced.POST = [{ status: 404, body: null }];
    await turn(captureRig(flux), "t1");
    expect(tombstones()).toMatchObject([{ kind: "space", subject: space }]);
    expect(fluxSpacesGone(database(), fluxKeyFingerprint(KEY_A))).toBe(1);
  });

  it("before the route is proven for that space and key, a bare 404 is an older proxy (6 h latch) and tombstones nothing; another key's proof does not count", async () => {
    const flux = new FakeFlux();
    key = KEY_B;
    await turn(captureRig(flux), "t1");
    key = KEY_A;
    expect(fluxRouteProven(database(), fluxBotSpace(database(), "moss"), fluxKeyFingerprint(KEY_A))).toBe(false);
    flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }];
    const capture = captureRig(flux);
    await turn(capture, "t1");
    await turn(capture, "t2", "fern");
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_tombstone")).toBe(0);
    expect(flux.of("POST", "/events")).toHaveLength(2);
  });

  it("an unproven space's 6 h latch cannot suppress a proven space's 404", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    flux.forced.POST = [{ status: 404, body: null }];
    await turn(capture, "t2", "fern"); // unproven route starts the latch
    flux.forced.POST = [{ status: 404, body: null }];
    await turn(capture, "t1"); // proven route must still be checked and tombstoned
    expect(flux.of("POST", "/events")).toHaveLength(3);
    expect(tombstones()).toEqual([{
      kind: "space", subject: fluxBotSpace(database(), "moss"), key_fp: fluxKeyFingerprint(KEY_A), attempt: null,
    }]);
    await turn(capture, "t2", "fern");
    expect(flux.of("POST", "/events")).toHaveLength(3); // fern's unproven route still waits
  });

  it("an unavailable route for one key does not latch another key", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.forced.POST = [{ status: 404, body: null }];
    await turn(capture, "t1");
    key = KEY_B;
    await turn(capture, "t1");
    expect(flux.events).toMatchObject([{ key: KEY_B }]);
    key = KEY_A;
    await turn(capture, "t1");
    expect(flux.of("POST", "/events")).toHaveLength(2);
    expect(tombstones()).toEqual([]);
  });

  it.each(["receipt", "2xx without a receipt"])("a durable %s proves the route after restart", async (proof) => {
    const flux = new FakeFlux();
    flux.noSourceIdOnce = proof !== "receipt";
    await turn(captureRig(flux), "t1");
    if (proof === "receipt") database().exec("DELETE FROM flux_mem_proven"); // pre-proof-table ledger
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(proof === "receipt" ? 1 : 0);
    const space = fluxBotSpace(database(), "moss");
    expect(fluxRouteProven(database(), space, fluxKeyFingerprint(KEY_A))).toBe(true);
    flux.forced.POST = [{ status: 404, body: null }];
    await turn(captureRig(flux), "t1");
    expect(tombstones()).toMatchObject([{ kind: "space", subject: space, key_fp: fluxKeyFingerprint(KEY_A) }]);
  });

  it("only the original key can poll a pending forget to completion", async () => {
    const flux = new FakeFlux();
    await turn(captureRig(flux), "t1");
    deleteConversation("t1");
    afterGrace();
    const forget = forgetRig(flux);
    await forget.tick();
    const [polling] = allFluxForgets(database());
    expect(polling).toMatchObject({ state: "polling", keyFp: fluxKeyFingerprint(KEY_A) });
    key = KEY_B;
    clock = polling!.nextAt;
    await forget.tick();
    expect(flux.of("GET")).toEqual([]);
    expect(allFluxForgets(database())).toMatchObject([{ state: "polling", opId: polling!.opId }]);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(1);
    key = KEY_A;
    clock = allFluxForgets(database())[0]!.nextAt;
    await forget.tick();
    expect(flux.of("GET")).toMatchObject([{ key: KEY_A }]);
    expect(allFluxForgets(database())).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt")).toBe(0);
  });

  it("M1: a late 2xx that re-owes a forget wakes an idle worker at once (the arm is recorded, no manual tick)", async () => {
    const flux = new FakeFlux();
    const arms: number[] = [];
    const runs: Array<() => void> = [];
    const forget = new FluxMemoryForget({
      db: () => database(), key: () => key, busy: () => false, fetch: flux.fetch, now: () => clock,
      setTimer: (run, ms) => { arms.push(ms); runs.push(run); return runs.length; }, clearTimer: () => {}, log: () => {},
    });
    const capture = captureRig(flux, () => forget.poke());
    await turn(capture, "t1");
    flux.hold = { ignoreAbort: true };
    startTurn(capture, "t1");
    await flush();
    deleteConversation("t1");
    afterGrace();
    // the worker finishes the thread forget while the capture is held (it cannot see it), then goes idle
    await drain(forget);
    expect(allFluxForgets(database())).toEqual([]);
    arms.length = 0;
    flux.forgotten.clear(); // Flux accepted the capture before its forget fence: the answer lands now
    flux.hold.release!();
    await Promise.all([...capture.inflight]);
    expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", threadId: "t1", state: "owed" }]);
    expect(arms).toEqual([0]);
    // the armed run is the worker's own pass: it sends the forget again
    const before = flux.of("POST", "/forget").length;
    runs.at(-1)!();
    await flush(); await flush();
    expect(flux.of("POST", "/forget").length).toBe(before + 1);
  });

  it("M1: a 2xx that re-owes nothing does not poke the worker", async () => {
    const flux = new FakeFlux();
    let pokes = 0;
    await turn(captureRig(flux, () => { pokes++; }), "t1");
    expect(flux.of("POST", "/events")).toHaveLength(1);
    expect(pokes).toBe(0);
  });

  it("M2: the ids fallback applies the main path's 409 policy: key off, slow cadence, receipts kept", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    deleteConversation("t1");
    afterGrace();
    flux.threadForgetLive = false;
    flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }, { status: 409, body: { error: { code: "memory_consent_disabled" } } }];
    await forgetRig(flux, capture).tick();
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("consent");
    expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(1);
    const [row] = allFluxForgets(database());
    expect(row).toMatchObject({ kind: "thread", state: "owed", lastStatus: 409 });
    expect(row!.nextAt).toBe(clock + 6 * HOUR);
  });

  it("M2: the ids fallback answered 409 memory_thread_forgotten is done for the row and latches nothing", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    deleteConversation("t1");
    afterGrace();
    flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }, { status: 409, body: { error: { code: "memory_thread_forgotten" } } }];
    await forgetRig(flux, capture).tick();
    expect(allFluxForgets(database())).toEqual([]);
    expect(fluxKeyOff(database(), fluxKeyFingerprint(KEY_A), clock)).toBe(false);
  });

  for (const answer of [{ status: 202, body: { operation_id: "op_ids" } }, { status: 204, body: null }, { status: 201, body: { forgotten: 1 } }]) {
    it(`M2: an ids forget answered ${answer.status} keeps the receipts (only 200, 410 or already_deleted drop them)`, async () => {
      const flux = new FakeFlux();
      const capture = captureRig(flux);
      await turn(capture, "t1");
      deleteConversation("t1");
      afterGrace();
      flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }, answer];
      await forgetRig(flux, capture).tick();
      expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(1);
      expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", state: "owed", lastStatus: answer.status, attempts: 1 }]);
    });
  }

  it("M2: 200 and 410 already_deleted drop the receipts", async () => {
    for (const answer of [{ status: 200, body: { forgotten: 1 } }, { status: 410, body: { error: { code: "already_deleted" } } }]) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      reconcileMemoryRoster(roster); setMemoryMode("active");
      const flux = new FakeFlux();
      const capture = captureRig(flux);
      await turn(capture, "t1");
      deleteConversation("t1");
      afterGrace();
      flux.forced.POST = [{ status: 404, body: { error: { code: "not_found" } } }, answer];
      await forgetRig(flux, capture).tick();
      expect(count("SELECT COUNT(*) AS n FROM flux_mem_receipt WHERE thread_id='t1'")).toBe(0);
      expect(allFluxForgets(database())).toMatchObject([{ kind: "thread", state: "owed", fallbackAt: clock }]);
    }
  });

  it("M3: a final key-off is never overwritten for that fingerprint; other codes still replace each other", () => {
    const fp = fluxKeyFingerprint(KEY_A);
    setFluxKeyOff(database(), fp, "memory_account_not_enabled", clock);
    setFluxKeyOff(database(), fp, "memory_consent_disabled", clock);
    expect(fluxKeyOffReason(database(), fp, clock)).toBe("consent");
    setFluxKeyOff(database(), fp, "key_unenrolled_no_auto_reenroll", clock);
    for (const code of ["memory_account_not_enabled", "memory_consent_disabled", null]) setFluxKeyOff(database(), fp, code, clock + 1);
    expect(fluxKeyOffReason(database(), fp, clock + 365 * 24 * HOUR)).toBe("final");
    expect(database().prepare("SELECT code, at FROM flux_key_off WHERE key_fp=?").get(fp)).toEqual({ code: "key_unenrolled_no_auto_reenroll", at: clock });
    // another fingerprint is its own row
    setFluxKeyOff(database(), fluxKeyFingerprint(KEY_B), "memory_consent_disabled", clock);
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_B), clock)).toBe("consent");
  });

  it("M3: a forget's 409 after a final capture 409 keeps the key final", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    await turn(capture, "t1");
    flux.keyOff.set(KEY_A, "key_unenrolled_no_auto_reenroll");
    await turn(capture, "t3");
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock)).toBe("final");
    deleteConversation("t1");
    afterGrace();
    flux.keyOff.set(KEY_A, "memory_consent_disabled");
    await forgetRig(flux, capture).tick();
    expect(fluxKeyOffReason(database(), fluxKeyFingerprint(KEY_A), clock + 365 * 24 * HOUR)).toBe("final");
  });

  it("L1: the settings route counts bots whose Flux space was deleted (this key only), and Settings shows one calm line", async () => {
    const flux = new FakeFlux();
    const capture = captureRig(flux);
    flux.shredded.add(fluxBotSpace(database(), "moss"));
    await turn(capture, "t1");
    expect(fluxSpacesGone(database(), fluxKeyFingerprint(KEY_A))).toBe(1);
    expect(fluxSpacesGone(database(), fluxKeyFingerprint(KEY_B))).toBe(0);
    expect(fluxSpacesGone(database(), null)).toBe(0);
    // a bot the owner deleted here is not "deleted at Flux": its tombstone is for every key, code deleted
    deleteBotRecords("fern", ["t2"]);
    expect(fluxSpacesGone(database(), fluxKeyFingerprint(KEY_A))).toBe(1);
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain("fluxSpaceGone=fluxSpacesGone(database(),fluxFp)");
    expect(index).toContain("forgetsWaiting:fluxForgetsWaiting,spaceGone:fluxSpaceGone");
    const settings = readFileSync(join(import.meta.dirname, "..", "src", "components", "MemorySettings.tsx"), "utf8");
    expect(settings).toContain('data-testid="flux-memory-space-gone"');
    expect(settings).toContain("whose Flux space was deleted. Murage's own memory keeps working.");
    const line = settings.slice(settings.indexOf('data-testid="flux-memory-space-gone"'), settings.indexOf("</p>", settings.indexOf('data-testid="flux-memory-space-gone"')));
    expect(line).toContain("Flux memory is off for");
    expect(line).not.toMatch(/\u2014|\u2013/);
  });
});

describe("Flux ledger on the supported step back to an older release", () => {
  it("removes unused port tables, including on the same memory-schema target", () => {
    const db = database(); initializeFluxSpaces(db);
    expect(() => assertNoFluxMemoryForDowngrade(db)).not.toThrow();
    downgradeFluxMemoryTables(db);
    for (const table of FLUX_MEMORY_TABLES_AFTER_118) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)).toBeUndefined();
    const source = readFileSync(join(import.meta.dirname, "installation-memory-downgrade.ts"), "utf8");
    expect(source).toContain("assertNoFluxMemoryForDowngrade(probe);");
    expect(source).toContain("downgradeFluxMemoryTables(db);");
  });
  it("refuses before removing a capture destination or an owed erase", () => {
    const db = database(); initializeFluxSpaces(db);
    const target = noteFluxSpaceUsed(db, "downgrade-thread", "moss", fluxKeyFingerprint(KEY_A));
    expect(target).toBeTruthy();
    const before = db.prepare("SELECT * FROM flux_mem_used").all();
    expect(() => assertNoFluxMemoryForDowngrade(db)).toThrow(/Flux memory still holds/);
    expect(() => downgradeFluxMemoryTables(db)).toThrow(/Flux memory still holds/);
    expect(db.prepare("SELECT * FROM flux_mem_used").all()).toEqual(before);
  });
});

it("capture admission and due erasures use indexed lookups even when no thread matches", () => {
  const db = database(); initializeFluxSpaces(db);
  const plan = (sql: string, ...args: Array<string | number>) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(row => String(row.detail)).join("\n");
  expect(plan("SELECT 1 FROM flux_mem_owed WHERE kind='thread' AND thread_id=? LIMIT 1", "absent")).toContain("flux_mem_owed_thread");
  const due = plan("SELECT * FROM flux_mem_owed WHERE next_at<=? ORDER BY next_at, created_at LIMIT ?", 100, 20);
  expect(due).toContain("flux_mem_owed_due"); expect(due).not.toContain("TEMP B-TREE");
  expect(plan("SELECT MIN(next_at) FROM flux_mem_owed")).toContain("flux_mem_owed_due");
  expect(plan("SELECT source_id FROM flux_mem_receipt WHERE space=? AND key_fp=? AND thread_id=? ORDER BY at, source_id LIMIT ?", "space", "key", "thread", 100)).toContain("flux_mem_receipt_thread");
});
