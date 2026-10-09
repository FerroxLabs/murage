// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 core, batch B1 (foundation): the PIP kind list and its readers, the
// brief as a PIP kind, the I-10 guards, the deliver-once receipt listeners, the
// continuity settings, the bundle order and render cache, and the copy rules.
// Synthetic fixture text only.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertGenericMemoryTarget, ownerMemoryTicket, pinMemory } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { attachContinuityCoverage, botIdentityRecordId, deleteBotIdentity, deletePipRecord, readContinuityCoverage, rejectGenericForgetOfPip, writeBotIdentity, type IdentityWrite } from "./identity.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex, type IndexHit } from "./index.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { searchMemory } from "./search.ts";
import { memoryAgentRoute } from "./routes.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { PIP_ALL_KINDS, PIP_ALL_KINDS_SQL, PIP_OWNER_KINDS, isPipKind, isPipOwnerKind, pipTierOf } from "./pip-kinds.ts";
import { PIP_ATTRIBUTION, PIP_IMPORTED_SUFFIX, cutAtSentence, importFadeMultiplier, observedReservation, pipKindLabel, reinforcedAtOf, selfSlotOrder } from "./pip-render.ts";
import { isPipReflectThread, parseContinuityOptions } from "./pip-types.ts";
import { MEMORY_FRAME_TOKENS } from "./bundle.ts";

const roster = {
  bots: [
    { id: "moss", threadId: "private", tasks: [{ threadId: "new-task" }] },
    { id: "neutral", threadId: "neutral-thread" },
  ],
  groups: [{ id: "room", threadId: "room-thread", memberIds: ["moss", "neutral"] }],
};
const ticket = ownerMemoryTicket();
const ACTION = "/api/memory/action";
const emptyBridge = { search: async () => ({ hits: [] as IndexHit[], vectorRows: 0 }) };
const opened: Array<{ close(): void }> = [];

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("active"); });
afterEach(() => { for (const handle of opened.splice(0)) try { handle.close(); } catch { /* already closed */ } });

function pip(kind: "commitment" | "self-trait" | "relation", key: string, text: string, patch: Partial<IdentityWrite> = {}, botId = "moss"): IdentityWrite {
  return { action: "identity-write", botId, kind, key, expectedVersion: 0, text, basis: "owner-fact", audience: "owner-private", ...patch };
}
function brief(text = "Moss keeps the harbour log and answers briefly.", botId = "moss", expectedVersion = 0): IdentityWrite {
  // An edit names the record id it saw (the brief re-created after a delete is a new generation); generation 0 here.
  return { action: "identity-write", botId, kind: "continuity-brief", key: "core", expectedVersion, ...(expectedVersion > 0 ? { expectedId: botIdentityRecordId(botId, "continuity-brief", "core") } : {}), text, basis: "fiction", audience: "owner-private" };
}
function access(botId = "moss", threadId = "private") {
  const registry = new InternalCapabilities(), generation = registry.begin(botId, threadId);
  const token = registry.mint({ botId, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const meta = () => database().prepare("SELECT policy_revision,deletion_epoch,data_revision FROM memory_meta WHERE id=1").get() as { policy_revision: number; deletion_epoch: number; data_revision: number };
const scopeOf = (botId: string) => String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(botId)!.id);
const stamp = (id: string, at: number) => database().prepare("UPDATE memory_records SET created_at=? WHERE id=? AND state='active'").run(at, id);
let factSeq = 0;
function fact(botId: string, text: string, receipt = true) {
  const id = `fixture-fact-${++factSeq}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scopeOf(botId), text, Date.now(), Date.now());
  if (receipt) database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  return id;
}
/** An observed row, as confirmPipProposal will write it: assistant-inference resting on an owner message. */
function observed(slug: string, text: string, reinforcedAt: number) {
  const sourceId = `src-${slug}`, sourceText = `Please remember: ${text}`;
  captureSource(database(), { id: sourceId, threadId: "private", messageId: `msg-${slug}`, origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: sourceText });
  const revision = Number(database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(sourceId)!.revision);
  const id = `identity:observed-${slug}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'commitment',?,'assistant-inference','active',0,?,NULL,NULL,?)").run(id, scopeOf("moss"), text, Date.now(), reinforcedAt);
  database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,?)").run(id, sourceId, revision, Buffer.byteLength(sourceText));
  database().prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis='pip:observed; Confirmed by the owner',entities=? WHERE record_id=? AND record_version=1")
    .run(JSON.stringify(["owner-private", slug, "claim:null", "gen:1", `reinforcedAt:${reinforcedAt}`]), id);
  return id;
}
/** A row of a PIP kind that has no writer in B1, so the guards can be exercised on every kind. */
function synthetic(kind: string, key: string) {
  const id = `identity:synthetic-${kind}-${key}`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'assistant-inference','active',0,?,NULL,NULL,?)").run(id, scopeOf("moss"), kind, `A ${kind} row.`, Date.now(), Date.now());
  database().prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=? WHERE record_id=? AND record_version=1").run(`pip:${kind === "episode" ? "summary" : kind === "pip-proposal" ? "proposal" : kind === "pip-counter" ? "counter" : "self"}; test row`, id);
  return id;
}
function deliver(botId: string, threadId: string) {
  const a = access(botId, threadId);
  return buildMemoryBundle("", a, emptyBridge).then(bundle => {
    const receipt = new MemoryDispatchReceipt(bundle, a, "driver-one");
    receipt.sessionStarted("session-one"); receipt.accepted();
    return { bundle, receipt, state: () => String(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state) };
  });
}

