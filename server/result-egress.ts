// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one way a stored result leaves the bot that produced it. Every path that copies, mirrors, records or returns a result's text somewhere
// else (the shared answer an asker reads, the copy written into the asker's conversation, the receipt, a hand-off replayed in an event run,
// check/wait_delegation, a delegation's copy into its source thread, a card's result in the project room) asks `releaseStoredResult`, and only
// the ReleasedText it hands back leaves: no other module can make one (server/released-text.ts), and the sinks that write to a bot accept nothing
// else for worker words (server/bot-egress.ts, server/murage-status.ts). The order is fixed:
//   1. delivery authorization for the request the result was written for (sharing revoked since: the reason, no text). A result with no
//      request, or whose request is not this asker's own hand-off, is read only when both sides are positively the owner's own unshared
//      conversations and the reader is the owner, or the reader is not the owner and the reply comes from the peer turn its own ask started
//      with that same not-owner audience; anything unresolved fails closed.
//   2. every message the result stands on is read now, and so is every message those were copied from, all the way back (a breadth-first walk
//      of the copy links, at most 8 deep and 64 messages, each once): one gone means the result is gone (a receipt's cached words never outlive
//      their original); a cycle, a walk past its limits, or an error means withheld.
//   3. for every message on that walk: withheld from bots, a captured message, a forgotten source, memory a non-owner audience may not see,
//      and partition ancestry: the withheld line, never the text.
//   4. three states, never two (REPLY-WITHHELD-CONTRACT C1, R1): a real mark on the walk is `withheld` ("it used something you deleted or
//      changed"); a check that could not finish (a pending revoke window, a thread whose lineage is not ready, a line with no lineage row,
//      an unproven captured or copy check, a partition check past its budget, a walk past its limits, an exception) is `checking`, and the
//      words are held for the owner's own conversation (`held`) until the check settles (server/held-replies.ts). A bot reads the checking
//      line either way. withheld beats checking beats shown; only a cycle on the walk reads withheld without a mark.
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { hostLine } from "./host-words.ts";
import type { FailureCode } from "./failure-code.ts";
import { MurageStatus, status } from "./murage-status.ts";
import { ReleasedText, WorkerText, type EgressOrigin, type TextLineage } from "./released-text.ts";
import type { WorkerMessage } from "./worker-message.ts";
import type { DatabaseSync } from "node:sqlite";
import type { HumanPrincipal } from "./human-principals.ts";
import { denyLookup, lineageLive } from "./memory/deny-read.ts";
import { addTurnParents, currentTurnLineage } from "./memory/lineage-write.ts";

export type { EgressOrigin };
/** What a line check answers: shown, withheld (a real mark) or checking (an unknown). A boolean answer keeps its old meaning. */
export type LineVerdictState = "shown" | "withheld" | "checking";
/** A check's answer with why: withheld, and whether only because it could not finish. */
export type CheckVerdict = { withheld: boolean; unproven: boolean };
/** Who the gate's `ownUnsharedWork` proved the reader to be (SL-E r3, lanes/release104/designs/SL-E.md section 10): the owner, on the owner's
 * own unshared conversations; or one linked person, on that person's own unshared conversations, with the principal it was proven for. The
 * person's principal is the only source of the scopes the memory rules then compare with (S(P)). `false`: nothing proven. A plain `true` is the
 * owner proof (the shape every owner-only caller already answers); no boolean is ever a person proof. */
export type OwnUnsharedProof = { reader: "owner" } | { reader: "person"; principal: HumanPrincipal } | false;
export interface EgressMessage { id: string; text?: string; copyOf?: { threadId: string; messageIds: string[] }; withheldFromBots?: boolean | "forgotten" | "checking"; murageLine?: boolean }

