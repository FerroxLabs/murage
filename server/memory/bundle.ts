import { authorityStamp, pinStamp } from "./authority-epoch.ts";
import { ownerPinIndexPresent } from "./schema.ts";
import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { createHash, randomUUID } from "node:crypto";
import { database } from "../database.ts";
import { drainMarkerForTurn } from "./send-fence.ts";
import type { MemoryBundle, MemoryEvidenceHandle } from "../../shared/memory.ts";
import { MEMORY_HANDLE_LIMIT, MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE, memoryHandle, memoryHandlePosition, memoryRequestPrefix } from "../../shared/memory.ts";
import { accessIncludesRoom, assertMemoryAccess, inMemoryAccessPass, type MemoryAccess } from "./policy.ts";
import { readableMemoryRecord, type MemoryReadOptions } from "./readable.ts";
import { noteRecallDegraded, searchMemory, type MemorySearchBridge } from "./search.ts";
import { causeOf } from "./worker-log.ts";
import { episodeHits } from "./pip-episodes.ts";
import { generationOf, readCounter } from "./pip-lived.ts";
import { supersededThreadCheckpoint, threadCheckpointId } from "./checkpoints.ts";
import { isLineageLimit, LineageAllowance, recordRestsOnWithheldMessage } from "./replay-lineage.ts";
import { threadCaptureScope } from "./capture-scope.ts";
import { PIP_ALL_KINDS_SQL, isPipOwnerKind, pipRenderId, pipTierOf, type PipTier } from "./pip-kinds.ts";
import { observedReservation, pipAttribution, pipKindLabel, reinforcedAtOf, selfSlotOrder, sentenceEnds } from "./pip-render.ts";
import { turnTrace } from "../turn-trace.ts";
import { scopeRow } from "./scope-id.ts";
import { maskFinancialIdentifiers } from "../../shared/financial-ids.ts";

// Moved to checkpoints.ts (replay-lineage.ts reads it without importing this module).
export { supersededThreadCheckpoint };

export interface BundleRecord {
  id: string; version: number; scopeId: string; text: string; assertion: string;
  pinned: boolean; kind: string; identityBasis?: string; sourceOutcome?: "failed"; evidence: MemoryEvidenceHandle[];
  /** The `pip:<tier>` tag of a PIP row (design §2.4): attribution is chosen from it. Absent on every other row. */
  pipTier?: PipTier; pipImported?: true;
  /** Set only when the bundle cut a too-long brief at a sentence boundary: `text` is then the first `cutBytes` bytes of the stored text. */
  cutBytes?: number;
}
export interface BoundedMemoryBundle extends MemoryBundle {
  evolutionPolicyRevision:string;
  pinned: BundleRecord[]; identity: BundleRecord[]; checkpoint: BundleRecord[]; evidence: BundleRecord[];
  /** Owner pins left out because they rest on a reply bots no longer see
   * (pinRestsOnWithheldReply); the caller tells the owner. */
  withheldPins?: ReadonlyArray<{id: string; version: number}>;
  /** Owner pins left out because together they do not fit this model's share (more than the handles, or more bytes than the budget),
   * trailing ones first (1.0.4). The turn runs without them; the caller tells the owner once per thread. */
  droppedPins?: ReadonlyArray<{id: string; version: number}>;
  /** Owner-only: how many owner-authored continuity rows this bundle carried of
   * those the bot has (PIP A7). Never part of `text`. Present only when the
   * bot's Continuity switch was on for this build. */
  continuity?: {brought: number; total: number};
  /** Recall kept the hits it could prove and left out ones it could not prove within its own budget or that read "checking" (a revoke still
   * being marked): partial, never empty for that reason. Never part of `text`. */
  recallPartial?: true;
}
/** Recall's own lineage budget (DESIGN-WRITETIME, S4): a recall candidate is proven from this, never from the turn's transcript allowance, so a
 * turn whose transcript spent its allowance still recalls what can be proven, marked partial. The same bounds as a tool read. */
export function recallBudget(): LineageAllowance { return LineageAllowance.tool(); }
const bundles = new WeakMap<MemoryBundle, {access: MemoryAccess; records: BundleRecord[]; withheldMessage?: (threadId: string, messageId: string, allowance: LineageAllowance) => boolean}>();

/** Hydrate authoritative bytes only; an approved projection does not expose its private parents. Every check is
 * readableMemoryRecord's (readable.ts), the one function memory_get, bundle hydration and search share. */
export function hydrateMemoryRecord(id: string, version: number, access: MemoryAccess, options: HydrateOptions): BundleRecord {
  return hydrate(id,version,access,false,options);
}

/** Hydrate a version that was disclosed to a turn: identical to hydrateMemoryRecord
 * except that the thread's own superseded checkpoint is accepted as stale. */
export function hydrateDisclosedMemoryRecord(id: string, version: number, access: MemoryAccess, options: HydrateOptions): BundleRecord {
  try { return hydrate(id,version,access,false,options); }
  catch (error) {
    if (!supersededThreadCheckpoint(id,version,access)) throw error;
    return hydrate(id,version,access,true,options);
  }
}
/** memory_get's extra reader rules: a bot's own tool call (no owner-authored continuity) and its transcript rule. */
export type HydrateOptions = Pick<MemoryReadOptions, "allowance" | "agent" | "withheldMessage">;

