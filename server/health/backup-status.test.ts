// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_FILES, parseBackupStatus, type BackupStatus } from "../../shared/health-protocol.mjs";
import { backupScheduleSchema } from "../../shared/backup-schedule.ts";
import { BackupCoordinator, type BackupCommittedState } from "../backup-coordinator.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { backupOutcome, backupOutcomeLine, createBackupStatusProducer, nextDailyOccurrence, projectBackupStatus } from "./backup-status.ts";
import { HealthPublisher } from "./publisher.ts";

const INSTALL = "d".repeat(32);
const T = (iso: string) => Date.parse(iso);
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const schedule = (extra: Record<string, unknown> = {}) => backupScheduleSchema.parse({
  enabled: true, installationRef: "homefolderref", destinationRef: "usbdriveref", recoveryRef: "keyfileref", timezone: "UTC", time: "09:00", catchupMs: 6 * 3_600_000,
  maxBytes: 100_000_000, maxDurationMs: 60_000, selection, ...extra,
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receipt = (verifiedAt: number, jobId = "a".repeat(64)) => ({ jobId, installationRef: "homefolderref", destinationRef: "usbdriveref", selectionHash: hash(selection), snapshotId: randomUUID(), artifactRef: "artifactrefxyz", sha256: "b".repeat(64), bytes: 1234, verifiedAt });
function state(extra: Partial<BackupCommittedState> = {}): BackupCommittedState {
  return { version: 1, revision: 3, configuredAt: T("2026-10-20T00:00:00Z"), schedule: schedule(), seen: [], watermark: 0, ...extra } as BackupCommittedState;
}
const job = (phase: NonNullable<BackupCommittedState["job"]>["phase"], scheduledAt: number, extra: Record<string, unknown> = {}) =>
  ({ id: "c".repeat(64), occurrence: "3:daily:2026-10-27", revision: 3, scheduledAt, phase, ...extra }) as NonNullable<BackupCommittedState["job"]>;
const project = (input: Partial<Parameters<typeof projectBackupStatus>[0]>) => {
  const status = projectBackupStatus({ installationId: INSTALL, now: T("2026-10-27T12:00:00Z"), state: state(), ...input });
  const parsed = parseBackupStatus(status);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  return status;
};

describe("current binding", () => {
  const due = T("2026-10-27T09:00:00Z");
  const verifiedState = state({ watermark: due, job: job("local-verified", due), lastVerified: receipt(due + 30_000) });
  it("a receipt with matching references is current only when the live check says so; without the check it is unknown", () => {
    expect(project({ state: verifiedState, bindingMatches: true })).toMatchObject({ currentBindingMatches: true, coverage: "complete" });
    expect(project({ state: verifiedState, bindingMatches: false })).toMatchObject({ currentBindingMatches: false, coverage: "complete" });
    for (const unknown of [null, undefined]) {
      expect(project({ state: verifiedState, ...(unknown === null ? { bindingMatches: null } : {}) })).toMatchObject({ currentBindingMatches: null, coverage: "partial" });
    }
    expect(project({ state: state({ ...verifiedState, lastVerified: { ...receipt(due), destinationRef: "otherdriveref" } }), bindingMatches: true }).currentBindingMatches).toBe(false);
  });

  it("a binding check that throws publishes unknown, never a match", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-backup-binding-"));
    try {
      const publisher = new HealthPublisher({ dataDir: dir });
      publisher.initialize();
      const producer = createBackupStatusProducer({ publisher, installationId: INSTALL, now: () => due + 60_000, bindingMatches: () => { throw new Error("folder unreadable"); } });
      expect(producer.onCommitted(verifiedState)).toMatchObject({ currentBindingMatches: null, coverage: "partial" });
    } finally { removeTempDirSync(dir); }
  });
});

describe("due-time rule", () => {
  it("an unverified daily obligation is due at its scheduled time; the next one is the following 09:00", () => {
    const status = project({ state: state({ watermark: T("2026-10-27T09:00:00Z"), job: job("waiting-idle", T("2026-10-27T09:00:00Z")) }) });
    expect(status).toMatchObject({ enabled: true, phase: "due", dueAt: T("2026-10-27T09:00:00Z"), nextDueAt: T("2026-10-28T09:00:00Z"), coverage: "complete", lastVerified: null });
  });

  it("is never rolled forward: an earlier unverified obligation from the previous projection stands over a later one", () => {
    const prior = project({ now: T("2026-10-26T12:00:00Z"), state: state({ watermark: T("2026-10-26T09:00:00Z"), job: job("waiting-backup-mode", T("2026-10-26T09:00:00Z")) }) });
    // A day later the coordinator has moved to a new daily job; the 26th was never verified.
    const later = project({ prior, state: state({ watermark: T("2026-10-27T09:00:00Z"), job: job("due", T("2026-10-27T09:00:00Z")) }) });
    expect(later.dueAt).toBe(T("2026-10-26T09:00:00Z"));
    expect(later.revision).toBe(prior.revision + 1);
  });

  it("a verification at or after the obligation meets it; one a millisecond before does not", () => {
    const due = T("2026-10-27T09:00:00Z");
    const base = { watermark: due, job: job("local-verified", due) };
    expect(project({ state: state({ ...base, lastVerified: receipt(due) }) }).dueAt).toBeNull();
    expect(project({ state: state({ ...base, job: job("needs-review", due, { error: "capture-unconfirmed" }), lastVerified: receipt(due - 1) }) }).dueAt).toBe(due);
  });

  it("turning backups off ends the obligation; a new policy revision does not inherit the old one", () => {
    const prior = project({ state: state({ watermark: T("2026-10-27T09:00:00Z") }) });
    expect(project({ prior, state: state({ schedule: schedule({ enabled: false }), watermark: T("2026-10-27T09:00:00Z") }) })).toMatchObject({ enabled: false, phase: "off", dueAt: null, nextDueAt: null });
    const reconfigured = project({ prior, state: state({ revision: 4, configuredAt: T("2026-10-27T11:00:00Z"), watermark: T("2026-10-27T09:00:00Z") }) });
    expect(reconfigured.dueAt).toBeNull();
  });

  it("a daily run skipped past its catch-up window is a failed, still-due obligation", () => {
    const due = T("2026-10-26T09:00:00Z");
    const status = project({ state: state({ watermark: due, job: job("skipped", due, { error: "catchup-expired" }) }) });
    expect(status).toMatchObject({ phase: "failed", failureCode: "deadline-passed", dueAt: due });
  });

  it("when the earliest obligation cannot be reconstructed it is unknown, never invented", () => {
    const status = project({ now: T("2026-10-27T20:00:00Z"), state: state() });
    expect(status).toMatchObject({ dueAt: null, coverage: "partial" });
  });

  it("names the next daily time in the schedule's own time zone", () => {
    expect(nextDailyOccurrence(schedule({ timezone: "Asia/Kolkata" }), T("2026-10-27T03:29:00Z"))).toBe(T("2026-10-27T03:30:00Z"));
    expect(nextDailyOccurrence(schedule({ timezone: "Asia/Kolkata" }), T("2026-10-27T03:30:00Z"))).toBe(T("2026-10-28T03:30:00Z"));
    expect(nextDailyOccurrence(schedule({ enabled: false }), T("2026-10-27T03:30:00Z"))).toBeNull();
  });
});

describe("outcomes", () => {
  it("maps committed coordinator states to the closed outcome vocabulary", () => {
    const due = T("2026-10-27T09:00:00Z");
    expect(backupOutcome(state({ job: job("local-verified", due) }))).toEqual({ result: "verified", code: "verified" });
    expect(backupOutcome(state({ job: job("return-pending", due) }))).toEqual({ result: "verified", code: "verified" });
    expect(backupOutcome(state({ job: job("needs-review", due, { error: "receipt-mismatch" }) }))).toEqual({ result: "failed", code: "verification-failed" });
    expect(backupOutcome(state({ job: job("needs-review", due, { error: "references-unavailable" }) }))).toEqual({ result: "failed", code: "destination-unavailable" });
    expect(backupOutcome(state({ job: job("capturing", due) }))).toEqual({ result: "waiting", code: "waiting" });
    expect(backupOutcome(state({ schedule: schedule({ enabled: false }) }))).toEqual({ result: "off", code: "off" });
  });

  it("the human line carries only the result, a code and the time", () => {
    expect(backupOutcomeLine({ result: "failed", code: "deadline-passed" }, T("2026-10-27T09:00:00Z"))).toBe("backup outcome result=failed code=deadline-passed at=2026-10-27T09:00:00.000Z");
  });

  it("the snapshot token is opaque and stable; the receipt's own ids never appear", () => {
    const r = receipt(T("2026-10-27T09:30:00Z"));
    const status = project({ state: state({ lastVerified: r }) });
    expect(status.lastVerified).toMatchObject({ verifiedAt: r.verifiedAt, bytes: 1234, verification: "artifact-reread" });
    expect(status.lastVerified!.snapshotToken).toMatch(/^[0-9a-f]{32}$/);
    expect(project({ state: state({ lastVerified: r }) }).lastVerified!.snapshotToken).toBe(status.lastVerified!.snapshotToken);
    const text = JSON.stringify(status);
    for (const secret of [r.snapshotId, r.jobId, r.sha256, "homefolderref", "usbdriveref", "artifactrefxyz"]) expect(text).not.toContain(secret);
  });
});

describe("published after the durable commit", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

  it("a real coordinator run publishes each committed phase, the verification only once its receipt is on disk, and one line per outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-health-backup-"));
    dirs.push(root);
    const control = join(root, "control");
    let now = T("2026-10-27T08:00:00Z");
    const publisher = new HealthPublisher({ dataDir: root, now: () => now });
    publisher.initialize();
    const lines: string[] = [];
    const seen: { phase: string; committed: boolean; published: BackupStatus | null }[] = [];
    const producer = createBackupStatusProducer({ publisher, installationId: INSTALL, now: () => now, log: line => lines.push(line), bindingMatches: () => true });
    const coordinator: BackupCoordinator = new BackupCoordinator({
      stateDirectory: control, now: () => now,
      onCommitted: committed => {
        const onDisk = JSON.parse(readFileSync(join(control, "backup-coordinator.json"), "utf8"));
        const published = producer.onCommitted(committed);
        seen.push({ phase: committed.job?.phase ?? "none", committed: JSON.stringify(onDisk) === JSON.stringify(committed), published });
      },
      claimIdle: async () => ({ state: "claimed", release: async () => {} }),
      captureOffline: async request => {
        const status = parseBackupStatus(publisher.readManifest(HEALTH_FILES.backupStatus));
        expect(status.ok && status.value).toMatchObject({ phase: "capturing", lastVerified: null, dueAt: T("2026-10-27T09:00:00Z") });
        now += 1_000;
        return { jobId: request.jobId, installationRef: request.installationRef, destinationRef: request.destinationRef, selectionHash: request.selectionHash, snapshotId: randomUUID(), artifactRef: "artifactrefxyz", sha256: "e".repeat(64), bytes: 4321, verifiedAt: now };
      },
    });
    coordinator.configure(0, schedule());
    now = T("2026-10-27T09:00:30Z");
    const ended = await coordinator.tick();
    expect(ended.phase).toBe("local-verified");
    expect(seen.every(entry => entry.committed)).toBe(true);
    expect(seen.map(entry => entry.phase)).toEqual(["none", "due", "claiming", "capturing", "local-verified"]);
    const final = parseBackupStatus(JSON.parse(readFileSync(join(root, "health", HEALTH_FILES.backupStatus), "utf8")));
    expect(final.ok && final.value).toMatchObject({ phase: "idle", dueAt: null, currentBindingMatches: true, lastVerified: { verifiedAt: T("2026-10-27T09:00:31Z"), bytes: 4321 } });
    expect(lines).toEqual([
      "backup outcome result=waiting code=waiting at=2026-10-27T08:00:00.000Z",
      "backup outcome result=verified code=verified at=2026-10-27T09:00:31.000Z",
    ]);
    for (const line of lines) expect(line).not.toMatch(/[\\/]|homefolderref|usbdriveref|artifactrefxyz/);
  });

  it("an observer that throws never changes the backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-health-backup-"));
    dirs.push(root);
    const coordinator = new BackupCoordinator({ stateDirectory: join(root, "control"), now: () => T("2026-10-27T08:00:00Z"), onCommitted: () => { throw new Error("observer"); } });
    expect(coordinator.configure(0, schedule()).enabled).toBe(true);
    expect(coordinator.status().revision).toBe(1);
  });

  it("a deferred root publishes nothing and the coordinator still commits", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-health-backup-"));
    dirs.push(root);
    const publisher = new HealthPublisher({ dataDir: root, deferWhileCaptureActive: () => true });
    publisher.initialize();
    const producer = createBackupStatusProducer({ publisher, installationId: INSTALL });
    const coordinator = new BackupCoordinator({ stateDirectory: join(root, "control"), onCommitted: committed => { producer.onCommitted(committed); } });
    expect(coordinator.configure(0, schedule()).enabled).toBe(true);
    expect(publisher.readManifest(HEALTH_FILES.backupStatus)).toBeNull();
  });
});

describe("startup republish of the committed state", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
  it("before any backup: says off, or on and when one is due, and never a verification", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "murage-backup-status-start-"));
    dirs.push(stateDirectory);
    let now = T("2026-10-27T08:00:00Z");
    const coordinator = new BackupCoordinator({ stateDirectory, now: () => now });
    const fresh = coordinator.committedState();
    expect(fresh.lastVerified).toBeUndefined();
    const off = project({ state: fresh, now });
    expect(off).toMatchObject({ enabled: false, lastVerified: null });
    coordinator.configure(0, { ...schedule(), enabled: true });
    now = T("2026-10-27T12:00:00Z");
    const configured = coordinator.committedState();
    const on = project({ state: configured, now });
    expect(on).toMatchObject({ enabled: true, lastVerified: null });
    expect(on.phase).not.toBe("verified");
  });
});
