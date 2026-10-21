// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy (DESIGN-WRITETIME.md, Murage 1.0.2): the shared types of the lane, fixed by S0. Every slice (S1 to S5) imports its
// lineage vocabulary from here and calls only the functions exported by lineage-write.ts, deny-read.ts, revoke-commit.ts, prompt-parts.ts
// and lineage-backfill.ts. The table names are in schema.ts (WRITETIME_TABLES). WRITETIME-API.md at the repository root lists every name.
//
// Brands: LineageToken, BuiltPrompt and ToolText carry a compile-time brand (a `unique symbol` that is declared, never exported). The only
// module that may cast to LineageToken is lineage-write.ts; to BuiltPrompt, PromptPart and ToolText only prompt-parts.ts. The static sink
// test (lineage-sinks.test.ts, S2) fails on any such cast elsewhere.

declare const lineageTokenBrand: unique symbol;
declare const promptPartBrand: unique symbol;
declare const builtPromptBrand: unique symbol;
declare const toolTextBrand: unique symbol;

/** Who wrote a line. Owner and person lines are judged only by their own flag, tombstone and the thread deny (never "checking"). */
export type LineAuthor = "owner" | "person" | "generated";

/** A line by position: its thread and its lsn (memory_line_lineage primary key). */
export interface LineKey { readonly threadId: string; readonly lsn: number }

/** A retained engine session (memory_session_lineage / memory_deny_session key). */
export interface SessionKey { readonly threadId: string; readonly driverInstance: string; readonly nativeSession: string }

/** The kinds of memory object a ref names. record, source, lesson and claim are memory tables; note, card, summary, skill and file are
 * Murage objects that hold words a bot wrote in a turn (a teammate's note or suggestion, a project card, a project summary, a learned skill,
 * a file written or read through a Murage tool). Each is one memory_deny_memory key and one carry child (child_kind 'record'). */
export const MEMORY_REF_KINDS = ["record", "source", "lesson", "claim", "note", "card", "summary", "skill", "file"] as const;
export type MemoryRefKind = (typeof MEMORY_REF_KINDS)[number];
/** The Murage-object kinds: no memory table, no scope; a mark on one is the whole of it (nothing is derived from one by lineage). */
export const OBJECT_REF_KINDS: ReadonlySet<MemoryRefKind> = new Set(["note", "card", "summary", "skill", "file"]);
/** The memory objects whose readers are tracked: a bot's turn that read one carries a durable edge object -> consumer (child_kind per the
 * consumer) so that forgetting what the object rests on reaches the consumer's replies (Astra audit P1 3). Records and sources are not
 * here: a receipt names them, and the marker follows the receipt. */
export const CONSUMED_REF_KINDS: ReadonlySet<MemoryRefKind> = new Set(["lesson", "claim", "note", "card", "summary", "skill", "file"]);
/** The interned "thread" an object's consumer edges hang from (memory_lineage_carry.parent_thread_no): one per kind and id, every version
 * (a mark on an object is the whole of it). Never a real thread id. */
export const objectCarryThread = (ref: { readonly kind: MemoryRefKind; readonly id: string }): string => `\u0001object\u0000${ref.kind}:${ref.id}`;
/** The to_lsn and from_lsn of an object -> consumer edge (a position in no thread). */
export const OBJECT_EDGE_LSN = 0;
/** The object's node in memory_thread_flow (writer threads flow into it, it flows into its consumers' threads). */
export const objectFlowNode = (ref: { readonly kind: MemoryRefKind; readonly id: string }): string => `\u0001obj\u0000${ref.kind}:${ref.id}`;

/** A memory object (memory_deny_memory key). version 0 or absent = every version. scopeId, when known, lets the read side check the
 * pending scope gate (memory_deny_pending_scope) without another seek. */
export interface MemoryRef {
  readonly kind: MemoryRefKind;
  readonly id: string;
  readonly version?: number;
  readonly scopeId?: string;
}
/** Map key of a MemoryRef in lookup results: `${kind}:${id}:${version ?? 0}`. Also the child_ref of a 'record' carry. */
export function memoryRefKey(ref: MemoryRef): string { return `${ref.kind}:${ref.id}:${ref.version ?? 0}`; }
/** The MemoryRef a memoryRefKey names, or null for text of any other shape. */
export function parseMemoryRefKey(key: string): MemoryRef | null {
  const parts = /^([a-z]+):(.*):(\d+)$/s.exec(key);
  if (!parts || !(MEMORY_REF_KINDS as readonly string[]).includes(parts[1]!)) return null;
  return { kind: parts[1] as MemoryRefKind, id: parts[2]!, version: Number(parts[3]) };
}