function hydrate(id: string, version: number, access: MemoryAccess, allowSuperseded: boolean, options: HydrateOptions): BundleRecord {
  return inMemoryAccessPass(() => hydrateInPass(id, version, access, allowSuperseded, options));
}
function hydrateInPass(id: string, version: number, access: MemoryAccess, allowSuperseded: boolean, options: HydrateOptions): BundleRecord {
  const read = readableMemoryRecord(id, version, access, { ...options, mode: allowSuperseded ? "disclosed" : "current" });
  if (typeof read === "string") throw new Error(read);
  const {row, details, evidence, sourceOutcome} = read;
  return bundleRecordOf(id, version, row, details, evidence, sourceOutcome);
}
/** The BundleRecord a stored row becomes: the one constructor hydration and the Pin-time measure (assertOwnerPinsFit) share, so both
 * render the same line (attribution, kind label, pin mark). */
function bundleRecordOf(id: string, version: number, row: Record<string, unknown>, details: {partition?: unknown; confidence_basis?: unknown} | undefined, evidence: MemoryEvidenceHandle[], sourceOutcome: "failed" | undefined): BundleRecord {
  const pipTier=details?.partition==="identity"?pipTierOf(details.confidence_basis):undefined;
  // Masked at read too, so a row the scrub has not reached yet never hands an engine its digits (scrub-pass.ts).
  return {id,version,scopeId:String(row.scope_id),text:maskFinancialIdentifiers(String(row.text)),assertion:String(row.assertion),pinned:row.owner_pinned===1,kind:String(row.kind),...(details?.partition==="identity"?{identityBasis:String(details.confidence_basis??"Unverified identity context")}:{ }),...(pipTier?{pipTier}:{}),...(pipTier&&String(details!.confidence_basis).includes("imported from ")?{pipImported:true as const}:{}),...(sourceOutcome?{sourceOutcome}:{}),evidence};
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
/** Owner-written continuity names its own slot in the line (PIP A10); every
 * other kind renders exactly as before. */
const PIP_LABELS: Record<string, string> = {
  "relation": "How we work together",
  "commitment": "Commitments (you said)",
  "self-trait": "About me (you said)",
};
export function referenceLine(record: BundleRecord, position: number): string {
  const attribution = record.kind==="checkpoint" ? "working notes" : record.pipTier ? pipAttribution(record.pipTier,record.pipImported===true) : record.kind==="character-canon" ? "fictional character canon; not model autobiography or world truth" : record.identityBasis?.includes("fictional") ? "owner-authored fictional continuity; not world truth" : record.sourceOutcome==="failed" ? "a tool reported a failed action" : ASSERTION_LABELS[record.assertion] ?? "unattributed";
  const kind = (record.pipTier ? pipKindLabel(record.kind,record.pipTier) : undefined) ?? PIP_LABELS[record.kind] ?? (/^[a-z][a-z-]{0,31}$/.test(record.kind) ? record.kind : "note");
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
/** The record as hydrated now against the record in the bundle. A brief the bundle cut at a sentence compares on the bytes it kept. */
function sameRecord(current: BundleRecord, record: BundleRecord): boolean {
  if (record.cutBytes === undefined) return JSON.stringify(current)===JSON.stringify(record);
  const {cutBytes, ...kept} = record;
  return JSON.stringify({...current,text:Buffer.from(current.text).subarray(0,cutBytes).toString("utf8")})===JSON.stringify(kept);
}
function tokens(text: string) { return Buffer.byteLength(memoryRequestPrefix(text),"utf8"); }
/** The fixed frame (preamble, tags, request boundary) every non-empty bundle
 * pays once. It is not memory: the share records may use sits above it. */
export const MEMORY_FRAME_TOKENS = tokens([MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_CLOSE].join("\n"));

/** The share of the context remembered words may use above the frame on every default engine (a context of 20,480 or more). */
export const PIN_SHARE_DEFAULT = 2048;
/** The bundle's budget for a context: the frame plus a tenth of the context, at most PIN_SHARE_DEFAULT. */
export function pinBudget(available = 20480): number { return MEMORY_FRAME_TOKENS + Math.min(PIN_SHARE_DEFAULT, Math.floor(available / 10)); }

/** A pinned row as the bundle would render it, read straight from the store (the owner's view: no reader rules, evidence is not rendered). */
function measuredPinRecord(db: ReturnType<typeof database>, id: string, version: number): BundleRecord {
  const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id, version) as Record<string, unknown>;
  const details = db.prepare("SELECT partition,confidence_basis FROM memory_record_details WHERE record_id=? AND record_version=?").get(id, version) as {partition?: unknown; confidence_basis?: unknown} | undefined;
  let sourceOutcome: "failed" | undefined;
  if (row.kind === "source" && db.prepare("SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? AND s.speaker='tool' AND s.outcome='failed' LIMIT 1").get(id, version)) sourceOutcome = "failed";
  return bundleRecordOf(id, version, row, details, [], sourceOutcome);
}
/** How many bytes the active owner pins of a scope take above the frame, rendered exactly as the bundle renders them, and the share
 * every default engine gives them. */
export function ownerPinUse(db: ReturnType<typeof database>, scopeId: string): {used: number; allowed: number} {
  const rows = db.prepare(`SELECT id,version FROM memory_records WHERE state='active' AND owner_pinned=1 AND scope_id=? AND kind NOT IN ${PIP_ALL_KINDS_SQL} ORDER BY id,version`).all(scopeId);
  const records = rows.map(row => measuredPinRecord(db, String(row.id), Number(row.version)));
  return {used: records.length ? tokens(render(records)) - MEMORY_FRAME_TOKENS : 0, allowed: PIN_SHARE_DEFAULT};
}
/** Pin time (1.0.4): run INSIDE the writer's transaction after the write, so a refusal rolls it back. The owner pins of the scope must
 * fit the default-engine share; a smaller local model leaves the trailing ones out at dispatch instead (droppedPins). `before` is the
 * scope's use measured before an edit of words that keep their pin: an edit that does not grow them is never refused, so an install
 * already over the share can still shorten a pin. */
export function assertOwnerPinsFit(db: ReturnType<typeof database>, scopeId: string, before?: number): void {
  const {used, allowed} = ownerPinUse(db, scopeId);
  if (used > allowed && (before === undefined || used > before)) throw Object.assign(new Error(`MEMORY_PIN_BUDGET: ${used}/${allowed}`), {status: 409, used, allowed});
}

/** No tokenizer dependency: UTF-8 bytes conservatively bound tokens, including metadata. Recall rests on replies' verdicts: its lineage work is
 * paid from `options.allowance` (replay-lineage.ts LineageAllowance), a REQUIRED option. */
export async function buildMemoryBundle(query: string, access: MemoryAccess, bridge: MemorySearchBridge, options: {allowance: LineageAllowance; availableContextTokens?: number; signal?: AbortSignal; excludeMessageIds?: readonly string[]; excludeSourceIds?: readonly string[]; evolutionPolicy?:MemoryEvolutionPolicy;
  /** The reader's own transcript rule: a message it may not be shown is not
   * recalled either (a room turn whose audience is not the owner). */
  withheldMessage?: (threadId: string, messageId: string, allowance: LineageAllowance) => boolean;
  /** The bot's Continuity switch is on for this direct owner turn (PIP P1). Off or absent: today's identity rows only. */
  continuity?: boolean;
  /** The bot's `continuityOptions` as stored; part of the render-cache key (design §2.1). */
  continuityOptions?: object;
  /** Recall's own budget; a fresh recallBudget() when absent. */
  recallAllowance?: LineageAllowance}): Promise<BoundedMemoryBundle> {
  const evolutionPolicy=options.evolutionPolicy??readMemoryEvolutionPolicy();
  const allowance=options.allowance, reading={allowance};
  const recall=options.recallAllowance??recallBudget(), recallReading={allowance:recall};
  let recallPartial=false;
  assertMemoryAccess(access);
  options.signal?.throwIfAborted();
  drainMarkerForTurn(database());
  const available = options.availableContextTokens ?? 20480;
  if (!Number.isSafeInteger(available) || available < 0) throw new Error("INVALID_MEMORY_CONTEXT_BUDGET");
  // Remembered words may take a tenth of the context, at most 2048, above the
  // fixed frame. The frame grew past 1.3 KB (MEMJSON2, 90891899); counted in
  // the share it left ~600 bytes at best and none below a ~14k context, where
  // any owner pin refused every turn with MEMORY_PIN_OVERFLOW.
  const budget = pinBudget(available);
  const db = database();
  // Do not prefilter stale pins: losing their evidence is a mandatory dispatch failure.
  // A room member reaches its own bot scope, but never its owner-private
  // identity partition, pinned or not: that is withheld, not a failed pin.
  const room = accessIncludesRoom(access);
  // The owner's pins: a partial index serves them once the upkeep has made it (ownerPinIndexPresent: one keyed read of the pinned records of the reader's scopes); until then reading them
  // walks every active record of the reader's scopes (41 ms with 20,000 captured chunks). They change only when a pinned record is added, changed or removed, which the pin stamp counts (authority-epoch.ts).
  const pinKey = JSON.stringify([access.scopeIds, room]), pinAt = pinStamp();
  const cachedPins = pinAt === undefined ? undefined : pinCache.get(pinKey);
  const pinRows = cachedPins && cachedPins.stamp === pinAt ? cachedPins.rows : db.prepare(`SELECT id,version FROM memory_records r${ownerPinIndexPresent(db) ? " INDEXED BY memory_records_pinned" : ""} WHERE state='active' AND owner_pinned=1 AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND scope_id IN (SELECT value FROM json_each(?))
    ${room ? "AND NOT EXISTS (SELECT 1 FROM memory_record_details d WHERE d.record_id=r.id AND d.record_version=r.version AND d.partition='identity')" : ""} ORDER BY id,version`).all(JSON.stringify(access.scopeIds));
  if (pinAt !== undefined && cachedPins?.stamp !== pinAt && pinStamp() === pinAt) {
    if (pinCache.size >= 64) pinCache.delete(pinCache.keys().next().value!);
    pinCache.set(pinKey, { stamp: pinAt, rows: pinRows.map(row => ({ id: row.id, version: row.version })) });
  }
  // A pin resting on a reply bots no longer see is left out, not a refused
  // turn: the owner is told, and the room goes on without it. Left-out pins
  // take no handle.
  const withheldPins: Array<{id: string; version: number}> = [];
  const deliverable = pinRows.filter(row => {
    const id = String(row.id), version = Number(row.version);
    if (!pinRestsOnWithheldReply(allowance,id,version,options.withheldMessage)) return true;
    withheldPins.push({id,version}); return false;
  });
  // 1.0.4: pins past the handle limit or the budget are left out, trailing ones first, and the owner is told (droppedPins); the turn
  // still runs. An install already over the share after the upgrade, or a small local model, keeps answering.
  const droppedPins: Array<{id: string; version: number}> = [];
  for (const row of deliverable.splice(MEMORY_HANDLE_LIMIT)) droppedPins.push({id:String(row.id),version:Number(row.version)});
  const pinned: BundleRecord[] = [];
  inMemoryAccessPass(() => {
    for (const row of deliverable) {
      try { pinned.push(hydrateMemoryRecord(String(row.id),Number(row.version),access,reading)); }
      catch (error) {
        assertMemoryAccess(access);
        // A pin whose check ran out of allowance is not a broken pin: it is withheld for now (checking), as the filter above withholds
        // one, and the warmer finishes its lineage; the turn goes on. Only a pin that is really unreadable stops the turn.
        // 1.0.2: a pin the write-time lookup reads "checking" (a revoke still in its window) is the same: withheld for now
        if (isLineageLimit(error) || (allowance.hit && error instanceof Error && /^MEMORY_(EVIDENCE|RECORD)_UNAVAILABLE$/.test(error.message))) { withheldPins.push({id:String(row.id),version:Number(row.version)}); continue; }
        throw new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch");
      }
    }
  });
  const overBudget: Array<{id: string; version: number}> = [];
  while (pinned.length && tokens(render(pinned)) > budget) { const record = pinned.pop()!; overBudget.unshift({id:record.id,version:record.version}); }
  droppedPins.unshift(...overBudget);
  const selected = [...pinned], identity: BundleRecord[] = [], checkpoint: BundleRecord[] = [], evidence: BundleRecord[] = [];
  let degradedReason: string | undefined;
  const add = (record: BundleRecord, target: BundleRecord[], ceiling = budget) => {
    if (selected.length>=MEMORY_HANDLE_LIMIT || selected.some(r => r.id===record.id && r.version===record.version)) return;
    if (tokens(render([...selected,record])) <= ceiling) { selected.push(record); target.push(record); }
  };
  // Compact private continuity is engine-independent and precedes optional
  // general recall. Long canon remains searchable instead of filling every turn.
  const identityRows=db.prepare(`SELECT r.id,r.version,r.kind,r.scope_id,r.created_at,d.entities,d.claim_status FROM memory_records r
    JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
    JOIN memory_scopes s ON s.id=r.scope_id
    WHERE r.state='active' AND (r.owner_pinned=0 OR r.kind='continuity-brief') AND d.partition='identity'
    AND s.kind='bot' AND s.owner_key=? AND s.id IN (SELECT value FROM json_each(?))
    AND r.kind IN (${options.continuity ? "'continuity-brief','reveal-state','relation','commitment','self-trait'" : "'continuity-brief','reveal-state'"})
    ORDER BY CASE r.kind WHEN 'continuity-brief' THEN 0 WHEN 'reveal-state' THEN 1 WHEN 'relation' THEN 2 WHEN 'commitment' THEN 3 WHEN 'self-trait' THEN 4 ELSE 5 END,r.created_at DESC,r.id`).all(access.botId,JSON.stringify(access.scopeIds));
  // Continuity rows (PIP A11) fill in two passes, in priority order, whole rows
  // only, each pass stopping at the first row that does not fit so a later row
  // never takes an earlier one's place. Pass one: up to half of what is left of
  // the ceiling after pins, brief and reveal state, so recall and the
  // checkpoint keep room on a small window. Pass two (after recall and the
  // checkpoint): whatever is still free, for the rows not yet placed. Rows
  // render in the identity slot in priority order whichever pass placed them.
  let continuityTotal = 0;
  const continuityRows: BundleRecord[] = [];
  let continuityCeiling: number | undefined;
  let continuityOpen = true;
  const placed = new Set<BundleRecord>();
  /** Tier and recency of each owner row, so the second pass can keep the §2.2 order. */
  const ownerMeta = new Map<BundleRecord, {id: string; tier: PipTier; reinforcedAt: number; contested: boolean; disputed: boolean}>();
  /** The owner rows the first pass placed: the advertised prefix. The second pass never moves them (stable-prefix rule). */
  const firstPassOwner = new Set<BundleRecord>();
  // PIP P2 (design §2.1): with Continuity on, the identity slots are placed by
  // placePipSlots (brief, then the self slot, then reveal state). Off bots
  // keep exactly the loop below.
  const pipOn = Boolean(options.continuity) && !room;
  if (pipOn) placePipSlots();
  inMemoryAccessPass(() => {
    for(const row of room || pipOn ? [] : identityRows){
      try {
        const record = hydrateMemoryRecord(String(row.id),Number(row.version),access,reading);
        if (!isPipOwnerKind(record.kind)) { add(record,identity); continue; }
        continuityTotal++;
        continuityRows.push(record);
        if (!continuityOpen) continue;
        if (continuityCeiling === undefined) {
          const base = selected.length ? tokens(render(selected)) : MEMORY_FRAME_TOKENS;
          continuityCeiling = base + Math.floor(Math.max(0, budget - base) / 2);
        }
        const before = selected.length;
        add(record,identity,continuityCeiling);
        if (selected.length === before) continuityOpen = false; else placed.add(record);
      }
      catch { assertMemoryAccess(access); degradedReason="MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; if (isPipOwnerKind(String(row.kind))) continuityTotal++; }
    }
  });
  /** Standing of an owner row for §2.2: disputed by the stored claim status, contested when counter occasions are open and not yet kept. */
  function standingOf(id: string, row: Record<string, unknown>): {contested: boolean; disputed: boolean} {
    const disputed = row.claim_status === "disputed";
    let entities: string[] = [];
    try { const parsed = JSON.parse(String(row.entities)); if (Array.isArray(parsed)) entities = parsed.map(String); } catch { /* a malformed list has no generation, so no counter */ }
    const generation = generationOf(entities);
    if (!generation) return {contested: false, disputed};
    const counter = readCounter(db, access.botId, id, generation);
    return {contested: !disputed && Boolean(counter && counter.occasions.some(o => !counter.kept.includes(o))), disputed};
  }
  /** §2.1 steps 2 and 3 and the reveal-state part of step 6, whole rows only. Concern slot, compact line,
   * time sense and state line land with the batches that write those rows (they add nothing today). */
  function placePipSlots() {
    type Placed = {record: BundleRecord; section: "brief" | "self" | "reveal"; tier: PipTier; reinforcedAt: number; id: string; contested: boolean; disputed: boolean};
    const sz = (list: BundleRecord[]) => list.length ? tokens(render(list)) : MEMORY_FRAME_TOKENS;
    const brief: BundleRecord[] = [], reveal: BundleRecord[] = [], owner: Array<Placed> = [];
    for (const row of identityRows) {
      try {
        const record = hydrateMemoryRecord(String(row.id),Number(row.version),access,reading);
        if (record.kind === "continuity-brief") brief.push(record);
        else if (isPipOwnerKind(record.kind)) { continuityTotal++; const meta = {id:record.id,tier:record.pipTier ?? "attested",reinforcedAt:reinforcedAtOf(row.entities,Number(row.created_at)),...standingOf(record.id,row)}; ownerMeta.set(record,meta); owner.push({record,section:"self",...meta}); }
        else reveal.push(record);
      } catch { assertMemoryAccess(access); degradedReason="MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; if (isPipOwnerKind(String(row.kind))) continuityTotal++; }
    }
    const base = sz(selected), R = Math.max(0, budget - base), half = base + Math.floor(R / 2);
    // Render cache (§2.1): the same inputs replay the same selection. The key adds the budget and the pin base
    // to the design's list, because a different window would otherwise replay a selection that no longer fits.
    const botScope = identityRows.length ? String(identityRows[0].scope_id) : undefined;
    const rows = [...brief,...reveal,...owner.map(o => o.record)];
    const standings = owner.filter(o => o.contested || o.disputed).map(o => `${o.id}:${o.disputed ? "d" : "c"}`).sort();
    const key = createHash("sha256").update(JSON.stringify([rows.map(r => `${r.id}@${r.version}`).sort(),options.continuityOptions ?? null,0,0,false,budget,base,...standings.length ? [standings] : []])).digest("hex");
    let selection: Array<{id: string; version: number; section: Placed["section"]; cutBytes?: number}> | undefined;
    if (botScope) {
      try {
        const cached = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='pip-render'").get(pipRenderId(access.botId));
        const parsed = cached ? JSON.parse(String(cached.intent)) : undefined;
        if (parsed?.key === key && Array.isArray(parsed.selection)) selection = parsed.selection;
      } catch { /* a cache that cannot be read is recomputed */ }
    }
    const chosen: Array<{record: BundleRecord; section: Placed["section"]}> = [];
    const fromCache = selection?.map(entry => {
      const record = rows.find(r => r.id === entry.id && r.version === entry.version);
      if (!record) return undefined;
      return {record: entry.cutBytes === undefined ? record : {...record,text:Buffer.from(record.text).subarray(0,entry.cutBytes).toString("utf8"),cutBytes:entry.cutBytes},section:entry.section};
    });
    if (fromCache && fromCache.every(Boolean)) chosen.push(...fromCache as typeof chosen);
    else {
      // Step 2: the brief takes what remains of the half-ceiling after 200 bytes held for the compact concern line.
      if (brief[0]) {
        const ceiling = Math.max(base, half - 200);
        const record = brief[0];
        const fits = (candidate: BundleRecord) => tokens(render([...selected,candidate])) <= ceiling;
        if (fits(record)) chosen.push({record,section:"brief"});
        else {
          const ends = sentenceEnds(record.text);
          for (let i = ends.length - 1; i >= 0; i--) {
            const text = record.text.slice(0,ends[i]).trimEnd();
            const candidate = {...record,text,cutBytes:Buffer.byteLength(text)};
            if (text && fits(candidate)) { chosen.push({record:candidate,section:"brief"}); break; }
          }
        }
      }
      // Step 3: the self slot, at most 30% of what remains after pins, with a third held for observed rows.
      const lead = [...selected,...chosen.map(c => c.record)];
      const selfBase = sz(lead), selfCap = Math.floor(R * 0.3);
      const ordered = selfSlotOrder(owner);
      const observed = ordered.filter(o => o.tier === "observed"), attested = ordered.filter(o => o.tier !== "observed");
      const reserve = observedReservation(selfCap,observed.length > 0);
      let picked: Placed[] = [];
      const place = (list: Placed[], ceiling: number) => {
        for (const row of list) {
          if (picked.includes(row)) continue;
          const trial = selfSlotOrder([...picked,row]);
          if (lead.length + trial.length > MEMORY_HANDLE_LIMIT || tokens(render([...lead,...trial.map(t => t.record)])) > ceiling) return;
          picked = trial;
        }
      };
      place(attested,Math.min(half,selfBase + selfCap - reserve));
      place(observed,Math.min(half,selfBase + selfCap));
      place(attested,Math.min(half,selfBase + selfCap));
      for (const row of picked) chosen.push({record:row.record,section:"self"});
      // Reveal state shares the same half-ceiling, at most 1,024 bytes of lines together.
      let revealBytes = 0;
      for (const record of reveal) {
        const all = [...selected,...chosen.map(c => c.record)];
        const line = Buffer.byteLength(referenceLine(record,all.length + 1));
        if (all.length >= MEMORY_HANDLE_LIMIT || revealBytes + line > 1024 || tokens(render([...all,record])) > half) continue;
        revealBytes += line; chosen.push({record,section:"reveal"});
      }
      if (botScope) {
        try {
          db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-render',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
            .run(pipRenderId(access.botId),botScope,JSON.stringify({key,selection:chosen.map(c => ({id:c.record.id,version:c.record.version,section:c.section,...c.record.cutBytes === undefined ? {} : {cutBytes:c.record.cutBytes}}))}));
        } catch { /* the cache is advisory */ }
      }
    }
    for (const {record} of chosen) { selected.push(record); identity.push(record); placed.add(record); if (ownerMeta.has(record)) firstPassOwner.add(record); }
    // Rows that did not fit wait for the second pass, in the same order.
    for (const row of selfSlotOrder(owner)) if (!chosen.some(c => c.record.id === row.record.id && c.record.version === row.record.version)) continuityRows.push(row.record);
  }
  const fillContinuity = () => {
    for (const record of continuityRows) {
      if (placed.has(record)) continue;
      if (selected.length>=MEMORY_HANDLE_LIMIT || selected.some(r => r.id===record.id && r.version===record.version)) return;
      const at = pinned.length + identity.length;
      if (tokens(render([...selected.slice(0,at),record,...selected.slice(at)])) > budget) return;
      selected.splice(at,0,record); identity.push(record); placed.add(record);
    }
  };
  /** Rows placed by the second pass land after the first pass's rows. Only those supplemental rows are put in §2.2 order
   * among themselves: a first-pass row keeps its position, so the advertised prefix and its handles never move. */
  const reorderOwnerRows = () => {
    const slots = selected.flatMap((record,index) => ownerMeta.has(record) && !firstPassOwner.has(record) ? [index] : []);
    const ordered = selfSlotOrder(slots.map(index => ({record:selected[index],...ownerMeta.get(selected[index])!}))).map(row => row.record);
    const inIdentity = identity.flatMap((record,index) => ownerMeta.has(record) && !firstPassOwner.has(record) ? [index] : []);
    slots.forEach((index,n) => { selected[index] = ordered[n]; });
    inIdentity.forEach((index,n) => { identity[index] = ordered[n]; });
  };
  // Reserve recall space while letting checkpoints use the unused pin share.
  // Measure the same framed representation as final delivery, including evidence
  // metadata. A second pass may use recall space left empty after retrieval.
  // The fixed frame (preamble, tags, request boundary) is paid once by every
  // non-empty bundle and is not a record's share: the ceiling sits above it,
  // or a preamble longer than the share would defer every checkpoint behind
  // recall (p09.test.ts, group-member-checkpoint-roll-api.test.ts).
  const frame = MEMORY_FRAME_TOKENS;
  const checkpointCeiling = Math.min(budget,Math.max(frame+896,tokens(render(pinned))+384));
  const deferredCheckpoints: BundleRecord[] = [];
  // Only the dispatched thread's own checkpoint: a direct turn reaches every
  // thread its bot owns for recall, but a sibling's checkpoint is that
  // thread's working state. A busy sibling rolls it on every capture, which
  // revoked this turn at acceptance (a routine waiting for a thread slot:
  // "Context changed"), and ten of them could crowd out the turn's own.
  // A room or project desk thread captures into its room's scope
  // (capture-scope.ts); a checkpoint made before 0.1.61 sits in the thread's
  // conversation scope. Either is the thread's own; the newer one rides.
  const captureScope = threadCaptureScope(access.threadId);
  const ownCheckpoints = [...new Set([captureScope, {kind:"conversation",owner:access.threadId}].map(scope => {
    const row = scopeRow(db, scope.kind,scope.owner);
    return row ? threadCheckpointId(String(row.id),access.threadId) : "";
  }).filter(Boolean))];
  // Driven from the thread's own checkpoint ids by primary key; the scope condition only filters (an index on the scope would walk every chunk it holds).
  const checkpoints = db.prepare("SELECT r.id,r.version FROM json_each(?) j JOIN memory_records r ON r.id=j.value WHERE r.state='active' AND r.owner_pinned=0 AND r.kind='checkpoint' AND +r.scope_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC LIMIT 1").all(JSON.stringify(ownCheckpoints),JSON.stringify(access.scopeIds));
  inMemoryAccessPass(() => {
    for (const row of checkpoints) {
      try {
        const record = hydrateMemoryRecord(String(row.id),Number(row.version),access,reading);
        if (options.withheldMessage && recordRestsOnWithheldMessage(allowance,record.id,record.version,options.withheldMessage)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
        if (tokens(render([...selected,record])) <= checkpointCeiling) add(record,checkpoint);
        else deferredCheckpoints.push(record);
      } catch { assertMemoryAccess(access); degradedReason = "MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; }
    }
  });
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
      const result = await searchMemory(query,access,bridge,{limit:20,signal:options.signal,evolutionPolicy,withheldMessage:options.withheldMessage,allowance:recall});
      degradedReason = result.degradedReason ?? degradedReason;
      if ((result as {partial?: boolean}).partial) recallPartial = true;
      inMemoryAccessPass(() => {
        for (const hit of result.hits) {
          try {
            const record = hydrateMemoryRecord(hit.id,hit.version,access,recallReading);
            // A sibling thread's checkpoint stays out of recall as well: it is
            // that thread's working state, and it rolls under this turn.
            if (record.kind==="checkpoint" && !ownCheckpoints.includes(record.id)) continue;
            if (options.withheldMessage && recordRestsOnWithheldMessage(recall,record.id,record.version,options.withheldMessage)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
            if (!citesOnly(record,ownSources)) add(record,evidence);
          }
          catch (error) { assertMemoryAccess(access); degradedReason = "MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE"; if (isLineageLimit(error) || recall.hit) recallPartial = true; }
        }
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      assertMemoryAccess(access);
      degradedReason = "MEMORY_RECALL_UNAVAILABLE";
      noteRecallDegraded("turn", causeOf(error), { hits: 0, ms: 0, index: "unknown", outcome: "empty" });
    }
    // PIP episodes (design 1.2): recall only, merged after the shared search, direct owner turns with Continuity on.
    if (pipOn && access.botId) {
      for (const hit of episodeHits(db,access.botId,query)) {
        try {
          const record = hydrateMemoryRecord(hit.id,hit.version,access,recallReading);
          if (options.withheldMessage && recordRestsOnWithheldMessage(recall,record.id,record.version,options.withheldMessage)) continue;
          if (!citesOnly(record,ownSources)) add(record,evidence);
        } catch (error) { assertMemoryAccess(access); if (isLineageLimit(error) || recall.hit) recallPartial = true; }
      }
    }
  }
  for (const record of deferredCheckpoints) add(record,checkpoint);
  fillContinuity();
  if (pipOn) reorderOwnerRows();
  options.signal?.throwIfAborted();
  assertMemoryAccess(access);
  // The optional await may have invalidated source revisions without changing policy.
  // The thread's own checkpoint may also have rolled meanwhile (recall waits on
  // the worker that captures this turn's prompt): that version is stale, not
  // revoked, exactly as at delivery, and stays in the bundle unless its
  // current version can take its place. The current one is preferred (0.1.61
  // final check 2, N1: a room member should read the room's notes as they are
  // now), under the same checks as any record here: hydrated now, the
  // reader's withheld rule, the budget.
  const successor = (record: BundleRecord): BundleRecord | undefined => {
    if (record.pinned || record.kind !== "checkpoint" || !supersededThreadCheckpoint(record.id,record.version,access)) return undefined;
    const row = db.prepare("SELECT version FROM memory_records WHERE id=? AND state='active' AND owner_pinned=0 ORDER BY version DESC LIMIT 1").get(record.id);
    if (!row || selected.some(r => r.id===record.id && r.version===Number(row.version))) return undefined;
    try {
      const next = hydrateMemoryRecord(record.id,Number(row.version),access,reading);
      if (options.withheldMessage && recordRestsOnWithheldMessage(allowance,next.id,next.version,options.withheldMessage)) return undefined;
      const index = selected.indexOf(record);
      return tokens(render([...selected.slice(0,index),next,...selected.slice(index+1)])) <= budget ? next : undefined;
    } catch { assertMemoryAccess(access); return undefined; }
  };
  inMemoryAccessPass(() => {
    for (const record of [...selected]) {
      const next = successor(record);
      if (next) {
        selected[selected.indexOf(record)] = next;
        for (const list of [identity,checkpoint,evidence]) { const index=list.indexOf(record); if (index>=0) list[index] = next; }
        continue;
      }
      try {
        // a recall hit is re-proven from recall's own budget, the rest from the turn's
        const proof = evidence.includes(record) ? recallReading : reading;
        const current = hydrateDisclosedMemoryRecord(record.id,record.version,access,proof);
        if (!sameRecord(current,record)) throw new Error("MEMORY_RECORD_CHANGED");
        // The reader's own rule too: what it may see can change while recall
        // waits (a receipt revoked with no policy change; Astra P1 #1).
        if (options.withheldMessage && recordRestsOnWithheldMessage(proof.allowance,record.id,record.version,options.withheldMessage)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
      } catch (error) {
        assertMemoryAccess(access);
        if (evidence.includes(record) && (isLineageLimit(error) || recall.hit)) recallPartial = true;
        const withheldPin = record.pinned && pinRestsOnWithheldReply(allowance,record.id,record.version,options.withheldMessage);
        if (record.pinned && !withheldPin) throw new Error("MEMORY_PIN_UNAVAILABLE: repair or unpin the owner constraint before dispatch");
        if (withheldPin) {
          withheldPins.push({id:record.id,version:record.version});
          pinned.splice(pinned.indexOf(record),1);
        }
        selected.splice(selected.indexOf(record),1);
        for (const list of [identity,checkpoint,evidence]) { const index=list.indexOf(record); if (index>=0) list.splice(index,1); }
        if (!withheldPin) degradedReason="MEMORY_OPTIONAL_EVIDENCE_UNAVAILABLE";
      }
    }
  });
  const text = render(selected);
  // Not part of the model text: the owner is told how much of it was brought.
  const continuity = options.continuity && !room ? {brought: identity.filter(record => isPipOwnerKind(record.kind)).length, total: continuityTotal} : undefined;
  const sourceVersions = [...new Map(selected.flatMap(r=>r.evidence).map(e=>[JSON.stringify([e.sourceId,e.revision]),{id:e.sourceId,revision:e.revision}])).values()];
  const bundle: BoundedMemoryBundle = {evolutionPolicyRevision:evolutionPolicy.revision,bundleId:randomUUID(),text,policyRevision:access.policyRevision,deletionEpoch:access.deletionEpoch,tokenCount:tokens(text),recordVersions:selected.map(r=>({id:r.id,version:r.version})),sourceVersions,pinned,identity,checkpoint,evidence,...continuity?{continuity}:{},...degradedReason?{degradedReason}:{},...withheldPins.length?{withheldPins:Object.freeze(withheldPins.map(pin=>Object.freeze({...pin})))}:{},...droppedPins.length?{droppedPins:Object.freeze(droppedPins.map(pin=>Object.freeze({...pin})))}:{},...recallPartial?{recallPartial:true as const}:{}};
  // Keep an immutable original across async transport and prevent caller-forged bundles.
  for (const record of selected) { for (const handle of record.evidence) Object.freeze(handle); Object.freeze(record.evidence); Object.freeze(record); }
  for (const row of bundle.recordVersions) Object.freeze(row);
  for (const row of bundle.sourceVersions) Object.freeze(row);
  Object.freeze(bundle.recordVersions); Object.freeze(bundle.sourceVersions);
  Object.freeze(pinned); Object.freeze(identity); Object.freeze(checkpoint); Object.freeze(evidence); Object.freeze(bundle);
  bundles.set(bundle,{access,records:selected,...options.withheldMessage?{withheldMessage:options.withheldMessage}:{}});
  // MURAGE_TURN_TRACE: one line per build, so a dispatch that builds twice shows it.
  turnTrace(access.threadId).mark("memory.bundle.built");
  return bundle;
}

/** An owner pin whose words rest on a reply bots no longer see: one the owner
 * forgot, or one made with something forgotten, deleted or changed, anywhere
 * down its evidence (replay-lineage.ts), or one the reader's own transcript
 * leaves out. A check that cannot finish counts as resting on one. */
function pinRestsOnWithheldReply(allowance: LineageAllowance, id: string, version: number, withheldMessage?: (threadId: string, messageId: string, allowance: LineageAllowance) => boolean): boolean {
  try { return recordRestsOnWithheldMessage(allowance,id,version,withheldMessage); }
  catch { return true; }
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

/** The owner's pinned records per reader, and the pin stamp they were read at. */
const pinCache = new Map<string, { stamp: string; rows: Array<{ id: unknown; version: unknown }> }>();
/** The authority stamp at which a bundle last passed the record loop below, per bundle. */
const bundleCheckedAt = new WeakMap<object, string>();
/** Must run immediately before the adapter call, after all other asynchronous setup.
 * The access check runs every time; the per-record rehydration and withheld-source walk are
 * memoised per (bundle, authority epoch): they read only what the epoch tracks (authority-epoch.ts). */
export function assertMemoryBundle(bundle: MemoryBundle, access: MemoryAccess) {
  const trusted = bundles.get(bundle);
  if (!trusted || trusted.access !== access) throw new Error("MEMORY_BUNDLE_UNTRUSTED");
  if (bundle.tokenCount !== tokens(bundle.text)) throw new Error("MEMORY_BUNDLE_BUDGET_MISMATCH");
  assertMemoryAccess(access);
  const stamp = authorityStamp();
  if (stamp !== undefined && bundleCheckedAt.get(bundle) === stamp) return;
  // the check re-proves what the build just proved (kept verdicts answer it): its own allowance, so a turn whose allowance is spent does not fail here
  const reading = { allowance: LineageAllowance.tool() };
  inMemoryAccessPass(() => {
    for (const record of trusted.records) {
      const current = hydrateDisclosedMemoryRecord(record.id,record.version,access,reading);
      if (!sameRecord(current,record)) throw new Error("MEMORY_CONTEXT_REVOKED");
      // What this reader may see is checked afresh at dispatch (Astra P1 #1).
      if (trusted.withheldMessage && recordRestsOnWithheldMessage(reading.allowance,record.id,record.version,trusted.withheldMessage)) throw new Error("MEMORY_CONTEXT_REVOKED");
    }
  });
  // Re-read after the loop: a stamp taken before it that has since moved is not a pass at that stamp.
  if (stamp !== undefined && authorityStamp() === stamp) bundleCheckedAt.set(bundle, stamp);
}