describe("PIP kind list", () => {
  it("names every PIP kind once, with the brief and the owner kinds inside it", () => {
    expect([...PIP_ALL_KINDS]).toEqual(["continuity-brief", "commitment", "self-trait", "relation", "pip-proposal", "pip-counter", "concern", "episode"]);
    expect(PIP_ALL_KINDS_SQL).toBe("('continuity-brief','commitment','self-trait','relation','pip-proposal','pip-counter','concern','episode')");
    expect([...PIP_OWNER_KINDS]).toEqual(["commitment", "self-trait", "relation"]);
    for (const kind of PIP_ALL_KINDS) expect(isPipKind(kind)).toBe(true);
    for (const kind of ["fact", "source", "checkpoint", "reveal-state", "character-canon", "", undefined, null, 3]) expect(isPipKind(kind)).toBe(false);
    expect(isPipOwnerKind("continuity-brief")).toBe(false);
    expect(isPipOwnerKind("commitment")).toBe(true);
    expect(pipTierOf("pip:attested; Owner-authored continuity")).toBe("attested");
    expect(pipTierOf("pip:observed")).toBe("observed");
    expect(pipTierOf("Owner-authored fictional continuity; not model autobiography")).toBeUndefined();
    expect(pipTierOf("pip:bogus")).toBeUndefined();
  });

  // I-15: every statement that reads memory_records names its kinds, excludes PIP kinds, or is an administrative
  // or point lookup. The pinned counts below fail when a reader is added or removed; review it against I-15,
  // then update the count. Readers that enumerate rows to a model or the owner are listed by purpose.
  it("keeps the I-15 census of memory_records readers", () => {
    const root = new URL("../", import.meta.url);
    const counts: Record<string, number> = {};
    const files = [...readdirSync(new URL("./", import.meta.url)).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).map(name => `memory/${name}`), "skills.ts", "human-principals.ts"];
    for (const file of files) {
      const source = readFileSync(new URL(file, root), "utf8");
      const n = (source.match(/\b(?:FROM|JOIN) memory_records\b/g) ?? []).length;
      if (n) counts[file] = n;
    }
    // Readers that hand rows to a model or the owner exclude PIP_ALL_KINDS_SQL or isPipKind in their own file.
    for (const file of ["memory/eligibility.ts", "memory/recent.ts", "memory/search.ts", "memory/projection.ts", "memory/owner-list.ts", "memory/bundle.ts", "memory/routes.ts", "memory/retention.ts", "memory/authority.ts", "memory/consolidate.ts", "memory/settings.ts", "skills.ts"])
      expect(readFileSync(new URL(file, root), "utf8"), file).toMatch(/PIP_ALL_KINDS_SQL|isPipKind|pip-kinds\.ts/);
    // Nothing still imports the P1 names.
    for (const file of files) expect(readFileSync(new URL(file, root), "utf8"), file).not.toMatch(/\bPIP_KINDS(?:_SQL)?\b/);
    expect(counts).toEqual({
      "memory/authority.ts": 11, "memory/automatic-learning.ts": 2, "memory/bring-in.ts": 2, "memory/bundle.ts": 6, "memory/capture.ts": 1, "memory/checkpoints.ts": 2,
      "memory/consolidate.ts": 3, "memory/eligibility.ts": 3, "memory/evolution-forgetting.ts": 1, "memory/forget.ts": 2, "memory/identity.ts": 8, "memory/import.ts": 1,
      "memory/learning-history.ts": 4, "memory/lessons.ts": 1, "memory/memory-moments.ts": 1, "memory/metrics.ts": 1, "memory/owner-list.ts": 2, "memory/procedure-review.ts": 3,
      "memory/projection.ts": 2, "memory/recent.ts": 2,
      // +3: derivationAncestryCurrent reads parent states only, never text (revoke fix round 2)
      "memory/replay-lineage.ts": 12, "memory/restore.ts": 7, // +1: the status scan counts records by state and adds up text lengths, never returning text
      "memory/retention.ts": 9, "memory/reveal-capture.ts": 2, "memory/routes.ts": 8,
      "memory/schema.ts": 3, "memory/search.ts": 1, "memory/settings.ts": 3, "memory/worker-controller.ts": 3, "skills.ts": 6, "human-principals.ts": 1,
      // B3: the lived family, episodes and reflection read only PIP kinds, named in their own statements.
      // Round 2 removed the redundant episode check from pip-reflect; pip-episodes owns it.
      "memory/pip-episodes.ts": 4, "memory/pip-lived.ts": 8, "memory/pip-reflect.ts": 2, "memory/pip-stance.ts": 4,
      // Mobile lane merge (reviewed against I-15): the identity source set moved from skills.ts to
      // provenance-stamp.ts (it names its kinds) plus a rowid chunk bound; replay-lineage gained a
      // point lookup by id; schema.ts folded two administrative checks into one marked statement.
      "memory/provenance-stamp.ts": 2,
    });
  });

  it("keeps PIP rows, the brief included, out of eligibility, search and the agent get route", async () => {
    const f1 = fact("moss", "harbour lantern oil is bought on Tuesdays");
    const ids = new Set([
      writeBotIdentity(ticket, brief("harbour lantern keeper brief"), roster).id,
      writeBotIdentity(ticket, pip("commitment", "lantern", "harbour lantern commitment"), roster).id,
      synthetic("concern", "a"), synthetic("episode", "b"), synthetic("pip-proposal", "c"), synthetic("pip-counter", "d"),
    ]);
    const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db")); opened.push(eligibility);
    const m = meta();
    for (const historical of [false, true]) {
      const allowed = eligibility.read({ scopeIds: [scopeOf("moss")], policyRevision: m.policy_revision, deletionEpoch: m.deletion_epoch, historical, cursor: "" }).allowed;
      expect(allowed.filter(row => ids.has(row.id))).toEqual([]);
      expect(allowed.some(row => row.id === f1)).toBe(true);
    }
    expect(eligibility.pipRecordIds().sort()).toEqual([...ids].sort());
    const leaky = { search: async () => ({ hits: [...ids].map(id => ({ id, version: 1, score: 9 })) as IndexHit[], vectorRows: 0 }) };
    expect((await searchMemory("harbour lantern", access(), leaky, { limit: 20 })).hits.filter(hit => ids.has(hit.id))).toEqual([]);
    for (const id of ids) await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id, version: 1 }] }, access(), emptyBridge), id).rejects.toThrow(/MEMORY_RECORD_UNAVAILABLE|MEMORY_IDENTITY|MEMORY_SCOPE_DENIED|MEMORY_EVIDENCE_UNAVAILABLE/);
  });

  describe("cold and warm index parity", () => {
    const TERMS = ["harbour", "lantern", "oil", "quartz"];
    const bm25 = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      try { return TERMS.map(term => db.prepare("SELECT version,bm25(lexical) AS score FROM lexical WHERE lexical MATCH ? ORDER BY rank,id").all(`"${term}"`).map(r => r.score)); }
      finally { db.close(); }
    };
    const project = (index: MemoryIndex) => {
      for (;;) {
        const batch = pendingProjectionRecords(database(), 16);
        if (!batch.length) return;
        index.upsert(batch.map(row => ({ id: String(row.id), version: Number(row.version), scopeId: String(row.scopeId), text: row.state === "deleted" ? "" : String(row.text), deleted: row.state === "deleted", archived: row.state === "archived" })));
        for (const row of batch) database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id=? AND record_version=?").run(row.id, row.version);
      }
    };
    it("a legacy indexed brief leaves the index at open, and a new brief is never indexed", () => {
      fact("moss", "harbour lantern schedule is posted on the door");
      fact("moss", "harbour lantern oil is bought on Tuesdays");
      const cleanPath = join(DATA_DIR, "clean-index.db"), path = join(DATA_DIR, "memory-index.db");
      const clean = new MemoryIndex(cleanPath); opened.push(clean);
      const dirty = new MemoryIndex(path); opened.push(dirty);
      project(dirty);
      for (const row of database().prepare("SELECT id,version,scope_id,text FROM memory_records WHERE kind='fact'").all())
        clean.upsert([{ id: String(row.id), version: Number(row.version), scopeId: String(row.scope_id), text: String(row.text), deleted: false }]);
      // the pre-P2 state: the brief carried an indexed receipt and an index entry
      const legacy = writeBotIdentity(ticket, brief("harbour lantern harbour lantern harbour lantern quartz quartz oil"), roster);
      expect(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id=?").get(legacy.id)!.n).toBe(0);
      database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'indexed','indexed',NULL)").run(legacy.id);
      dirty.upsert([{ id: legacy.id, version: 1, scopeId: scopeOf("moss"), text: String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(legacy.id)!.text), deleted: false }]);
      expect(bm25(path)).not.toEqual(bm25(cleanPath));
      const eligibility = new MemoryEligibility(join(DATA_DIR, "messages.db")); opened.push(eligibility);
      expect(eligibility.pipRecordIds()).toEqual([legacy.id]);
      expect(dirty.purgeRecords(eligibility.pipRecordIds())).toBeGreaterThan(0);
      expect(bm25(path)).toEqual(bm25(cleanPath));
      expect(dirty.purgeRecords(eligibility.pipRecordIds())).toBe(0);
      // warm: a brief edit adds no receipt, so nothing is projected for it
      writeBotIdentity(ticket, brief("harbour lantern edited", "moss", 1), roster);
      expect(pendingProjectionRecords(database(), 16).filter(row => row.id === legacy.id)).toEqual([]);
      expect(bm25(path)).toEqual(bm25(cleanPath));
    });
  });
});