/** Why a part of engine input stands on nothing stored (Murage's own words, static text, the owner's words typed into this turn). */
export type NoneReason = "murage" | "static" | "owner-turn" | "engine-meta";

/** What a piece of engine input, a tool result or a written line rests on (DESIGN-WRITETIME 2.2). */
export type LineageRef =
  /** One stored line, by message id (a copy, a quote, a replayed or owed line, a tool result naming a line): a `point` carry. */
  | { readonly kind: "line"; readonly threadId: string; readonly messageId: string;
      /** A line of the prompt's own thread its replay shows in words (the last rebuild names them one by one instead of a prefix: prompt-parts.ts
       * ownReplayRefs). The send fence judges it by content, as it judges a prefix's shown lines, whatever the reader: an audience-only mark
       * (a receipt flipped by an install-wide revoke) never refuses the owner's own replay (Astra 1.0.3 room High). Lines of other threads
       * never carry it and stay judged for the reader's audience. */
      readonly replay?: true }
  /** A thread read wholesale up to headLsn (taken at write when absent): a `prefix` carry (project read_messages, conversation reads). */
  | { readonly kind: "prefix"; readonly threadId: string; readonly headLsn?: number;
      /** The lines of the thread a prompt showed in words (a replay): the send fence asks the marks of these again, so a line the owner
       * forgot after the prompt was built is caught (they were judged when it was built; a thread read wholesale lists none). */
      readonly shown?: readonly string[];
      /** The prompt's own thread read by content at the send fence, whatever the fence's reader: a room turn whose whole audience is the owner
       * (roomOwnerAudience), as the owner's direct chat is read (1.0.3 revoke storm, M1). An audience-only revoke (a receipt flip) then never
       * holds the room's own transcript; a content revoke still does. Every other ref of the prompt keeps the fence's reader. */
      readonly content?: true }
  /** A memory object shown or read. */
  | { readonly kind: "memory"; readonly ref: MemoryRef }
  /** A receipt (memory_disclosures bundle) the turn used: folds into mem_lsn (lsn = currentLsn when taken) and the footprint. */
  | { readonly kind: "receipt"; readonly bundleId: string; readonly lsn: number; readonly scopeIds: readonly string[] }
  /** Stands on nothing stored. */
  | { readonly kind: "none"; readonly reason: NoneReason };

/** Carry rows (memory_lineage_carry, STORAGE-AUDIT 3). A carry says: the child rests on the lines of the parent thread from from_lsn to
 * to_lsn (inclusive). One row per contiguous run of parent lines shown, never per line written: a turn's carries are written once with the
 * TURN as their child, and every line the turn writes finds them through its own turn_lsn. A run is split around a line whose words were not
 * shown, so a carry never names a line its child did not see. Unknown positions are carried at UNKNOWN_LSN (every range of the parent
 * thread reaches them, fail closed). */
export type CarryChildKind = "line" | "turn" | "session" | "record";
/** memory_lineage_carry.child_kind codes. */
export const CARRY_CHILD_CODE: Readonly<Record<CarryChildKind, number>> = { line: 0, turn: 1, session: 2, record: 3 };
export interface Carry {
  readonly parentThread: string; readonly fromLsn: number; readonly toLsn: number;
  readonly childKind: CarryChildKind; readonly childRef: string; readonly childThread: string | null;
}
/** mem_lsn of a line resting on a receipt that was already stale when it was folded: below every watermark. */
export const STALE_MEM_LSN = -(2 ** 52);
/** A carry's parent position when it is not known (a line with no lineage row, a thread not ready). */
export const UNKNOWN_LSN = Number.MAX_SAFE_INTEGER;
/** The lowest position: a prefix carry starts here (every line of the thread up to its head). */
export const FIRST_LSN = Number.MIN_SAFE_INTEGER;
/** THE child_ref encoding of a carry (every writer and the marker use these, nothing else). The child's thread is child_thread_no.
 *  - line:    the child line's lsn as decimal text (an old line's lsn is negative: U1 numbers lines below 1);
 *  - turn:    the turn's turn_lsn as decimal text (every line of the thread with that turn_lsn rests on the carry);
 *  - session: `${driverInstance}\u0000${nativeSession}` (child_thread_no is the session's thread);
 *  - record:  memoryRefKey(ref), for every MemoryRef kind (a record, a source, a lesson, a claim, a Murage object). */