/** What the egress needs to ask about, supplied once by the server (and by tests). */
export interface ResultEgressDeps {
  message: (threadId: string, messageId: string) => EgressMessage | undefined;
  authorize: (requestId: string, worker: string, destinationThreadId: string) => { ok: true } | { ok: false; code: string; line: string };
  /** true, or `{ withheld: true }`, is withheld; `{ withheld: true, unproven: true }` is checking (replay-lineage.ts copyOriginVerdict). */
  copyOriginWithheld: (copy: EgressOrigin) => boolean | CheckVerdict;
  /** The same shape (replay-lineage.ts capturedMessageVerdict). */
  capturedMessageWithheld: (threadId: string, messageId: string) => boolean | CheckVerdict;
  messageSourceForgotten: (threadId: string, messageId: string) => boolean;
  /** With `scopeIds` (a person proof's S(P), SL-E r3 E3b): "shown", "withheld" or "checking" by whose memory the line rests on. Without:
   * today's rule, true for any memory. */
  messageMadeWithMemory: (threadId: string, messageId: string, scopeIds?: readonly string[]) => boolean | LineVerdictState;
  /** false is withheld; "checking" is a check past its budget. */
  partitionAllowed: (workerBotId: string, threadId: string, messageIds: string[]) => boolean | LineVerdictState;
  /** Both sides are positively the owner's own unshared conversations (the origin of the result is given when there is one). */
  ownUnsharedWork: (who: { fromBotId: string; toBotId: string; fromThreadId: string }, origin: EgressOrigin | undefined) => OwnUnsharedProof | boolean;
  /** S(P) for a person proof's principal, read live (memory/policy.ts personReadableScopes); "unknown" when it cannot be read. Absent: unknown. */
  personScopes?: (principal: HumanPrincipal) => ReadonlySet<string> | "unknown";
  /** The words a withheld result is replaced by; the status table's own `withheld` line when absent. */
  withheldLine?: string;
  /** The words a result still being checked is replaced by for a bot; the status table's own `checking` line when absent. */
  checkingLine?: string;
  /** Write-time (DESIGN-WRITETIME 6 k, S4): whether every one of these lines of one thread reads shown to the result's reader. The lines'
   * carries already hold the copy chain, so this replaces the walk's per-message rules once the read-time judge goes (S6); until then both
   * apply. index.ts supplies `writetimeLinesShown(database)`. Absent: the read-time rules alone. */
  linesShown?: (threadId: string, messageIds: readonly string[], notOwnerAudience: boolean, scopeIds?: readonly string[]) => boolean | LineVerdictState;
  /** The reader door (server/bot-read.ts doorEgress, LINEAGE-DESIGN-S6 rule 16): whether these stored lines of one thread read as stored to the
   * bot the result is released to, judged as every bot-facing read is (classified rows, copy and hand-off chains, the row check, lineage
   * verdicts). index.ts supplies `doorEgress(database)`. Absent: the gate's own rules alone (the tests of those rules). */
  doorShown?: (readerBotId: string, threadId: string, messageIds: readonly string[], notOwnerAudience: boolean, scopeIds?: readonly string[]) => boolean | LineVerdictState;
}

/** The write-time lookup on a result's lines, for ResultEgressDeps.linesShown: one page lookup per thread. A not-owner audience is judged
 * with no scopes of its own, so any memory footprint withholds (as messageMadeWithMemory does today); the owner audience skips the footprint.
 * Until write-time lineage is written on this file the read-time rules decide alone.
 * `ownerConversation` (index.ts): the thread is one of the owner's own direct conversations. Lines there, released to the owner's own
 * audience, are judged as that conversation itself reads them (the content reader, audience null): every content mark, content pending window
 * and unknown still binds, while the audience-only marks a permission, roster or settings change leaves (receipt flips and what they inherit)
 * do not, since such a change takes nothing away from the owner (Lee_J / Phantom, lanes/release103/LEE-PHANTOM.md). Lines in a person's or a
 * room's conversation keep the owner audience, so every receipt revocation still binds them (result-egress-privacy.test.ts). */
/** SL-E r3.2 (A2) (lanes/release104/designs/SL-E.md section 11): a teammate's copied reply handed over to a linked person's turn on a resumed
 * session (index.ts external delivery), judged for that person's reader `{ owner: false, scopeIds: S(P) }` through the same write-time lookup
 * and reader door as W9: the copy row in the person's conversation and the lines it was copied from. The words only when every one reads
 * "shown"; S(P) unknown, or anything else, is the withheld line (`unproven` when the answer is not known, "still being checked"). */
