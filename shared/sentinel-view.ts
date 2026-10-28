// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client-safe Sentinel view types and the fixed copy catalogue (1.0.9, GAP-SENTINEL-109 sections 7 and 8).
//
// The scanner's own types (server/sentinel/types.ts, publication.ts) are re-exported as types only, so nothing from the
// server runs in the app. Every sentence a Health surface shows comes from the fixed tables below, keyed by the issue's
// titleKey: an input can never put its own text on screen, in a digest or in a notification. An unknown key falls back to
// one plain sentence. Copy rules: no em dashes, plain words, states said as what was checked.
export type {
  Coverage, DetectorId, IssueState, NextAction, Resolution, ScannerStatus, SentinelView, Severity, ViewRow, ViewSummary,
} from "../server/sentinel/types.ts";
import type { NextAction, Severity, SentinelView, ViewRow, ViewSummary } from "../server/sentinel/types.ts";
import type { IssueDetail } from "../server/sentinel/publication.ts";

/** One issue as the owner API returns it: no evidence references, source tokens or related fingerprints. */
export type HealthIssue = Omit<IssueDetail, "evidence" | "sourceKey" | "relatedFingerprints">;

/** GET /api/sentinel/summary. `waiting`: no published view yet (Sentinel not set up or not run). */
export interface HealthSummaryResponse {
  status: "ready" | "waiting" | "unavailable";
  view: SentinelView | null;
}

/** GET /api/sentinel/issues. */
export type HealthIssuesResponse =
  | { ok: true; storeRevision: number; items: HealthIssue[]; next: string | null }
  | { ok: false; reason: "refresh" | "bad-cursor" | "bad-request" | "unavailable" };

/** One grouped digest row: issues sharing a title, counted together. */
export interface HealthDigestRow {
  titleKey: string;
  severity: Severity;
  /** Issues grouped into this row. */
  issues: number;
  /** Occurrences across them. */
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** The daily in-app digest (section 8.3): one per local date, stable id from the date and store revision. */
export interface HealthDigest {
  id: string;
  date: string;
  storeRevision: number;
  createdAt: number;
  /** At most DIGEST_ROWS, ranked by impact then recency. */
  rows: HealthDigestRow[];
  /** Open issues beyond the rows shown. */
  moreCount: number;
  /** Issues observed to recover since the previous digest. */
  recoveredCount: number;
}

/** What an owner's Inbox read carries about Health. Never attached to a less privileged read. */
export interface HealthInbox {
  status: HealthSummaryResponse["status"];
  summary: ViewSummary | null;
  /** Unresolved rows to show in the card (at most DIGEST_ROWS). */
  rows: ViewRow[];
  digest: HealthDigest | null;
}

export const DIGEST_ROWS = 5;

/** The fixed title catalogue, keyed by the detectors' titleKey. */
export const HEALTH_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "health.backup.not-protected": "No recent verified backup",
  "health.backup.overdue": "A scheduled backup is overdue",
  "health.backup.capture-stalled": "A backup started and has not finished",
  "health.io-pressure.sustained-writes": "Heavy disk writes while Murage was idle",
  "health.extraction.unusable-replies": "Memory learning got replies it could not use",
  "health.engine-holds.home-held": "An engine kept its files open and held up cleanup",
  "health.deletion.still-pending": "Some deleted conversations are still being removed",
  "health.send-fence.rebuilding": "A conversation keeps rebuilding its history before sending",
  "health.dispatch.exhausted-turns": "Some messages stopped after every retry",
  "health.resets.loop": "A conversation keeps starting a new engine session",
  "health.isolation-noise.fallback": "Some skill files could not be read and were skipped",
  "health.coverage.producer-silent-server": "Murage has not sent fresh health information",
  "health.coverage.producer-silent-desktop": "The desktop app has not sent fresh health information",
  "health.coverage.stats-stale": "Storage figures are waiting for a fresh reading",
  "health.coverage.scan-failing": "Recent health checks did not finish",
  "health.coverage.source-unavailable-server": "Health information from Murage is waiting for a fresh reading",
  "health.coverage.source-unavailable-desktop": "Health information from the desktop app is waiting for a fresh reading",
  "health.coverage.source-unavailable-backup": "Backup status is waiting for a fresh reading",
  "health.coverage.source-unavailable-db-stats": "Storage figures are waiting to be read",
});
export const HEALTH_TITLE_FALLBACK = "A health check found something to look at";

export function healthTitle(titleKey: string | null | undefined): string {
  return (titleKey && Object.prototype.hasOwnProperty.call(HEALTH_TITLES, titleKey) ? HEALTH_TITLES[titleKey] : undefined) ?? HEALTH_TITLE_FALLBACK;
}

/** Where a detail row's next action goes; fixed destinations only. */
export const NEXT_ACTION_LABELS: Readonly<Record<NextAction, string | null>> = Object.freeze({
  backups: "Open Backups",
  "memory-settings": "Open Memory settings",
  "manage-storage": "Manage storage",
  diagnostics: "Open Diagnostics",
  none: null,
});

export const HEALTH_COPY = Object.freeze({
  title: "Health",
  noIssues: "No issues found in the checked sources.",
  waiting: "Some health checks are waiting for fresh information.",
  notSetUp: "Health checks start after Murage sets up its background checker.",
  unavailable: "Health information could not be read just now.",
  recovered: "Recovered",
  viewHealth: "View Health",
  digestHeading: "Daily health summary",
  details: "Details",
  hideDetails: "Hide details",
  open: "Open",
  resolved: "Resolved",
  loadMore: "Show more",
  refresh: "Health changed while you were reading. Showing the latest.",
});

export const checkedLine = (age: string) => `Checked ${age}`;
export const lastCompleteLine = (age: string) => `Last complete check ${age}`;
export const lastRanLine = (age: string) => `Health checks last ran ${age}`;
export const openCountLine = (n: number) => (n === 1 ? "1 open issue" : `${n} open issues`);
export const recoveredLine = (n: number) => `${HEALTH_COPY.recovered}: ${n === 1 ? "1 issue" : `${n} issues`}`;

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
export const severityRank = (severity: Severity): number => SEVERITY_RANK[severity] ?? 0;

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ageLabel(at: number | null | undefined, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at)) return "never";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** A measured duration: "45 min", "3 h", "2 days". */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Heartbeat older than this while the app runs: the card says when checks last ran instead of "Checked". */
export const HEALTH_STALE_MS = 30 * 60_000;

/** The one state sentence the card leads with, from the summary alone. */
export function healthStateLine(status: HealthSummaryResponse["status"], summary: ViewSummary | null, now: number): { sentence: string; time: string | null } {
  if (status === "unavailable") return { sentence: HEALTH_COPY.unavailable, time: null };
  if (status === "waiting" || !summary) return { sentence: HEALTH_COPY.notSetUp, time: null };
  const checked = summary.lastCheckedAt;
  const stopped = summary.scanner !== "running" || checked === null || now - checked > HEALTH_STALE_MS;
  const time = stopped
    ? (checked === null ? null : lastRanLine(ageLabel(checked, now)))
    : summary.coverage === "complete" ? checkedLine(ageLabel(checked, now)) : lastCompleteLine(ageLabel(summary.lastCompleteCheckAt, now));
  if (summary.openCount > 0) return { sentence: healthTitle(summary.topTitleKey), time };
  if (summary.coverage !== "complete" || stopped) return { sentence: HEALTH_COPY.waiting, time };
  return { sentence: HEALTH_COPY.noIssues, time };
}
