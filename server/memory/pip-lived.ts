// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 lived self-model (design 1.2, 4): proposals built from the owner's own words, confirm-to-write
// observed rows, contradiction counters with Keep, generation rules, and the stance events that feed them.
// Every statement is template-built by the host from owner bytes; the model only nominates spans.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { redactSecretsInText } from "../redact.ts";
import { botIdentityRecordId, deletePipRecord, invalidatePipRender, PIP_ACTIVE_CAP } from "./identity.ts";
import { pipCounterId, pipProposalId } from "./pip-kinds.ts";
import { admissibleSentenceRanges, claimEntity, claimsCompatible, claimsContradict, parseAuthoredStatement, parseOwnerText, type ParsedClaim } from "./pip-claims.ts";
import { boundQuote, ownerSourceStillAdmissible, type AdmittedSource } from "./pip-admission.ts";
import { reconcilePipStances, type StanceBinding } from "./pip-stance.ts";
import { learningWriteDecision } from "./learning-guard.ts";

export interface Handle { sourceId: string; revision: number; start: number; end: number }
export type TargetKind = "commitment" | "self-trait";
export type ProposalState = "proposed" | "confirmed" | "dismissed" | "invalidated";

export const PROPOSAL_ACTIVE_CAP = 24;
export const PROPOSAL_EXPIRY_MS = 30 * 24 * 3_600_000;
export const COUNTER_OCCASION_CAP = 64;
const MAX_HANDLES = 8;
export const LIVED_BASIS = {
  proposal: "pip:proposal; Proposed from your own words; not yet confirmed",
  observed: "pip:observed; Confirmed by the owner from the owner's own words",
  counter: "pip:counter; Owner words that point the other way",
} as const;
export const COUNTER_TEXT = "Something the owner said points the other way.";

const sha = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const entitiesOf = (raw: unknown): string[] => { try { const v = JSON.parse(String(raw)); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const entityValue = (entities: string[], prefix: string): string | undefined => entities.find(e => e.startsWith(prefix))?.slice(prefix.length);
const claimOf = (entities: string[], text: string): ParsedClaim | null => {
  const raw = entityValue(entities, "claim:");
  if (raw !== undefined) { if (raw === "null") return null; try { return JSON.parse(raw) as ParsedClaim; } catch { return null; } }
  return parseAuthoredStatement(text);
};

/** A slug that names the statement and cannot collide: words, then six hex of the statement hash. */
export function slugOf(statement: string): string {
  const words = statement.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38).replace(/-+$/g, "");
  return `${words || "note"}-${sha(statement).slice(0, 6)}`;
}

// ------------------------------------------------------------------ rows ----

interface Version { id: string; scopeId: string; kind: string; text: string; assertion: string; basis: string; entities: string[]; handles?: Handle[]; claimStatus?: "provisional" | "current" | "disputed"; botId: string }

/** Insert the next version of a PIP row (supersede the previous). Returns the new version number. */
function insertVersion(db: DatabaseSync, v: Version): number {
  const previous = db.prepare("SELECT version,owner_pinned,state FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(v.id);
  const version = Number(previous?.version ?? 0) + 1, now = Date.now();
  if (previous && previous.state === "active") db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now, v.id, Number(previous.version));
  db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,'active',?,?,NULL,?,?)").run(v.id, version, v.scopeId, v.kind, redactSecretsInText(v.text), v.assertion, previous?.owner_pinned ?? 0, now, previous ? v.id : null, now);
  db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=?,claim_status=? WHERE record_id=? AND record_version=?")
    .run(v.basis, JSON.stringify(v.entities), v.claimStatus ?? "provisional", v.id, version);
  for (const h of v.handles ?? []) db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?,?,?)").run(v.id, version, h.sourceId, h.revision, h.start, h.end);
  invalidatePipRender(db, v.botId);
  return version;
}
type Latest = Record<string, any> & { entityList: string[] };
const latest = (db: DatabaseSync, id: string): Latest | undefined => {
  const row = db.prepare("SELECT r.*,d.entities,d.confidence_basis,d.claim_status FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=? ORDER BY r.version DESC LIMIT 1").get(id) as Record<string, any> | undefined;
  return row ? { ...row, entityList: entitiesOf(row.entities) } : undefined;
};
const handlesOf = (db: DatabaseSync, id: string, version: number): Handle[] =>
  db.prepare("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id,start_byte").all(id, version)
    .map(r => ({ sourceId: String(r.source_id), revision: Number(r.source_revision), start: Number(r.start_byte), end: Number(r.end_byte) }));