export function personCopyHandOver(
  readers: { linesShown: NonNullable<ResultEgressDeps["linesShown"]>; doorShown: NonNullable<ResultEgressDeps["doorShown"]> },
  readerBotId: string, threadId: string, message: { id: string; copyOf?: { threadId: string; messageIds: readonly string[] } },
  scopes: ReadonlySet<string> | "unknown",
): { withheld: boolean; unproven: boolean } {
  if (scopes === "unknown") return { withheld: true, unproven: true };
  const scopeIds = [...scopes];
  const flags = { withheld: false, checking: false };
  try {
    fold(readers.doorShown(readerBotId, threadId, [message.id], true, scopeIds), flags, "withheld-when-false");
    fold(readers.linesShown(threadId, [message.id], true, scopeIds), flags, "withheld-when-false");
    if (message.copyOf?.messageIds.length) fold(readers.linesShown(message.copyOf.threadId, message.copyOf.messageIds, true, scopeIds), flags, "withheld-when-false");
  } catch { flags.checking = true; }
  return flags.withheld ? { withheld: true, unproven: false } : flags.checking ? { withheld: true, unproven: true } : { withheld: false, unproven: false };
}

/** `scopeIds` (SL-E r3 W9): a proven person reader's S(P). The same lookup judges the lines for the audience `{ owner: false, scopeIds }`, so
 * every mark, window and the watermark apply as today and the footprint rule compares with the person's own scopes. Absent: today's rule. */
export function writetimeLinesShown(db: () => DatabaseSync, ownerConversation?: (threadId: string) => boolean): (threadId: string, messageIds: readonly string[], notOwnerAudience: boolean, scopeIds?: readonly string[]) => LineVerdictState {
  return (threadId, messageIds, notOwnerAudience, scopeIds) => {
    const file = db();
    if (!messageIds.length || !lineageLive(file)) return "shown";
    const page = { threadId, lines: messageIds.map(messageId => ({ messageId, author: "generated" as const })) };
    // Only policy/epoch age is exempt for the owner's own chat: a roster change alone must not hide a Chief's delegated reply.
    // Keep the owner audience explicit so receipt revocations, content marks and pending checks still bind the result.
    const verdicts = notOwnerAudience && scopeIds !== undefined ? denyLookup(file, page, { audience: { owner: false, scopeIds: [...scopeIds] } })
      : !notOwnerAudience && ownerConversation?.(threadId) === true ? denyLookup(file, page, { audience: null })
      : denyLookup(file, page, { audience: { owner: !notOwnerAudience, scopeIds: [] } }, { ownerOwnChat: !notOwnerAudience });
    // the worst state over the lines: a mark anywhere withholds; otherwise an unknown anywhere is checking
    let worst: LineVerdictState = "shown";
    for (const id of messageIds) {
      const state = verdicts.get(id)?.state ?? "checking";
      if (state === "withheld") return "withheld";
      if (state === "checking") worst = "checking";
    }
    return worst;
  };
}

export interface StoredResultRef {
  /** The worker's message(s) that hold the result. Absent when a request finished without one. */
  origin?: EgressOrigin;
  /** The request the result was written for; absent on an older receipt. */
  requestId?: string;
  /** The request found for an older receipt is not the same work: never trusted. */
  binding?: "mismatch";
  /** A receipt records who the result was made for; set (true or false) only for receipts. */
  recordedNotOwner?: boolean;
  /** The result was written by the peer turn a direct ask just started for this same not-owner reader, and that turn ran with the reader's
   * not-owner audience (no owner memory, About me, integrations or computers). Only the ask route sets it, and only when it started the turn
   * that way. With it, a not-owner reader is no reason on its own to refuse an unbound reply: the reply must still be the owner's own
   * unshared work, and every message-level rule below still judges it for a not-owner audience. */
  peerTurnNotOwner?: true;
  /** A receipt written before results carried their lineage: its text cannot be checked, so it reads checking (never shown, never withheld). */
  lineageUnknown?: boolean;
  /** The record is Murage's own account of how a request ended (a stop, a refusal, a failure to start), not a worker's words. It references no
   * message and carries no text through the gate: after authorization the gate answers `status`, and the caller writes its own status line. */
  statusOnly?: boolean;
}

