import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { humanMayReadRecord } from "../human-principals.ts";
import { randomUUID } from "node:crypto";
import { database } from "../database.ts";
import type { MemoryBundle, MemoryEvidenceHandle } from "../../shared/memory.ts";
import { MEMORY_HANDLE_LIMIT, MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE, memoryHandle, memoryHandlePosition, memoryRequestPrefix } from "../../shared/memory.ts";
import { accessIncludesRoom, assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import { threadCheckpointId, unsettledIntention } from "./checkpoints.ts";

export interface BundleRecord {
  id: string; version: number; scopeId: string; text: string; assertion: string;
  pinned: boolean; kind: string; identityBasis?: string; sourceOutcome?: "failed"; evidence: MemoryEvidenceHandle[];
}
export interface BoundedMemoryBundle extends MemoryBundle {
  evolutionPolicyRevision:string;
  pinned: BundleRecord[]; identity: BundleRecord[]; checkpoint: BundleRecord[]; evidence: BundleRecord[];
}
const bundles = new WeakMap<MemoryBundle, {access: MemoryAccess; records: BundleRecord[]}>();

/** Hydrate authoritative bytes only; an approved projection does not expose its private parents. */
export function hydrateMemoryRecord(id: string, version: number, access: MemoryAccess): BundleRecord {
  return hydrate(id,version,access,false);
}

/** A thread's own checkpoint rolls on every captured message in that thread, the
 * turn's own prompt and reply included, so the version selected for a dispatch
 * is routinely archived inside the dispatch window. That supersession forgets
 * nothing: the archived version is a bounded index of evidence that is still
 * active at the same revisions, under the same policy revision and deletion
 * epoch (an owner forget, archive or policy change moves one of those and is
 * refused on its own). A disclosed version in that state is stale, not
 * revoked. Everything else stays fail-closed: the record must be the current
 * thread's checkpoint, unpinned, untombstoned, with a newer active version and
 * every evidence source intact.
 *
 * "The current thread" is the thread the turn is dispatched for
 * (access.threadId), never the bot's own thread: a room member's turn is
 * claimed for the room thread (server/index.ts runGroupMemberTurn), so the
 * room checkpoint — which rolls on every member's prompt and reply — is that
 * turn's own, while the member's own-thread checkpoint and other rooms'
 * checkpoints are not (dispatch-preparation.test.ts, RED2E). */
export function supersededThreadCheckpoint(id: string, version: number, access: MemoryAccess): boolean {
  const db = database();
  const row = db.prepare("SELECT scope_id,kind,state,owner_pinned FROM memory_records WHERE id=? AND version=?").get(id,version);
  if (!row || row.kind !== "checkpoint" || row.state !== "archived" || row.owner_pinned === 1 || id !== threadCheckpointId(String(row.scope_id),access.threadId)) return false;
  return Boolean(db.prepare("SELECT 1 FROM memory_records WHERE id=? AND version>? AND state='active' LIMIT 1").get(id,version));
}

/** Hydrate a version that was disclosed to a turn: identical to hydrateMemoryRecord
 * except that the thread's own superseded checkpoint is accepted as stale. */
export function hydrateDisclosedMemoryRecord(id: string, version: number, access: MemoryAccess): BundleRecord {
  try { return hydrate(id,version,access,false); }
  catch (error) {
    if (!supersededThreadCheckpoint(id,version,access)) throw error;
    return hydrate(id,version,access,true);
  }
}

function hydrate(id: string, version: number, access: MemoryAccess, allowSuperseded: boolean): BundleRecord {
  assertMemoryAccess(access);
  const db = database();
  const row = db.prepare(allowSuperseded
    ? "SELECT * FROM memory_records WHERE id=? AND version=? AND state IN ('active','archived')"
    : "SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'").get(id,version);
  if (!row || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(id,version)) throw new Error("MEMORY_RECORD_UNAVAILABLE");
  assertMemoryAccess(access,String(row.scope_id));
  if(!humanMayReadRecord(db,id,version,access.humanPrincipal))throw new Error("MEMORY_SCOPE_DENIED");
  const details=db.prepare("SELECT partition,confidence_basis FROM memory_record_details WHERE record_id=? AND record_version=?").get(id,version);
  if(details?.partition==="identity"){
    const own=db.prepare("SELECT 1 FROM memory_scopes WHERE id=? AND ((kind='bot' AND owner_key=?) OR kind='conversation')").get(row.scope_id,access.botId);
    if(!own||accessIncludesRoom(access))throw new Error("MEMORY_SCOPE_DENIED");
  }
  const evidence = db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id,version) as unknown as MemoryEvidenceHandle[];
  if (!evidence.length && row.assertion !== "owner-statement") throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  for (const handle of evidence) {
    const source = db.prepare("SELECT s.scope_id,s.state,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.revision,handle.sourceId);
    if (!source || source.state !== "active" || source.revision !== handle.revision || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    assertMemoryAccess(access,String(source.scope_id));
    const text = JSON.parse(String(source.payload)).text;
    if (typeof text !== "string" || !Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Buffer.byteLength(text)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  }
  // A captured chunk keeps its source's settlement (checkpoints.ts): an unsettled
  // intention is not current evidence; a failed tool output is only a failure.
  let sourceOutcome: "failed" | undefined;
  if (row.kind === "source") {
    const sources = db.prepare("SELECT s.speaker,s.outcome,s.turn_id,s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(id,version);
    if (!allowSuperseded && row.owner_pinned !== 1 && sources.some(source => unsettledIntention(db,source))) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    if (sources.some(source => source.speaker === "tool" && source.outcome === "failed")) sourceOutcome = "failed";
  }
  return {id,version,scopeId:String(row.scope_id),text:String(row.text),assertion:String(row.assertion),pinned:row.owner_pinned===1,kind:String(row.kind),...(details?.partition==="identity"?{identityBasis:String(details.confidence_basis??"Unverified identity context")}:{ }),...(sourceOutcome?{sourceOutcome}:{}),evidence};
}

/** Engine-facing rendering: attributed remembered words only. Record ids, scopes
 * and evidence handles stay in BundleRecord, the receipts and the MCP tools.
 * Each line opens with its turn-local handle (m1, m2, …): the 1-based position
 * of the record in the bundle, which is also its position in recordVersions and
 * in the disclosure receipt (MEMJSON2). */
const ASSERTION_LABELS: Record<string, string> = {
  "owner-statement": "the owner said",
  "tool-observation": "a tool showed",
  "assistant-inference": "earlier assistant inference",
  "unverified-import": "imported, unverified",
};
function referenceLine(record: BundleRecord, position: number): string {
  const attribution = record.kind==="character-canon" ? "fictional character canon; not model autobiography or world truth" : record.identityBasis?.includes("fictional") ? "owner-authored fictional continuity; not world truth" : record.sourceOutcome==="failed" ? "a tool reported a failed action" : ASSERTION_LABELS[record.assertion] ?? "unattributed";
  const kind = /^[a-z][a-z-]{0,31}$/.test(record.kind) ? record.kind : "note";
  // One JSON string literal per line: stored text cannot introduce a newline,
  // the closing tag or the current-request boundary. Angle brackets are
  // escaped so the frame's tags never appear inside remembered text.
  const quoted = JSON.stringify(record.text).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `- ${memoryHandle(position)} (${attribution}; ${kind}${record.pinned ? "; pinned by the owner" : ""}) ${quoted}`;
}
function render(records: BundleRecord[]) {
  if (!records.length) return "";
  return [MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, ...records.map((record, index) => referenceLine(record, index + 1)), MEMORY_REFERENCE_CLOSE].join("\n");
}

/** The record a turn-local handle names in this bundle, or undefined when the
 * handle is malformed or past the last remembered line. Position N of the
 * frame is recordVersions[N-1]: the same order the receipt persists. */
export function memoryHandleRecord(bundle: MemoryBundle, handle: unknown): {id: string; version: number} | undefined {
  const position = memoryHandlePosition(handle);
  if (position === undefined) return undefined;
  const row = bundle.recordVersions[position - 1];
  return row ? {id: row.id, version: row.version} : undefined;
}
function tokens(text: string) { return Buffer.byteLength(memoryRequestPrefix(text),"utf8"); }

/** No tokenizer dependency: UTF-8 bytes conservatively bound tokens, including metadata. */
export async function buildMemoryBundle(query: string, access: MemoryAccess, bridge: MemorySearchBridge, options: {availableContextTokens?: number; signal?: AbortSignal; excludeMessageIds?: readonly string[]; excludeSourceIds?: readonly string[]; evolutionPolicy?:MemoryEvolutionPolicy} = {}): Promise<BoundedMemoryBundle> {
  const evolutionPolicy=options.evolutionPolicy??readMemoryEvolutionPolicy();
  assertMemoryAccess(access);
  options.signal?.throwIfAborted();
  const available = options.availableContextTokens ?? 20480;
  if (!Number.isSafeInteger(available) || available < 0) throw new Error("INVALID_MEMORY_CONTEXT_BUDGET");
  const budget = Math.min(2048,Math.floor(available/10));
  const db = database();
  // Do not prefilter stale pins: losing their evidence is a mandatory dispatch failure.
  // A room member reaches its own bot scope, but never its owner-private
  // identity partition, pinned or not: that is withheld, not a failed pin.
  const room = accessIncludesRoom(access);
  const pinRows = db.prepare(`SELECT id,version FROM memory_records r WHERE state='active' AND owner_pinned=1 AND scope_id IN (SELECT value FROM json_each(?))
    ${room ? "AND NOT EXISTS (SELECT 1 FROM memory_record_details d WHERE d.record_id=r.id AND d.record_version=r.version AND d.partition='identity')" : ""} ORDER BY id,version`).all(JSON.stringify(access.scopeIds));
  // More pins than handles cannot fit any budget either; name the real limit.
  if (pinRows.length > MEMORY_HANDLE_LIMIT) throw new Error("MEMORY_PIN_OVERFLOW: curate owner pins or increase available context before dispatch");
  const pinned = pinRows.map(row => {
    try { return hydrateMemoryRecord(String(row.id),Number(row.version),access); }
    catch { assertMemoryAccess(access); throw new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch"); }
  });
  if (tokens(render(pinned)) > budget) throw new Error("MEMORY_PIN_OVERFLOW: curate owner pins or increase available context before dispatch");
  const selected = [...pinned], identity: BundleRecord[] = [], checkpoint: BundleRecord[] = [], evidence: BundleRecord[] = [];
  let degradedReason: string | undefined;
  const add = (record: BundleRecord, target: BundleRecord[]) => {
    if (selected.length>=MEMORY_HANDLE_LIMIT || selected.some(r => r.id===record.id && r.version===record.version)) return;
    if (tokens(render([...selected,record])) <= budget) { selected.push(record); target.push(record); }
  };
  // Compact private continuity is engine-independent and precedes optional
  // general recall. Long canon remains searchable instead of filling every turn.
  const identityRows=db.prepare(`SELECT r.id,r.version FROM memory_records r
    JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    JOIN memory_scopes s ON s.id=r.scope_id
    WHERE r.state='active' AND r.owner_pinned=0 AND d.partition='identity'
    AND s.kind='bot' AND s.owner_key=? AND s.id IN (SELECT value FROM json_each(?))
    AND r.kind IN ('continuity-brief','reveal-state')
    ORDER BY CASE r.kind WHEN 'continuity-brief' THEN 0 ELSE 1 END,r.created_at DESC,r.id`).all(access.botId,JSON.stringify(access.scopeIds));
  for(const row of room ? [] : identityRows){
    try { add(hydrateMemoryRecord(String(row.id),Number(row.version),access),identity); }
    catch { assertMemoryAccess(access); degradedReason="MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; }
  }
  // Reserve recall space while letting checkpoints use the unused pin share.
  // Measure the same framed representation as final delivery, including evidence
  // metadata. A second pass may use recall space left empty after retrieval.
  // The fixed frame (preamble, tags, request boundary) is paid once by every
  // non-empty bundle and is not a record's share: the ceiling sits above it,
  // or a preamble longer than the share would defer every checkpoint behind
  // recall (p09.test.ts, group-member-checkpoint-roll-api.test.ts).
  const frame = tokens([MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_CLOSE].join("\n"));
  const checkpointCeiling = Math.min(budget,Math.max(frame+896,tokens(render(pinned))+384));
  const deferredCheckpoints: BundleRecord[] = [];
  const checkpoints = db.prepare("SELECT id,version FROM memory_records WHERE state='active' AND owner_pinned=0 AND kind='checkpoint' AND scope_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT 10").all(JSON.stringify(access.scopeIds));
  for (const row of checkpoints) {
    try {
      const record = hydrateMemoryRecord(String(row.id),Number(row.version),access);
      if (tokens(render([...selected,record])) <= checkpointCeiling) add(record,checkpoint);
      else deferredCheckpoints.push(record);
    } catch { assertMemoryAccess(access); degradedReason = "MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; }
  }
  if (query.trim()) {
    // The dispatching message is captured before its own bundle is built, so
    // recall would otherwise hand the engine its current request back as a
    // remembered "source" chunk (MEMJSON2). Any record whose evidence rests
    // solely on this turn's own messages is left out of recall; pins and the
    // thread checkpoint are untouched (a pin is an owner constraint, and the
    // checkpoint is one record summarising the whole thread).
    // Likewise a notebook the prompt already carries whole (the bot's
    // MEMORY.md, its team brief) is not recalled again as imported chunks.
    const ownSources = new Set([...ownMessageSources(db,access.threadId,options.excludeMessageIds),...(options.excludeSourceIds ?? [])]);
    try {
      const result = await searchMemory(query,access,bridge,{limit:20,signal:options.signal,evolutionPolicy});
      degradedReason = result.degradedReason ?? degradedReason;
      for (const hit of result.hits) {
        try {
          const record = hydrateMemoryRecord(hit.id,hit.version,access);
          if (!citesOnly(record,ownSources)) add(record,evidence);
        }
        catch { assertMemoryAccess(access); degradedReason = "MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; }
      }
    } catch {
      options.signal?.throwIfAborted();
      assertMemoryAccess(access);
      degradedReason = "MEMORY_RECALL_UNAVAILABLE";
    }
  }
  for (const record of deferredCheckpoints) add(record,checkpoint);
  options.signal?.throwIfAborted();
  assertMemoryAccess(access);
  // The optional await may have invalidated source revisions without changing policy.
  for (const record of [...selected]) {
    try {
      const current = hydrateMemoryRecord(record.id,record.version,access);
      if (JSON.stringify(current)!==JSON.stringify(record)) throw new Error("MEMORY_RECORD_CHANGED");
    } catch {
      assertMemoryAccess(access);
      if (record.pinned) throw new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch");
      selected.splice(selected.indexOf(record),1);
      for (const list of [identity,checkpoint,evidence]) { const index=list.indexOf(record); if (index>=0) list.splice(index,1); }
      degradedReason="MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE";
    }
  }
  const text = render(selected);
  const sourceVersions = [...new Map(selected.flatMap(r=>r.evidence).map(e=>[JSON.stringify([e.sourceId,e.revision]),{id:e.sourceId,revision:e.revision}])).values()];
  const bundle: BoundedMemoryBundle = {evolutionPolicyRevision:evolutionPolicy.revision,bundleId:randomUUID(),text,policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,tokenCount:tokens(text),recordVersions:selected.map(r=>({id:r.id,version:r.version})),sourceVersions,pinned,identity,checkpoint,evidence,...degradedReason?{degradedReason}:{}};
  // Keep an immutable original across async transport and prevent caller-forged bundles.
  for (const record of selected) { for (const handle of record.evidence) Object.freeze(handle); Object.freeze(record.evidence); Object.freeze(record); }
  for (const row of bundle.recordVersions) Object.freeze(row);
  for (const row of bundle.sourceVersions) Object.freeze(row);
  Object.freeze(bundle.recordVersions); Object.freeze(bundle.sourceVersions);
  Object.freeze(pinned); Object.freeze(identity); Object.freeze(checkpoint); Object.freeze(evidence); Object.freeze(bundle);
  bundles.set(bundle,{access,records:selected});
  return bundle;
}

/** Source ids captured from the given messages of the dispatching thread. */
function ownMessageSources(db: ReturnType<typeof database>, threadId: string, messageIds: readonly string[] | undefined): Set<string> {
  const ids = [...new Set((messageIds ?? []).filter(id => typeof id === "string" && id))];
  if (!ids.length) return new Set();
  const rows = db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))").all(threadId,JSON.stringify(ids));
  return new Set(rows.map(row => String(row.id)));
}
/** True when every evidence handle of a record points at one of the sources. */
function citesOnly(record: BundleRecord, sources: Set<string>): boolean {
  return sources.size > 0 && record.evidence.length > 0 && record.evidence.every(handle => sources.has(handle.sourceId));
}

/** Must run immediately before the adapter call, after all other asynchronous setup. */
export function assertMemoryBundle(bundle: MemoryBundle, access: MemoryAccess) {
  const trusted = bundles.get(bundle);
  if (!trusted || trusted.access !== access) throw new Error("MEMORY_BUNDLE_UNTRUSTED");
  if (bundle.tokenCount !== tokens(bundle.text)) throw new Error("MEMORY_BUNDLE_BUDGET_MISMATCH");
  assertMemoryAccess(access);
  for (const record of trusted.records) {
    const current = hydrateDisclosedMemoryRecord(record.id,record.version,access);
    if (JSON.stringify(current)!==JSON.stringify(record)) throw new Error("MEMORY_CONTEXT_REVOKED");
  }
}
