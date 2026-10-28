// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One Sentinel scan (1.0.9, GAP-SENTINEL-109 sections 6.2, 6.3, 8.4 and 9).
//
//   idle -> admitted -> reading -> evaluating -> committing -> published -> idle
//
// admitted   the output root is verified (owner-only, outside data root and repositories) and the OS-held exclusive
//            lease is taken: an exclusive SQLite lock on <outputRoot>/lease.sqlite (fcntl on POSIX, LockFileEx on
//            Windows), which the OS releases when the process dies. A live holder means `already-running`; a lease is
//            never stolen on elapsed time. The store opens (unknown schema: keep the last view, report upgrade-needed,
//            stop writing; corrupt: preserve it, report unavailable). A view behind the committed revision (crash after
//            commit, before publication) is republished as is, without recounting.
// reading    backup status and stats first, then the producer windows, under one ScanBudget. Unchanged identities skip
//            reads entirely (cached backup/stats values are reused), but detectors still run so due-time and freshness
//            deadlines are evaluated.
// evaluating runDetectors() with persisted per-detector state, then lifecycle.step() per result (pending results from a
//            previous over-full scan first). At most 32 changed issue rows per scan; the rest wait in `pending`.
// committing ONE store transaction: cursors, detector states, issues, intents, pending, caches, self-health, ledger,
//            write ledger. Issue rows, intents, pending results and metadata fit the 128 KiB per-commit cap; detector
//            states have their own fixed allowance (DETECTOR_STATES_COMMIT_BYTES, never more than that per commit), so
//            no amount of detector state can stop every commit. Everything is charged to the rolling-24h 32 MiB ledger
//            (64 KiB reserve kept for a status), the view by the bytes it actually takes.
// published  view.json from the committed store, only when it changed.
//
// A crash before commit leaves the old cursors: the same records replay. Nothing here sends a notification, opens a
// source database read-write, or touches the network.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HEALTH_LIMITS, type CoverageValue, type EvidenceSourceRole } from "../../shared/health-protocol.mjs";
import { ScanBudget, canCharge, charge, parseBucket, type ScanBudgetOptions, type WriteBucketState } from "./budget.ts";
import { DETECTOR_VERSIONS, runDetectors, type PersistedDetectorState } from "./detectors/index.ts";
import { step, type IssueRecord, type PageLedger } from "./lifecycle.ts";
import type { AclCheck } from "./win-acl.ts";
import { checkInputRoot, ensureOutputRoot, type OutputRootOptions, type SentinelDescriptor } from "./paths.ts";
import { publishView, readPublishedView, statusView, viewFromStore } from "./publication.ts";
import { readBackupStatus, readDbStats, readProducer, type CachedBackup, type CachedDbStats, type ProducerCursor, type ProducerKey, type ReadContext } from "./sources.ts";
import { PENDING_MAX, SentinelStore, type DeliveryIntent, type SelfHealth, type StoreChanges } from "./store.ts";
import { fingerprint, type Coverage, type DetectorId, type DetectorInput, type DetectorResult, type IssueCoverage, type ScannerStatus } from "./types.ts";

export const LEASE_FILE = "lease.sqlite";
export const FAILURES_FILE = "failures.json";
export const SCAN_FAILURES_MAX = 16;
/** Changed detector states committed at once, at most (logical bytes): a fixed allowance outside the 128 KiB cap for
 * issue rows. Ten detectors of up to 64 KiB each could exceed it; the largest changed states then keep their prior
 * value this scan (their windows are counted as overflow), and the commit always goes through. */
export const DETECTOR_STATES_COMMIT_BYTES = 160 * 1024;
/** A view is charged at least this much (a first view, or one whose previous size is unknown). */
export const VIEW_CHARGE_MIN_BYTES = 2 * 1024;
/** A wall-clock step that differs from the awake clock by more than this between scans is a discontinuity. */
export const CLOCK_SLACK_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;
const INTENT_RETENTION_MS = 30 * DAY_MS;

export type ScanPhase = "idle" | "admitted" | "reading" | "evaluating" | "committing" | "published";
export type ScanStatus = "published" | "no-op" | "already-running" | "upgrade-needed" | "unavailable" | "budget-exhausted" | "output-refused" | "failed";