export type ReleasedResult =
  | { kind: "text"; text: ReleasedText; copyOf?: EgressOrigin }
  | { kind: "withheld"; line: MurageStatus }
  /** A check on the walk could not finish: a bot reads `line`; for the owner's own audience the words are `held` (with their originals) so
   * the owner's conversation can keep them flagged "checking" until the hold settles (REPLY-WITHHELD-CONTRACT C3). */
  | { kind: "checking"; line: MurageStatus; held?: { text: ReleasedText; copyOf: EgressOrigin } }
  | { kind: "refused"; line: MurageStatus; code: string }
  | { kind: "status" }
  | { kind: "gone" };

let configured: ResultEgressDeps | undefined;
const mint = ReleasedText.claim();
const unseal = WorkerText.claimUnseal();
export function configureResultEgress(deps: ResultEgressDeps | undefined): void { configured = deps; }

export const COPY_WALK_MAX_DEPTH = 8;
export const COPY_WALK_MAX_NODES = 64;

type Walk = { ok: true; nodes: Array<{ threadId: string; message: EgressMessage }> } | { ok: false; why: "gone" | "withheld" | "checking" };

/** Every message the result stands on and every message those were copied from. A missing one is `gone`; a cycle is `withheld`; a limit or an
 * error is `checking` (the walk could not finish: nothing proves a mark, nothing proves its absence). */
function walkCopies(deps: ResultEgressDeps, origin: EgressOrigin): Walk {
  const nodes: Array<{ threadId: string; message: EgressMessage }> = [];
  const seen = new Set<string>();
  let level: EgressOrigin[] = [origin];
  try {
    for (let depth = 0; level.length; depth += 1) {
      if (depth > COPY_WALK_MAX_DEPTH) return { ok: false, why: "checking" };
      const next: EgressOrigin[] = [];
      for (const group of level) {
        for (const id of group.messageIds) {
          const key = `${group.threadId}\u0000${id}`;
          if (seen.has(key)) {
            // met again on this walk: a copy of a copy of itself is a cycle; the same original reached twice from different copies is not
            if (depth > 0 && nodes.some(node => node.threadId === group.threadId && node.message.id === id && node.message.copyOf && cyclesBack(deps, node.message.copyOf, group.threadId, id))) return { ok: false, why: "withheld" };
            continue;
          }
          seen.add(key);
          if (nodes.length >= COPY_WALK_MAX_NODES) return { ok: false, why: "checking" };
          const message = deps.message(group.threadId, id);
          if (!message) return { ok: false, why: "gone" };
          nodes.push({ threadId: group.threadId, message });
          if (message.copyOf) next.push({ threadId: message.copyOf.threadId, messageIds: message.copyOf.messageIds });
        }
      }
      level = next;
    }
  } catch { return { ok: false, why: "checking" }; }
  return { ok: true, nodes };
}

/** Does following `from` copy links come back to the message (threadId, id)? Bounded the same way as the walk. */
function cyclesBack(deps: ResultEgressDeps, from: EgressOrigin, threadId: string, id: string): boolean {
  let level: EgressOrigin[] = [from];
  const seen = new Set<string>();
  for (let depth = 0; level.length && depth <= COPY_WALK_MAX_DEPTH; depth += 1) {
    const next: EgressOrigin[] = [];
    for (const group of level) for (const mid of group.messageIds) {
      if (group.threadId === threadId && mid === id) return true;
      const key = `${group.threadId}\u0000${mid}`;
      if (seen.has(key) || seen.size >= COPY_WALK_MAX_NODES) continue;
      seen.add(key);
      const message = deps.message(group.threadId, mid);
      if (message?.copyOf) next.push({ threadId: message.copyOf.threadId, messageIds: message.copyOf.messageIds });
    }
    level = next;
  }
  return false;
}