describe("the brief is a PIP kind", () => {
  it("renders exactly as before", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const off = await buildMemoryBundle("", access(), emptyBridge);
    expect(off.text).toMatch(/- m1 \(owner-authored fictional continuity; not world truth; continuity-brief\) "Moss keeps the harbour log and answers briefly\."/);
    expect(off.continuity).toBeUndefined();
    const on = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(on.text).toBe(off.text);
    expect(on.continuity).toEqual({ brought: 0, total: 0 });
  });

  it("takes no projection receipt and bumps no policy revision on write or edit", () => {
    const first = writeBotIdentity(ticket, brief(), roster);
    const before = meta();
    writeBotIdentity(ticket, brief("Moss keeps the log.", "moss", 1), roster);
    expect(meta()).toEqual(before);
    expect(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id=?").get(first.id)!.n).toBe(0);
    // character canon keeps the global bump (it can live on in replayed replies
    // no receipt cites); reveal state is targeted like other records
    writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lamp", expectedVersion: 0, text: "The lamp is brass.", basis: "fiction", audience: "owner-private" }, roster);
    expect(meta().policy_revision).toBe(before.policy_revision + 1);
  });

  it("revokes only the disclosures that carried the old brief", async () => {
    writeBotIdentity(ticket, brief(), roster);
    writeBotIdentity(ticket, brief("Neutral keeps the dock log.", "neutral"), roster);
    const mine = await deliver("moss", "private"), other = await deliver("neutral", "neutral-thread");
    expect(mine.state()).toBe("delivered");
    writeBotIdentity(ticket, brief("Moss keeps the log and answers plainly.", "moss", 1), roster);
    expect(mine.state()).toBe("revoked");
    expect(other.state()).toBe("delivered");
    // the next turn rebuilds with the new text
    const next = await buildMemoryBundle("", access(), emptyBridge);
    expect(next.text).toContain("answers plainly");
  });

  it("refuses generic forget and every generic control, and is deleted only through the dedicated action", async () => {
    const row = writeBotIdentity(ticket, brief(), roster);
    const before = meta();
    for (const request of [
      { action: "forget", kind: "record", id: row.id }, { action: "archive", id: row.id, version: 1 }, { action: "restore-archive", id: row.id, version: 1 },
      { action: "correct", id: row.id, version: 1, text: "Edited from the generic editor." }, { action: "promote", id: row.id, version: 1, scopeId: scopeOf("neutral") },
    ] as Array<Record<string, unknown>>) await expect(memoryOwnerRoute(ACTION, request, ticket, roster), String(request.action)).rejects.toThrow(/MEMORY_IDENTITY_PIP_USE_CONTINUITY|MEMORY_IDENTITY_WRITE_REQUIRED|INVALID_MEMORY/);
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(row.id)!.state).toBe("active");
    expect(meta()).toEqual(before);
    // stale version first, then the real delete; the field is not retired for good
    await expect(memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 2, expectedId: row.id }, ticket, roster)).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(await memoryOwnerRoute(ACTION, { action: "identity-delete", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 1, expectedId: row.id }, ticket, roster)).toMatchObject({ deleted: true });
    const again = writeBotIdentity(ticket, brief("A fresh brief."), roster);
    expect(again.id).not.toBe(row.id);
    expect(again.id).toBe(botIdentityRecordId("moss", "continuity-brief", "core", 1));
    expect(() => writeBotIdentity(ticket, { ...brief("Stale window.", "moss", 1), expectedId: row.id }, roster)).toThrow("MEMORY_VERSION_CONFLICT");
  });
});

