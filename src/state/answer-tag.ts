// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every HTTP answer carries the time its request was sent (BOTADDED-DESIGN-V3 r6 §2.1, §0.4): `api()` tags the body and every
// bot inside it, and `fromAnswer` turns a tagged object into the origin a bot-record action carries. An answer older than
// ANSWER_TTL_MS is marked `expired` here, at dispatch time on a monotonic clock, so the reducer never reads a clock for it (L6).

/** How long an HTTP answer may still be applied after its request was sent; the server's `removed[]` window is the same length. */
export const ANSWER_TTL_MS = 10 * 60_000;

/** The origin of a bot-record action built from an HTTP answer. */
export interface HttpOrigin { source: "http"; sentAt: number; expired: boolean }

const SENT_AT = new WeakMap<object, number>();

const monotonicNow = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** The clock answers are stamped with. Exported so a test can read the same clock it advances. */
export const answerClock = { now: monotonicNow };

function tag(value: unknown, sentAt: number): void {
  if (value && typeof value === "object" && !SENT_AT.has(value)) SENT_AT.set(value, sentAt);
}

/** Stamp an answer body, its `bot`, and each record of `bots`, `archivedBots` and `removed` with the send time. */
export function tagAnswer(body: unknown, sentAt: number): void {
  if (!body || typeof body !== "object") return;
  tag(body, sentAt);
  const record = body as Record<string, unknown>;
  tag(record.bot, sentAt);
  for (const key of ["bots", "archivedBots", "removed"]) {
    const list = record[key];
    if (Array.isArray(list)) for (const item of list) tag(item, sentAt);
  }
}

export function sentAtOf(value: unknown): number | undefined {
  return value && typeof value === "object" ? SENT_AT.get(value) : undefined;
}

/** Give a copy the tag of the answer it was made from (a helper that spreads an answer loses the WeakMap entry). */
export function carryAnswerTag<T>(from: unknown, to: T): T {
  const sentAt = sentAtOf(from);
  if (sentAt !== undefined) tag(to, sentAt);
  return to;
}

const strictTags = (): boolean => {
  try { return Boolean((import.meta as { env?: { DEV?: boolean; MODE?: string } }).env?.DEV); } catch { return false; }
};

/** The origin of an action built from this answer object. A miss (an untagged object) throws in test and dev builds, so a dispatch
 * site that spreads an answer is caught; in production it is treated as expired: dropped, and the roster read again (r6 L2). */
export function fromAnswer(answer: unknown): HttpOrigin {
  const sentAt = sentAtOf(answer);
  if (sentAt === undefined) {
    if (strictTags()) throw new Error("fromAnswer: this object is not an api() answer (spread or built locally)");
    return { source: "http", sentAt: Number.NEGATIVE_INFINITY, expired: true };
  }
  return { source: "http", sentAt, expired: answerClock.now() - sentAt > ANSWER_TTL_MS };
}

/** For a helper that hands back a derived shape of an answer it just received (no object of the answer survives): the receipt time
 * stands in for the send time. Used only where the answer itself is not reachable. */
export function freshAnswer(): HttpOrigin {
  return { source: "http", sentAt: answerClock.now(), expired: false };
}

/** Tag an object as if `api()` had answered it now: tests and the order harness build answers this way. */
export function asAnswer<T>(body: T, sentAt = answerClock.now()): T {
  tagAnswer(body, sentAt);
  return body;
}