const withheldResult = (deps: ResultEgressDeps): ReleasedResult => ({ kind: "withheld", line: withheldLine(deps) });
/** The line a withheld result is replaced by: the server's own words for it when it supplies them, otherwise the status table's. */
const withheldLine = (deps: ResultEgressDeps | undefined): MurageStatus => deps?.withheldLine === undefined ? status("withheld") : hostLine(deps.withheldLine);
/** The line a bot reads for a result still being checked. */
const checkingLine = (deps: ResultEgressDeps | undefined): MurageStatus => deps?.checkingLine === undefined ? status("checking") : hostLine(deps.checkingLine);
/** One check's answer folded into the walk's two flags (withheld wins over checking). */
function fold(answer: boolean | LineVerdictState | CheckVerdict | undefined, flags: { withheld: boolean; checking: boolean }, meaning: "withheld-when-true" | "withheld-when-false"): void {
  if (answer === undefined) return;
  if (typeof answer === "boolean") { if (meaning === "withheld-when-true" ? answer : !answer) flags.withheld = true; return; }
  if (typeof answer === "string") { if (answer === "withheld") flags.withheld = true; else if (answer === "checking") flags.checking = true; return; }
  if (answer.withheld) { if (answer.unproven) flags.checking = true; else flags.withheld = true; }
}

/** `worker`: the bot that produced the result. `authority.fromBotId` and `destinationThreadId`: who is asking and where the text would go.
 * `text`: the text as it was recorded (a receipt, or the reply just written); read from the stored message when absent. */