describe("I-10 guards over every PIP kind", () => {
  it("refuses the generic functions on a row of each kind and leaves it untouched", async () => {
    const rows = [
      ["continuity-brief", writeBotIdentity(ticket, brief(), roster).id],
      ["commitment", writeBotIdentity(ticket, pip("commitment", "water", "Water the plants."), roster).id],
      ["relation", writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster).id],
      ["self-trait", writeBotIdentity(ticket, pip("self-trait", "calm", "Stays calm."), roster).id],
      ["pip-proposal", synthetic("pip-proposal", "p")], ["pip-counter", synthetic("pip-counter", "c")], ["concern", synthetic("concern", "k")], ["episode", synthetic("episode", "e")],
    ] as const;
    const before = meta();
    for (const [kind, id] of rows) {
      expect(() => assertGenericMemoryTarget(database(), id, 1), kind).toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
      expect(() => archiveMemoryRecord(ticket, id, 1), kind).toThrow("MEMORY_IDENTITY_WRITE_REQUIRED");
      expect(() => pinMemory(ticket, id, 1, true), kind).toThrow("MEMORY_IDENTITY_NOT_PINNABLE");
      expect(() => rejectGenericForgetOfPip(ticket, { kind: "record", id }), kind).toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
      for (const action of ["archive", "restore-archive", "forget"] as const)
        await expect(memoryOwnerRoute(ACTION, action === "forget" ? { action, kind: "record", id } : { action, id, version: 1 }, ticket, roster), `${kind} ${action}`).rejects.toThrow("MEMORY_IDENTITY_PIP_USE_CONTINUITY");
      expect(database().prepare("SELECT state,owner_pinned FROM memory_records WHERE id=?").get(id), kind).toEqual({ state: "active", owner_pinned: 0 });
    }
    expect(meta()).toEqual(before);
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_tombstones").get()!.n)).toBe(0);
  });

  it("deletes a row of any PIP kind through the one version-fenced delete", () => {
    const scopeId = scopeOf("moss");
    for (const kind of ["pip-proposal", "pip-counter", "concern", "episode"]) {
      const id = synthetic(kind, "d");
      expect(() => deletePipRecord(id, scopeId, 2), kind).toThrow("MEMORY_VERSION_CONFLICT");
      expect(deletePipRecord(id, scopeId, 1), kind).toEqual({ id, deleted: true });
      expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(id)!.state).toBe("deleted");
      expect(() => deletePipRecord(id, scopeId, 1), kind).toThrow("MEMORY_NOT_FOUND");
    }
    const ordinary = fact("moss", "An ordinary note.");
    expect(() => deletePipRecord(ordinary, scopeId, 1)).toThrow("MEMORY_NOT_FOUND");
  });
});

