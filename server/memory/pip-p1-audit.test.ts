// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P1 blind-audit fixes: continuity rows stay out of the shared recall index
// (production ranker parity), never reach /learn, cannot be changed through the
// generic archive/restore/forget controls, delete under a version fence and a
// bounded tombstone, report coverage on delivery only, and leave room for
// recall on a small window. Synthetic fixture text only.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster, assertMemoryAccess } from "./policy.ts";
import { attachContinuityCoverage, deleteBotIdentity, readContinuity, readContinuityCoverage, recordContinuityCoverage, writeBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle, MEMORY_FRAME_TOKENS } from "./bundle.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex, type IndexHit } from "./index.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { searchMemory } from "./search.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { continuationMemoryRevoked } from "./disclosures.ts";
import { Store } from "../store.ts";
import { decorateMemoryInstance } from "../harness/memory-adapter.ts";
import { MEMORY_REFERENCE_OPEN } from "../../shared/memory.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { setMemoryMode } from "./repository.ts";
import { ownerMemoryList } from "./owner-list.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { prepareMemorySkillReview } from "../skills.ts";

const roster = {
  bots: [
    { id: "moss", threadId: "private", tasks: [{ threadId: "new-task" }, { threadId: "desk", channelProjectDesk: { groupId: "proj" } }] },
    { id: "neutral", threadId: "neutral-thread" },
  ],
  groups: [
    { id: "proj", threadId: "proj-thread", memberIds: ["moss"], channelProject: {} },
  ],
};
const ticket = ownerMemoryTicket();
const ACTION = "/api/memory/action";
const emptyBridge = { search: async () => ({ hits: [] as IndexHit[], vectorRows: 0 }) };
const opened: Array<{ close(): void }> = [];

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
afterEach(() => { for (const handle of opened.splice(0)) try { handle.close(); } catch { /* already closed */ } vi.useRealTimers(); });