export const lineChildRef = (lsn: number): string => String(lsn);
export const turnChildRef = (turnLsn: number): string => String(turnLsn);
export const sessionChildRef = (driverInstance: string, nativeSession: string): string => `${driverInstance}\u0000${nativeSession}`;
export const recordChildRef = (ref: MemoryRef): string => memoryRefKey(ref);
/** What a carry row points at, or null when its child_ref does not parse (the marker fails the slice on null: never skipped). */
export type CarryChild =
  | { readonly kind: "line"; readonly threadId: string; readonly lsn: number }
  | { readonly kind: "turn"; readonly threadId: string; readonly turnLsn: number }
  | { readonly kind: "session"; readonly session: SessionKey }
  | { readonly kind: "memory"; readonly ref: MemoryRef };
export function decodeCarryChild(childKind: number, childRef: string, childThread: string | null): CarryChild | null {
  const position = () => /^-?\d+$/.test(childRef) && Number.isSafeInteger(Number(childRef)) ? Number(childRef) : null;
  switch (childKind) {
    case CARRY_CHILD_CODE.line: { const lsn = position(); return childThread && lsn !== null ? { kind: "line", threadId: childThread, lsn } : null; }
    case CARRY_CHILD_CODE.turn: { const turnLsn = position(); return childThread && turnLsn !== null ? { kind: "turn", threadId: childThread, turnLsn } : null; }
    case CARRY_CHILD_CODE.session: {
      const at = childRef.indexOf("\u0000");
      if (!childThread || at < 0) return null;
      return { kind: "session", session: { threadId: childThread, driverInstance: childRef.slice(0, at), nativeSession: childRef.slice(at + 1) } };
    }
    case CARRY_CHILD_CODE.record: { const ref = parseMemoryRefKey(childRef); return ref ? { kind: "memory", ref } : null; }
    default: return null;
  }
}

/** A node of a revoke's work queue (memory_revoke_frontier.node, text via encodeNode). DESIGN-WRITETIME 3 and Opus section 4. */
export type FrontierNode =
  /** from: where the walk of what rests on the line starts when not at the line itself (refs added to a written line, revoke-commit.ts). */
  | { readonly kind: "line"; readonly threadId: string; readonly lsn: number; readonly from?: number }
  | { readonly kind: "range"; readonly threadId: string; readonly fromLsn: number }
  | { readonly kind: "record"; readonly id: string; readonly version: number }
  | { readonly kind: "source"; readonly id: string }
  | { readonly kind: "receipt"; readonly bundleId: string }
  | { readonly kind: "session"; readonly session: SessionKey }
  | { readonly kind: "scope"; readonly scopeId: string }
  /** The consumers of a memory object (a lesson, claim, note, card, summary, skill or file: the replies, turns and objects that read it; a
   * record or a source: the revoked receipts that cite it, held as its consumers, revoke-commit.ts holdRevokedReceipt). */
  | { readonly kind: "object"; readonly objectKind: MemoryRefKind; readonly id: string };
export function encodeNode(node: FrontierNode): string { return JSON.stringify(node); }
/** The node a frontier row holds, or null for a row of any other shape (a row that does not parse is never skipped silently by the
 * marker: it treats null as a failed slice). */
export function decodeNode(text: string): FrontierNode | null {
  try {
    const node = JSON.parse(text) as FrontierNode;
    const str = (value: unknown) => typeof value === "string";
    const int = (value: unknown) => Number.isSafeInteger(value);
    switch (node?.kind) {
      case "line": return str(node.threadId) && int(node.lsn) && (node.from === undefined || int(node.from)) ? node : null;
      case "range": return str(node.threadId) && int(node.fromLsn) ? node : null;
      case "record": return str(node.id) && int(node.version) ? node : null;
      case "source": return str(node.id) ? node : null;
      case "receipt": return str(node.bundleId) ? node : null;
      case "session": return node.session && str(node.session.threadId) && str(node.session.driverInstance) && str(node.session.nativeSession) ? node : null;
      case "scope": return str(node.scopeId) ? node : null;
      case "object": return str(node.id) && (MEMORY_REF_KINDS as readonly string[]).includes(node.objectKind) ? node : null;
      default: return null;
    }
  } catch { return null; }
}
/** memory_thread_flow node for a scope (`thread_flow.from_thread` takes `scope:<id>`). */
export const scopeFlowNode = (scopeId: string): string => `scope:${scopeId}`;
/** memory_deny_pending.thread_id meaning every thread (the first slice of a revoke only). */
export const PENDING_ALL_THREADS = "*";
/** memory_deny_pending_scope.scope_id meaning every scope (the window of a revoke whose memory flow is not proven narrower). */
export const PENDING_ALL_SCOPES = "*";

