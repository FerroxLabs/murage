// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation deletion obligations for Sentinel (1.0.9, GAP-SENTINEL-109 sections 4.1, 4.2 and 5: S04, S05).
// Observe only: conversation-deletion.ts calls these after its own persisted transitions and they never change what it
// decides. Every figure comes from the journal the deletion owner has just written or read (no extra read, no scan) and
// from the attempt's own per-home reasons; nothing here holds a thread id, a path, an engine home or an error text.
//
//   observeDeletionJournal(entries)   the persisted pending list: pending count and oldest pending time per engine kind
//   observeDeletionAttempt(...)       one attempt's holder state per engine kind (held, clear, unknown)
//   observeDeletionCompleted(entry)   the final removal of a pending entry, with its human line
//
// Each changed engine kind gets one `obligation` fact (code `deletion`); restart reconciliation is the owner's first
// journal read, which reports every kind it finds.
import { toEngineKind, type EngineKind, type HolderState } from "../../shared/health-protocol.mjs";
import { recordCounter, recordFact } from "./counters.ts";

/** The deletion owner's engine names in the contract's categories. */
const DELETION_ENGINE_KINDS: Readonly<Record<string, EngineKind>> = {
  claude: "claude", codex: "codex", antigravity: "antigravity", fuigo: "acp", grok: "other",
  gemini: "acp", qwen: "acp", opencode: "acp", kimi: "acp", cursor: "acp", droid: "acp", hermes: "acp",
};
export const deletionEngineKind = (engine: unknown): EngineKind =>
  typeof engine === "string" && Object.hasOwn(DELETION_ENGINE_KINDS, engine) ? DELETION_ENGINE_KINDS[engine]! : toEngineKind(engine);

/** What the journal entries carry that this reads: when the entry was made and which engines' homes it names. */
export interface DeletionJournalEntry { createdAt?: unknown; engineHomes?: ReadonlyArray<{ engine?: unknown }> }

interface KindState {
  pending: number; oldest: number | null; holder: HolderState; holderClearAt: number | null;
  failedAfterClear: number; completed: number; emitted: string | null;
  /** When the last fact went out, and how many unchanged zero-pending facts were sent again after it. */
  emittedAt: number | null; zeroResends: number;
}
/** An unchanged summary is sent again after this long while work is pending (a lost fact, or a scanner that started
 *  after it, still sees the obligation), and an unchanged zero-pending summary this many more times. */
export const DELETION_RESEND_MS = 10 * 60_000;
export const DELETION_ZERO_RESENDS = 2;
const kinds = new Map<EngineKind, KindState>();
const state = (kind: EngineKind): KindState => {
  let entry = kinds.get(kind);
  if (!entry) { entry = { pending: 0, oldest: null, holder: "unknown", holderClearAt: null, failedAfterClear: 0, completed: 0, emitted: null, emittedAt: null, zeroResends: 0 }; kinds.set(kind, entry); }
  return entry;
};

/** The engine kinds one entry is owed to: each of its homes' engines, or `none` when it names no engine home. */
export function entryKinds(entry: DeletionJournalEntry): EngineKind[] {
  const out = new Set<EngineKind>();
  for (const home of Array.isArray(entry?.engineHomes) ? entry.engineHomes : []) out.add(deletionEngineKind(home?.engine));
  return out.size ? [...out] : ["none"];
}

function emit(kind: EngineKind, entry: KindState, now: number, force = false): void {
  const signature = `${entry.pending}|${entry.oldest}|${entry.holder}|${entry.holderClearAt}|${entry.failedAfterClear}`;
  if (!force && entry.completed === 0 && signature === entry.emitted) {
    const due = entry.emittedAt === null || now - entry.emittedAt >= DELETION_RESEND_MS;
    if (!due || (entry.pending === 0 && entry.zeroResends >= DELETION_ZERO_RESENDS)) return;
    if (entry.pending === 0) entry.zeroResends++;
  } else entry.zeroResends = 0;
  entry.emitted = signature;
  entry.emittedAt = now;
  recordFact({
    kind: "obligation", engineKind: kind, code: "deletion", pendingCount: entry.pending,
    oldestPendingAt: entry.pending > 0 ? entry.oldest ?? now : null, holderState: entry.holder,
    ...(entry.holderClearAt !== null ? { holderClearAt: entry.holderClearAt } : {}),
    failedAttemptsAfterClear: entry.failedAfterClear, completedDelta: entry.completed, observedAt: now,
  });
  entry.completed = 0;
}