describe("deliver-once listeners on the receipt", () => {
  it("runs each listener once, independently, in order, and a throwing listener fails neither the turn nor the next listener", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const a = access();
    const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", a, emptyBridge, { continuity: true }), a, "driver-one");
    const calls: string[] = [];
    receipt.addOnDelivered(() => { calls.push("first"); });
    receipt.addOnDelivered(() => { calls.push("throws"); throw new Error("a listener failed"); });
    receipt.addOnDelivered(bundle => { calls.push(`third:${bundle.bundleId === receipt.bundle.bundleId}`); });
    attachContinuityCoverage(receipt, "moss", { brought: 2, total: 4 });
    expect(calls).toEqual([]);
    receipt.sessionStarted("s1");
    expect(() => receipt.accepted()).not.toThrow();
    receipt.accepted(); receipt.completed(true);
    expect(calls).toEqual(["first", "throws", "third:true"]);
    expect(readContinuityCoverage("moss")).toMatchObject({ brought: 2, total: 4, turn: receipt.bundle.bundleId });
  });
  it("runs no listener for a turn that was never delivered", async () => {
    const a = access();
    const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", a, emptyBridge), a, "driver-one");
    let ran = false;
    receipt.addOnDelivered(() => { ran = true; });
    database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(receipt.bundle.bundleId);
    expect(() => receipt.accepted()).toThrow();
    expect(ran).toBe(false);
  });
});

