// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backup status manifest producer (1.0.9, GAP-SENTINEL-109 sections 4.1, 4.2 and 6.4).
//
// DATA_DIR/health/backup-status.json is a projection of the backup coordinator's COMMITTED state: it is built only from
// what backup-coordinator.ts has already written durably (its onCommitted hook fires after the save), so it never runs
// ahead of a receipt. The desktop host calls the same boundary after its own commits (publishBackupStatus).
//
// Due-time rule: `dueAt` is the earliest scheduled obligation that has no matching verification. It stays fixed until a
// verification at or after it commits, or until the policy ends (backups turned off or a new policy revision); it is
// never rolled forward to a later time. The previous projection is read back and reconciled on restart. When the
// earliest obligation cannot be reconstructed it is unknown (null, coverage partial), never invented.
//
// The human line, once per changed outcome: `backup outcome result=verified|failed|waiting|off code=<enum> at=<ISO>`.
// It carries no filename, folder, destination or key reference.
import { createHash } from "node:crypto";
import {
  HEALTH_FILES, HEALTH_SCHEMA_VERSION, HEALTH_TOKEN_PATTERN, parseBackupStatus,
  type BackupFailureCode, type BackupPhase, type BackupResult, type BackupStatus, type CoverageValue,
} from "../../shared/health-protocol.mjs";
import type { BackupCommittedState } from "../backup-coordinator.ts";
import { latestBackupOccurrence } from "../../shared/backup-schedule.ts";
import { recordCounter } from "./counters.ts";
import type { HealthPublisher } from "./publisher.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type JobPhase = NonNullable<BackupCommittedState["job"]>["phase"];
type JobError = NonNullable<NonNullable<BackupCommittedState["job"]>["error"]>;

/** Phases whose receipt has committed: the job's obligation is met. */
const VERIFIED_PHASES = new Set<JobPhase>(["local-verified", "return-pending", "returned", "install-requested", "upgrade-complete"]);
const WAITING_PHASES = new Set<JobPhase>(["due", "waiting-idle", "waiting-backup-mode"]);
const CAPTURE_PHASES = new Set<JobPhase>(["claiming", "capturing", "handoff-prepared", "handoff-armed", "offline-claimed"]);

/** Coordinator job errors in the contract's closed failure codes. */
export const FAILURE_CODE_BY_JOB_ERROR: Readonly<Record<JobError, BackupFailureCode>> = Object.freeze({
  "interrupted": "capture-failed",
  "capture-unconfirmed": "capture-failed",
  "receipt-mismatch": "verification-failed",
  "cancelled": "other",
  "duration-exceeded": "deadline-passed",
  "catchup-expired": "deadline-passed",
  "idle-release-unconfirmed": "other",
  "references-unavailable": "destination-unavailable",
});

export interface BackupOutcome { result: BackupResult; code: BackupResult | BackupFailureCode }

/** The outcome the committed state shows, in the line's closed vocabulary. */
export function backupOutcome(state: BackupCommittedState): BackupOutcome {
  const job = state.job;
  if (job && VERIFIED_PHASES.has(job.phase)) return { result: "verified", code: "verified" };
  if (job?.phase === "needs-review") return { result: "failed", code: job.error ? FAILURE_CODE_BY_JOB_ERROR[job.error] : "other" };
  if (job?.phase === "skipped" && job.error === "catchup-expired") return { result: "failed", code: "deadline-passed" };
  if (job && (WAITING_PHASES.has(job.phase) || CAPTURE_PHASES.has(job.phase))) return { result: "waiting", code: "waiting" };
  return state.schedule.enabled ? { result: "waiting", code: "waiting" } : { result: "off", code: "off" };
}

export function backupOutcomeLine(outcome: BackupOutcome, at: number): string {
  return `backup outcome result=${outcome.result} code=${outcome.code} at=${new Date(at).toISOString()}`;
}

function phaseOf(state: BackupCommittedState): BackupPhase {
  if (!state.schedule.enabled && !state.job) return "off";
  const phase = state.job?.phase;
  if (!phase || VERIFIED_PHASES.has(phase) || phase === "upgrade-cancelled") return state.schedule.enabled ? "idle" : "off";
  if (phase === "waiting-backup-mode") return "waiting-owner";
  if (WAITING_PHASES.has(phase)) return "due";
  if (CAPTURE_PHASES.has(phase)) return "capturing";
  if (phase === "needs-review") return "failed";
  if (phase === "skipped") return state.job?.error === "catchup-expired" ? "failed" : state.schedule.enabled ? "idle" : "off";
  return "other";
}