/** The pending list as persisted (just written, or just read back). One fact per engine kind whose figures changed. */
export function observeDeletionJournal(entries: readonly DeletionJournalEntry[], now = Date.now()): void {
  try {
    const seen = new Map<EngineKind, { pending: number; oldest: number | null }>();
    for (const entry of entries) {
      const at = typeof entry?.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt > 0 ? Math.floor(entry.createdAt) : null;
      for (const kind of entryKinds(entry)) {
        const figure = seen.get(kind) ?? { pending: 0, oldest: null };
        figure.pending++;
        if (at !== null && (figure.oldest === null || at < figure.oldest)) figure.oldest = at;
        seen.set(kind, figure);
      }
    }
    for (const kind of new Set([...kinds.keys(), ...seen.keys()])) {
      const entry = state(kind);
      const figure = seen.get(kind) ?? { pending: 0, oldest: null };
      entry.pending = figure.pending;
      entry.oldest = figure.oldest;
      if (entry.pending === 0) { entry.holderClearAt = null; entry.failedAfterClear = 0; }
      emit(kind, entry, now);
    }
  } catch { /* telemetry never changes the operation it observes */ }
}

/** Holder state of one engine home from the attempt's reason code for it (engine-history-run.ts sets these from its own
 *  check of the home): open or held by a program is `held`; a file step that failed after the check (`changed`, an
 *  errno code) had the home closed (`clear`); anything else could not tell (`unknown`). */
export function holderOfReason(reason: string | undefined): HolderState {
  const text = reason ?? "";
  // Held: the engine had the home open, or was running in it.
  if (/^(engine-open|held|engine-running|busy|locked|EBUSY)$/.test(text) || /locked by its engine/.test(text)) return "held";
  // Clear only when the attempt got past the holder check: the engine was closed and a file step itself failed.
  if (text === "changed" || /^E[A-Z]+$/.test(text)) return "clear";
  // Anything else (engine-unchecked, helper-unloadable, a helper or journal failure, no reason, an unknown reason)
  // never proves the home was clear (design section 5: an unchecked holder is unavailable).
  return "unknown";
}

/** One attempt's outcome: the homes it planned (`engine\0home` keys, never kept) and the reasons of those that failed. */
export function observeDeletionAttempt(homes: readonly string[], failedReasons: Readonly<Record<string, string | undefined>>, now = Date.now()): void {
  try {
    const byKind = new Map<EngineKind, { held: boolean; unknown: boolean; failed: boolean }>();
    for (const key of homes) {
      const kind = deletionEngineKind(key.split("\0")[0]);
      const seen = byKind.get(kind) ?? { held: false, unknown: false, failed: false };
      if (Object.hasOwn(failedReasons, key)) {
        seen.failed = true;
        const holder = holderOfReason(failedReasons[key]);
        if (holder === "held") seen.held = true;
        if (holder === "unknown") seen.unknown = true;
      }
      byKind.set(kind, seen);
    }
    for (const [kind, seen] of byKind) {
      const entry = state(kind);
      const holder: HolderState = seen.held ? "held" : seen.unknown ? "unknown" : "clear";
      recordCounter("engine-holds", holder, kind);
      if (seen.failed) recordCounter("engine-holds", "failed-attempt", kind);
      if (holder === "clear") {
        if (entry.holder !== "clear" || entry.holderClearAt === null) { entry.holderClearAt = now; entry.failedAfterClear = 0; }
        if (seen.failed) entry.failedAfterClear++;
      } else { entry.holderClearAt = null; entry.failedAfterClear = 0; }
      entry.holder = holder;
      if (seen.failed && holder === "held") recordCounter("deletion", "held", kind);
      emit(kind, entry, now);
    }
  } catch { /* telemetry never changes the operation it observes */ }
}

/** A deletion was recorded (begin) or a retry armed: counts only. */
export function observeDeletionEvent(code: "pending" | "retry", entry: DeletionJournalEntry): void {
  try { for (const kind of entryKinds(entry)) recordCounter("deletion", code, kind); } catch { /* telemetry only */ }
}

/** The pending entry is gone from the journal: the obligation completed. One human line per engine kind it was owed to. */
export function observeDeletionCompleted(entry: DeletionJournalEntry, now = Date.now()): void {
  try {
    const created = typeof entry?.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : now;
    const elapsedMs = Math.max(0, Math.round(now - created));
    for (const kind of entryKinds(entry)) {
      recordCounter("deletion", "completed", kind);
      recordCounter("engine-holds", "completed", kind);
      const state_ = state(kind);
      state_.completed++;
      emit(kind, state_, now, true);
      try { console.info(`deletion outcome result=completed engine=${kind} elapsedMs=${elapsedMs}`); } catch { /* logging is best effort */ }
    }
  } catch { /* telemetry never changes the operation it observes */ }
}

/** Test hook. */
export function resetDeletionObserverForTests(): void { kinds.clear(); }