/** What an owner action revokes (one revoke_jobs row each). Edits, deletes, branch switches and regenerate are line roots (2.8). */
export type RevokeRoot =
  | { readonly kind: "line"; readonly threadId: string; readonly messageIds: readonly string[];
      readonly cause: "forget" | "hide" | "edit" | "delete" | "branch-switch" | "regenerate" }
  | { readonly kind: "thread"; readonly threadId: string; readonly cause: "delete-conversation" }
  | { readonly kind: "bot"; readonly botId: string; readonly threadIds: readonly string[]; readonly cause: "delete-bot" }
  | { readonly kind: "memory"; readonly ref: MemoryRef; readonly cause: "archive" | "correct" | "forget" | "revise" | "retire" | "delete" | "unprovable" }
  | { readonly kind: "scope"; readonly scopeId: string; readonly cause: "scope-deny" }
  /** "receipt-revoked": the receipt's state turned 'revoked' (a roster, settings, branch or restore revoke, or a single receipt): the RC
   * withheld what rests on it from AUDIENCE readers only (replay-lineage.ts: `audience !== null && row.state === "revoked"`), never from the
   * content judge of the owner's direct chat and rooms, and never from memory recall: its marks are audience-only (memory_revoke_audience).
   * "receipt-content": what the receipt cites is gone (U2 seeds it from a 1.0.1 file): withheld from every reader. */
  | { readonly kind: "receipt"; readonly bundleId: string; readonly cause: "receipt-revoked" | "receipt-content" }
  | { readonly kind: "session"; readonly session: SessionKey; readonly cause: "session-revoked" }
  | { readonly kind: "policy"; readonly cause: "policy-bump" }
  | { readonly kind: "epoch"; readonly cause: "epoch-bump" };

/** The reader a lookup judges for. audience null: content checks only (direct facts and marks; no watermark, no footprint). An owner
 * audience skips the footprint check (as copyOriginRevoked does today). */
export interface LineageAudience { readonly owner: boolean; readonly scopeIds: readonly string[] }
/** ownFlag (LINEAGE-DESIGN-S6 15b, default true): whether the stored owner's note (withheldFromBots) and the caller's flag withhold a line
 * ("own-flag"). The reader door (bot-read.ts) sets it false and reads the committed verdicts the note mirrors. */
export interface LineageReader { readonly audience: LineageAudience | null; readonly ownFlag?: boolean }

/** Why a line is withheld. */
export type DenyReason = "own-flag" | "tombstone" | "thread-deny" | "deny-line" | "deny-range" | "watermark" | "footprint"
  | "deny-session" | "session-forgotten" | "deny-memory" | "scope-deny" | "murage-anchor" | "door-epoch";
/** Why a line reads "checking" (withheld, with the lincold2 copy). Every unknown maps here (DESIGN-WRITETIME 3). */
export type CheckingReason = "no-lineage" | "thread-not-ready" | "pending" | "footprint-wide" | "lookup-error" | "not-built";
export type LineageVerdict =
  | { readonly state: "shown" }
  | { readonly state: "withheld"; readonly reason: DenyReason }
  | { readonly state: "checking"; readonly reason: CheckingReason };
