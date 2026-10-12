// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The live side of "waiting for you" (PROPOSAL-v2 9.3, items 0.3). A tick every
// 500 ms reads ONE temp-table row; only when the counter moved does it run the
// indexed per-scope counts, and it announces only the subjects whose number
// changed. The frame carries counts, never memory text, and is desktop-only in
// sse-visibility. A change also moves the messages version so the Inbox answer,
// the sidebar badge and the tray re-read (the waiting revision is part of the
// Inbox key through that version).
import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import type { MemoryRoster } from "./policy.ts";
import { waitingCounts } from "./review.ts";
import { WAITING_BOOT, waitingEpoch } from "./waiting-epoch.ts";

export const WAITING_TICK_MS = 500;

export interface WaitingFrame {
  kind: "memory.waiting"; botId?: string; groupId?: string; subject: "bot" | "room" | "other";
  waiting: number; total: number; revision: number; boot: string;
}

export interface WaitingPushGateOptions { minGapMs?: number; step?: number }
/** Push rule (PROPOSAL-v2 9.3): on 0 to N, and again at each +10, at most once per bot per 4 hours. Counts only. */
export class WaitingPushGate {
  private last = new Map<string, { at: number; count: number }>();
  private readonly minGap: number; private readonly step: number;
  constructor(options: WaitingPushGateOptions = {}) { this.minGap = options.minGapMs ?? 4 * 3_600_000; this.step = options.step ?? 10; }
  /** True when a notification for this subject should go out now. */
  decide(key: string, previous: number, next: number, now: number): boolean {
    const sent = this.last.get(key);
    if (next <= 0) { return false; }
    const fresh = previous === 0;
    const stepped = sent !== undefined && next >= sent.count + this.step;
    if (!fresh && !stepped) return false;
    if (sent && now - sent.at < this.minGap) return false;
    this.last.set(key, { at: now, count: next });
    return true;
  }
}

export interface WaitingMonitorOptions {
  roster: () => MemoryRoster;
  emit: (frame: WaitingFrame) => void;
  /** Called once per change, after the frames: the Inbox key moves. */
  changed?: () => void;
  push?: (change: { key: string; subject: "bot" | "room" | "other"; id: string; name: string; waiting: number }) => void;
  database?: () => DatabaseSync;
  now?: () => number;
}

export class WaitingMonitor {
  private epoch: number | null = null;
  private known = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly gate = new WaitingPushGate();
  private readonly options: WaitingMonitorOptions;
  constructor(options: WaitingMonitorOptions) { this.options = options; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* a missed tick is caught up by the next change */ } }, WAITING_TICK_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One look. Returns the frames it emitted (for tests). */
  tick(): WaitingFrame[] {
    const db = (this.options.database ?? database)();
    const epoch = waitingEpoch(db);
    if (epoch === null || epoch === this.epoch) return [];
    const first = this.epoch === null;
    this.epoch = epoch;
    const counts = waitingCounts(db, this.options.roster());
    const total = [...counts.values()].reduce((sum, item) => sum + item.waiting, 0);
    const frames: WaitingFrame[] = [];
    const seen = new Set<string>();
    for (const [key, { subject, waiting }] of counts) {
      seen.add(key);
      const before = this.known.get(key) ?? 0;
      if (before === waiting) continue;
      this.known.set(key, waiting);
      frames.push({ kind: "memory.waiting", subject: subject.kind, ...(subject.kind === "bot" ? { botId: subject.id } : subject.kind === "room" ? { groupId: subject.id } : {}), waiting, total, revision: epoch, boot: WAITING_BOOT });
      if (!first && this.options.push && this.gate.decide(key, before, waiting, (this.options.now ?? Date.now)())) this.options.push({ key, subject: subject.kind, id: subject.id, name: subject.name, waiting });
    }
    // A subject that no longer has anything waiting says so once.
    for (const [key, before] of [...this.known]) {
      if (seen.has(key) || before === 0) continue;
      this.known.set(key, 0);
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      frames.push({ kind: "memory.waiting", subject: kind as "bot" | "room" | "other", ...(kind === "bot" ? { botId: id } : kind === "room" ? { groupId: id } : {}), waiting: 0, total, revision: epoch, boot: WAITING_BOOT });
    }
    if (first && !frames.length) return [];
    for (const frame of frames) this.options.emit(frame);
    if (frames.length) this.options.changed?.();
    return frames;
  }
}