export interface ScanOutcome {
  status: ScanStatus;
  phase: ScanPhase;
  revision: number | null;
  changedIssues: number;
  deferred: number;
  chargedBytes: number;
  republished: boolean;
  coverage: Coverage;
  reason: string | null;
  readBytes: number;
}

export interface ScanHooks {
  /** Called inside `committing`, before the transaction (a throw simulates a crash before commit). */
  beforeCommit?: () => void;
  /** Called after the commit, before publication (a throw simulates a crash after commit). */
  afterCommit?: () => void;
}

export interface ScanOptions extends OutputRootOptions {
  descriptor: SentinelDescriptor;
  now?: () => number;
  /** Awake (monotonic, suspend-excluding) clock in ms. Default process.hrtime. */
  monotonicMs?: () => number;
  budget?: ScanBudgetOptions;
  runDetectors?: typeof runDetectors;
  hooks?: ScanHooks;
  /** Windows owner-only DACL verdict for the producer input root (default: icacls, server/sentinel/win-acl.ts). */
  aclCheck?: AclCheck;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const json = (value: unknown) => JSON.stringify(value ?? null);
const defaultMonotonic = () => Number(process.hrtime.bigint() / 1_000_000n);

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

export interface Lease { release(): void }

/** Takes the OS-held exclusive lease, or answers null when another live scanner holds it. */
export function acquireLease(outputRoot: string, platform: NodeJS.Platform = process.platform): Lease | null {
  const file = pathFor(platform).join(outputRoot, LEASE_FILE);
  try { closeSync(openSync(file, "wx", 0o600)); } catch { /* exists */ }
  try { const st = lstatSync(file); if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return null; } catch { return null; }
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { timeout: 0, allowExtension: false }); } catch { return null; }
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch {
    try { db.close(); } catch { /* closed */ }
    return null;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try { db.exec("ROLLBACK"); } catch { /* none open */ }
      try { db.close(); } catch { /* closed */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Scan failures (written by the supervisor when a child is killed or crashes)
// ---------------------------------------------------------------------------

function readFailuresFile(outputRoot: string, platform: NodeJS.Platform): number[] {
  const file = pathFor(platform).join(outputRoot, FAILURES_FILE);
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > 4096) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { failures?: unknown };
    return Array.isArray(parsed.failures) ? parsed.failures.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0).slice(-SCAN_FAILURES_MAX) : [];
  } catch { return []; }
}

