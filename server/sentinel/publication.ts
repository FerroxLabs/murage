// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Publication of the Sentinel view and the owner-API read helpers (1.0.9, GAP-SENTINEL-109 sections 6.3, 8.1 and 8.4).
//
// view.json (in the output root) is built only from the committed store: the store revision, a summary and at most 25
// compact rows within 16 KiB. It is replaced atomically (temporary child + rename, owner-only) and only when its
// contents change (publishedAt alone is not a change). After a crash between the store commit and publication, the next
// scan republishes the same revision without recounting anything.
//
// Owner-API reads (lane C mounts them on GET /api/sentinel/summary and /api/sentinel/issues): readPublishedView() reads
// view.json; readIssuesPage() and readPageIntents() open state.sqlite READ-ONLY for short indexed queries. Neither can open
// a source database or start a scan. Issue pages use an opaque cursor carrying the store revision; when the revision
// moved the answer is `refresh`, never a mixed page. limit <= 50, response <= 64 KiB.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import type { IssueRecord } from "./lifecycle.ts";
import { INTENTS_MAX, SEVERITY_RANK, SentinelStore } from "./store.ts";
import type { Coverage, DetectorId, Issue, NextAction, ScannerStatus, SentinelView, Severity, ViewRow, ViewSummary } from "./types.ts";

export const VIEW_FILE = "view.json";

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The fixed next action per detector (section 8.1). Never derived from input. */
export const NEXT_ACTION: Readonly<Record<DetectorId, NextAction>> = Object.freeze({
  backup: "backups", "io-pressure": "manage-storage", extraction: "memory-settings", "engine-holds": "diagnostics", deletion: "manage-storage",
  "send-fence": "diagnostics", "dispatch-exhausted": "diagnostics", resets: "diagnostics", "isolation-noise": "diagnostics", coverage: "none",
});

export function toViewRow(record: IssueRecord): ViewRow {
  const issue = record.issue;
  return {
    fingerprint: issue.fingerprint, detectorId: issue.detectorId, titleKey: issue.titleKey, severity: issue.severity, state: issue.state,
    delivery: record.delivery, firstSeenAt: issue.firstSeenAt, lastSeenAt: issue.lastSeenAt, count: issue.count, coverage: issue.coverage.overall,
    ...(issue.resolution ? { resolution: issue.resolution } : {}), ...(issue.resolvedAt !== undefined ? { resolvedAt: issue.resolvedAt } : {}),
    nextAction: NEXT_ACTION[issue.detectorId] ?? "none",
  };
}

export interface ViewInputs {
  storeRevision: number;
  now: number;
  scanner: ScannerStatus;
  coverage: Coverage;
  lastCheckedAt: number | null;
  lastCompleteCheckAt: number | null;
  /** Observed recoveries since the last digest (the host's digest owns the reset point; the scanner counts from the
   * last 24 h of resolved rows it shows). */
  records: readonly IssueRecord[];
  openCount: number;
}

const RANK_SEVERITY: Record<number, Severity> = { 1: "low", 2: "medium", 3: "high" };

/** Builds the view from committed records: at most 25 rows, at most 16 KiB (rows dropped from the end count in moreCount). */
export function buildView(input: ViewInputs): SentinelView {
  const unresolved = input.records.filter(r => r.issue.state !== "resolved" && !r.issue.presentedBy);
  const top = unresolved[0]?.issue ?? null;
  const highest = unresolved.reduce<number>((max, r) => Math.max(max, SEVERITY_RANK[r.issue.severity]), 0);
  const recovered = input.records.filter(r => r.issue.resolution === "observed-recovery" && (r.issue.resolvedAt ?? 0) > input.now - 24 * 60 * 60_000).length;
  const rows = input.records.filter(r => !r.issue.presentedBy).slice(0, HEALTH_LIMITS.viewRows).map(toViewRow);
  const summary: ViewSummary = {
    openCount: input.openCount,
    highestSeverity: highest ? RANK_SEVERITY[highest]! : null,
    topTitleKey: top?.titleKey ?? null,
    lastCheckedAt: input.lastCheckedAt,
    lastCompleteCheckAt: input.lastCompleteCheckAt,
    coverage: input.coverage,
    scanner: input.scanner,
    recoveredCount: recovered,
    moreCount: Math.max(0, input.openCount - rows.filter(r => r.state !== "resolved").length),
  };
  const view: SentinelView = { schemaVersion: 1, storeRevision: input.storeRevision, publishedAt: input.now, summary, rows };
  while (bytesOf(view) > HEALTH_LIMITS.viewBytes && view.rows.length > 0) {
    const dropped = (view.rows as ViewRow[]).pop()!;
    if (dropped.state !== "resolved") view.summary.moreCount++;
  }
  return view;
}