const tombstoned = (db: DatabaseSync, id: string) => Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id));
export const excludedThreadsOf = (db: DatabaseSync, botId: string): string[] => {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get("pip-reflect:" + botId);
  if (!row) return [];
  try { const v = JSON.parse(String(row.intent)).excludedThreads; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

// -------------------------------------------------------------- proposals ----

export interface ProposalDraft { targetKind: TargetKind; statement: string; claim: ParsedClaim; act: string; handles: Handle[] }

/** Write or extend proposals (idempotent by id). Dismissed ids stay refused through their tombstone. */
export function writeProposals(db: DatabaseSync, botId: string, scopeId: string, drafts: readonly ProposalDraft[]): { written: number; skipped: number } {
  expireProposals(botId);
  let written = 0, skipped = 0;
  for (const d of drafts) {
    const slug = slugOf(d.statement), id = pipProposalId(botId, d.targetKind, slug, d.statement);
    if (tombstoned(db, id) || tombstoned(db, botIdentityRecordId(botId, d.targetKind, slug))) { skipped++; continue; }
    const existing = latest(db, id);
    if (existing && existing.state === "active") {
      const state = existing.entityList[2] as ProposalState;
      if (state !== "proposed") { skipped++; continue; }
      const have = handlesOf(db, id, Number(existing.version));
      const fresh = d.handles.filter(h => !have.some(x => x.sourceId === h.sourceId));
      if (!fresh.length || have.length >= MAX_HANDLES) { skipped++; continue; }
      insertVersion(db, { id, botId, scopeId, kind: "pip-proposal", text: d.statement, assertion: "assistant-inference", basis: LIVED_BASIS.proposal, entities: existing.entityList, handles: [...have, ...fresh].slice(0, MAX_HANDLES) });
      written++; continue;
    }
    const open = Number(db.prepare(`SELECT count(*) AS n FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
      WHERE r.scope_id=? AND r.kind='pip-proposal' AND r.state='active' AND json_extract(d.entities,'$[2]')='proposed'`).get(scopeId)!.n);
    if (open >= PROPOSAL_ACTIVE_CAP) { skipped++; continue; }
    insertVersion(db, { id, botId, scopeId, kind: "pip-proposal", text: d.statement, assertion: "assistant-inference", basis: LIVED_BASIS.proposal,
      entities: [d.targetKind, slug, "proposed", claimEntity(d.claim), "act:" + d.act], handles: d.handles.slice(0, MAX_HANDLES) });
    written++;
  }
  return { written, skipped };
}

export interface ProposalView { id: string; version: number; targetKind: TargetKind; statement: string; state: ProposalState; createdAt: number; act: string; quotes: Array<{ sourceId: string; text: string }>; confirmedRecordId?: string }

/** Owner-only list for the Self tab: proposals still open, and what each rests on (the owner's own words). */
export function listProposals(ticket: object, botId: string, roster: MemoryRoster, now = Date.now()): ProposalView[] {
  requireMemoryOwner(ticket);
  if (!roster.bots.some(b => b.id === botId)) throw new Error("MEMORY_SUBJECT_UNKNOWN");
  const db = database(), scopeId = ensureScope("bot", botId);
  const rows = db.prepare("SELECT r.id,r.version,r.text,r.created_at,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.scope_id=? AND r.kind='pip-proposal' AND r.state='active' ORDER BY r.created_at DESC,r.id").all(scopeId);
  const out: ProposalView[] = [];
  for (const r of rows) {
    const entities = entitiesOf(r.entities), state = entities[2] as ProposalState;
    if (state !== "proposed" || now - Number(r.created_at) > PROPOSAL_EXPIRY_MS) continue;
    const quotes: ProposalView["quotes"] = [];
    for (const h of handlesOf(db, String(r.id), Number(r.version))) {
      const src = db.prepare("SELECT v.payload FROM memory_source_versions v WHERE v.source_id=? AND v.revision=?").get(h.sourceId, h.revision);
      let text = ""; try { text = String(JSON.parse(String(src?.payload)).text ?? ""); } catch { /* withheld */ }
      const q = boundQuote(text, h.start, h.end);
      if (q) quotes.push({ sourceId: h.sourceId, text: q });
    }
    if (!quotes.length) continue;
    out.push({ id: String(r.id), version: Number(r.version), targetKind: entities[0] as TargetKind, statement: String(r.text), state, createdAt: Number(r.created_at), act: entityValue(entities, "act:") ?? "", quotes });
  }
  return out;
}

/** Thirty days without an answer: an administrative version, never a deletion. */
export function expireProposals(botId: string, now = Date.now()): number {
  return transaction(db => {
    const scopeId = ensureScope("bot", botId);
    let n = 0;
    for (const r of db.prepare("SELECT r.id,r.version,r.text,r.created_at,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.scope_id=? AND r.kind='pip-proposal' AND r.state='active'").all(scopeId)) {
      const entities = entitiesOf(r.entities);
      if (entities[2] !== "proposed" || now - Number(r.created_at) <= PROPOSAL_EXPIRY_MS) continue;
      entities[2] = "invalidated";
      insertVersion(db, { id: String(r.id), botId, scopeId, kind: "pip-proposal", text: String(r.text), assertion: "assistant-inference", basis: LIVED_BASIS.proposal, entities: [...entities, "admin:expired"], handles: handlesOf(db, String(r.id), Number(r.version)) });
      n++;
    }
    return n;
  });
}

export type ConfirmResult = { ok: true; id: string; version: number; recordId: string; already?: true } | { ok: false; reason: "stale" | "invalid" | "cap" | "not-found" | "retired" };

/** I-5: the only writer of an observed row. Re-checks I-1 and the byte binding inside the transaction. */
export function confirmPipProposal(ticket: object, input: { botId: string; id: string; expectedVersion: number }, roster: MemoryRoster): ConfirmResult {
  requireMemoryOwner(ticket);
  if (!roster.bots.some(b => b.id === input.botId)) throw new Error("MEMORY_SUBJECT_UNKNOWN");
  return transaction(db => {
    const scopeId = ensureScope("bot", input.botId), cur = latest(db, input.id);
    if (!cur || cur.scope_id !== scopeId || cur.kind !== "pip-proposal" || cur.state !== "active" || tombstoned(db, input.id)) return { ok: false, reason: "not-found" } as const;
    const e = cur.entityList, state = e[2] as ProposalState, kind = e[0] as TargetKind, slug = e[1];
    const confirmedId = entityValue(e, "confirmed:");
    if (state === "confirmed" && confirmedId) return { ok: true, id: input.id, version: Number(cur.version), recordId: confirmedId, already: true } as const;
    if (Number(cur.version) !== input.expectedVersion) return { ok: false, reason: "stale" } as const;
    if (state !== "proposed") return { ok: false, reason: "invalid" } as const;
    const invalidate = (): ConfirmResult => {
      insertVersion(db, { id: input.id, botId: input.botId, scopeId, kind: "pip-proposal", text: String(cur.text), assertion: "assistant-inference", basis: LIVED_BASIS.proposal, entities: [kind, slug, "invalidated", ...e.slice(3)], handles: handlesOf(db, input.id, Number(cur.version)) });
      return { ok: false, reason: "invalid" };
    };
    if (Date.now() - Number(cur.created_at) > PROPOSAL_EXPIRY_MS) return invalidate();
    const handles = handlesOf(db, input.id, Number(cur.version)), excluded = excludedThreadsOf(db, input.botId);
    const claim = claimOf(e, String(cur.text));
    if (!handles.length || !claim) return invalidate();
    for (const h of handles) {
      if (!ownerSourceStillAdmissible(db, input.botId, h.sourceId, h.revision, excluded)) return invalidate();
      const src = db.prepare("SELECT s.thread_id,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?").get(h.sourceId, h.revision);
      let text = ""; try { text = String(JSON.parse(String(src?.payload)).text ?? ""); } catch { return invalidate(); }
      const parsed = admissibleSentenceRanges(text).find(p => p.start === h.start && p.end === h.end);
      if (!parsed || !parsed.result.ok || parsed.result.production === "RETRACT" || parsed.result.statement !== String(cur.text) || JSON.stringify(parsed.result.claim) !== JSON.stringify(claim)) return invalidate();
      const decision = learningWriteDecision(db, { writer: "pip-reflection", sourceId: h.sourceId, sourceRevision: h.revision, targetScopeId: scopeId, botId: input.botId, threadId: String(src?.thread_id), target: "identity" });
      if (decision.decision !== "auto") return invalidate();
    }
    const recordId = botIdentityRecordId(input.botId, kind, slug);
    if (tombstoned(db, recordId)) return { ok: false, reason: "retired" } as const;
    const existing = latest(db, recordId);
    if (!existing || existing.state !== "active") {
      const active = Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=? AND kind=? AND state='active'").get(scopeId, kind)!.n);
      if (active >= PIP_ACTIVE_CAP) return { ok: false, reason: "cap" } as const;
      const now = Date.now();
      insertVersion(db, { id: recordId, botId: input.botId, scopeId, kind, text: String(cur.text), assertion: "assistant-inference", basis: LIVED_BASIS.observed,
        entities: ["owner-private", slug, claimEntity(claim), "gen:1", `reinforcedAt:${now}`], handles, claimStatus: "current" });
    }
    const version = insertVersion(db, { id: input.id, botId: input.botId, scopeId, kind: "pip-proposal", text: String(cur.text), assertion: "assistant-inference", basis: LIVED_BASIS.proposal,
      entities: [kind, slug, "confirmed", claimEntity(claim), "act:" + (entityValue(e, "act:") ?? ""), "confirmed:" + recordId], handles });
    return { ok: true, id: input.id, version, recordId } as const;
  });
}

/** Dismiss tombstones the proposal id, so the same statement is never proposed again. */
export function dismissPipProposal(ticket: object, input: { botId: string; id: string; expectedVersion: number }, roster: MemoryRoster) {
  requireMemoryOwner(ticket);
  if (!roster.bots.some(b => b.id === input.botId)) throw new Error("MEMORY_SUBJECT_UNKNOWN");
  return deletePipRecord(input.id, ensureScope("bot", input.botId), input.expectedVersion);
}

// -------------------------------------------------- stance events, counters ----

const stanceId = (botId: string) => "pip-stance:" + botId;
function readStance(db: DatabaseSync, botId: string): StanceBinding {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(stanceId(botId));
  try { const v = row ? JSON.parse(String(row.intent)) : null; if (v && typeof v.support === "object") return v; } catch { /* fresh */ }
  return { support: {} };
}
function writeStance(db: DatabaseSync, botId: string, value: StanceBinding) {
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-stance',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(stanceId(botId), ensureScope("bot", botId), JSON.stringify(value));
}
export const generationOf = (entities: string[]): number => Number(entityValue(entities, "gen:") ?? 0) || 0;
/** Distinct reinforcing occasions on the current generation. */
export function supportCount(db: DatabaseSync, botId: string, targetId: string, generation: number): number {
  return (readStance(db, botId).support[`${targetId}#${generation}`] ?? []).length;
}
export interface CounterState { id: string; version: number; occasions: string[]; kept: string[]; saturated: boolean; disputed: boolean }
export function readCounter(db: DatabaseSync, botId: string, targetId: string, generation: number): CounterState | null {
  const id = pipCounterId(targetId, generation), cur = latest(db, id);
  if (!cur || cur.state !== "active") return null;
  const occasions = cur.entityList.filter(x => x.startsWith("occ:")).map(x => x.slice(4));
  const kept = cur.entityList.filter(x => x.startsWith("kept:")).map(x => x.slice(5));
  const saturated = cur.entityList.includes("saturated");
  const support = supportCount(db, botId, targetId, generation);
  const unkept = occasions.filter(o => !kept.includes(o)).length;
  return { id, version: Number(cur.version), occasions, kept, saturated, disputed: saturated || unkept >= Math.max(5, Math.ceil(0.3 * support)) };
}
export const retireCounter = (db: DatabaseSync, targetId: string, generation: number) => {
  const id = pipCounterId(targetId, generation);
  if (!db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(id) || tombstoned(db, id)) return;
  db.prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'pip-generation-change',?)").run(randomUUID(), id, Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), Date.now());
  db.prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(id);
};

export interface StanceDraft { targetId: string; handle: Handle; quote: string }
export interface StanceOutcome { reinforced: number; countered: number; related: number; dropped: number }

/** Host-computed stance events. The model nominates (target, span); the host parses the owner's words and decides. */
export function applyStanceEvents(db: DatabaseSync, botId: string, scopeId: string, drafts: readonly StanceDraft[]): StanceOutcome {
  const out: StanceOutcome = { reinforced: 0, countered: 0, related: 0, dropped: 0 };
  reconcilePipStances(db, botId);
  const stance = readStance(db, botId);
  let dirty = false;
  for (const d of drafts) {
    const target = latest(db, d.targetId);
    if (!target || target.scope_id !== scopeId || target.state !== "active" || !["commitment", "self-trait"].includes(String(target.kind))) { out.dropped++; continue; }
    const tClaim = claimOf(target.entityList, String(target.text));
    const parsed = parseOwnerText(d.quote).find(p => p.result.ok)?.result;
    if (!tClaim || !parsed || !parsed.ok) { out.dropped++; continue; }
    const gen = generationOf(target.entityList), key = `${d.targetId}#${gen}`, occasion = d.handle.sourceId;
    let verdict: "reinforce" | "contradict" | "related";
    if (parsed.production === "RETRACT") verdict = claimsContradict(tClaim, parsed.retract) ? "contradict" : "related";
    else if (claimsCompatible(tClaim, parsed.claim) && (parsed.claim.kind === "self-trait") === (parsed.production.startsWith("OBS"))) verdict = "reinforce";
    else if (claimsContradict(tClaim, parsed.claim)) verdict = "contradict";
    else verdict = "related";
    const events = (stance.events ??= {})[key] ??= {};
    const priorEvent = events[occasion];
    if (priorEvent?.verdict === verdict && priorEvent.handle.revision === d.handle.revision) { out.dropped++; continue; }
    events[occasion] = { verdict, handle: d.handle }; dirty = true;
    // Remove the previous side before admitting this occasion's current stance.
    stance.support[key] = (stance.support[key] ?? []).filter(id => id !== occasion);
    if (verdict === "related") { out.related++; continue; }
    if (verdict === "reinforce") {
      const seen = stance.support[key] ?? [];
      if (seen.includes(occasion)) { out.dropped++; continue; }
      stance.support[key] = [...seen, occasion]; dirty = true; out.reinforced++;
      const entities = target.entityList.map(x => x.startsWith("reinforcedAt:") ? `reinforcedAt:${Date.now()}` : x);
      db.prepare("UPDATE memory_record_details SET entities=? WHERE record_id=? AND record_version=?").run(JSON.stringify(entities), d.targetId, Number(target.version));
      invalidatePipRender(db, botId);
      continue;
    }
    const cid = pipCounterId(d.targetId, gen), counter = latest(db, cid);
    if (counter && counter.state === "active" && counter.entityList.includes(`occ:${occasion}`)) { out.dropped++; continue; }
    const prev = counter && counter.state === "active" ? counter.entityList : [d.targetId, `gen:${gen}`];
    const occCount = prev.filter(x => x.startsWith("occ:")).length;
    const entities = occCount >= COUNTER_OCCASION_CAP ? (prev.includes("saturated") ? prev : [...prev, "saturated"]) : [...prev, `occ:${occasion}`];
    const prior = counter && counter.state === "active" ? handlesOf(db, cid, Number(counter.version)) : [];
    const handles = occCount >= COUNTER_OCCASION_CAP ? prior : [...prior, d.handle];
    insertVersion(db, { id: cid, botId, scopeId, kind: "pip-counter", text: COUNTER_TEXT, assertion: "assistant-inference", basis: LIVED_BASIS.counter, entities, handles });
    out.countered++;
    const state = readCounter(db, botId, d.targetId, gen);
    if (state?.disputed) db.prepare("UPDATE memory_record_details SET claim_status='disputed' WHERE record_id=? AND record_version=?").run(d.targetId, Number(target.version));
  }
  if (dirty) { writeStance(db, botId, stance); reconcilePipStances(db, botId); }
  return out;
}

/** I-9 Keep: the owner keeps the row despite the counter occasions. CAS on (target, generation, counter version). */
export function keepPipRecord(ticket: object, input: { botId: string; targetId: string; generation: number; counterVersion: number }, roster: MemoryRoster): { ok: boolean; reason?: "stale" | "not-found" } {
  requireMemoryOwner(ticket);
  if (!roster.bots.some(b => b.id === input.botId)) throw new Error("MEMORY_SUBJECT_UNKNOWN");
  return transaction(db => {
    const scopeId = ensureScope("bot", input.botId), target = latest(db, input.targetId);
    if (!target || target.scope_id !== scopeId || target.state !== "active") return { ok: false, reason: "not-found" as const };
    const counter = readCounter(db, input.botId, input.targetId, input.generation);
    if (!counter || generationOf(target.entityList) !== input.generation) return { ok: false, reason: "not-found" as const };
    if (counter.version !== input.counterVersion) return { ok: false, reason: "stale" as const };
    const cur = latest(db, counter.id)!;
    const add = counter.occasions.filter(o => !counter.kept.includes(o)).map(o => `kept:${o}`);
    insertVersion(db, { id: counter.id, botId: input.botId, scopeId, kind: "pip-counter", text: COUNTER_TEXT, assertion: "assistant-inference", basis: LIVED_BASIS.counter,
      entities: [...cur.entityList, ...add], handles: handlesOf(db, counter.id, counter.version) });
    db.prepare("UPDATE memory_record_details SET claim_status='current' WHERE record_id=? AND record_version=?").run(input.targetId, Number(target.version));
    invalidatePipRender(db, input.botId);
    return { ok: true };
  });
}

// ------------------------------------------- applying one lived model result ----

export interface LivedResult {
  proposals: Array<{ act: string; spans: Array<{ sourceId: string; start: number; end: number }> }>;
  stance: Array<{ targetId: string; span: { sourceId: string; start: number; end: number } }>;
  episode: { text: string; sourceIds: string[] } | null;
  reported?: unknown;
}
export const LIVED_SCHEMA = {
  type: "object", additionalProperties: false, required: ["proposals", "stance", "episode"],
  properties: {
    proposals: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["act", "spans"], properties: { act: { type: "string" }, spans: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["sourceId", "start", "end"], properties: { sourceId: { type: "string" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } } } } } } },
    stance: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["targetId", "span"], properties: { targetId: { type: "string" }, span: { type: "object", additionalProperties: false, required: ["sourceId", "start", "end"], properties: { sourceId: { type: "string" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } } } } } },
    episode: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["text", "sourceIds"], properties: { text: { type: "string" }, sourceIds: { type: "array", items: { type: "string" }, maxItems: 12 } } }] },
    reported: { type: "object" },
  },
} as const;