/** The next daily time strictly after `now` in the schedule's own time zone, or null. Bounded: at most 60 minute steps
 *  to align the minute, then at most 48 hour steps (DST gaps skip a day). */
export function nextDailyOccurrence(schedule: BackupCommittedState["schedule"], now: number): number | null {
  if (!schedule.enabled || !schedule.timezone || !schedule.time) return null;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { return null; }
  const local = (at: number) => { const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value])); return `${parts.hour}:${parts.minute}`; };
  const target = schedule.time;
  let at = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  for (let step = 0; step < 60 && local(at).slice(3) !== target.slice(3); step++) at += MINUTE;
  for (let step = 0; step < 48; step++, at += HOUR) if (local(at) === target) return at;
  return null;
}

export interface BackupStatusInput {
  installationId: string;
  now: number;
  state: BackupCommittedState;
  /** The host's current folder/key binding check (electron/backup-schedule-host.mjs). null when not known here. */
  bindingMatches?: boolean | null;
  /** The previously published projection, for the due-time rule and the revision counter. */
  prior?: BackupStatus | null;
  /** A deterministic opaque token for a receipt's snapshot (default: sha256 of installation id and snapshot id). */
  snapshotToken?: (snapshotId: string) => string;
  /** The time limit the host chose for this handoff. It is never in the committed state (shared/backup-budget.mjs). */
  captureBudget?: BackupCaptureBudget | null;
}

export interface BackupCaptureBudget { handoffId: string; budgetMs: number }

/** Builds the manifest from committed coordinator state. Pure. */
export function projectBackupStatus(input: BackupStatusInput): BackupStatus {
  const { state, now, installationId } = input;
  const prior = input.prior && input.prior.installationId === installationId ? input.prior : null;
  const schedule = state.schedule;
  const job = state.job;
  const captureLimitMs = job?.handoff && input.captureBudget?.handoffId === job.handoff.id ? input.captureBudget.budgetMs : schedule.maxDurationMs;
  const receipt = state.lastVerified;
  const verifiedAt = receipt?.verifiedAt ?? null;
  const satisfied = (at: number) => verifiedAt !== null && verifiedAt >= at;
  const phase = phaseOf(state);
  let coverage: CoverageValue = "complete";
  let dueAt: number | null = null;
  if (schedule.enabled) {
    const candidates: number[] = [];
    // The previous projection's obligation stands while the same policy holds and nothing verified it.
    if (prior && prior.enabled && prior.policyRevision === state.revision && prior.dueAt !== null && !satisfied(prior.dueAt)) candidates.push(prior.dueAt);
    // A job not yet verified (including a daily one skipped past its catch-up window) is an obligation.
    if (job && job.revision === state.revision && !VERIFIED_PHASES.has(job.phase) && job.phase !== "upgrade-cancelled" && !(job.phase === "skipped" && job.error === "cancelled") && !satisfied(job.scheduledAt)) candidates.push(job.scheduledAt);
    // The coordinator's watermark is the last daily time it opened a job for.
    if (state.watermark >= state.configuredAt && state.watermark > 0 && !satisfied(state.watermark)) candidates.push(state.watermark);
    const latest = latestBackupOccurrence(schedule, now);
    if (latest && latest.at >= state.configuredAt && !satisfied(latest.at)) candidates.push(latest.at);
    dueAt = candidates.length ? Math.min(...candidates) : null;
    // Without a prior projection, a policy configured more than a day ago with no verification since and no
    // reconstructable occurrence leaves the earliest obligation unknown.
    if (dueAt === null && !prior && verifiedAt === null && now - state.configuredAt > 24 * HOUR) coverage = "partial";
  }
  const bindingKnown = input.bindingMatches === true || input.bindingMatches === false;
  const receiptBound = Boolean(receipt && receipt.installationRef === schedule.installationRef && receipt.destinationRef === schedule.destinationRef);
  // A receipt whose stored references match is current protection only when the live folder/key check says so. Without
  // that check (absent, or it threw) the binding is unknown: published as null with partial coverage, never as a match.
  const currentBindingMatches: boolean | null = !receiptBound ? false : bindingKnown ? input.bindingMatches === true : null;
  if (schedule.enabled && currentBindingMatches === null && coverage === "complete") coverage = "partial";
  const token = input.snapshotToken ?? ((id: string) => createHash("sha256").update(installationId).update("\0").update(id).digest("hex").slice(0, 32));
  const status: BackupStatus = {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    installationId,
    revision: (prior?.revision ?? 0) + 1,
    at: now,
    enabled: schedule.enabled,
    configuredAt: state.configuredAt > 0 ? state.configuredAt : schedule.enabled ? now : null,
    policyRevision: state.revision,
    dueAt,
    nextDueAt: nextDailyOccurrence(schedule, now),
    phase,
    currentBindingMatches,
    lastVerified: receipt ? { verifiedAt: receipt.verifiedAt, snapshotToken: token(receipt.snapshotId), bytes: receipt.bytes, verification: "artifact-reread" } : null,
    coverage,
  };
  const outcome = backupOutcome(state);
  if (outcome.result === "failed") {
    status.failureCode = outcome.code as BackupFailureCode;
    status.failureAt = prior?.failureCode === status.failureCode && prior.failureAt !== undefined ? prior.failureAt : now;
  }
  if (job?.attemptAt !== undefined) status.lastAttemptAt = job.attemptAt;
  if (job && CAPTURE_PHASES.has(job.phase) && job.attemptAt !== undefined && captureLimitMs) status.captureDeadlineAt = job.attemptAt + captureLimitMs;
  if (job?.phase === "waiting-backup-mode") status.pendingOwnerSince = prior?.pendingOwnerSince ?? job.scheduledAt;
  return status;
}

