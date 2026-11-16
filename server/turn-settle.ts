// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Faithful port of BOT-CREATE-OUTSIDE-1019 r3.3.1 settle.py. Guard order is normative.
export type Origin = 'own' | 'reached' | 'content';
export type SettleVerdict = 'clean' | 'outside' | 'content' | 'unsettled';
export type WriteReason = Exclude<SettleVerdict, 'clean'> | 'turn-open' | 'review';
export const FAMILY: Record<string, string> = { claude: 'claude', codex: 'codex', acp: 'acp', fuigo: 'acp', hermes: 'acp' };
export const ENGINE_FINAL_STOP: Record<string, ReadonlySet<string | null>> = {
  claude: new Set([null, 'end_turn']), codex: new Set([null]), acp: new Set([null]),
};
export const SETTLE_EVIDENCE_DRIVERS = new Set(['claude', 'codex', 'fuigo']);
export const HELPER_ROW = { claude: 'claude-bg', codex: 'codex-helpers', acp: 'acp-helpers' };
export const HELPER_SITE = { claude: 'result', codex: 'held_done', acp: 'settle_held' };
export interface HelperRow { name: string; site: string; recorded: boolean; readsComplete: boolean; outsideRead: boolean; interrupted: boolean }
export interface TerminalFacts {
  site?: string; subtype?: string; steer_ever_waited?: boolean | number; bg_ever_held?: boolean | number;
  stop_requested?: boolean | number; helpers_ever_held?: boolean | number; cancel_requested?: boolean | number;
  interj_accepted?: boolean | number; interj_pending?: number; interj_uncertain?: number;
  extra_stop?: string | null; asked?: boolean | number; stop?: string | null; ok?: boolean | number;
}
export interface TerminalEvent { ok?: boolean; stopReason?: string | null; readsComplete?: true; helperRow?: HelperRow }
export function complete_flag(engine: string, t: TerminalFacts, rows: ReadonlySet<string>): boolean {
  const fam = FAMILY[engine];
  if (fam === 'claude') {
    if (t.site !== 'result') return false;
    if (t.subtype !== 'success') return false;
    if (t.steer_ever_waited) return false;
    if (t.bg_ever_held && !rows.has(HELPER_ROW.claude)) return false;
    return true;
  }
  if (fam === 'codex') {
    if (t.stop_requested) return false;
    if (t.site === 'turn_completed') {
      if (t.helpers_ever_held) return false;
      return true;
    }
    if (t.site === 'held_done') return rows.has(HELPER_ROW.codex);
    return false; // codex grace, cap, close, cancel
  }
  if (t.cancel_requested) return false;
  if (t.interj_accepted) return false;
  if ((t.interj_pending ?? 0) > 0) return false;
  if ((t.interj_uncertain ?? 0) > 0) return false;
  if (t.site === 'end_turn') return true;
  if (t.site === 'settle_held') return rows.has(HELPER_ROW.acp);
  return false; // ACP grace, close, prewarm, cancel
}
export function emit(engine: string, t: TerminalFacts, complete: boolean): TerminalEvent {
  const fam = FAMILY[engine];
  const extra = t.extra_stop === null ? { stopReason: null } : {};
  if (t.asked) {
    const ev: TerminalEvent = { ok: true, stopReason: 'cancelled' };
    Object.assign(ev, extra);
    return ev;
  }
  const arg = t.stop ?? null;
  const base_stop = fam === 'codex' ? arg ?? '' : arg;
  const ev: TerminalEvent = { ok: !!t.ok, stopReason: base_stop };
  if (complete) ev.readsComplete = true;
  Object.assign(ev, extra); // folded extra wins
  return ev;
}
export function terminal_clean(engine: string, ev: TerminalEvent): boolean {
  const fam = FAMILY[engine];
  if (ev.ok !== true) return false;
  if (ev.readsComplete !== true) return false;
  if (!ENGINE_FINAL_STOP[fam]?.has(ev.stopReason ?? null)) return false;
  return true;
}
export function cwd_marks(_holds_entry_below: unknown, inside_entry: unknown): boolean {
  return !!inside_entry;
}
export interface SetupEntry { req: string; origin: string; option: boolean; push_suppressed: boolean }
export class Row {
  gen: string; thread: string; driver: string; origin: string;
  abnormal = false; marked = false; unclassified = 0; settled = false;
  mark_sources = new Set<string>();
  helper_read = false;
  writes: Array<[string, number]> = [];
  setup: SetupEntry[] = [];
  constructor(gen: string, thread: string, driver: string, origin: string) {
    this.gen = gen; this.thread = thread; this.driver = driver; this.origin = origin;
  }
}
export class Ledger {
  rows = new Map<string, Row>();
  by_ptid = new Map<string, string>();
  live = new Map<string, string | null>();
  open(gen: string, thread: string, driver: string, origin: string): void { this.rows.set(gen, new Row(gen, thread, driver, origin)); }
  bind(gen: string, ptid: string): void { this.by_ptid.set(ptid, gen); }
  gen_of(ptid: string, _thread: string): string | undefined { return this.by_ptid.get(ptid); }
  take(gen: string): Row | undefined {
    const r = this.rows.get(gen);
    if (!r) return undefined;
    if (r.settled) return undefined;
    r.settled = true;
    return r;
  }
  mark(thread: string, src: string, lifecycle = false): void {
    const previous = this.live.get(thread);
    this.live.set(thread, src);
    for (const r of this.rows.values()) if (r.thread === thread && !r.settled) {
      r.marked = true;
      if (previous != null) {
        if (previous === 'helper' && !r.mark_sources.has(previous)) r.helper_read = true;
        r.mark_sources.add(previous);
      }
      r.mark_sources.add(src);
      if (src === 'helper' && !lifecycle) r.helper_read = true;
    }
  }
  helper_mark(gen: string, src = 'helper'): void {
    const r = this.rows.get(gen);
    if (r && !r.settled) {
      r.marked = true;
      r.mark_sources.add(src);
      r.helper_read = true;
    }
    if (r) this.live.set(r.thread, src);
  }
  abnormal(thread?: string, gen?: string): void {
    for (const r of this.rows.values()) if (!r.settled && (r.gen === gen || (gen === undefined && r.thread === thread))) r.abnormal = true;
  }
}
export function settle_verdict(row: Row, ev: TerminalEvent, live_read: string | null, _live_origin: string): SettleVerdict {
  if (row.abnormal) return 'unsettled';
  if (!terminal_clean(row.driver, ev)) return 'unsettled';
  if (row.unclassified > 0) return 'outside';
  const helper = ev.helperRow;
  const fam = FAMILY[row.driver] as keyof typeof HELPER_ROW;
  const helper_waived = row.mark_sources.size === 1 && row.mark_sources.has('helper') && !row.helper_read
    && (live_read === null || live_read === 'helper')
    && helper?.name === HELPER_ROW[fam]
    && helper?.site === HELPER_SITE[fam]
    && helper?.recorded === true
    && helper?.readsComplete === true
    && helper?.outsideRead === false
    && helper?.interrupted === false;
  if (row.marked && !helper_waived) return 'outside';
  if (live_read !== null && !helper_waived) return 'outside';
  if (!['own', 'reached'].includes(row.origin)) return 'content';
  if (!SETTLE_EVIDENCE_DRIVERS.has(row.driver)) return 'unsettled';
  return 'clean';
}
export function write_outcome(verdict: SettleVerdict, rev_at_write: number, rev_now: number): Exclude<SettleVerdict, 'clean'> | 'review' | 'active' {
  if (verdict !== 'clean') return verdict;
  if (rev_at_write !== rev_now) return 'review';
  return 'active';
}