export function releaseStoredResult(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text?: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedResult {
  if (!deps) throw new Error("The result gate is not configured");
  const recorded = text === undefined ? undefined : unseal(text);
  const origin = ref.origin;
  // S(P) for a proven person reader (SL-E r3); undefined for every other audience, whose rules stay byte-for-byte as before
  let personScopes: ReadonlySet<string> | "unknown" | undefined;
  const ids = origin?.messageIds ?? [];
  // Every message the result stands on, and every one those were copied from, is read now: a receipt's cached words carry no authority of
  // their own, and one original that is gone or flagged takes the whole result with it.
  const walk = origin ? walkCopies(deps, origin) : undefined;
  const stored = walk?.ok ? walk.nodes.find(node => node.threadId === origin!.threadId && node.message.id === ids[0])?.message : undefined;
  // 1. authorization (the stored message is read first only to learn where a copy came from)
  if (ref.requestId && ref.binding !== "mismatch") {
    const verdict = deps.authorize(ref.requestId, worker, destinationThreadId);
    if (!verdict.ok) return { kind: "refused", line: hostLine(verdict.line), code: verdict.code };
  } else {
    const proof = ref.binding === "mismatch" || (notOwnerAudience && ref.peerTurnNotOwner !== true) || ref.recordedNotOwner === true ? false
      : deps.ownUnsharedWork({ fromBotId: authority.fromBotId, toBotId: worker, fromThreadId: destinationThreadId }, stored?.copyOf ?? origin);
    if (!proof) return { kind: "refused", line: status("origin_unconfirmed"), code: "origin_unconfirmed" };
    // SL-E r3 E3b: a person proof names the reader, and only its principal yields the scopes the memory rules compare with (S(P)), read live
    if (proof !== true && proof.reader === "person" && notOwnerAudience) {
      try { personScopes = deps.personScopes?.(proof.principal) ?? "unknown"; } catch { personScopes = "unknown"; }
    }
  }
  // A status-only record is Murage's own account of how a request ended: it references no worker message and carries no worker text.
  if (ref.statusOnly === true) return { kind: "status" };
  // 2. the stored messages, as read now: gone means gone, whatever text was recorded beside them
  if (origin && walk && !walk.ok) {
    if (walk.why === "gone") return { kind: "gone" };
    if (walk.why === "withheld") return withheldResult(deps);
    // a walk that could not finish (a limit, a read that threw) is an unknown: the owner's own conversation keeps the recorded words beside the
    // originals while the check runs, as any other checking answer does (REPLY-WITHHELD-CONTRACT C3, R1)
    const held = !notOwnerAudience && recorded !== undefined && ids.length ? { text: mint(recorded, { threadId: origin.threadId, messageIds: [...ids] }), copyOf: { threadId: origin.threadId, messageIds: [...ids] } } : undefined;
    return { kind: "checking", line: checkingLine(deps), ...(held ? { held } : {}) };
  }
  if (origin && (ids.length === 0 && recorded === undefined)) return { kind: "gone" };
  const body = recorded ?? stored?.text;
  if (body === undefined) return { kind: "gone" };
  // Worker text that names no stored message has no origin the rules above could read, so none of them has been applied to it: no mark is
  // known, so it is an unknown and reads checking (REPLY-WITHHELD-CONTRACT C1). Its words reach no one from here: with no original there is
  // nothing to hold beside, so every audience gets the checking line alone.
  // (words made for the owner, asked for by a reader who is not, are a real mark and stay withheld)
  if (recorded !== undefined && ids.length === 0) return ref.recordedNotOwner === false && notOwnerAudience ? withheldResult(deps) : { kind: "checking", line: checkingLine(deps) };
  // 3. the message-level rules, for every message on the walk: a mark is withheld, an unknown is checking, withheld wins. A receipt written
  // before results carried their lineage is an unknown too (C1): checking, never "deleted or changed"
  const flags = { withheld: ref.recordedNotOwner === false && notOwnerAudience, checking: ref.lineageUnknown === true };
  try {
    if (origin && walk?.ok) {
      for (const { threadId, message } of walk.nodes) {
        // a stored "checking" is no note (never a stored verdict, REPLY-WITHHELD-CONTRACT R2): the live checks below judge the row; any other flag is a mark
        if (message.withheldFromBots !== undefined && message.withheldFromBots !== false && message.withheldFromBots !== "checking") flags.withheld = true;
        if (message.copyOf) fold(deps.copyOriginWithheld(message.copyOf), flags, "withheld-when-true");
        fold(deps.capturedMessageWithheld(threadId, message.id), flags, "withheld-when-true");
        if (deps.messageSourceForgotten(threadId, message.id) || (notOwnerAudience && personScopes === undefined && deps.messageMadeWithMemory(threadId, message.id))) flags.withheld = true;
        // SL-E r3 E3b: a proven person reads what rests only on that person's memory (W1-W8); S(P) unknown is an unknown (W7)
        if (notOwnerAudience && personScopes !== undefined) {
          if (personScopes === "unknown") flags.checking = true;
          else fold(deps.messageMadeWithMemory(threadId, message.id, [...personScopes]), flags, "withheld-when-true");
        }
        fold(deps.partitionAllowed(worker, message.copyOf?.threadId ?? threadId, message.copyOf?.messageIds ?? [message.id]), flags, "withheld-when-false");
      }
      if (ids.length) fold(deps.copyOriginWithheld(origin), flags, "withheld-when-true");
      // write-time and the reader door: every line on the walk, by thread (a page lookup each)
      const byThread = new Map<string, string[]>();
      for (const { threadId, message } of walk.nodes) byThread.set(threadId, [...(byThread.get(threadId) ?? []), message.id]);
      // (W9: a proven person's lines are judged for the audience of S(P). S(P) unknown is already checking (W7): no footprint can be judged
      // without it, so these two are not asked, and nothing they could add would release words)
      const scoped = notOwnerAudience && personScopes !== undefined && personScopes !== "unknown" ? [...personScopes] : undefined;
      if (personScopes !== "unknown") for (const [threadId, lineIds] of byThread) {
        if (deps.linesShown) fold(scoped ? deps.linesShown(threadId, lineIds, notOwnerAudience, scoped) : deps.linesShown(threadId, lineIds, notOwnerAudience), flags, "withheld-when-false");
        if (deps.doorShown) fold(scoped ? deps.doorShown(authority.fromBotId, threadId, lineIds, notOwnerAudience, scoped) : deps.doorShown(authority.fromBotId, threadId, lineIds, notOwnerAudience), flags, "withheld-when-false");
      }
    }
  } catch { flags.checking = true; }
  if (flags.withheld) return withheldResult(deps);
  if (flags.checking) {
    // the owner's own conversation keeps the words beside the originals while the check runs; any other audience gets the line alone
    const held = !notOwnerAudience && origin && ids.length ? { text: mint(body, { threadId: origin.threadId, messageIds: [...ids] }), copyOf: { threadId: origin.threadId, messageIds: [...ids] } } : undefined;
    return { kind: "checking", line: checkingLine(deps), ...(held ? { held } : {}) };
  }
  // write-time (DESIGN-WRITETIME 2.4: hand-off, ask and delegate results): the released words rest on every line of the walk. A turn running
  // on the destination thread is handed them now, so they join its parents (its replies, notes and session carry them). Outside a turn
  // nothing is recorded here: a copy written into the thread carries its originals itself (message-db.ts).
  if (origin && walk?.ok) {
    const turn = currentTurnLineage(destinationThreadId);
    if (turn) addTurnParents(turn, walk.nodes.map(({ threadId, message }) => ({ kind: "line" as const, threadId, messageId: message.id })));
  }
  return { kind: "text", text: mint(body, origin && ids.length ? { threadId: origin.threadId, messageIds: [...ids] } : undefined), ...(origin && ids.length ? { copyOf: origin } : {}) };
}

/** What an ask hands back to the bot that asked (and what is mirrored beside it): the gate's answer in the shape the ask needs. A result that is
 * withheld or gone comes back as the withheld line with no link to its original; a refusal carries the reason and nothing else. */
export type ReleasedAskReply =
  | { ok: true; text: ReleasedText; copyOf?: EgressOrigin; withheld: false }
  | { ok: true; text: MurageStatus; withheld: true; checking?: false }
  /** Left out only until a check finishes: the asking turn reads the checking line, never "deleted or changed" (REPLY-WITHHELD-CONTRACT C6). */
  | { ok: true; text: MurageStatus; withheld: true; checking: true }
  | { ok: false; line: MurageStatus; code: string };

export function releaseAskReply(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedAskReply {
  const released = releaseStoredResult(ref, worker, destinationThreadId, authority, notOwnerAudience, text, deps);
  if (released.kind === "text") return { ok: true, text: released.text, ...(released.copyOf ? { copyOf: released.copyOf } : {}), withheld: false };
  if (released.kind === "refused") return { ok: false, line: released.line, code: released.code };
  if (released.kind === "checking") return { ok: true, text: released.line, withheld: true, checking: true };
  return { ok: true, text: released.kind === "withheld" ? released.line : withheldLine(deps ?? configured), withheld: true };
}

/** One row of a conversation that is about to be quoted to a bot (a running delegation's recent activity), reduced to what the gate lets through.
 * Every field the row would render (its text, its tool name) is released together or not at all. A row that records a failure or a retry is never
 * quoted: it is released as the kind of failure it describes, one of the few codes a bot may be told, and the provider's own words stay where
 * the owner reads them. */
export type ReleasedRow = { text?: ReleasedText; tool?: ReleasedText; failure?: { kind: "retrying" | "error"; code: FailureCode } };
export function releaseMessage(
  message: WorkerMessage,
  release: (message: { id: string; text: WorkerText }) => ReleasedResult,
): ReleasedRow | undefined {
  const fields: Array<["text" | "tool", WorkerText]> = [];
  if (message.kind === "text" && message.text?.present) fields.push(["text", message.text]);
  if (message.kind === "activity" && message.tool?.name.present) fields.push(["tool", message.tool.name]);
  if (!fields.length) return undefined;
  const row: ReleasedRow = {};
  for (const [field, words] of fields) {
    const released = release({ id: message.id, text: words });
    if (released.kind !== "text") return undefined;
    if (field === "tool" && message.failure) return { failure: { kind: message.failure, code: words.failureCode() } };
    row[field] = released.text;
  }
  return row;
}

/** The same released words, resting on more: a reader shown them takes that into its own turn's sources (server/steer-lineage.ts). */
export function releasedWithLineage(text: ReleasedText, lineage: Partial<TextLineage>): ReleasedText { return mint(text, undefined, lineage); }

void RECEIPT_ORIGIN_UNCONFIRMED_LINE;