function pip(kind: "commitment" | "self-trait" | "relation", key: string, text: string, patch: Partial<IdentityWrite> = {}): IdentityWrite {
  return { action: "identity-write", botId: "moss", kind, key, expectedVersion: 0, text, basis: "owner-fact", audience: "owner-private", ...patch };
}
function brief(text = "Moss keeps the harbour log.", botId = "moss", expectedVersion = 0): IdentityWrite {
  return { action: "identity-write", botId, kind: "continuity-brief", key: "core", expectedVersion, text, basis: "fiction", audience: "owner-private" };
}
function access(botId = "moss", threadId = "private") {
  const registry = new InternalCapabilities(), generation = registry.begin(botId, threadId);
  const token = registry.mint({ botId, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const meta = () => database().prepare("SELECT policy_revision,deletion_epoch,data_revision FROM memory_meta WHERE id=1").get() as { policy_revision: number; deletion_epoch: number; data_revision: number };
function scopeOf(botId: string) { return String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(botId)!.id); }
let factSeq = 0;
/** An ordinary current fact with a pending projection receipt, as capture leaves it. */
function fact(botId: string, text: string) {
  const id = `fixture-fact-${++factSeq}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scopeOf(botId), text, Date.now(), Date.now());
  database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  return id;
}
/** What the worker controller does with what it selects: index it, mark it indexed. */
function project(index: MemoryIndex) {
  let projected = 0;
  for (;;) {
    const batch = pendingProjectionRecords(database(), 16);
    if (!batch.length) return projected;
    index.upsert(batch.map(row => ({ id: String(row.id), version: Number(row.version), scopeId: String(row.scopeId), text: row.state === "deleted" ? "" : String(row.text), deleted: row.state === "deleted", archived: row.state !== "active" })));
    for (const row of batch) database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id=? AND record_version=?").run(row.id, row.version);
    projected += batch.length;
  }
}
/** The production ranker: FTS5 BM25 inside memory/index.ts, behind the real eligibility predicate. */
function productionBridge(index: MemoryIndex, eligibility: MemoryEligibility) {
  return {
    async search(input: { query: string; scopeIds: string[]; policyRevision: number; deletionEpoch: number; historical: boolean; cursor: string; limit: number }) {
      const { allowed } = eligibility.read(input);
      return { hits: index.search(input.query, allowed, null, "none", input.limit).hits, vectorRows: 0 };
    },
  };
}
const freshEligibility = () => { const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db")); opened.push(eligibility); return eligibility; };
/** The index's corpus statistics: row counts and raw BM25 per term. */
function corpus(terms: string[]) {
  const db = new DatabaseSync(join(DATA_DIR, "memory-index.db"), { readOnly: true });
  try {
    return {
      entries: db.prepare("SELECT id,version FROM entries ORDER BY id,version").all(),
      lexical: Number(db.prepare("SELECT count(*) AS n FROM lexical").get()!.n),
      bm25: terms.map(term => db.prepare("SELECT id,bm25(lexical) AS score FROM lexical WHERE lexical MATCH ? ORDER BY rank,id").all(`"${term}"`)),
    };
  } finally { db.close(); }
}

describe("PIP keeps continuity out of the shared recall index", () => {
  const QUERIES = ["harbour lantern", "lantern oil", "quartz", "tuesdays glass spring", "dock rope"];
  it("changes neither BM25 corpus statistics, ranked ids nor prompt bytes for another bot or for the same bot with the switch off, cold or warm", async () => {
    setMemoryMode("active");
    for (const text of ["harbour lantern schedule is posted on the door", "harbour lantern oil is bought on Tuesdays", "harbour lantern glass was replaced last spring", "the quartz bell rings at noon"]) fact("moss", text);
    for (const text of ["dock rope was coiled on Friday", "dock lantern needs oil on Tuesdays", "neutral harbour notes are in the blue book"]) fact("neutral", text);
    writeBotIdentity(ticket, brief(), roster);
    writeBotIdentity(ticket, brief("Neutral keeps the dock notes.", "neutral"), roster);
    const index = new MemoryIndex(join(DATA_DIR, "memory-index.db")); opened.push(index);
    project(index);
    const mossOf = async (bridge: ReturnType<typeof productionBridge>, query: string) => ({
      ids: (await searchMemory(query, access(), bridge, { limit: 20 })).hits.map(hit => `${hit.id}@${hit.version}`),
      historical: (await searchMemory(query, access(), bridge, { limit: 20, historical: true })).hits.map(hit => `${hit.id}@${hit.version}`),
      off: (await buildMemoryBundle(query, access(), bridge)).text,
      offFalse: (await buildMemoryBundle(query, access(), bridge, { continuity: false })).text,
    });
    const neutralOf = async (bridge: ReturnType<typeof productionBridge>, query: string) => ({
      ids: (await searchMemory(query, access("neutral", "neutral-thread"), bridge, { limit: 20 })).hits.map(hit => `${hit.id}@${hit.version}`),
      text: (await buildMemoryBundle(query, access("neutral", "neutral-thread"), bridge)).text,
    });
    const snapshot = async (bridge: ReturnType<typeof productionBridge>) => {
      const out: Record<string, unknown> = {};
      for (const query of QUERIES) { out["moss " + query] = await mossOf(bridge, query); out["neutral " + query] = await neutralOf(bridge, query); }
      return out;
    };
    const baseline = await snapshot(productionBridge(index, freshEligibility()));
    const before = corpus(["harbour", "lantern", "oil", "quartz", "tuesdays", "dock", "rope"]);
    // recall really happened in the baseline
    expect((baseline["moss harbour lantern"] as { ids: string[] }).ids.length).toBeGreaterThanOrEqual(3);
    expect((baseline["neutral dock rope"] as { ids: string[] }).ids.length).toBeGreaterThanOrEqual(1);
    expect((baseline["moss harbour lantern"] as { off: string }).off).toContain("harbour lantern");

    // PIP rows with different query-term distributions: heavy repeats, a rare term only they carry, and an edit
    writeBotIdentity(ticket, pip("commitment", "lantern-a", "harbour lantern harbour lantern harbour lantern"), roster);
    writeBotIdentity(ticket, pip("commitment", "lantern-b", "lantern oil quartz quartz quartz dock rope"), roster);
    writeBotIdentity(ticket, pip("commitment", "lantern-b", "lantern oil quartz quartz quartz dock rope tuesdays", { expectedVersion: 1 }), roster);
    writeBotIdentity(ticket, pip("self-trait", "lantern-c", "harbour lantern glass spring tuesdays"), roster);
    writeBotIdentity(ticket, pip("relation", "owner", "harbour lantern harbour lantern harbour lantern harbour lantern harbour lantern quartz"), roster);
    expect(project(index)).toBe(0);
    expect(pendingProjectionRecords(database(), 16)).toEqual([]);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE r.kind IN ('commitment','self-trait','relation')").get()!.n)).toBe(0);
    expect(corpus(["harbour", "lantern", "oil", "quartz", "tuesdays", "dock", "rope"])).toEqual(before);

    const cold = productionBridge(index, freshEligibility());
    expect(await snapshot(cold)).toEqual(baseline);
    // warm: the same eligibility, read again
    expect(await snapshot(cold)).toEqual(baseline);
    // and a deleted PIP row changes nothing either
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "commitment", key: "lantern-a", expectedVersion: 1 }, roster);
    expect(project(index)).toBe(0);
    expect(corpus(["harbour", "lantern", "oil", "quartz", "tuesdays", "dock", "rope"])).toEqual(before);
    expect(await snapshot(productionBridge(index, freshEligibility()))).toEqual(baseline);
  });

  it("is rebuilt without them: a reset index re-queues every receipt, and none belongs to a continuity row", () => {
    fact("moss", "harbour lantern notes");
    writeBotIdentity(ticket, pip("commitment", "kept", "harbour lantern promise"), roster);
    writeBotIdentity(ticket, pip("relation", "owner", "harbour lantern routine"), roster);
    writeBotIdentity(ticket, brief(), roster);
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed'").run();
    // the controller's reset-on-rebuilt-index update touches every receipt that exists
    database().prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'").run();
    const queued = pendingProjectionRecords(database(), 16).map(row => String(row.text));
    // the brief joined the PIP kinds in P2, so it is no longer projected either
    expect(queued.sort()).toEqual(["harbour lantern notes"]);
  });

  it("still lists continuity rows for the owner from the authoritative records, and does not slow the indexed search of other rows", () => {
    const f = fact("moss", "harbour lantern notes");
    const row = writeBotIdentity(ticket, pip("commitment", "lantern-promise", "A lantern promise for the owner."), roster);
    const index = new MemoryIndex(join(DATA_DIR, "memory-index.db")); opened.push(index);
    project(index);
    const found = ownerMemoryList({ botId: "moss", query: "lantern" }, roster);
    expect(found.searchMode).toBe("indexed");
    expect(found.rows.map(r => String(r.id)).sort()).toEqual([f, row.id].sort());
    expect(ownerMemoryList({ botId: "moss", query: "nothing-matches-this" }, roster).rows).toEqual([]);
  });
});

describe("PIP never reaches /learn", () => {
  it("refuses review-as-skill and prepareMemorySkillReview for every continuity kind before any request is built or dispatched", async () => {
    setMemoryMode("active");
    const startSkillReview = vi.fn(async () => ({ botId: "moss", threadId: "t", messageId: "m" }));
    const rows = [
      writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster),
      writeBotIdentity(ticket, pip("commitment", "weekly", "Send the weekly summary."), roster),
      writeBotIdentity(ticket, pip("self-trait", "plain", "Prefers plain words."), roster),
    ];
    const bindings = () => Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-skill-review:%'").get()!.n);
    // Continuity absent on the bot and a project desk among its tasks: no path leads to a dispatch.
    for (const row of rows) {
      await expect(memoryOwnerRoute(ACTION, { action: "review-as-skill", id: row.id, version: 1, botId: "moss" }, ticket, roster, { startSkillReview })).rejects.toThrow("MEMORY_IDENTITY_PIP_NOT_SKILL");
      expect(() => prepareMemorySkillReview(ticket, "moss", row.id, 1)).toThrow("MEMORY_IDENTITY_PIP_NOT_SKILL");
    }
    expect(startSkillReview).not.toHaveBeenCalled();
    expect(bindings()).toBe(0);
    // an ordinary fact is unaffected by the guard (it reaches the dispatch)
    const ordinary = fact("moss", "A repeatable procedure for the harbour log.");
    await expect(memoryOwnerRoute(ACTION, { action: "review-as-skill", id: ordinary, version: 1, botId: "moss" }, ticket, roster, { startSkillReview })).resolves.toMatchObject({ workflow: "learn" });
    expect(startSkillReview).toHaveBeenCalledTimes(1);
  });
});

describe("PIP generic owner actions", () => {
  async function twoBotState() {
    writeBotIdentity(ticket, brief("Neutral keeps the dock notes.", "neutral"), roster);
    const neutral = access("neutral", "neutral-thread");
    const bundle = await buildMemoryBundle("", neutral, emptyBridge);
    const receipt = new MemoryDispatchReceipt(bundle, neutral, "driver-one");
    receipt.sessionStarted("session-one"); receipt.accepted();
    return { neutral, bundle, state: () => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state };
  }

  it("refuses archive and restore-archive so the cap cannot be exceeded, and changes nothing for another bot", async () => {
    const other = await twoBotState();
    const rows = [];
    for (let n = 0; n < 24; n++) rows.push(writeBotIdentity(ticket, pip("commitment", `c-${n}`, `Commitment ${n}.`), roster));
    const before = meta();
    for (const action of ["archive", "restore-archive"] as const)
      await expect(memoryOwnerRoute(ACTION, { action, id: rows[0].id, version: 1 }, ticket, roster)).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(rows[0].id)!.state).toBe("active");
    expect(() => writeBotIdentity(ticket, pip("commitment", "c-24", "One too many."), roster)).toThrow("MEMORY_IDENTITY_PIP_CAP");
    // also the approve/correct/pin family stays closed to these rows
    await expect(memoryOwnerRoute(ACTION, { action: "correct", id: rows[0].id, version: 1, text: "Edited from the generic editor." }, ticket, roster)).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='commitment' AND state='active'").get()!.n)).toBe(24);
    expect(meta()).toEqual(before);
    expect(other.state()).toBe("delivered");
    expect(() => assertMemoryAccess(other.neutral)).not.toThrow();
  });

  it("refuses generic forget of a continuity row, with or without a revision: nothing is deleted, no epoch moves, other bots untouched", async () => {
    const other = await twoBotState();
    const first = writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm."), roster);
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm and plain.", { expectedVersion: 1 }), roster);
    const relation = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster);
    const commitment = writeBotIdentity(ticket, pip("commitment", "call", "Call on Friday."), roster);
    const before = meta();
    for (const target of [first, relation, commitment]) {
      for (const extra of [{}, { revision: 1 }, { revision: 2 }]) {
        await expect(memoryOwnerRoute(ACTION, { action: "forget", kind: "record", id: target.id, ...extra }, ticket, roster)).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
      }
    }
    expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_tombstones").get()!.n)).toBe(0);
    expect(meta()).toEqual(before);
    expect(other.state()).toBe("delivered");
    // the dedicated, version-fenced delete still works
    await memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "calm", expectedVersion: 2 }, ticket, roster);
    expect(database().prepare("SELECT state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{ state: "deleted" }, { state: "deleted" }]);
    // an ordinary record still uses the installation-wide forget
    const ordinary = fact("moss", "An ordinary note.");
    await memoryOwnerRoute(ACTION, { action: "forget", kind: "record", id: ordinary }, ticket, roster);
    expect(meta().deletion_epoch).toBe(before.deletion_epoch + 1);
  });
});

describe("PIP delete fence and bounded tombstone", () => {
  it("requires expectedVersion and returns MEMORY_VERSION_CONFLICT for a stale view, deleting nothing", async () => {
    const first = writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Friday."), roster);
    writeBotIdentity(ticket, pip("commitment", "call-back", "Call back on Saturday.", { expectedVersion: 1 }), roster);
    await expect(memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "commitment", key: "call-back" }, ticket, roster)).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
    await expect(memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "commitment", key: "call-back", expectedVersion: 1 }, ticket, roster)).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(database().prepare("SELECT version,state FROM memory_records WHERE id=? ORDER BY version").all(first.id)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_id=?").get(first.id)!.n)).toBe(0);
    expect(await memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "commitment", key: "call-back", expectedVersion: 2 }, ticket, roster)).toEqual({ id: first.id, deleted: true });
  });

  it("does not requeue another bot's completed deletion receipts or its pending work", () => {
    const gone = fact("neutral", "a forgotten neutral note");
    database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(gone);
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id=?").run(gone);
    const pendingDelete = fact("neutral", "a neutral note waiting to leave the index");
    database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(pendingDelete);
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending' WHERE record_id=?").run(pendingDelete);
    const live = fact("neutral", "a live neutral note");
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id=?").run(live);
    const receipts = () => database().prepare("SELECT record_id,lexical_status,embedding_status FROM memory_projection_receipts ORDER BY record_id").all();
    const before = receipts();
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm."), roster);
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm and plain.", { expectedVersion: 1 }), roster);
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "calm", expectedVersion: 2 }, roster);
    expect(receipts()).toEqual(before);
    expect(receipts().find(row => row.record_id === gone)).toMatchObject({ lexical_status: "deleted", embedding_status: "deleted" });
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(live)!.state).toBe("active");
  });
});

describe("PIP leaves another bot's state alone across save, edit and delete", () => {
  it("keeps bot B's delivered disclosure, resume cursor, prompt bytes (recall exercised) and in-flight consolidation", async () => {
    setMemoryMode("capture");
    writeBotIdentity(ticket, brief("Neutral keeps the dock notes.", "neutral"), roster);
    const b = access("neutral", "neutral-thread");
    const noteId = fact("neutral", "dock lantern needs oil on Tuesdays");
    const bridge = { search: async () => ({ hits: [{ id: noteId, version: 1, score: 1, lexical: true }] as IndexHit[], vectorRows: 0 }) };
    const query = "dock lantern oil";
    const bundle = await buildMemoryBundle(query, b, bridge);
    expect(bundle.text).toContain("dock lantern needs oil on Tuesdays");
    const receipt = new MemoryDispatchReceipt(bundle, b, "driver-one");
    receipt.sessionStarted("session-one"); receipt.accepted();

    // Bot B's real persisted ENGINE resume cursor (the one the direct-turn path clears when
    // memory context changes), and B's engine adapter behind the production memory decorator.
    const selection = () => ({ instanceId: "driver-one", model: "fixture-model" });
    const store = new Store(selection, undefined, true);
    const botB = store.createBot({}, { seedMessages: false });
    store.setResumeCursor(botB.id, "driver-one", "session-one");
    const persistedCursor = () => new Store(selection, undefined, true).bot(botB.id)!.resumeCursors["driver-one"];
    expect(persistedCursor()).toBe("session-one");
    const listeners: Array<(event: RuntimeEvent) => void> = [];
    const sent: SendTurnInput[] = [];
    const engine = {
      capabilities: {}, onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.push(listener); return () => {}; },
      hasSession: () => true, stopAll: async () => {},
      sendTurn: async (turn: SendTurnInput) => {
        sent.push(turn);
        for (const listener of listeners) listener({ eventId: "e", provider: "driver-one", threadId: turn.threadId, createdAt: new Date().toISOString(), type: "session.started", sessionId: "session-one" } as RuntimeEvent);
        return { turnId: "t" };
      },
    };
    const live = decorateMemoryInstance({ adapter: engine, dispose: async () => {}, snapshot: async () => ({ state: "available" }) } as unknown as ProviderInstance);
    await live.adapter.sendTurn({ threadId: "neutral-thread", text: "first turn", memoryContext: bundle } as SendTurnInput);
    expect(sent.at(-1)!.text).toContain(MEMORY_REFERENCE_OPEN); // the first turn delivers the frame

    // a real persisted consolidation cursor for B, then a slice held in flight
    const text = "a".repeat(20000);
    captureSource(database(), { id: "held-source", threadId: "neutral-thread", messageId: "held-message", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
    let jobId = "";
    for (;;) {
      const work = claimMemoryJob("pip-fixture");
      if (!work) throw new Error("fixture source not captured completely");
      jobId = work.id; const result = captureWork(work); publishMemoryWork(work, "pip-fixture", result);
      if (result.status === "complete") break;
    }
    const quoted = (chunk: string) => { const quote = chunk.slice(0, 8); return JSON.stringify([{ text: quote, quote, startByte: 0, endByte: Buffer.byteLength(quote) }]); };
    const first = await consolidateMemorySource(jobId, async chunk => quoted(chunk), new AbortController().signal);
    expect(first.status).toBe("partial");
    const intent = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'consolidation:%'").get()!.intent));
    expect(intent().cursor).toBe(first.cursor);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = consolidateMemorySource(jobId, async chunk => { await gate; return quoted(chunk); }, new AbortController().signal);
    await vi.waitFor(() => expect(intent().status).toBe("running"));
    const generation = intent().generation;

    const before = meta();
    const stillBHolds = async (step: string) => {
      expect(meta(), step).toEqual(before);
      expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state, step).toBe("delivered");
      expect(intent(), step).toMatchObject({ status: "running", generation, cursor: first.cursor });
      const again = await buildMemoryBundle(query, access("neutral", "neutral-thread"), bridge);
      expect(again.text, step).toBe(bundle.text);
      expect(memoryContinuationChanged(again, "neutral-thread", "driver-one", "session-one"), step).toBe(false);
      expect(() => assertMemoryAccess(b), step).not.toThrow();
      // B's next dispatch exactly as the direct-turn path decides it: the persisted engine
      // resume cursor is kept (no reset), and the adapter does not send the frame again.
      const resume = String(persistedCursor());
      expect(resume, step).toBe("session-one");
      expect(continuationMemoryRevoked("neutral-thread", "driver-one", resume, access("neutral", "neutral-thread")), step).toBe(false);
      await live.adapter.sendTurn({ threadId: "neutral-thread", text: "next turn", memoryContext: again, resumeCursor: resume } as SendTurnInput);
      expect(sent.at(-1)!.text, step).toBe("next turn");
      expect(sent.at(-1)!.resumeCursor, step).toBe("session-one");
      expect(persistedCursor(), step).toBe("session-one");
    };
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm under pressure."), roster);
    await stillBHolds("save");
    writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm and plain.", { expectedVersion: 1 }), roster);
    await stillBHolds("edit");
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "self-trait", key: "calm", expectedVersion: 2 }, roster);
    await stillBHolds("delete");

    release();
    // the slice that was in flight across all three completes: it was never revoked
    await expect(held).resolves.toMatchObject({ status: "complete" });
  });
});

describe("PIP coverage is written on delivery", () => {
  const counts = { brought: 3, total: 5 };
  async function receiptFor(botId: string, thread: string) {
    writeBotIdentity(ticket, brief("Moss keeps the harbour log.", botId), roster);
    const a = access(botId, thread);
    return { a, receipt: new MemoryDispatchReceipt(await buildMemoryBundle("", a, emptyBridge, { continuity: true }), a, "driver-one") };
  }

  it("records the count and the turn when the disclosure becomes delivered, and always restamps it", async () => {
    const { receipt } = await receiptFor("moss", "private");
    attachContinuityCoverage(receipt, "moss", counts);
    expect(readContinuityCoverage("moss")).toBeNull();
    receipt.sessionStarted("s1"); receipt.accepted();
    const first = readContinuityCoverage("moss")!;
    expect(first).toMatchObject({ ...counts, turn: receipt.bundle.bundleId });
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 5000);
    recordContinuityCoverage("moss", counts, "later-turn");
    expect(readContinuityCoverage("moss")!.at).toBeGreaterThan(first.at);
    expect(readContinuityCoverage("moss")).toMatchObject({ ...counts, turn: "later-turn" });
  });

  it("leaves the count alone when the dispatch fails, and clears it for a later off or non-active turn", async () => {
    const { a, receipt } = await receiptFor("moss", "private");
    attachContinuityCoverage(receipt, "moss", counts);
    receipt.sessionStarted("s1"); receipt.accepted();
    const delivered = readContinuityCoverage("moss")!;
    expect(delivered.turn).toBe(receipt.bundle.bundleId);

    // a later turn is prepared but its dispatch is rejected before acceptance
    const bundle2 = await buildMemoryBundle("", a, emptyBridge, { continuity: true });
    const failed = new MemoryDispatchReceipt(bundle2, a, "driver-one");
    attachContinuityCoverage(failed, "moss", { brought: 1, total: 9 });
    database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundle2.bundleId);
    expect(() => failed.accepted()).toThrow();
    expect(readContinuityCoverage("moss")).toEqual(delivered);

    // the next turn has the switch off (or memory not active): no stale success remains
    const off = new MemoryDispatchReceipt(await buildMemoryBundle("", a, emptyBridge), a, "driver-one");
    attachContinuityCoverage(off, "moss", undefined);
    expect(readContinuityCoverage("moss")).toBeNull();
    expect(readContinuity(ticket, "moss", roster).coverage).toBeNull();
    off.sessionStarted("s2"); off.accepted();
    expect(readContinuityCoverage("moss")).toBeNull();
  });
});

describe("PIP budget share", () => {
  it("lets continuity rows use at most half of what is left after pins, brief and reveal state, so recall keeps room on a small window", async () => {
    setMemoryMode("active");
    writeBotIdentity(ticket, brief(), roster);
    for (let n = 0; n < 6; n++) writeBotIdentity(ticket, pip("commitment", `c-${n}`, `${String.fromCharCode(65 + n)}`.repeat(180)), roster);
    for (let n = 0; n < 6; n++) writeBotIdentity(ticket, pip("self-trait", `t-${n}`, `${String.fromCharCode(75 + n)}`.repeat(180)), roster);
    const f = fact("moss", "harbour lantern oil is bought on Tuesdays");
    const bridge = { search: async () => ({ hits: [{ id: f, version: 1, score: 1, lexical: true }] as IndexHit[], vectorRows: 0 }) };
    const window = 8000; // ceiling = fixed frame + 800
    const ceiling = MEMORY_FRAME_TOKENS + 800;
    const base = (await buildMemoryBundle("", access(), emptyBridge, { availableContextTokens: window })).tokenCount; // frame + brief
    const pipOnly = await buildMemoryBundle("", access(), emptyBridge, { continuity: true, availableContextTokens: window });
    const withRecall = await buildMemoryBundle("harbour lantern oil", access(), bridge, { continuity: true, availableContextTokens: window });
    // 12 rows of ~200 rendered bytes would fill the whole remainder; with nothing else to bring they may use all of it (A11 pass two)
    expect(pipOnly.continuity!.total).toBe(12);
    expect(pipOnly.continuity!.brought).toBeGreaterThan(0);
    expect(pipOnly.continuity!.brought).toBeLessThan(12);
    expect(pipOnly.tokenCount).toBeLessThanOrEqual(ceiling);
    expect(pipOnly.tokenCount).toBeGreaterThan(base + Math.floor((ceiling - base) / 2));
    // with recall present, the first pass held them to half, so they bring no more than when alone
    expect(withRecall.continuity!.brought).toBeLessThanOrEqual(pipOnly.continuity!.brought);
    // the recall hit is still delivered next to them, and so is the whole-row rule
    expect(withRecall.recordVersions.some(row => row.id === f)).toBe(true);
    expect(withRecall.text).toContain("harbour lantern oil is bought on Tuesdays");
    expect(withRecall.tokenCount).toBeLessThanOrEqual(ceiling);
    for (const record of withRecall.identity) expect(withRecall.text).toContain(JSON.stringify(record.text));
  });
});

describe("PIP two-pass budget (A11)", () => {
  const window = 8000; // ceiling = fixed frame + 800
  const ceiling = MEMORY_FRAME_TOKENS + 800;
  it("(a) with no recall or checkpoint, a relation larger than half the remainder but within the full ceiling is delivered", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const relation = writeBotIdentity(ticket, pip("relation", "owner", "R".repeat(520)), roster);
    const small = writeBotIdentity(ticket, pip("commitment", "small", "Call on Friday."), roster);
    // newest first (design 2.2); a fixed lead, because +10 ms raced the second write on a loaded machine
    database().prepare("UPDATE memory_records SET created_at=? WHERE id=?").run(Number(database().prepare("SELECT created_at FROM memory_records WHERE id=?").get(small.id)!.created_at) + 60_000, relation.id);
    const base = (await buildMemoryBundle("", access(), emptyBridge, { availableContextTokens: window })).tokenCount;
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true, availableContextTokens: window });
    expect(520 + 40).toBeGreaterThan(Math.floor((ceiling - base) / 2)); // the row really is past the old half-share
    expect(bundle.identity.map(record => record.id)).toContain(relation.id);
    expect(bundle.text).toContain("R".repeat(520));
    expect(bundle.tokenCount).toBeLessThanOrEqual(ceiling);
    // the row first in priority is the first rendered
    expect(bundle.identity.filter(record => record.kind !== "continuity-brief")[0].id).toBe(relation.id);
  });
  it("(b) with recall present on a small window the recall hit is still delivered, and a row placed in pass two renders in its A4 slot", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const relation = writeBotIdentity(ticket, pip("relation", "owner", "R".repeat(520)), roster);
    const small = writeBotIdentity(ticket, pip("commitment", "small", "Call on Friday."), roster);
    // newest first (design 2.2); a fixed lead over the later write, as in (a): +10 ms raced it on a loaded Windows runner
    database().prepare("UPDATE memory_records SET created_at=? WHERE id=?").run(Number(database().prepare("SELECT created_at FROM memory_records WHERE id=?").get(small.id)!.created_at) + 60_000, relation.id);
    const f = fact("moss", "harbour lantern oil on Tuesdays");
    const bridge = { search: async () => ({ hits: [{ id: f, version: 1, score: 1, lexical: true }] as IndexHit[], vectorRows: 0 }) };
    const bundle = await buildMemoryBundle("harbour lantern oil", access(), bridge, { continuity: true, availableContextTokens: window });
    expect(bundle.recordVersions.some(row => row.id === f)).toBe(true);
    expect(bundle.tokenCount).toBeLessThanOrEqual(ceiling);
    expect(bundle.identity.map(record => record.id)).toContain(relation.id); // skipped in pass one, placed in pass two
    expect(bundle.text.indexOf("R".repeat(520))).toBeLessThan(bundle.text.indexOf("harbour lantern oil on Tuesdays"));
    // a whole row or nothing: no later row stands in for an omitted earlier one
    const brought = bundle.identity.filter(record => record.kind !== "continuity-brief").map(record => record.kind);
    expect(brought[0]).toBe("relation");
  });
  it("(c) OFF is unchanged: continuity rows existing or not, the bytes are the same", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const f = fact("moss", "harbour lantern oil on Tuesdays");
    const bridge = { search: async () => ({ hits: [{ id: f, version: 1, score: 1, lexical: true }] as IndexHit[], vectorRows: 0 }) };
    const clean = await buildMemoryBundle("harbour lantern oil", access(), bridge, { availableContextTokens: window });
    writeBotIdentity(ticket, pip("relation", "owner", "R".repeat(520)), roster);
    writeBotIdentity(ticket, pip("commitment", "small", "Call on Friday."), roster);
    for (const options of [{}, { continuity: false }]) {
      const off = await buildMemoryBundle("harbour lantern oil", access(), bridge, { availableContextTokens: window, ...options });
      expect(off.text).toBe(clean.text);
      expect(off.continuity).toBeUndefined();
    }
  });
});

describe("PIP entries an earlier build indexed leave the derived index", () => {
  const TERMS = ["harbour", "lantern", "oil", "quartz", "tuesdays"];
  const FACTS = ["harbour lantern schedule is posted on the door", "harbour lantern oil is bought on Tuesdays", "the quartz bell rings at noon"];
  /** The pre-fix state: continuity rows with indexed receipts and index entries. */
  function seedPreFix(index: MemoryIndex) {
    const rows = [
      writeBotIdentity(ticket, pip("commitment", "lantern-a", "harbour lantern harbour lantern harbour lantern oil"), roster),
      writeBotIdentity(ticket, pip("self-trait", "lantern-b", "quartz quartz quartz tuesdays lantern"), roster),
      writeBotIdentity(ticket, pip("relation", "owner", "harbour lantern harbour lantern quartz oil"), roster),
    ];
    for (const row of rows) {
      database().prepare("INSERT OR REPLACE INTO memory_projection_receipts VALUES(?,1,0,'indexed','indexed',NULL)").run(row.id);
      index.upsert([{ id: row.id, version: 1, scopeId: scopeOf("moss"), text: String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(row.id)!.text), deleted: false }]);
      index.vector({ id: row.id, version: 1, scopeId: scopeOf("moss"), text: "", deleted: false }, "m", 0, [1, 0, 0]);
    }
    return rows;
  }
  const bm25 = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return TERMS.map(term => db.prepare("SELECT version,bm25(lexical) AS score FROM lexical WHERE lexical MATCH ? ORDER BY rank,id").all(`"${term}"`).map(r => r.score)); }
    finally { db.close(); }
  };

  it("startup cleanup removes continuity entries (lexical and vectors), is idempotent, and BM25 equals a clean index", () => {
    for (const text of FACTS) fact("moss", text);
    const cleanPath = join(DATA_DIR, "clean-index.db"), path = join(DATA_DIR, "memory-index.db");
    const clean = new MemoryIndex(cleanPath); opened.push(clean);
    const dirty = new MemoryIndex(path); opened.push(dirty);
    project(dirty);
    for (const row of database().prepare("SELECT id,version,scope_id,text FROM memory_records WHERE kind='fact'").all())
      clean.upsert([{ id: String(row.id), version: Number(row.version), scopeId: String(row.scope_id), text: String(row.text), deleted: false }]);
    const rows = seedPreFix(dirty);
    const dirtyScores = bm25(path), cleanScores = bm25(cleanPath);
    expect(dirtyScores).not.toEqual(cleanScores); // the pre-fix state really does skew ranking
    const eligibility = freshEligibility();
    expect(eligibility.pipRecordIds().sort()).toEqual(rows.map(row => row.id).sort());
    expect(dirty.purgeRecords(eligibility.pipRecordIds())).toBeGreaterThan(0);
    expect(bm25(path)).toEqual(cleanScores);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of ["entries", "vectors", "lexical_keys", "lexical"]) {
        expect(Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(rows.map(row => row.id)))!.n)).toBe(0);
      }
    } finally { db.close(); }
    // a second open finds nothing left to do
    expect(dirty.purgeRecords(eligibility.pipRecordIds())).toBe(0);
    expect(bm25(path)).toEqual(cleanScores);
  });

  it("a deleted continuity record with an existing index entry is selected for removal and removed; a live one is never inserted", () => {
    const path = join(DATA_DIR, "memory-index.db");
    const index = new MemoryIndex(path); opened.push(index);
    fact("moss", FACTS[0]);
    project(index);
    const [commitment] = seedPreFix(index);
    // live continuity (even with an old pending receipt) is not selected for insertion
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending' WHERE record_id=?").run(commitment.id);
    expect(pendingProjectionRecords(database(), 16)).toEqual([]);
    database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id=?").run(commitment.id);
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "commitment", key: "lantern-a", expectedVersion: 1 }, roster);
    const pending = pendingProjectionRecords(database(), 16);
    expect(pending.map(row => [String(row.id), row.state, row.text])).toEqual([[commitment.id, "deleted", ""]]);
    expect(project(index)).toBe(1);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of ["entries", "vectors", "lexical_keys", "lexical"]) expect(Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE id=?`).get(commitment.id)!.n)).toBe(0);
      expect(Number(db.prepare("SELECT count(*) AS n FROM entries").get()!.n)).toBe(3); // the fact plus the two other seeded rows
    } finally { db.close(); }
  });
});
