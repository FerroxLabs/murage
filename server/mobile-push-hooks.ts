// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two small pieces of the harness's push wiring (server/index.ts), kept here
// so they can be tested: where the last answer to a request came from, and
// the trace a push failure leaves. Neither ever holds or logs content.

import type { ResolvedBy } from "../shared/mobile-push.ts";

type Where = "desktop" | "elsewhere";

/** Who settled a card that just stopped waiting (B10): an answer keeps where
 *  it came from; a dismissed or expired card was answered by nobody, and must
 *  not read "Answered on another device." */
export function settledBy(card: { answered?: string | null; dismissed?: boolean; expired?: boolean }, answeredWhere: Where): ResolvedBy {
  if (card.answered !== undefined && card.answered !== null) return answeredWhere;
  if (card.dismissed) return "dismissed";
  if (card.expired) return "expired";
  return answeredWhere;
}

/** Where the last answer to a request came from, for "Answered on desktop"
 * (R6). Bounded; the card patch that settles the request takes its entry. */
export class AnsweredWhere {
  private readonly entries = new Map<string, Where>();
  private readonly max: number;

  constructor(max = 1_000) {
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  note(key: string, where: Where): void {
    this.entries.delete(key);
    this.entries.set(key, where);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  /** Recorded while the respond route answers, and dropped again if the
   * route refuses: a refused desktop attempt must not make a later
   * resolution from elsewhere read "Answered on desktop". An accepted one
   * stays, because the engine's own event often settles the card after the
   * route has already replied. */
  attempt(key: string, where: Where, res: { statusCode: number; once(event: "finish", listener: () => void): unknown }): void {
    this.note(key, where);
    res.once("finish", () => {
      if (res.statusCode !== 200 && this.entries.get(key) === where) this.entries.delete(key);
    });
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  take(key: string): Where {
    const where = this.entries.get(key) ?? "elsewhere";
    this.entries.delete(key);
    return where;
  }
}

const WARN_EVERY_MS = 60_000;

/** A push hook's failure, as one content-free line: the hook's name and the
 * error's class, never its message (messages carry ids and paths). At most
 * once a minute per hook, and it never throws. */
export function createPushWarn(log: (line: string) => void = console.warn, now: () => number = Date.now): (hook: string, error: unknown) => void {
  const last = new Map<string, number>();
  return (hook, error) => {
    try {
      const at = now();
      const previous = last.get(hook);
      if (previous !== undefined && at - previous < WARN_EVERY_MS) return;
      last.set(hook, at);
      log(`mobile push: ${hook} failed (${errorClass(error)})`);
    } catch { /* a trace that cannot be written is not a second failure */ }
  };
}

function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name ?? error.name : "unknown";
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "unknown";
}