/** Records one failed scan attempt (bounded to the newest 16), atomically and owner-only. */
export function recordScanFailure(outputRoot: string, at: number, platform: NodeJS.Platform = process.platform): void {
  const p = pathFor(platform);
  const failures = [...readFailuresFile(outputRoot, platform), at].sort((a, b) => a - b).slice(-SCAN_FAILURES_MAX);
  const temp = p.join(outputRoot, `.tmp-${randomBytes(8).toString("hex")}.json`);
  try {
    writeFileSync(temp, JSON.stringify({ failures }), { mode: 0o600, flag: "wx" });
    if (platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, p.join(outputRoot, FAILURES_FILE));
  } catch { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const worst = (values: Coverage[]): Coverage => {
  if (values.length === 0) return "unavailable";
  if (values.every(v => v === "complete" || v === "not-applicable")) return "complete";
  if (values.every(v => v === "unavailable")) return "unavailable";
  return "partial";
};

/** A persisted detector state without its stored awake clock (engine holds, deletion and coverage keep one). */
function withoutAwake(persisted: PersistedDetectorState | undefined): unknown {
  const state = persisted?.state as Record<string, unknown> | undefined;
  if (!state || typeof state !== "object" || !("awake" in state)) return persisted ?? null;
  const { awake: _awake, ...rest } = state;
  return { version: persisted!.version, state: rest };
}

const intentId = (fp: string, episode: number, delivery: string, reason: string) => createHash("sha256").update(`${fp}|${episode}|${delivery}|${reason}`).digest("hex").slice(0, 32);

interface ClockMark { wallAt: number; monoAt: number }

/** Desktop producer coverage. Both segments absent on an installation that runs no desktop producer (the descriptor says
 * so, or, without that, the producer never published anything here) is not-applicable: a server-only installation is
 * never short of a source it does not have. A desktop producer that is expected, or that published before, and whose
 * segments are now missing stays unavailable. */
export function desktopCoverage(d: SentinelDescriptor, read: ReturnType<typeof readProducer> | null, prior: ProducerCursor | null): Coverage {
  if (!read) return "unavailable";
  if (read.reason !== "missing") return read.coverage;
  const expected = d.producers ? d.producers.includes("desktop") : prior !== null;
  return expected ? "unavailable" : "not-applicable";
}

/** Backup status coverage. The manifest comes only from a committing backup coordinator, which only a desktop
 * installation runs (the desktop host republishes the committed state at every start). So an absent manifest is
 * not-applicable wherever the desktop producer is not-applicable (self-host, Cloud), and unavailable wherever a desktop producer is
 * expected or present. */
export function backupCoverage(read: { coverage: Coverage; reason: string | null }, desktop: Coverage): Coverage {
  if (read.reason !== "missing") return read.coverage;
  return desktop === "not-applicable" ? "not-applicable" : "unavailable";
}

export function runScan(options: ScanOptions): ScanOutcome {
  const platform = options.platform ?? process.platform;
  const d = options.descriptor;
  const now = (options.now ?? Date.now)();
  const mono = (options.monotonicMs ?? defaultMonotonic)();
  const outcome: ScanOutcome = { status: "failed", phase: "idle", revision: null, changedIssues: 0, deferred: 0, chargedBytes: 0, republished: false, coverage: "unavailable", reason: null, readBytes: 0 };
  const done = (status: ScanStatus, reason: string | null = null) => { outcome.status = status; outcome.reason = reason; return outcome; };

  const root = ensureOutputRoot(d.outputRoot, options);
  if (!root.ok) return done("output-refused", root.reason);
  const lease = acquireLease(d.outputRoot, platform);
  if (!lease) return done("already-running");
  let store: SentinelStore | null = null;
  try {
    outcome.phase = "admitted";
    const opened = SentinelStore.open(d.outputRoot, { installationId: d.installationId, platform });
    if (opened.status !== "ok") {
      const scanner: ScannerStatus = opened.status === "upgrade-needed" ? "upgrade-needed" : "unavailable";
      publishView(d.outputRoot, statusView(readPublishedView(d.outputRoot, platform), now, scanner), platform);
      opened.store?.close();
      return done(opened.status === "upgrade-needed" ? "upgrade-needed" : "unavailable", opened.reason);
    }
    store = opened.store;
    const self = store.selfHealth();

    // Crash after commit, before publication: republish the committed revision as is.
    const published = readPublishedView(d.outputRoot, platform);
    if (store.revision() > 0 && (!published || published.storeRevision !== store.revision())) {
      const coverage = (store.meta<Coverage>("last_coverage") ?? "unavailable");
      if (publishView(d.outputRoot, viewFromStore(store, now, "running", coverage, self.lastCommitAt, self.lastCompleteAt), platform) >= 0) outcome.republished = true;
    }

    // Daily write budget: when even a small commit would break into the reserve, stop source work.
    let bucket: WriteBucketState = parseBucket(store.meta("write_bucket"), now);
    if (!canCharge(bucket, 16 * 1024, now)) {
      if (self.lastStop !== "write-budget" && canCharge(bucket, 8 * 1024, now, true)) {
        const status: SelfHealth = { ...self, lastScanAt: now, lastStop: "write-budget", budgetStops: self.budgetStops + 1 };
        const cost = SentinelStore.estimateCharge({ meta: { self_health: status } });
        bucket = charge(bucket, cost, now);
        outcome.revision = store.commit({ meta: { self_health: status, write_bucket: bucket } });
        outcome.chargedBytes = cost;
        publishView(d.outputRoot, viewFromStore(store, now, "running", "partial", self.lastCommitAt, self.lastCompleteAt), platform);
      }
      return done("budget-exhausted", "write-budget");
    }

    // ----- reading -----
    outcome.phase = "reading";
    const budget = new ScanBudget(options.budget);
    const ctx: ReadContext = { budget, installationId: d.installationId, inputRoot: d.inputRoot, now, platform, ...(options.uid !== undefined ? { uid: options.uid } : {}) };
    const rootOk = budget.takeStat(2) && checkInputRoot(d.inputRoot, { ...ctx, ...(options.aclCheck ? { aclCheck: options.aclCheck } : {}) }).ok;
    const backupCache = store.meta<CachedBackup>("backup_cache");
    const statsCache = store.meta<CachedDbStats>("dbstats_cache");
    const cursors: Record<ProducerKey, ProducerCursor | null> = { server: store.cursor("server"), desktop: store.cursor("desktop") };
    const backup = rootOk ? readBackupStatus(d.sources.backupStatus, backupCache, ctx) : { status: null, coverage: "unavailable" as Coverage, cache: null, changed: backupCache !== null, reason: "input-root" };
    const stats = rootOk ? readDbStats(d.sources.dbStatsManifest, statsCache, ctx) : { snapshot: null, coverage: "unavailable" as Coverage, cache: null, changed: statsCache !== null, reason: "input-root" };
    const server = rootOk ? readProducer("server", { current: d.sources.serverCurrent, previous: d.sources.serverPrevious }, cursors.server, ctx) : null;
    const desktop = rootOk ? readProducer("desktop", { current: d.sources.desktopCurrent, previous: d.sources.desktopPrevious }, cursors.desktop, ctx) : null;
    outcome.readBytes = budget.used.bytes;
    const desktopSource = desktopCoverage(d, desktop, cursors.desktop);
    const sourceCoverage: Record<EvidenceSourceRole & ("server" | "desktop" | "backup" | "db-stats"), Coverage> = {
      server: server?.coverage ?? "unavailable", desktop: desktopSource, backup: backupCoverage(backup, desktopSource), "db-stats": stats.coverage,
    };

    // ----- evaluating -----
    outcome.phase = "evaluating";
    const clock = store.meta<ClockMark>("clock");
    const rebooted = clock !== null && mono < clock.monoAt;
    const clockJump = clock !== null && !rebooted && Math.abs((now - clock.wallAt) - (mono - clock.monoAt)) > CLOCK_SLACK_MS;
    const discontinuity = rebooted || clockJump || !!server?.discontinuity || !!desktop?.discontinuity;
    const storedFailures = store.meta<number[]>("scan_failures") ?? [];
    const fileFailures = readFailuresFile(d.outputRoot, platform);
    const scanFailures = [...new Set([...storedFailures, ...fileFailures])].sort((a, b) => a - b).slice(-SCAN_FAILURES_MAX);
    const input: DetectorInput = {
      installationId: d.installationId, now,
      awake: { awakeNowMs: mono, previousAwakeMs: clock && !rebooted ? clock.monoAt : null, discontinuity },
      windows: { server: server?.windows ?? [], desktop: desktop?.windows ?? [] },
      backupStatus: backup.status, dbStats: stats.snapshot,
      sourceCoverage: sourceCoverage as Partial<Record<EvidenceSourceRole, CoverageValue>>,
      ...(scanFailures.length ? { scanFailures } : {}),
    };
    const priorStates = store.detectorStates();
    const runs = (options.runDetectors ?? runDetectors)(input, priorStates);

    const completeAt = { ...(store.meta<Record<string, number | null>>("source_complete_at") ?? {}) };
    for (const [role, value] of Object.entries(sourceCoverage)) if (value === "complete") completeAt[role] = now;
    const sources: IssueCoverage["sources"] = (Object.keys(sourceCoverage) as Array<keyof typeof sourceCoverage>).map(role => ({ role, status: sourceCoverage[role], lastCompleteAt: completeAt[role] ?? null }));

    const detectorStates: Partial<Record<DetectorId, PersistedDetectorState>> = {};
    // A state that differs only in its stored awake clock is no reason to commit on its own (it rides along when
    // something else commits): an idle installation with unchanged inputs writes nothing.
    let progressed = false;
    for (const run of runs) {
      if (!run.nextState) continue;
      if (json(run.nextState) !== json(priorStates[run.id])) {
        detectorStates[run.id] = run.nextState;
        if (json(withoutAwake(run.nextState)) !== json(withoutAwake(priorStates[run.id]))) progressed = true;
      }
    }
    // The state allowance: the largest changed states keep their prior value until the rest fit.
    let stateOverflow = 0;
    let stateBytes = Object.values(detectorStates).reduce((n, state) => n + json(state).length, 0);
    for (const [id, state] of Object.entries(detectorStates).sort((a, b) => json(b[1]).length - json(a[1]).length)) {
      if (stateBytes <= DETECTOR_STATES_COMMIT_BYTES) break;
      stateBytes -= json(state).length;
      delete detectorStates[id as DetectorId];
      stateOverflow++;
    }
    const cursorChanges: Partial<Record<ProducerKey, ProducerCursor | null>> = {};
    if (server && json(server.cursor) !== json(cursors.server)) cursorChanges.server = server.cursor;
    if (desktop && json(desktop.cursor) !== json(cursors.desktop)) cursorChanges.desktop = desktop.cursor;
    // Byte room for issue rows, intents and pending results inside the 128 KiB commit: what is left after the fixed part
    // (cursors and a metadata allowance). Detector states have their own allowance; the view is charged separately.
    const META_ALLOWANCE = 4 * 1024;
    const fixedCost = SentinelStore.estimateCharge({ cursors: cursorChanges }) + 2 * META_ALLOWANCE;
    let room = HEALTH_LIMITS.commitBytes - fixedCost;
    const rowCost = (record: IssueRecord) => SentinelStore.estimateCharge({ issues: [record] }) - 3 * 4096 + 2 * 300;
    const pendingCost = (result: DetectorResult) => SentinelStore.estimateCharge({ pendingAdd: [{ detectorId: result.tuple.detectorId, detectorVersion: 1, result }] }) - 3 * 4096;

    let ledger: PageLedger = store.pageLedger();
    const changed = new Map<string, IssueRecord>();
    const priorOf = new Map<string, IssueRecord | null>();
    const intents: Omit<DeliveryIntent, "revision">[] = [];
    const pendingAdd: StoreChanges["pendingAdd"] = [];
    const pendingRemove: number[] = [];
    const removeIssues = new Set<string>();
    let overflow = stateOverflow;
    let rows = store.issueCount();
    const pendingRows = store.pending();
    let pendingTotal = pendingRows.length;
    const evictable = store.oldestResolved(HEALTH_LIMITS.changedIssuesPerScan);

    const apply = (result: DetectorResult, deferredSeq: number | null): void => {
      const fp = fingerprint(result.tuple);
      if (!priorOf.has(fp)) priorOf.set(fp, store!.issue(fp));
      const prior = changed.get(fp) ?? priorOf.get(fp) ?? null;
      const out = step(prior, result, ledger, { now, detectorVersion: DETECTOR_VERSIONS[result.tuple.detectorId] ?? 1, discontinuity, sources });
      const differs = out.record !== null && json(out.record) !== json(prior);
      if (!differs) { ledger = out.ledger; if (deferredSeq !== null) pendingRemove.push(deferredSeq); return; }
      const isNewRow = priorOf.get(fp) === null && !changed.has(fp);
      const cost = rowCost(out.record!);
      const atCap = !changed.has(fp) && (changed.size >= HEALTH_LIMITS.changedIssuesPerScan || cost > room);
      if (atCap) {
        if (deferredSeq !== null) return; // still waiting, keeps its place
        const waiting = pendingCost(result);
        if (pendingTotal < PENDING_MAX && waiting <= room) {
          pendingAdd.push({ detectorId: result.tuple.detectorId, detectorVersion: DETECTOR_VERSIONS[result.tuple.detectorId] ?? 1, result });
          pendingTotal++; room -= waiting; outcome.deferred++;
        } else overflow++;
        return;
      }
      if (!changed.has(fp)) room -= cost;
      if (isNewRow && rows >= HEALTH_LIMITS.issueRows) {
        const victim = evictable.find(v => !changed.has(v) && !removeIssues.has(v));
        if (!victim) { overflow++; if (deferredSeq !== null) pendingRemove.push(deferredSeq); return; }
        removeIssues.add(victim);
        rows--;
      }
      if (isNewRow) rows++;
      ledger = out.ledger;
      changed.set(fp, out.record!);
      if (deferredSeq !== null) pendingRemove.push(deferredSeq);
      const issue = out.record!.issue;
      if (out.intent) intents.push({ id: intentId(fp, issue.episode, out.intent.delivery, out.intent.reason), fingerprint: fp, episode: issue.episode, delivery: out.intent.delivery, reason: out.intent.reason, titleKey: issue.titleKey, createdAt: now });
      else if (out.transition === "opened") intents.push({ id: intentId(fp, issue.episode, "digest", "opened"), fingerprint: fp, episode: issue.episode, delivery: "digest", reason: "opened", titleKey: issue.titleKey, createdAt: now });
      else if (out.transition === "resolved") intents.push({ id: intentId(fp, issue.episode, "digest", "recovered"), fingerprint: fp, episode: issue.episode, delivery: "digest", reason: "recovered", titleKey: issue.titleKey, createdAt: now });
    };

    for (const pending of pendingRows) {
      if (pending.detectorVersion !== DETECTOR_VERSIONS[pending.detectorId]) { pendingRemove.push(pending.seq); continue; }
      apply(pending.result, pending.seq);
    }
    for (const run of runs) for (const result of run.results) apply(result, null);

    // Resolved issues past retention, a bounded number per scan.
    for (const fp of store.expiredResolved(now, HEALTH_LIMITS.changedIssuesPerScan)) if (!changed.has(fp)) removeIssues.add(fp);

    const overall = worst(Object.values(sourceCoverage));
    outcome.coverage = overall;
    const meta: Record<string, unknown> = {};
    if (backup.changed || json(backup.cache) !== json(backupCache)) meta.backup_cache = backup.cache;
    if (stats.changed || json(stats.cache) !== json(statsCache)) meta.dbstats_cache = stats.cache;
    if (json(scanFailures) !== json(storedFailures)) meta.scan_failures = scanFailures;
    if (json(ledger) !== json(store.pageLedger())) meta.page_ledger = ledger;
    const heartbeatAt = store.meta<number>("heartbeat_at");
    const heartbeatDue = heartbeatAt === null || now - heartbeatAt >= HEALTH_LIMITS.heartbeatMinIntervalMs || now < heartbeatAt;

    const anything = changed.size > 0 || removeIssues.size > 0 || intents.length > 0 || pendingAdd.length > 0 || pendingRemove.length > 0
      || progressed || Object.keys(cursorChanges).length > 0 || Object.keys(meta).length > 0 || overflow > 0
      || overall !== store.meta<Coverage>("last_coverage");
    if (!anything && !heartbeatDue) {
      outcome.revision = store.revision();
      return done("no-op");
    }

    // ----- committing -----
    outcome.phase = "committing";
    const stop = budget.stopReason;
    const selfNext: SelfHealth = {
      lastScanAt: now, lastCommitAt: now, lastCompleteAt: overall === "complete" ? now : self.lastCompleteAt, lastStop: stop,
      budgetStops: self.budgetStops + (stop ? 1 : 0), overflow: overflow > 0 ? { count: self.overflow.count + overflow, lastAt: now } : self.overflow,
    };
    meta.self_health = selfNext;
    meta.clock = { wallAt: now, monoAt: mono } satisfies ClockMark;
    meta.last_coverage = overall;
    meta.source_complete_at = completeAt;
    if (heartbeatDue) meta.heartbeat_at = now;
    const changes: StoreChanges = {
      meta, cursors: cursorChanges, detectorStates, issues: [...changed.values()], removeIssues: [...removeIssues], intents,
      pendingAdd, pendingRemove, pruneIntentsBefore: now - INTENT_RETENTION_MS,
    };
    // Per-commit cap on everything but the detector states (issue rows were admitted against the remaining room above;
    // the states have their own allowance). Only metadata past its allowance could exceed it: then nothing commits, the
    // same records replay next scan, and the stop is visible.
    const cost = SentinelStore.estimateCharge(changes);
    const capped = SentinelStore.estimateCharge({ ...changes, detectorStates: {} });
    if (capped > HEALTH_LIMITS.commitBytes) return done("budget-exhausted", "commit-cap");
    // The daily ledger also pays for the view this scan publishes, by the size of the view it replaces.
    const viewCharge = Math.min(HEALTH_LIMITS.viewBytes, Math.max(VIEW_CHARGE_MIN_BYTES, published ? json(published).length + 1 : 0));
    if (!canCharge(bucket, cost + viewCharge, now)) return done("budget-exhausted", "write-budget");
    bucket = charge(bucket, cost + viewCharge, now);
    meta.write_bucket = bucket;
    options.hooks?.beforeCommit?.();
    outcome.revision = store.commit(changes);
    outcome.chargedBytes = cost;
    outcome.changedIssues = changed.size;
    options.hooks?.afterCommit?.();
    if (fileFailures.length) { try { rmSync(pathFor(platform).join(d.outputRoot, FAILURES_FILE), { force: true }); } catch { /* next scan merges again */ } }

    // ----- published -----
    publishView(d.outputRoot, viewFromStore(store, now, "running", overall, now, selfNext.lastCompleteAt), platform);
    outcome.phase = "published";
    return done("published");
  } finally {
    store?.close();
    lease.release();
  }
}
