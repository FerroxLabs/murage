// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.4 "Presence": a desktop or browser tab that is visible says so every
// 30 s (src/lib/presence.ts); phones stay quiet while one has within 90 s.
// Memory only: after a restart nobody is "at the desk" until a tab says so,
// which errs toward buzzing the phone.
export const PRESENCE_WINDOW_MS = 90_000;
export const PRESENCE_HOLD_MS = 120_000;
export const PRESENCE_BEAT_MS = 30_000;
const MAX_CLIENTS = 64;
/** A page's report counter never gets near this (two a minute). */
export const PRESENCE_MAX_SEQ = 2_147_483_647;
/** How many clients' last seq the host remembers; outlives `seen`, which a
 * hidden report or the window empties, because a late report can come after. */
const MAX_SEQ_CLIENTS = 256;

/** What server.log may say about a client: its first four characters. */
const idPrefix = (clientId: string) => clientId.slice(0, 4);

export class Presence {
  private readonly seen = new Map<string, number>();
  /** The highest seq taken from each client that sends one. */
  private readonly lastSeq = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** The last answer given, so a change is logged once, not on every ask. */
  private was = false;
  /** When the newest visible report arrived, for "since last beat". */
  private lastBeat = 0;

  // The log is the diagnostic for the flap (2026-09-28): every change of the
  // answer with its reason, never a steady beat. Content-free: a four-char id
  // prefix and counts. console.log is the harness's stdout, which the
  // desktop app appends to server.log as `[out]`.
  constructor(now: () => number = Date.now, log: (line: string) => void = console.log) {
    this.now = now;
    this.log = log;
  }

  get size(): number {
    return this.seen.size;
  }

  /** `seq` is the page's own report counter. A report whose seq is not above
   * the last one taken from that client arrived late (the client gave up on
   * it and sent a newer one) and is dropped. Without seq (a renderer from
   * before it) reports apply in arrival order. */
  report(clientId: string, visible: boolean, seq?: number): void {
    if (seq !== undefined) {
      const last = this.lastSeq.get(clientId);
      if (last !== undefined && seq <= last) return;
      this.lastSeq.delete(clientId);
      this.lastSeq.set(clientId, seq);
      while (this.lastSeq.size > MAX_SEQ_CLIENTS) this.lastSeq.delete(this.lastSeq.keys().next().value!);
    }
    const now = this.now();
    this.seen.delete(clientId);
    if (visible) {
      this.seen.set(clientId, now);
      this.lastBeat = now;
      while (this.seen.size > MAX_CLIENTS) this.seen.delete(this.seen.keys().next().value!);
    }
    const present = this.fresh(now);
    if (present === this.was) return;
    this.was = present;
    this.note(present ? "presence began" : `presence ended by a hidden report client=${idPrefix(clientId)} after ${now - this.lastBeat} ms since last beat`);
  }

  present(): boolean {
    const now = this.now();
    const present = this.fresh(now);
    if (present !== this.was) {
      this.was = present;
      // Only expiry can turn the answer off here; only a report turns it on.
      if (!present) this.note(`presence lapsed after ${now - this.lastBeat} ms since last beat`);
    }
    return present;
  }

  /** Drops the clients whose last report is older than the window. */
  private fresh(now: number): boolean {
    for (const [id, at] of this.seen) if (now - at >= PRESENCE_WINDOW_MS) this.seen.delete(id);
    return this.seen.size > 0;
  }

  private note(line: string): void {
    try {
      this.log(line);
    } catch { /* a trace that cannot be written is not a failure */ }
  }
}

export function parsePresenceBody(value: unknown): { clientId: string; visible: boolean; seq?: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "clientId,visible" && keys !== "clientId,seq,visible") return null;
  if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId) || typeof body.visible !== "boolean") return null;
  if (!("seq" in body)) return { clientId: body.clientId, visible: body.visible };
  const seq = body.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > PRESENCE_MAX_SEQ) return null;
  return { clientId: body.clientId, visible: body.visible, seq };
}