/** Builds the view straight from a store (bounded queries only). */
export function viewFromStore(store: SentinelStore, now: number, scanner: ScannerStatus, coverage: Coverage, lastCheckedAt: number | null, lastCompleteCheckAt: number | null): SentinelView {
  const records = store.viewIssues(HEALTH_LIMITS.viewRows);
  return buildView({ storeRevision: store.revision(), now, scanner, coverage, lastCheckedAt, lastCompleteCheckAt, records, openCount: store.unresolvedCounts().open });
}

const comparable = (view: SentinelView) => JSON.stringify({ ...view, publishedAt: 0 });

/** Reads and shape-checks view.json; null when absent, oversize or malformed. */
export function readPublishedView(outputRoot: string, platform: NodeJS.Platform = process.platform): SentinelView | null {
  const file = pathFor(platform).join(outputRoot, VIEW_FILE);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > HEALTH_LIMITS.viewBytes) return null;
    const view = JSON.parse(readFileSync(file, "utf8")) as SentinelView;
    if (view?.schemaVersion !== 1 || typeof view.storeRevision !== "number" || !Array.isArray(view.rows) || typeof view.summary !== "object" || view.summary === null) return null;
    return view;
  } catch { return null; }
}

/** Atomically publishes `view` when its contents (ignoring publishedAt) differ from the current file. Answers the bytes
 * written (0 when unchanged), or -1 on failure (the previous file stays). */
export function publishView(outputRoot: string, view: SentinelView, platform: NodeJS.Platform = process.platform): number {
  const current = readPublishedView(outputRoot, platform);
  if (current && comparable(current) === comparable(view)) return 0;
  const p = pathFor(platform);
  const text = `${JSON.stringify(view)}\n`;
  if (Buffer.byteLength(text) > HEALTH_LIMITS.viewBytes) return -1;
  const temp = p.join(outputRoot, `.tmp-${randomBytes(8).toString("hex")}.json`);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    if (platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, p.join(outputRoot, VIEW_FILE));
    return Buffer.byteLength(text);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    return -1;
  }
}

/** A view that keeps the last valid rows but states the scanner's condition (unknown schema, corrupt or unavailable
 * store). Never reconstructs rows from a partial source. */
export function statusView(last: SentinelView | null, now: number, scanner: ScannerStatus): SentinelView {
  if (last) return { ...last, publishedAt: now, summary: { ...last.summary, scanner, coverage: "unavailable" } };
  return {
    schemaVersion: 1, storeRevision: 0, publishedAt: now, rows: [],
    summary: { openCount: 0, highestSeverity: null, topTitleKey: null, lastCheckedAt: null, lastCompleteCheckAt: null, coverage: "unavailable", scanner, recoveredCount: 0, moreCount: 0 },
  };
}

// ---------------------------------------------------------------------------
// Owner-API reads (read-only store queries)
// ---------------------------------------------------------------------------

export interface IssueDetail extends Omit<Issue, "installationId"> { delivery: ViewRow["delivery"]; nextAction: NextAction; recoveryStartedAt: number | null }

export type IssuesPage =
  | { ok: true; storeRevision: number; items: IssueDetail[]; next: string | null }
  | { ok: false; reason: "refresh" | "bad-cursor" | "unavailable" | "bad-request" };

interface CursorBody { v: 1; r: number; o: 0 | 1; k: number; l: number; f: string }

const encodeCursor = (body: CursorBody) => Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
function decodeCursor(text: string): CursorBody | null {
  if (typeof text !== "string" || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const body = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as CursorBody;
    if (body?.v !== 1 || !Number.isSafeInteger(body.r) || (body.o !== 0 && body.o !== 1) || !Number.isSafeInteger(body.k) || !Number.isSafeInteger(body.l) || typeof body.f !== "string" || !/^[0-9a-f]{64}$/.test(body.f)) return null;
    return body;
  } catch { return null; }
}

function detail(record: IssueRecord): IssueDetail {
  const { installationId: _omit, ...issue } = record.issue;
  return { ...issue, delivery: record.delivery, nextAction: NEXT_ACTION[issue.detectorId] ?? "none", recoveryStartedAt: record.recoveryStartedAt };
}

export interface IssuesQuery { state: "open" | "resolved"; after?: string | null; limit?: number }