/** Shape check for a persisted or replayed result (the host never trusts the binary's validation). */
export function validLivedResult(v: unknown): v is LivedResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const span = (s: unknown) => !!s && typeof s === "object" && typeof (s as any).sourceId === "string" && Number.isInteger((s as any).start) && Number.isInteger((s as any).end);
  return Array.isArray(r.proposals) && r.proposals.length <= 6 && r.proposals.every((p: any) => p && typeof p.act === "string" && Array.isArray(p.spans) && p.spans.length >= 1 && p.spans.length <= 3 && p.spans.every(span))
    && Array.isArray(r.stance) && r.stance.length <= 12 && r.stance.every((s: any) => s && typeof s.targetId === "string" && span(s.span))
    && (r.episode === null || (!!r.episode && typeof (r.episode as any).text === "string" && Array.isArray((r.episode as any).sourceIds) && (r.episode as any).sourceIds.length <= 12 && (r.episode as any).sourceIds.every((x: unknown) => typeof x === "string")));
}

/** Every nominated range must be one host-admitted sentence of the complete source. */
export function validOwnerNominations(admitted: readonly AdmittedSource[], result: LivedResult, options: { botName?: string } = {}): boolean {
  const sources = new Map(admitted.filter(s => s.kind === "owner").map(s => [s.sourceId, admissibleSentenceRanges(s.text, options)]));
  const find = (s: { sourceId: string; start: number; end: number }) => sources.get(s.sourceId)?.find(r => r.start === s.start && r.end === s.end)?.result;
  return result.proposals.every(p => {
    let statement: string | undefined;
    return p.spans.every(s => {
      const parsed = find(s);
      if (!parsed?.ok || parsed.production === "RETRACT" || parsed.production !== p.act || (statement !== undefined && parsed.statement !== statement)) return false;
      statement = parsed.statement;
      return true;
    });
  }) && result.stance.every(s => find(s.span)?.ok);
}

