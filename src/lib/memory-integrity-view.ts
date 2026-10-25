// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the app says after the server is listening and the upgrade's later work is still running (/api/health `upgrade`, the contract in
// shared/upgrade-contract.mjs): a calm strip that says chat works, how far along it is and about how long is left, and a plain notice when memory is
// set aside. This file owns no state and no rules: the app family of the reducer (shared/upgrade-machine.mjs) holds every figure, and the functions
// here only turn its selections into the app's words. Nothing claims the work is finished unless the server said so (complete: true).
import { formatDone, formatElapsed, formatTotal } from "../../shared/upgrade-wait.mjs";
import { DONE_SHOWN_MS, POLL_HIDDEN_MS, POLL_VISIBLE_MS, selectDetail, selectSettingsDescription, selectStrip, type MachineContext, type SettingsKey, type StripSelection } from "../../shared/upgrade-machine.mjs";
import { localeCode, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export { DONE_SHOWN_MS, POLL_HIDDEN_MS, POLL_VISIBLE_MS };
/** The spoken announcement of the strip changes at most this often (a hold is spoken at once). */
export const ANNOUNCE_GAP_MS = 10_000;

export interface StripView {
  kind: "working" | "done" | "hold";
  role: "status" | "alert";
  text: string;
  percent: number | null;
  phaseLabel: string | null;
  /** The time-left phrase on its own ("about 6 minutes left"), for the detail row. */
  left: string | null;
  /** "612,000 of 1.2 million messages" where the server counts them exactly, else null. */
  counter: string | null;
  /** "9s so far" for a step with nothing to count (time awake, never a countdown), else null. */
  elapsed: string | null;
  /** True once an estimate has risen: the work is taking longer than first said. */
  slow: boolean;
}

const PHASE_KEYS: Record<string, LocaleKey> = {
  "output-index": "memoryStrip.phase.output-index", references: "memoryStrip.phase.references", learning: "memoryStrip.phase.learning",
  lineage: "memoryStrip.phase.lineage", shapes: "memoryStrip.phase.shapes", storage: "memoryStrip.phase.storage",
  "message-index": "memoryStrip.phase.message-index", "search-index": "memoryStrip.phase.search-index", marker: "memoryStrip.phase.marker",
  masking: "memoryStrip.phase.masking", settling: "memoryStrip.phase.settling",
};
export function phaseLabel(id: string | undefined | null): string | null {
  return id && Object.hasOwn(PHASE_KEYS, id) ? t(PHASE_KEYS[id]!) : null;
}
export function leftPhrase(minutes: number): string {
  return minutes === 0 ? t("memoryStrip.left.under") : minutes === 1 ? t("memoryStrip.left.one") : t("memoryStrip.left.many", { n: minutes });
}
/** The owner's words for a hold. Whatever the reason, the sentence is the reviewed one in the app's language: the server's code and prose are never shown. */
export function holdText(_code?: string | null): string { return t("memoryStrip.hold"); }

const COUNTER_KEYS: Record<string, LocaleKey> = {
  messages: "memoryStrip.detail.counter", conversations: "memoryStrip.detail.counterConversations", sets: "memoryStrip.detail.counterSets",
  open: "memoryStrip.detail.counterOpen",
};
function counterText(counter: StripSelection["counter"]): string | null {
  if (!counter || !Object.hasOwn(COUNTER_KEYS, counter.unit)) return null;
  return t(COUNTER_KEYS[counter.unit]!, { done: formatDone(counter.done, localeCode()), total: counter.total === undefined ? "" : formatTotal(counter.total, localeCode()) });
}

function elapsedText(selection: StripSelection): string | null {
  const ms = selection.elapsedMs;
  return typeof ms === "number" && ms >= 1000 ? t("memoryStrip.detail.elapsed", { elapsed: formatElapsed(ms, localeCode()) }) : null;
}

/** The words for a selection of the reducer. */
export function stripViewOf(selection: StripSelection | null): StripView | null {
  if (!selection) return null;
  const base = { phaseLabel: null, left: null, counter: null, elapsed: null, slow: false } as const;
  if (selection.kind === "hold") return { kind: "hold", role: "alert", text: holdText(selection.holdKey), percent: null, ...base };
  if (selection.kind === "done") return { kind: "done", role: "status", text: t("memoryStrip.done"), ...base, percent: 100 };
  const left = selection.left === null ? null : leftPhrase(selection.left);
  const percent = selection.percent;
  // an open-ended step (its end moves as it goes) says what is done so far: no percent and no time left
  const soFar = selection.counter?.unit === "open" ? counterText(selection.counter) : null;
  const label = phaseLabel(selection.phaseId);
  let text = soFar !== null && label ? t("memoryStrip.workingOpen", { label, done: soFar }) : percent === null ? t("memoryStrip.workingNoPercent") : left ? t("memoryStrip.workingEta", { percent, left }) : t("memoryStrip.working", { percent });
  if (selection.slow) text = `${text} ${t("memoryStrip.slow")}`;
  return { kind: "working", role: "status", text, percent, phaseLabel: phaseLabel(selection.phaseId), left, counter: counterText(selection.counter), elapsed: elapsedText(selection), slow: selection.slow };
}
/** The strip and the detail rows, both from the one reducer context. */
export function stripView(ctx: MachineContext): StripView | null { return stripViewOf(selectStrip(ctx)); }
export function detailView(ctx: MachineContext): StripView | null { return stripViewOf(selectDetail(ctx)); }

const SETTINGS_KEYS: Record<SettingsKey, LocaleKey> = {
  held: "memoryStrip.mode.held", paused: "memoryStrip.mode.paused", pausedNoted: "memoryStrip.mode.pausedNoted", off: "memoryStrip.mode.off",
  capture: "memoryStrip.mode.capture", active: "memoryStrip.mode.active", on: "memoryStrip.mode.on",
};
/** The Memory settings line: a known hold overrides every cached mode, and a claim about capture is made only where a source says capture is on. */
export function settingsDescription(ctx: MachineContext, endpoint?: Parameters<typeof selectSettingsDescription>[1]): string {
  return t(SETTINGS_KEYS[selectSettingsDescription(ctx, endpoint)]);
}

/** Decides what a screen reader is told. Calm progress is spoken at most every `gapMs`; the first sentence, a change of kind and a hold are
 * spoken at once. `offer` answers with the sentence in effect and, when a newer one is being held back, how long until it may be spoken. */
export function createAnnouncer(gapMs: number = ANNOUNCE_GAP_MS, now: () => number = Date.now) {
  let spoken = "", kind: StripView["kind"] | null = null, at = -Infinity;
  return {
    offer(view: StripView | null): { text: string; retryInMs: number | null } {
      if (!view) { spoken = ""; kind = null; return { text: "", retryInMs: null }; }
      const immediate = view.kind !== "working" || kind !== "working" || spoken === "";
      const waited = now() - at;
      if (immediate || waited >= gapMs) { spoken = view.text; kind = view.kind; at = now(); return { text: spoken, retryInMs: null }; }
      return { text: spoken, retryInMs: view.text === spoken ? null : gapMs - waited };
    },
  };
}