/** True only for "shown": withheld and checking both keep the text from the engine. */
export const verdictShows = (verdict: LineageVerdict): boolean => verdict.state === "shown";
/** The stricter of two verdicts (withheld > checking > shown). */
export function worstVerdict(a: LineageVerdict, b: LineageVerdict): LineageVerdict {
  const rank = (v: LineageVerdict) => (v.state === "withheld" ? 2 : v.state === "checking" ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}

/** One page of a thread for denyLookup: the lines the caller would show, with the direct facts it already holds. */
export interface PageLine { readonly messageId: string; readonly author: LineAuthor; readonly withheldFromBots?: boolean }
export interface LinePage { readonly threadId: string; readonly lines: readonly PageLine[] }

/** A line about to be written (writeLineage). */
export interface LineInput { readonly threadId: string; readonly messageId: string; readonly author: LineAuthor }
/** What a written line rests on: the running turn (bot and room-member replies), extra refs (copies, hand-off results, event replays,
 * room card results), or nothing (owner and person lines). */
/** quotedNow: the refs are what a line already written (a row Murage wrote, message-db.ts isEngineOutput) quotes from this write on, not what
 * it rested on when written: a revoke they rest on holds and walks its thread from now (lineage-write.ts lineageRow). */
export interface LineageParents { readonly turn?: TurnLineage; readonly refs?: readonly LineageRef[]; readonly quotedNow?: boolean;
  /** A generated row attached to no one turn but resting on open turns (a merge: several open turns of its member or thread, or a Murage
   * line quoting a turn's words): the lowest turn lsn of those turns. Its turn_lsn is this when lower than its own head, so a revoke
   * committed after the earliest of them began still holds it (deny-read.ts pendingWindows) and its ranges reach it. */
  readonly began?: number }

/** The running turn's lineage (replaces RunningTurnLineage's roots; DESIGN-WRITETIME 2.2). turnLsn is the lsn at prompt build and is
 * never moved by a steer. parents grows through addTurnParents only. */
export interface TurnLineage {
  readonly threadId: string;
  readonly turnId: string;
  readonly turnLsn: number;
  readonly parents: readonly LineageRef[];
  /** deny_generation when the prompt was built (the send fence compares it). */
  readonly denyGeneration: number;
}

/** Returned by writeLineage and required by writeMessage (S1): a message cannot be stored without its lineage row. Only lineage-write.ts
 * makes one. */
export type LineageToken = { readonly threadId: string; readonly messageId: string; readonly lsn: number } & { readonly [lineageTokenBrand]: true };

/** One part of engine input with what it rests on. Only prompt-parts.ts makes one (promptPart). */
export type PromptPart = { readonly text: string; readonly lineageOf: readonly LineageRef[] } & { readonly [promptPartBrand]: true };
/** The whole engine input of a send or steer. The driver send, the steer send and the submission fence accept only this. Assembling one
 * adds every part's refs to the running turn. Only prompt-parts.ts makes one (buildPrompt). */
export type BuiltPrompt = {
  readonly text: string;
  readonly parts: readonly PromptPart[];
  readonly denyGeneration: number;
  /** How many deny_generation values in (above, upTo] the building turn's own committed writes produced (its session row at session.started,
   * its lines' carries; lineage-write.ts ownCarry records each exact value in the bump's own transaction): a moved generation made only of
   * these is not a revoke committed since the prompt was built. */
  readonly ownGenerations?: (db: import("node:sqlite").DatabaseSync, above: number, upTo: number) => number;
} & { readonly [builtPromptBrand]: true };
/** A tool handler's result text with what it rests on. Every tool handler returns this. Only prompt-parts.ts makes one (toolText). */
export type ToolText = { readonly text: string; readonly lineageOf: readonly LineageRef[] } & { readonly [toolTextBrand]: true };

/** Limits fixed by the design. */
export const FOOTPRINT_SCOPE_CAP = 32;        // more scopes than this intern to FOOTPRINT_STAR
export const FOOTPRINT_STAR = 0;              // footprint set id meaning `*` (any non-owner audience withheld); never a memory_scope_sets row
export const COPY_HOPS = 8;                   // past these a copy is written denied with cause `over`
export const COPY_ORIGINS = 64;
export const DENY_RANGE_COALESCE = 64;        // a thread's deny_range rows merge into one at this count (withholds more, never less)
export const MARKER_SLICE_MS = 8;
export const MARKER_SLICE_ROWS = 256;
/** deny_range's sticky coalesced row of audience-only revokes (memory_revoke_audience): -1 is the coalesced row of the others. */
export const AUDIENCE_COALESCED = -2;
/** memory_revoke_reached's reserved ids (DRAIN-104 2.1, 2.6): an audience job's cover rows (what it walked and under which cap), and the
 * audience walker. No job id is ever below 1, so tidy, undo and the fold's copies (all keyed by a job's id) never touch them. */
export const COVER_REVOKE = -3;
export const WALKER_REVOKE = -5;
export const BACKFILL_SLICE_MS = 50;

/** Calls made to an S0 fail-closed stub, by function name. A slice replaces its stubs; a count left after S5 names a stub still live. */
const stubCalls = new Map<string, number>();
export function noteWritetimeStub(name: string): void { stubCalls.set(name, (stubCalls.get(name) ?? 0) + 1); }
export function writetimeStubCalls(): ReadonlyMap<string, number> { return stubCalls; }