describe("continuity settings", () => {
  it("validates strictly and clears on null or an empty object", () => {
    expect(parseContinuityOptions(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseContinuityOptions(null)).toEqual({ ok: true, value: undefined });
    expect(parseContinuityOptions({})).toEqual({ ok: true, value: undefined });
    expect(parseContinuityOptions({ reflect: true, inner: true, between: true, innerState: true, selfCutover: true, reflectModel: " gpt-x " })).toEqual({ ok: true, value: { reflect: true, inner: true, between: true, innerState: true, selfCutover: true, reflectModel: "gpt-x" } });
    expect(parseContinuityOptions({ shadow: { modelSelection: { provider: "p", model: "m" }, since: 5, dailyCap: 40 } })).toMatchObject({ ok: true, value: { shadow: { since: 5, dailyCap: 40 } } });
    for (const bad of [[], "x", 3, { reflect: false }, { reflect: "true" }, { other: true }, { reflectModel: "" }, { reflectModel: 4 }, { reflectModel: "a\nb" }, { shadow: { since: 1 } }, { shadow: { modelSelection: {}, since: 1, dailyCap: 41 } }, { shadow: { modelSelection: {}, since: "x", dailyCap: 4 } }])
      expect(parseContinuityOptions(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  });
  it("recognises the reflection pseudo thread", () => {
    expect(isPipReflectThread("pip-reflect:moss:run1:lived:1")).toBe(true);
    for (const id of ["moss", "pip-shadow:moss", "", undefined, 4]) expect(isPipReflectThread(id)).toBe(false);
  });
});

describe("PIP bundle order, prefix and cache", () => {
  const cacheRow = () => database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-render:moss'").get() as { intent: string } | undefined;
  function seed(withBrief = true) {
    const ids: Record<string, string> = {};
    ids.brief = withBrief ? writeBotIdentity(ticket, brief(), roster).id : botIdentityRecordId("moss", "continuity-brief", "core");
    ids.reveal = (() => {
      const canon = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "lamp", expectedVersion: 0, text: "CANON_HIDDEN the keeper hid a key.", basis: "fiction", audience: "owner-private" }, roster);
      return writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "reveal-state", key: "lamp", expectedVersion: 0, text: "REVEAL_NOTE the owner heard about the key.", basis: "fiction", audience: "owner-private", canon: { id: canon.id, version: 1 }, revealed: true }, roster).id;
    })();
    ids.relation = writeBotIdentity(ticket, pip("relation", "owner", "We plan on Mondays."), roster).id;
    ids.c1 = writeBotIdentity(ticket, pip("commitment", "first", "Send the weekly summary."), roster).id;
    ids.c2 = writeBotIdentity(ticket, pip("commitment", "second", "Never book travel without asking."), roster).id;
    ids.t1 = writeBotIdentity(ticket, pip("self-trait", "plain", "Prefers plain words."), roster).id;
    ids.o1 = observed("o1", "Answer the weekly summary first.", 9000);
    stamp(ids.relation, 500); stamp(ids.c1, 1000); stamp(ids.c2, 2000); stamp(ids.t1, 3000);
    return ids;
  }

  it("places the brief, then attested rows newest first, then observed rows, then reveal state", async () => {
    const ids = seed();
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(bundle.recordVersions.map(row => row.id)).toEqual([ids.brief, ids.t1, ids.c2, ids.c1, ids.relation, ids.o1, ids.reveal]);
    expect(bundle.text).not.toContain("CANON_HIDDEN");
    expect(bundle.continuity).toEqual({ brought: 5, total: 5 });
  });

  it("attributes each line from its tier tag and keeps the brief and reveal lines as they were", async () => {
    seed();
    const { text } = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(text).toContain(`(${PIP_ATTRIBUTION.attested}; About me (you said))`);
    expect(text).toContain(`(${PIP_ATTRIBUTION.attested}; Commitments (you said))`);
    expect(text).toContain(`(${PIP_ATTRIBUTION.attested}; How we work together)`);
    expect(text).toContain(`(${PIP_ATTRIBUTION.observed}; Commitments (confirmed))`);
    expect(text).toMatch(/\(owner-authored fictional continuity; not world truth; continuity-brief\)/);
    expect(text).toMatch(/\(owner-authored fictional continuity; not world truth; reveal-state\)/);
    expect(text).not.toMatch(/the owner said/);
  });

  it("keeps a byte-identical PIP prefix across turns and writes one render-cache row", async () => {
    seed();
    const first = await buildMemoryBundle("", access(), emptyBridge, { continuity: true, continuityOptions: { reflect: true } });
    const row1 = cacheRow()!.intent;
    const second = await buildMemoryBundle("harbour", access(), emptyBridge, { continuity: true, continuityOptions: { reflect: true } });
    expect(second.text).toBe(first.text);
    expect(cacheRow()!.intent).toBe(row1);
    // recall sits after the PIP prefix: a fact joins, the prefix is unchanged
    const f = fact("moss", "harbour lantern oil is bought on Tuesdays");
    const recalled = await buildMemoryBundle("harbour lantern", access(), { search: async () => ({ hits: [{ id: f, version: 1, score: 9 } as unknown as IndexHit], vectorRows: 0 }) }, { continuity: true, continuityOptions: { reflect: true } });
    const close = first.text.lastIndexOf("\n");
    expect(recalled.text.startsWith(first.text.slice(0, close))).toBe(true);
    expect(recalled.text.length).toBeGreaterThan(first.text.length);
    // a different setting is a different key
    await buildMemoryBundle("", access(), emptyBridge, { continuity: true, continuityOptions: { reflect: true, inner: true } });
    expect(cacheRow()!.intent).not.toBe(row1);
  });

  it("drops the render cache on every PIP write and delete, and rebuilds the same bytes without it", async () => {
    const ids = seed();
    const first = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(cacheRow()).toBeDefined();
    database().prepare("DELETE FROM memory_scope_bindings WHERE id='pip-render:moss'").run();
    const rebuilt = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(rebuilt.text).toBe(first.text);
    writeBotIdentity(ticket, pip("commitment", "third", "Call back on Friday."), roster);
    expect(cacheRow()).toBeUndefined();
    await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(cacheRow()).toBeDefined();
    deleteBotIdentity(ticket, { action: "identity-delete", botId: "moss", kind: "commitment", key: "first", expectedVersion: 1 }, roster);
    expect(cacheRow()).toBeUndefined();
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(ids.c1)!.state).toBe("deleted");
    writeBotIdentity(ticket, brief("Moss keeps the harbour log.", "moss", 1), roster);
    expect(cacheRow()).toBeUndefined();
  });

  it("never replays a cached selection after a row is deleted behind the cache", async () => {
    const ids = seed();
    await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(ids.t1);
    const after = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(after.recordVersions.map(row => row.id)).not.toContain(ids.t1);
  });

  it("holds a third of the self slot for observed rows when attested rows could fill it", async () => {
    writeBotIdentity(ticket, brief(), roster);
    for (let n = 0; n < 24; n++) { const row = writeBotIdentity(ticket, pip("commitment", `a-${n}`, `Attested ${String(n).padStart(2, "0")} ${"x".repeat(90)}`), roster); stamp(row.id, 10000 + n); }
    const obs = [0, 1, 2].map(n => observed(`r${n}`, `Observed ${n} ${"y".repeat(90)}`, 20000 + n));
    const bundle = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    const mounted = bundle.identity.filter(r => obs.includes(r.id));
    expect(mounted.length).toBeGreaterThanOrEqual(1);
    // §2.2 order (attested, then observed) holds inside the advertised prefix (the first pass, frozen by the render
    // cache) and again inside the rows the second pass appends after it: the second pass never moves a prefix row.
    const selection = (JSON.parse(String((database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-render:moss'").get() as { intent: string }).intent)).selection as Array<{ id: string }>).map(entry => entry.id);
    const inOrder = (tiers: Array<string | undefined>) => tiers.slice(0, tiers.indexOf("observed") < 0 ? tiers.length : tiers.indexOf("observed")).every(tier => tier === "attested") && tiers.slice(tiers.indexOf("observed") < 0 ? tiers.length : tiers.indexOf("observed")).every(tier => tier === "observed");
    const commitments = bundle.identity.filter(r => r.kind === "commitment");
    const prefixIds = new Set(selection);
    expect(inOrder(commitments.filter(r => prefixIds.has(r.id)).map(r => r.pipTier))).toBe(true);
    expect(inOrder(commitments.filter(r => !prefixIds.has(r.id)).map(r => r.pipTier))).toBe(true);
    expect(bundle.identity.map(r => r.id).slice(0, selection.length)).toEqual(selection);
    expect(bundle.tokenCount - MEMORY_FRAME_TOKENS).toBeLessThanOrEqual(2048);
    expect(bundle.continuity!.total).toBe(27);
  });

  it("cuts a brief that does not fit at a sentence boundary and keeps the receipt valid", async () => {
    const sentences = Array.from({ length: 12 }, (_, n) => `Sentence number ${n} says something plain about the harbour.`).join(" ");
    const row = writeBotIdentity(ticket, brief(sentences.slice(0, 760)), roster);
    const tiny = await buildMemoryBundle("", access(), emptyBridge, { continuity: true, availableContextTokens: 1200 });
    const brief0 = tiny.identity.find(r => r.id === row.id);
    if (brief0) {
      expect(brief0.cutBytes).toBeGreaterThan(0);
      expect(brief0.text.endsWith(".")).toBe(true);
      expect(Buffer.byteLength(brief0.text)).toBe(brief0.cutBytes);
    }
    const a = access();
    const bundle = await buildMemoryBundle("", a, emptyBridge, { continuity: true, availableContextTokens: 1200 });
    const receipt = new MemoryDispatchReceipt(bundle, a, "driver-one");
    expect(() => receipt.assertCurrent()).not.toThrow();
    receipt.sessionStarted("s"); receipt.accepted();
    // a wide window keeps the whole brief, with no cut marker
    const wide = await buildMemoryBundle("", access(), emptyBridge, { continuity: true });
    expect(wide.identity.find(r => r.id === row.id)!.cutBytes).toBeUndefined();
    expect(wide.text).toContain("Sentence number 5");
  });

  it("is byte-identical to today for a bot with Continuity off, whatever PIP rows exist", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const baseline = await buildMemoryBundle("", access(), emptyBridge);
    seed(false);
    database().prepare("UPDATE memory_records SET state='archived' WHERE kind='reveal-state'").run();
    for (const options of [{}, { continuity: false }, { continuity: false, continuityOptions: { reflect: true } }]) {
      const off = await buildMemoryBundle("", access(), emptyBridge, options);
      expect(off.text).toBe(baseline.text);
      expect(off.recordVersions).toEqual(baseline.recordVersions);
    }
    expect(cacheRow()).toBeUndefined();
  });

  it("mixes on and off bots without crossing rows, and skips every PIP slot for a room", async () => {
    writeBotIdentity(ticket, brief("Neutral keeps the dock log.", "neutral"), roster);
    writeBotIdentity(ticket, pip("commitment", "dock", "Check the dock lights.", {}, "neutral"), roster);
    seed();
    const on = await buildMemoryBundle("", access("moss", "private"), emptyBridge, { continuity: true });
    const off = await buildMemoryBundle("", access("neutral", "neutral-thread"), emptyBridge);
    expect(on.text).toContain("weekly summary");
    expect(off.text).not.toContain("weekly summary");
    expect(off.text).toContain("dock log");
    expect(off.text).not.toContain("dock lights");
    const room = await buildMemoryBundle("", access("moss", "room-thread"), emptyBridge, { continuity: true });
    expect(room.identity).toEqual([]);
    expect(room.continuity).toBeUndefined();
  });
});

describe("PIP render rules", () => {
  it("orders the self slot by tier, then recency, then standing, then id", () => {
    const rows = [
      { id: "d", tier: "observed", reinforcedAt: 9 }, { id: "b", tier: "attested", reinforcedAt: 1 }, { id: "a", tier: "attested", reinforcedAt: 5 },
      { id: "c", tier: "attested", reinforcedAt: 5, contested: true }, { id: "e", tier: "attested", reinforcedAt: 9, disputed: true }, { id: "f", tier: "attested", reinforcedAt: 5 },
    ] as const;
    expect(selfSlotOrder(rows).map(r => r.id)).toEqual(["a", "f", "b", "c", "e", "d"]);
  });
  it("reserves a third of the slot for observed rows only when one exists", () => {
    expect(observedReservation(600, true)).toBe(200);
    expect(observedReservation(601, true)).toBe(201);
    expect(observedReservation(600, false)).toBe(0);
  });
  it("fades imported rows by half about every fourteen sessions", () => {
    expect(importFadeMultiplier(0)).toBe(1);
    expect(importFadeMultiplier(-3)).toBe(1);
    expect(importFadeMultiplier(14)).toBeCloseTo(0.4966, 3);
    expect(importFadeMultiplier(28)).toBeLessThan(importFadeMultiplier(14));
  });
  it("reads reinforcedAt from the entities and falls back to the creation time", () => {
    expect(reinforcedAtOf(JSON.stringify(["owner-private", "x", "reinforcedAt:1234"]), 5)).toBe(1234);
    expect(reinforcedAtOf(JSON.stringify(["owner-private", "x"]), 5)).toBe(5);
    expect(reinforcedAtOf("not json", 7)).toBe(7);
  });
  it("cuts at the last sentence that fits", () => {
    const text = "One is here. Two is here. Three is here.";
    expect(cutAtSentence(text, 100)).toBe(text);
    expect(cutAtSentence(text, 26)).toBe("One is here. Two is here.");
    expect(cutAtSentence(text, 15)).toBe("One is here.");
    expect(cutAtSentence(text, 5)).toBeUndefined();
  });
  it("labels each tier and facet", () => {
    expect(pipKindLabel("commitment", "observed")).toBe("Commitments (confirmed)");
    expect(pipKindLabel("self-trait", "observed")).toBe("About me (confirmed)");
    expect(pipKindLabel("relation", "attested")).toBe("How we work together");
    expect(pipKindLabel("concern", "self", "wondering")).toBe("Something I've been wondering");
    expect(pipKindLabel("episode", "summary")).toBe("Earlier conversation");
    expect(pipKindLabel("fact", "attested")).toBeUndefined();
  });
});

const EM_DASH = String.fromCharCode(0x2014);
describe("I-24 and the copy rules", () => {
  const files = [
    "pip-kinds.ts", "pip-types.ts", "pip-claims.ts", "pip-vocabulary.ts", "pip-render.ts", "pip-claims.test.ts", "pip-p2-b1.test.ts",
  ].map(name => [name, readFileSync(new URL(name, import.meta.url), "utf8")] as const);
  const docs = [["CLAIM-VOCABULARY.md", readFileSync(new URL("../../lanes/pip/CLAIM-VOCABULARY.md", import.meta.url), "utf8")] as const];
  it("has no em dash in any PIP string, template, label or published list", () => {
    for (const [name, text] of [...files, ...docs]) expect(text.includes(EM_DASH), name).toBe(false);
    for (const value of [...Object.values(PIP_ATTRIBUTION), PIP_IMPORTED_SUFFIX]) expect(value).not.toContain(EM_DASH);
  });
  it("avoids the words the copy rules forbid", () => {
    for (const [name, text] of [...files.filter(([n]) => !n.endsWith(".test.ts")), ...docs]) {
      expect(text, name).not.toMatch(/\b(safe|safety|unsafe)\b/i);
      expect(text, name).not.toMatch(/always-on|self-evolving/i);
    }
    for (const value of Object.values(PIP_ATTRIBUTION)) expect(value).not.toMatch(/\b(feel|feels|felt|alive|aware|conscious)\b/i);
  });
});