export interface LivedApplication { proposals: number; stance: StanceOutcome; dropped: number; episode: LivedEpisode | null }
export interface LivedEpisode { text: string; handles: Handle[] }

/** Verify every nomination against admitted owner bytes and write what survives. Runs inside the application transaction. */
export function applyLivedResult(db: DatabaseSync, botId: string, scopeId: string, admitted: readonly AdmittedSource[], result: LivedResult, options: { botName?: string } = {}): LivedApplication {
  const bySource = new Map(admitted.filter(a => a.kind === "owner").map(a => [a.sourceId, a]));
  const drafts: ProposalDraft[] = [];
  let dropped = 0;
  for (const p of result.proposals) {
    const handles: Handle[] = [];
    let statement: string | undefined, claim: ParsedClaim | undefined, ok = true;
    for (const s of p.spans) {
      const src = bySource.get(s.sourceId);
      const parsed = src ? admissibleSentenceRanges(src.text, options).find(x => x.start === s.start && x.end === s.end)?.result : undefined;
      if (!src || !parsed || !parsed.ok || parsed.production === "RETRACT" || parsed.production !== p.act) { ok = false; break; }
      if (statement !== undefined && statement !== parsed.statement) { ok = false; break; }
      statement = parsed.statement; claim = parsed.claim;
      handles.push({ sourceId: src.sourceId, revision: src.revision, start: s.start, end: s.end });
    }
    if (!ok || !statement || !claim) { dropped++; continue; }
    // I-4: the destination must resolve to this bot's own identity scope for every handle.
    const allowed = handles.every(h => {
      const decision = learningWriteDecision(db, { writer: "pip-reflection", sourceId: h.sourceId, sourceRevision: h.revision, targetScopeId: scopeId, botId, threadId: bySource.get(h.sourceId)!.threadId, target: "identity" });
      return decision.decision === "auto";
    });
    if (!allowed) { dropped++; continue; }
    drafts.push({ targetKind: claim.kind, statement, claim, act: p.act, handles });
  }
  const written = writeProposals(db, botId, scopeId, drafts);
  const stanceDrafts: StanceDraft[] = [];
  for (const s of result.stance) {
    const src = bySource.get(s.span.sourceId), quote = src ? boundQuote(src.text, s.span.start, s.span.end) : null;
    if (!src || !quote || !admissibleSentenceRanges(src.text, options).some(x => x.start === s.span.start && x.end === s.span.end)) { dropped++; continue; }
    stanceDrafts.push({ targetId: s.targetId, quote, handle: { sourceId: src.sourceId, revision: src.revision, start: s.span.start, end: s.span.end } });
  }
  const stance = applyStanceEvents(db, botId, scopeId, stanceDrafts);
  let episode: LivedEpisode | null = null;
  if (result.episode) {
    const handles = [...new Set(result.episode.sourceIds)].map(id => bySource.get(id)).filter((x): x is AdmittedSource => Boolean(x))
      .map(a => ({ sourceId: a.sourceId, revision: a.revision, start: 0, end: Math.max(1, Buffer.byteLength(a.text)) }));
    episode = { text: result.episode.text, handles };
  }
  return { proposals: written.written, stance, dropped: dropped + written.skipped, episode };
}

export interface DisputeView { targetId: string; text: string; kind: TargetKind; generation: number; counterVersion: number; unkept: number; support: number }
/** Owner-only: observed rows that counter evidence is disputing, with what Keep needs (CAS values). */
export function pipDisputes(ticket: object, botId: string, roster: MemoryRoster): DisputeView[] {
  requireMemoryOwner(ticket);
  if (!roster.bots.some(b => b.id === botId)) throw new Error("MEMORY_SUBJECT_UNKNOWN");
  const db = database(), scopeId = ensureScope("bot", botId), out: DisputeView[] = [];
  for (const r of db.prepare(`SELECT r.id,r.kind,r.text,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    WHERE r.scope_id=? AND r.kind IN ('commitment','self-trait') AND r.state='active' AND d.claim_status='disputed'`).all(scopeId)) {
    const generation = generationOf(entitiesOf(r.entities)), counter = readCounter(db, botId, String(r.id), generation);
    if (!counter) continue;
    out.push({ targetId: String(r.id), text: String(r.text), kind: r.kind as TargetKind, generation, counterVersion: counter.version, unkept: counter.occasions.filter(o => !counter.kept.includes(o)).length, support: supportCount(db, botId, String(r.id), generation) });
  }
  return out;
}