export interface BackupStatusProducerOptions {
  publisher: HealthPublisher;
  installationId: string;
  now?: () => number;
  bindingMatches?: () => boolean | null;
  /** Where the human outcome line goes (server.log through observeLine, or the desktop log). */
  log?: (line: string) => void;
}

/** Publishes backup-status.json after each durable coordinator commit. Wire `onCommitted` into BackupCoordinator's
 *  options (server) or call it from the desktop host's publishBackupStatus hook with coordinator state. Never throws. */
export function createBackupStatusProducer(options: BackupStatusProducerOptions) {
  if (!HEALTH_TOKEN_PATTERN.test(options.installationId)) throw new Error("HEALTH_INSTALLATION_ID_INVALID");
  const now = options.now ?? Date.now;
  let prior: BackupStatus | null | undefined;
  let lastOutcome: string | null = null;
  // Kept for its handoff and never cleared: a publish still queued after the capture ends reads the same limit.
  let captureBudget: BackupCaptureBudget | null = null;
  const readPrior = () => {
    if (prior !== undefined) return prior;
    const parsed = parseBackupStatus(options.publisher.readManifest(HEALTH_FILES.backupStatus));
    prior = parsed.ok && parsed.value.installationId === options.installationId ? parsed.value : null;
    return prior;
  };
  return {
    noteCaptureBudget(budget: BackupCaptureBudget) {
      if (typeof budget?.handoffId === "string" && Number.isSafeInteger(budget.budgetMs) && budget.budgetMs > 0) captureBudget = { handoffId: budget.handoffId, budgetMs: budget.budgetMs };
    },
    onCommitted(state: BackupCommittedState): BackupStatus | null {
      try {
        const at = now();
        let binding: boolean | null = null;
        try { binding = options.bindingMatches?.() ?? null; } catch { binding = null; }
        const status = projectBackupStatus({ installationId: options.installationId, now: at, state, bindingMatches: binding, prior: readPrior(), captureBudget });
        const checked = parseBackupStatus(status);
        if (!checked.ok) return null;
        const outcome = backupOutcome(state);
        const key = `${outcome.result}:${outcome.code}:${state.revision}`;
        if (key !== lastOutcome) {
          lastOutcome = key;
          recordCounter("backup", outcome.result, "none");
          if (outcome.result === "failed") recordCounter("backup", outcome.code, "none");
          try { options.log?.(backupOutcomeLine(outcome, at)); } catch { /* a log line never changes the backup */ }
        }
        if (!options.publisher.replaceManifest(HEALTH_FILES.backupStatus, JSON.stringify(checked.value))) return null;
        prior = checked.value;
        return checked.value;
      } catch { return null; }
    },
  };
}
