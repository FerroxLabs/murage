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
//      conversations; anything unresolved fails closed.
//   2. every message the result stands on is read now, and so is every message those were copied from, all the way back (a breadth-first walk
//      of the copy links, at most 8 deep and 64 messages, each once): one gone means the result is gone (a receipt's cached words never outlive
//      their original); a cycle, a walk past its limits, or an error means withheld.
//   3. for every message on that walk: withheld from bots, a captured message, a forgotten source, memory a non-owner audience may not see,
//      and partition ancestry: the withheld line, never the text.
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { hostLine } from "./host-words.ts";
import type { FailureCode } from "./failure-code.ts";
import { MurageStatus, status } from "./murage-status.ts";
import { ReleasedText, WorkerText, type EgressOrigin } from "./released-text.ts";
import type { WorkerMessage } from "./worker-message.ts";

export type { EgressOrigin };
export interface EgressMessage { id: string; text?: string; copyOf?: { threadId: string; messageIds: string[] }; withheldFromBots?: boolean | "forgotten" }

/** What the egress needs to ask about, supplied once by the server (and by tests). */
export interface ResultEgressDeps {
  message: (threadId: string, messageId: string) => EgressMessage | undefined;
  authorize: (requestId: string, worker: string, destinationThreadId: string) => { ok: true } | { ok: false; code: string; line: string };
  copyOriginWithheld: (copy: EgressOrigin) => boolean;
  capturedMessageWithheld: (threadId: string, messageId: string) => boolean;
  messageSourceForgotten: (threadId: string, messageId: string) => boolean;
  messageMadeWithMemory: (threadId: string, messageId: string) => boolean;
  partitionAllowed: (workerBotId: string, threadId: string, messageIds: string[]) => boolean;
  /** Both sides are positively the owner's own unshared conversations (the origin of the result is given when there is one). */
  ownUnsharedWork: (who: { fromBotId: string; toBotId: string; fromThreadId: string }, origin: EgressOrigin | undefined) => boolean;
  /** The words a withheld result is replaced by; the status table's own `withheld` line when absent. */
  withheldLine?: string;
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
  /** A receipt written before results carried their lineage: its text cannot be checked, so it is withheld. */
  lineageUnknown?: boolean;
  /** The record is Murage's own account of how a request ended (a stop, a refusal, a failure to start), not a worker's words. It references no
   * message and carries no text through the gate: after authorization the gate answers `status`, and the caller writes its own status line. */
  statusOnly?: boolean;
}

export type ReleasedResult =
  | { kind: "text"; text: ReleasedText; copyOf?: EgressOrigin }
  | { kind: "withheld"; line: MurageStatus }
  | { kind: "refused"; line: MurageStatus; code: string }
  | { kind: "status" }
  | { kind: "gone" };

let configured: ResultEgressDeps | undefined;
const mint = ReleasedText.claim();
const unseal = WorkerText.claimUnseal();
export function configureResultEgress(deps: ResultEgressDeps | undefined): void { configured = deps; }

export const COPY_WALK_MAX_DEPTH = 8;
export const COPY_WALK_MAX_NODES = 64;

type Walk = { ok: true; nodes: Array<{ threadId: string; message: EgressMessage }> } | { ok: false; why: "gone" | "withheld" };

/** Every message the result stands on and every message those were copied from. A missing one is `gone`; a cycle, a limit or an error is `withheld`. */
function walkCopies(deps: ResultEgressDeps, origin: EgressOrigin): Walk {
  const nodes: Array<{ threadId: string; message: EgressMessage }> = [];
  const seen = new Set<string>();
  let level: EgressOrigin[] = [origin];
  try {
    for (let depth = 0; level.length; depth += 1) {
      if (depth > COPY_WALK_MAX_DEPTH) return { ok: false, why: "withheld" };
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
          if (nodes.length >= COPY_WALK_MAX_NODES) return { ok: false, why: "withheld" };
          const message = deps.message(group.threadId, id);
          if (!message) return { ok: false, why: "gone" };
          nodes.push({ threadId: group.threadId, message });
          if (message.copyOf) next.push({ threadId: message.copyOf.threadId, messageIds: message.copyOf.messageIds });
        }
      }
      level = next;
    }
  } catch { return { ok: false, why: "withheld" }; }
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

