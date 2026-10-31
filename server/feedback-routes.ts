// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// POST /api/feedback: the "?" panel's "Tell us what was confusing" (UX lane L-FB). The owner on the desktop, the phone
// through the Door, or the Cloud window; the route policy entry (companion class) decides who reaches it. The body is the
// contract in feedback-relay.ts; anything else is a 400 with a plain line, and nothing is sent.
//
// Answers: 200 {sent:true}; 200 {sent:false, reason} when the control plane could not take it (the form keeps the draft);
// 400 {sent:false, reason:"invalid", error} when the body breaks the contract (a client bug, never the owner's fault).
import { FEEDBACK_DEADLINE_MS, FEEDBACK_MAX_BODY_BYTES, feedbackRequestSchema, relayFeedback, type FeedbackRelayDeps } from "./feedback-relay.ts";

const TIMEOUT = Symbol("timeout");

export const FEEDBACK_ROUTE = "/api/feedback";
const INVALID = { status: 400, body: { sent: false, reason: "invalid", error: "Murage could not read that feedback. Close the panel and try again." } };
const TOO_LARGE = { status: 413, body: { sent: false, reason: "invalid", error: "That is too long to send. Make it shorter and press Send again." } };

/** `close: true` when the body read was cut off: the wiring sets `connection: close`, so Node ends the socket after the
 *  answer instead of keeping a half-read request alive. */
export type FeedbackAnswer = { status: number; body: unknown; close?: true };

export async function feedbackRoute(
  req: { method: string; path: string; readBody: (maxBytes: number, signal?: AbortSignal) => Promise<unknown> },
  deps: FeedbackRelayDeps & { now?: () => number },
): Promise<FeedbackAnswer | null> {
  // POST is the one method route-policy.ts classifies, so it is the one method this route answers; any other falls
  // through to the unknown-route answer.
  if (req.method === "POST" && req.path === FEEDBACK_ROUTE) return answerFeedback(req, deps);
  return null;
}

async function answerFeedback(
  req: { readBody: (maxBytes: number, signal?: AbortSignal) => Promise<unknown> },
  deps: FeedbackRelayDeps & { now?: () => number },
): Promise<FeedbackAnswer> {
  // One 10 s deadline for the whole answer, body reading included: a body that trickles in still gets an answer in time.
  const deadlineMs = deps.deadlineMs ?? FEEDBACK_DEADLINE_MS;
  const started = (deps.now ?? Date.now)();
  // At the deadline the read itself is stopped (read-body.ts drops its listeners and bytes), not just no longer awaited.
  const reading = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => { reading.abort(); resolve(TIMEOUT); }, deadlineMs); });
  let raw: unknown;
  try {
    const read = await Promise.race([req.readBody(FEEDBACK_MAX_BODY_BYTES, reading.signal), late]);
    if (read === TIMEOUT) return { status: 200, body: { sent: false, reason: "timeout" }, close: true };
    raw = read;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 408) return { status: 200, body: { sent: false, reason: "timeout" }, close: true };
    return status === 413 ? TOO_LARGE : INVALID;
  } finally {
    clearTimeout(timer);
  }
  const parsed = feedbackRequestSchema.safeParse(raw);
  if (!parsed.success) return INVALID;
  const left = deadlineMs - ((deps.now ?? Date.now)() - started);
  if (left <= 0) return { status: 200, body: { sent: false, reason: "timeout" } };
  const result = await relayFeedback(parsed.data, { ...deps, deadlineMs: left });
  if (!result.sent && result.reason === "too_long") return TOO_LARGE;
  return { status: 200, body: result };
}
