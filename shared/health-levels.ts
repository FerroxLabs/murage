// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How much a Health issue asks of the owner, and how identical issues fold (Sean 11-01). No words live here, so the
// server can count Needs you from it and the first paint can read it; the owner's sentences are in
// src/components/health/health-guide.ts, keyed the same way.
//
//   act    the owner must do something: an ordinary Needs you item, counted, with one action, and the red dot
//   watch  worth a look, there is something the owner can do, and nothing breaks if they wait: an amber dot, no count
//   note   nothing to do, Murage is on it: no dot and no count, listed on the Health screen only
//
// A title this build does not know is a note: it can never raise a count or a dot.
export type HealthIssueLevel = "act" | "watch" | "note";

export const HEALTH_ISSUE_LEVELS: Readonly<Record<string, HealthIssueLevel>> = Object.freeze({
  "health.backup.not-protected": "act",
  "health.backup.overdue": "watch",
  "health.backup.capture-stalled": "watch",
  "health.io-pressure.sustained-writes": "watch",
  "health.extraction.unusable-replies": "watch",
  "health.dispatch.exhausted-turns": "watch",
  "health.engine-holds.home-held": "note",
  "health.deletion.still-pending": "note",
  "health.send-fence.rebuilding": "note",
  "health.resets.loop": "note",
  "health.isolation-noise.fallback": "note",
  "health.coverage.producer-silent-server": "note",
  "health.coverage.producer-silent-desktop": "note",
  "health.coverage.stats-stale": "note",
  "health.coverage.scan-failing": "note",
  "health.coverage.source-unavailable-server": "note",
  "health.coverage.source-unavailable-desktop": "note",
  "health.coverage.source-unavailable-backup": "note",
  "health.coverage.source-unavailable-db-stats": "note",
});

export function healthIssueLevel(titleKey: string | null | undefined): HealthIssueLevel {
  return (titleKey && Object.hasOwn(HEALTH_ISSUE_LEVELS, titleKey) ? HEALTH_ISSUE_LEVELS[titleKey] : undefined) ?? "note";
}

const RANK: Readonly<Record<HealthIssueLevel, number>> = { act: 3, watch: 2, note: 1 };

/** What a row must carry to fold: a title, and when it was seen. Both the view's rows and the issue details have these. */
export interface FoldableHealthRow { titleKey: string; count: number; firstSeenAt: number; lastSeenAt: number }

/** One line of the Health screen: every issue with the same title, together. */
export interface HealthFold<R extends FoldableHealthRow = FoldableHealthRow> {
  titleKey: string;
  level: HealthIssueLevel;
  /** How many issues this line stands for. */
  issues: number;
  /** Occurrences across them. */
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  rows: R[];
}

/** Folds identical issues to one line: act first, then watch, then note, newest first inside a level. */
export function foldHealthRows<R extends FoldableHealthRow>(rows: readonly R[]): HealthFold<R>[] {
  const folds = new Map<string, HealthFold<R>>();
  for (const row of rows) {
    const fold = folds.get(row.titleKey);
    if (!fold) { folds.set(row.titleKey, { titleKey: row.titleKey, level: healthIssueLevel(row.titleKey), issues: 1, count: row.count, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, rows: [row] }); continue; }
    fold.issues += 1;
    fold.count += row.count;
    fold.firstSeenAt = Math.min(fold.firstSeenAt, row.firstSeenAt);
    fold.lastSeenAt = Math.max(fold.lastSeenAt, row.lastSeenAt);
    fold.rows.push(row);
  }
  return [...folds.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || b.lastSeenAt - a.lastSeenAt);
}

/** The strongest level among open issues; null when nothing is open. */
export function strongestHealthLevel(rows: ReadonlyArray<{ titleKey: string }>): HealthIssueLevel | null {
  let top: HealthIssueLevel | null = null;
  for (const row of rows) {
    const level = healthIssueLevel(row.titleKey);
    if (top === null || RANK[level] > RANK[top]) top = level;
  }
  return top;
}