/** `worker`: the bot that produced the result. `authority.fromBotId` and `destinationThreadId`: who is asking and where the text would go.
 * `text`: the text as it was recorded (a receipt, or the reply just written); read from the stored message when absent. */
export function releaseStoredResult(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text?: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedResult {
  if (!deps) throw new Error("The result gate is not configured");
  const recorded = text === undefined ? undefined : unseal(text);
  const origin = ref.origin;
  const ids = origin?.messageIds ?? [];
  // Every message the result stands on, and every one those were copied from, is read now: a receipt's cached words carry no authority of
  // their own, and one original that is gone or flagged takes the whole result with it.
  const walk = origin ? walkCopies(deps, origin) : undefined;
  const stored = walk?.ok ? walk.nodes.find(node => node.threadId === origin!.threadId && node.message.id === ids[0])?.message : undefined;
  // 1. authorization (the stored message is read first only to learn where a copy came from)
  if (ref.requestId && ref.binding !== "mismatch") {
    const verdict = deps.authorize(ref.requestId, worker, destinationThreadId);
    if (!verdict.ok) return { kind: "refused", line: hostLine(verdict.line), code: verdict.code };
  } else if (ref.binding === "mismatch" || notOwnerAudience || ref.recordedNotOwner === true
    || !deps.ownUnsharedWork({ fromBotId: authority.fromBotId, toBotId: worker, fromThreadId: destinationThreadId }, stored?.copyOf ?? origin)) {
    return { kind: "refused", line: status("origin_unconfirmed"), code: "origin_unconfirmed" };
  }
  // A status-only record is Murage's own account of how a request ended: it references no worker message and carries no worker text.
  if (ref.statusOnly === true) return { kind: "status" };
  // 2. the stored messages, as read now: gone means gone, whatever text was recorded beside them
  if (origin && walk && !walk.ok) return walk.why === "gone" ? { kind: "gone" } : withheldResult(deps);
  if (origin && (ids.length === 0 && recorded === undefined)) return { kind: "gone" };
  const body = recorded ?? stored?.text;
  if (body === undefined) return { kind: "gone" };
  // Worker text that names no stored message has no origin the rules above could read, so none of them has been applied to it: it is withheld.
  if (recorded !== undefined && ids.length === 0) return withheldResult(deps);
  // 3. the message-level rules, for every message on the walk
  let withheld = ref.lineageUnknown === true || (ref.recordedNotOwner === false && notOwnerAudience);
  try {
    if (origin && walk?.ok) {
      for (const { threadId, message } of walk.nodes) {
        if (message.withheldFromBots !== undefined && message.withheldFromBots !== false) withheld = true;
        if (message.copyOf && deps.copyOriginWithheld(message.copyOf)) withheld = true;
        if (deps.capturedMessageWithheld(threadId, message.id) || deps.messageSourceForgotten(threadId, message.id) || (notOwnerAudience && deps.messageMadeWithMemory(threadId, message.id))) withheld = true;
        if (!deps.partitionAllowed(worker, message.copyOf?.threadId ?? threadId, message.copyOf?.messageIds ?? [message.id])) withheld = true;
      }
      if (ids.length && deps.copyOriginWithheld(origin)) withheld = true;
    }
  } catch { withheld = true; }
  if (withheld) return withheldResult(deps);
  return { kind: "text", text: mint(body, origin && ids.length ? { threadId: origin.threadId, messageIds: [...ids] } : undefined), ...(origin && ids.length ? { copyOf: origin } : {}) };
}

/** What an ask hands back to the bot that asked (and what is mirrored beside it): the gate's answer in the shape the ask needs. A result that is
 * withheld or gone comes back as the withheld line with no link to its original; a refusal carries the reason and nothing else. */
export type ReleasedAskReply =
  | { ok: true; text: ReleasedText; copyOf?: EgressOrigin; withheld: false }
  | { ok: true; text: MurageStatus; withheld: true }
  | { ok: false; line: MurageStatus; code: string };

export function releaseAskReply(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedAskReply {
  const released = releaseStoredResult(ref, worker, destinationThreadId, authority, notOwnerAudience, text, deps);
  if (released.kind === "text") return { ok: true, text: released.text, ...(released.copyOf ? { copyOf: released.copyOf } : {}), withheld: false };
  if (released.kind === "refused") return { ok: false, line: released.line, code: released.code };
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

void RECEIPT_ORIGIN_UNCONFIRMED_LINE;
