// 1.0.13 BACKUP-BUDGET-A (designs/BACKUP-BUDGET-A-1013.md): the clocks below the desktop host follow one budget.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { createBackupStatusProducer, projectBackupStatus } from "./health/backup-status.ts";
import { encodeRequest } from "../native/backup-age/protocol.mjs";
import { MAX_BACKUP_DURATION_MS } from "../shared/backup-budget.mjs";
import { canonicalUpdateDescriptor, type UpdateCandidate } from "../shared/update-candidate.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

const MIN = 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); vi.useRealTimers(); });
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" };
const choices = { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "UTC", time: "09:00", catchupMs: 3600000, maxBytes: 1000, maxDurationMs: 30 * MIN, selection, preUpgrade: true };
function candidate(): UpdateCandidate {
  const sha512 = Buffer.alloc(64, 1).toString("base64");
  const base = { schemaVersion: 1, candidateId: "update-" + "0".repeat(64), version: "9.0.0", platform: "darwin", arch: "arm64", artifacts: [{ kind: "primary", sha512 }], manifestDigests: [sha512] } as UpdateCandidate;
  return { ...base, candidateId: "update-" + createHash("sha256").update(canonicalUpdateDescriptor(base)).digest("hex") };
}

it("a pre-upgrade backup that ran 40 minutes still passes every install check", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "murage-budget-a-")); roots.push(stateDirectory);
  let now = Date.parse("2026-09-13T01:00:00Z");
  const c = new BackupCoordinator({ stateDirectory, now: () => now }); c.configure(0, choices);
  const update = candidate(), intent = { version: 1 as const, id: randomUUID(), bindingRevision: "b".repeat(64), installationIdentity: "c".repeat(64), expiresAt: now + 30 * MIN };
  const job = c.prepareUpgrade(update, intent).job!;
  c.armHandoff(intent.id); c.claimHandoff(intent.id, intent.bindingRevision, intent.installationIdentity); c.beginHandoffCapture(intent.id);
  now += 40 * MIN; expect(now).toBeGreaterThan(intent.expiresAt);
  c.completeHandoff(intent.id, { jobId: job.id, installationRef: "installation-one", destinationRef: "destination-one", selectionHash: createHash("sha256").update(JSON.stringify(selection)).digest("hex"), snapshotId: randomUUID(), artifactRef: job.id, sha256: "a".repeat(64), bytes: 10, verifiedAt: now, candidateId: update.candidateId });
  expect(c.validateUpgrade(intent.id, update, intent.bindingRevision, intent.installationIdentity).phase).toBe("return-pending");
  c.requestUpgradeInstall(intent.id, update, intent.bindingRevision, intent.installationIdentity);
  expect(c.completeUpgrade(intent.id, update.version, update, intent.bindingRevision, intent.installationIdentity).phase).toBe("upgrade-complete");
});

it("the worker command refuses more than 4 hours and the Windows helper takes exactly that", async () => {
  const args = (ms: number) => ["backup-encrypted", "--data-dir", "/nowhere", "--output", "/nowhere/a.age", "--age-tool", "/nowhere/age", "--recipient", "age1x", "--credential-policy", "preserve-in-encrypted-fidelity", "--max-bytes", "1000", "--max-duration-ms", String(ms)];
  await expect(installationRecoveryCommand(args(MAX_BACKUP_DURATION_MS + 1), { readIdentity: async () => "x" })).rejects.toThrow("INVALID_BACKUP_BUDGET");
  const request = { nonce: "12345678-1234-4234-8234-123456789abc", operation: "private-stage", parentPid: 1, parentDirectory: "C:\\work", maxBytes: 1, closeTimeoutMs: 1000 };
  expect(() => encodeRequest({ ...request, timeoutMs: MAX_BACKUP_DURATION_MS })).not.toThrow();
  expect(() => encodeRequest({ ...request, timeoutMs: MAX_BACKUP_DURATION_MS + 1 })).toThrow();
  expect(readFileSync(new URL("../native/backup-age/transport.cpp", import.meta.url), "utf8")).toContain(`number(fields[8], ${MAX_BACKUP_DURATION_MS})`);
});

const capturing = (handoffId: string) => ({ version: 1, revision: 1, configuredAt: 1, schedule: { ...choices }, seen: [], watermark: 0, job: { id: "a".repeat(64), occurrence: "1:manual:x", revision: 1, scheduledAt: 1, phase: "capturing", attemptAt: 1000, handoff: { version: 1, id: handoffId, bindingRevision: "b".repeat(64), installationIdentity: "c".repeat(64), expiresAt: 2 } } }) as never;

it("Sentinel's deadline follows the budget for its own handoff only", () => {
  const input = { installationId: "a".repeat(32), now: 2000, state: capturing("one") };
  expect(projectBackupStatus({ ...input, captureBudget: { handoffId: "one", budgetMs: 79 * MIN } }).captureDeadlineAt).toBe(1000 + 79 * MIN);
  expect(projectBackupStatus({ ...input, captureBudget: { handoffId: "two", budgetMs: 79 * MIN } }).captureDeadlineAt).toBe(1000 + 30 * MIN);
  expect(projectBackupStatus(input).captureDeadlineAt).toBe(1000 + 30 * MIN);
});

it("the producer holds the budget across commits", () => {
  const written: string[] = [];
  const producer = createBackupStatusProducer({ installationId: "a".repeat(32), now: () => 2000, publisher: { readManifest: () => null, replaceManifest: (_name: string, text: string) => { written.push(text); return true; } } as never });
  producer.noteCaptureBudget({ handoffId: "one", budgetMs: 79 * MIN });
  producer.onCommitted(capturing("one")); producer.onCommitted(capturing("one"));
  expect(written.map(text => JSON.parse(text).captureDeadlineAt)).toEqual([1000 + 79 * MIN, 1000 + 79 * MIN]);
});
