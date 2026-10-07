// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.5 "Server enforcement". The order matters: a refused Allow must
// not use up the decision, so step-up is checked before first-wins. Every
// check up to store.decide() is synchronous, and decide() is one INSERT OR
// IGNORE on push_decisions' primary key, so of two phones answering at once
// exactly one reaches answer(). The desk never writes push_decisions: phone
// against desk is guarded only by the card().pending check here (a
// check-then-act gap until answer() runs) and by the engine resolving each
// request once. Do not rely on push_decisions to exclude the desk.
import { createHash } from "node:crypto";
import { parseRespondBody } from "../shared/mobile-push.ts";
import type { PushStore } from "./mobile-push-store.ts";

/** Identifies a thread in a log line without naming it: a report can match
 * two lines to the same thread but can never recover the id (or any
 * message text) from what was logged (moss-approval-bug.md: there was no
 * record at all of which push decision took the call down). */
const threadHash = (threadId: string) => createHash("sha256").update(threadId).digest("hex").slice(0, 12);

export interface RespondDeps {
  store: PushStore;
  now(): number;
  /** A hidden thread answers exactly like a missing one (Global Constraints). */
  visible(threadId: string): boolean;
  /** `scope` is the LIVE card's approval scope at answer time. */
  card(threadId: string, requestId: string): { pending: boolean; scope?: string } | null;
  /** The request's rating right now (index.ts liveRating over the live card): the same rule the response route uses. */
  liveRating(threadId: string, requestId: string): "low" | "risky" | "unrated";
  answer(threadId: string, requestId: string, decision: "allow" | "deny"): Promise<string>;
  /** Content-free diagnostics; console.warn when left out. */
  log?(line: string): void;
}

const fail = (status: number, code: string, error: string) => ({ status, body: { code, error } });

export async function respondFromPush(input: { deviceId: string; bindingId: string; body: unknown }, deps: RespondDeps): Promise<{ status: number; body: unknown }> {
  const body = parseRespondBody(input.body);
  if (!body) return fail(400, "bad_request", "That action was not understood. Open Murage to answer.");
  const event = deps.store.latestForRequest(input.bindingId, body.requestId);
  // Only what actually went to this phone can be answered from it: a held,
  // pending, exhausted or dropped row never reached the lock screen.
  if (!event || event.state !== "sent" || event.expiresAt <= deps.now()) return fail(404, "unavailable", "This request is no longer available. Open Murage to see what is waiting.");
  // The notification outlives the owner hiding this bot from the phone: the
  // lock-screen action must then be as unavailable as the detail route is.
  if (!deps.visible(event.threadId)) return fail(404, "unavailable", "This request is no longer available. Open Murage to see what is waiting.");
  if (event.category === "resolved") return fail(409, "already_answered", "This was already answered.");
  if (event.category !== "approval" && event.category !== "approval-open") return fail(400, "not_supported", "Open Murage to answer this.");
  if (body.revision !== event.revision) return fail(409, "stale", "This changed since the notification. Open Murage to answer.");
  const card = deps.card(event.threadId, body.requestId);
  if (!card?.pending) return fail(409, "already_answered", "This was already answered.");
  // An Allow that meets an unfinished Deny is told so before any step-up or
  // risk check, and the decision is neither consumed nor changed.
  if (body.decision === "allow" && deps.store.unfinishedDecision(event.threadId, body.requestId) === "deny") return fail(409, "unfinished", "An earlier answer from this phone did not finish. Open Murage to answer.");
  // Local-computer control is never allowed from a notification, whatever the
  // push was rated: the card may have taken the scope after the push went out.
  // Deny never needs step-up.
  if (body.decision === "allow" && card.scope) return fail(403, "step_up", "Open Murage to allow this.");
  // Only an explicit "low" rating allows from the lock screen; "risky" and
  // "unrated" (no push_risk row) need step-up. Deny never does.
  if (body.decision === "allow" && deps.store.risk(event.threadId, body.requestId, event.revision) !== "low") return fail(403, "step_up", "Open Murage to allow this.");
  // The stored rating is a snapshot from when the push went out. Re-read it from the live card just before
  // accepting, exactly as the response route does: anything but "low" now goes to the app's proof flow.
  if (body.decision === "allow" && deps.liveRating(event.threadId, body.requestId) !== "low") return fail(403, "step_up", "Open Murage to allow this.");
  if (!deps.store.decide(event.threadId, body.requestId, body.decision, input.deviceId, body.revision, deps.now())) {
    // An earlier answer that threw is not "already answered": the card is
    // still pending, so one retry is taken over atomically. The checks above
    // (low-only Allow with the live re-rating) have already run for it.
    if (!deps.store.isUnknown(event.threadId, body.requestId)) return fail(409, "already_answered", "This was already answered.");
    if (!deps.store.retryUnknown(event.threadId, body.requestId, body.decision, input.deviceId, body.revision, deps.now())) {
      return deps.store.isUnknown(event.threadId, body.requestId)
        ? fail(409, "unfinished", "An earlier answer from this phone did not finish. Open Murage to answer.")
        : fail(409, "already_answered", "This was already answered.");
    }
  }
  // Content-free: the decision and a thread hash, never a request id or
  // any message text. The only other trace of this decision was the
  // shell's own (unpersisted) os_log line.
  (deps.log ?? console.warn)(`mobile push respond: ${body.decision} thread=${threadHash(event.threadId)}`);
  // The decision stays recorded even if answer() fails: it may have landed
  // before the throw, and releasing it could let a second, conflicting one
  // in. It is marked unfinished so a retry is not called "already answered",
  // and the phone is told plainly that it did not finish, never ok:true.
  const started = Date.now();
  try {
    const outcome = await deps.answer(event.threadId, body.requestId, body.decision);
    return { status: 200, body: { ok: true, outcome } };
  } catch (error) {
    try { deps.store.markUnknown(event.threadId, body.requestId); } catch { /* the row stays recorded either way */ }
    (deps.log ?? console.warn)(`mobile push respond: answer failed (${errorClass(error)}) after ${Date.now() - started}ms; status 502`);
    return fail(502, "unavailable", "That did not finish. Try again, or open Murage to answer.");
  }
}

/** The error's class name only, never its message: messages can carry ids. */
function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name ?? error.name : typeof error;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
}