/** One page of issues (presentation groups included), newest-highest first, from the committed store. Read-only. */
export function readIssuesPage(outputRoot: string, installationId: string, query: IssuesQuery, platform: NodeJS.Platform = process.platform): IssuesPage {
  if (query.state !== "open" && query.state !== "resolved") return { ok: false, reason: "bad-request" };
  const limit = Math.min(HEALTH_LIMITS.apiLimitMax, Math.max(1, Math.floor(query.limit ?? HEALTH_LIMITS.apiLimitDefault)));
  if (!Number.isFinite(limit)) return { ok: false, reason: "bad-request" };
  const cursor = query.after ? decodeCursor(query.after) : null;
  if (query.after && !cursor) return { ok: false, reason: "bad-cursor" };
  const opened = SentinelStore.open(outputRoot, { installationId, platform, readOnly: true });
  if (opened.status !== "ok" && opened.status !== "upgrade-needed") { opened.store?.close(); return { ok: false, reason: "unavailable" }; }
  const store = opened.store;
  if (!store) return { ok: false, reason: "unavailable" };
  try {
    const revision = store.revision();
    const open = query.state === "open" ? 1 : 0;
    if (cursor && (cursor.r !== revision || cursor.o !== open)) return { ok: false, reason: "refresh" };
    const rows = (cursor
      ? store.db.prepare(`SELECT rank, last_seen_at, fingerprint, record FROM issues WHERE open = ? AND (rank < ? OR (rank = ? AND (last_seen_at < ? OR (last_seen_at = ? AND fingerprint > ?))))
          ORDER BY rank DESC, last_seen_at DESC, fingerprint LIMIT ?`).all(open, cursor.k, cursor.k, cursor.l, cursor.l, cursor.f, limit + 1)
      : store.db.prepare("SELECT rank, last_seen_at, fingerprint, record FROM issues WHERE open = ? ORDER BY rank DESC, last_seen_at DESC, fingerprint LIMIT ?").all(open, limit + 1)
    ) as Array<{ rank: number; last_seen_at: number; fingerprint: string; record: string }>;
    const items: IssueDetail[] = [];
    let used = 256;
    let last: (typeof rows)[number] | null = null;
    let more = rows.length > limit;
    for (const row of rows.slice(0, limit)) {
      let record: IssueRecord;
      try { record = JSON.parse(row.record) as IssueRecord; } catch { continue; }
      const item = detail(record);
      const size = bytesOf(item) + 1;
      if (used + size > HEALTH_LIMITS.apiResponseBytes) { more = true; break; }
      used += size;
      items.push(item);
      last = row;
    }
    const next = more && last ? encodeCursor({ v: 1, r: revision, o: open as 0 | 1, k: last.rank, l: last.last_seen_at, f: last.fingerprint }) : null;
    return { ok: true, storeRevision: revision, items, next };
  } catch { return { ok: false, reason: "unavailable" }; }
  finally { store.close(); }
}

/** A page intent with whether the episode it was made for is still open in the store. */
export interface PageIntent { id: string; fingerprint: string; episode: number; titleKey: string; createdAt: number; open: boolean }

/** Every page intent the scanner store holds (its retention and INTENTS_MAX bound the list), oldest first, each with
 * whether its issue episode is still open. The host's delivery owner keys its ledger by intent id; this read never
 * changes the store. */
export function readPageIntents(outputRoot: string, installationId: string, platform: NodeJS.Platform = process.platform): { ok: true; intents: PageIntent[] } | { ok: false; reason: "unavailable" } {
  const opened = SentinelStore.open(outputRoot, { installationId, platform, readOnly: true });
  const store = opened.store;
  if ((opened.status !== "ok" && opened.status !== "upgrade-needed") || !store) { store?.close(); return { ok: false, reason: "unavailable" }; }
  try {
    const rows = store.db.prepare(`SELECT n.id, n.fingerprint, n.episode, n.title_key, n.created_at,
        (s.open = 1 AND json_extract(s.record, '$.issue.episode') = n.episode) AS still_open
      FROM intents n LEFT JOIN issues s ON s.fingerprint = n.fingerprint
      WHERE n.delivery = 'page' ORDER BY n.created_at, n.id LIMIT ?`)
      .all(INTENTS_MAX) as Array<{ id: string; fingerprint: string; episode: number; title_key: string; created_at: number; still_open: number | null }>;
    return { ok: true, intents: rows.map(r => ({ id: r.id, fingerprint: r.fingerprint, episode: r.episode, titleKey: r.title_key, createdAt: r.created_at, open: r.still_open === 1 })) };
  } catch { return { ok: false, reason: "unavailable" }; }
  finally { store.close(); }
}
