// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-01: "Name the file in every message." A refusal about one
// item in the data folder carries that item from the stage, through the
// desktop's diagnostic and the durable failure note, into the sentence the
// Backups page and the Inbox show. What a verified backup left out is kept
// beside it and listed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { captureFailureSentence } from "../shared/backup-capture-failure.mjs";
import { captureFailureDiagnostic } from "../electron/backup-schedule-host.mjs";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";

it("a refusal about one item names it, all the way to the sentence", () => {
  const directory = mkdtempSync(join(tmpdir(), "murage-failure-naming-"));
  try {
    const coordinator = new BackupCoordinator({ stateDirectory: directory, acquire: () => ({ release() {} }) });
    const refusal = Object.assign(new Error("INVALID_INSTALLATION_RECORDS"), { code: "INVALID_INSTALLATION_RECORDS", path: "routines.json" });
    coordinator.recordCaptureFailure(captureFailureDiagnostic("capture", refusal));
    // The note is only read back while a job needs review; read the file.
    const note = JSON.parse(readFileSync(join(directory, "backup-capture-failure.json"), "utf8"));
    expect(note).toMatchObject({ stage: "capture", code: "INVALID_INSTALLATION_RECORDS", path: "routines.json" });
    const sentence = captureFailureSentence(note);
    expect(sentence).toContain("The item is routines.json in Murage's data folder.");
    expect(sentence).not.toContain("couldn't say why");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("a path outside the data folder is never kept or shown", () => {
  for (const path of ["/Users/sam/.ssh/id_rsa", "C:\\Users\\sam\\x", "../../etc/passwd", "~/x", "a\nb"]) {
    const diagnostic = captureFailureDiagnostic("capture", Object.assign(new Error("UNSAFE_SNAPSHOT_ENTRY"), { path }));
    expect(diagnostic).not.toHaveProperty("path");
    expect(captureFailureSentence({ stage: "capture", code: "UNSAFE_SNAPSHOT_ENTRY", path })).not.toContain("The item is");
  }
});

it("the stage's own refusal carries the item as a relative path", () => {
  const error = new InstallationSnapshotError("SNAPSHOT_LIMIT_EXCEEDED", { path: "workspaces\\mira\\video.mov" });
  expect(error.path).toBe("workspaces/mira/video.mov");
});

it("what a verified backup left out is kept for that backup only", () => {
  const directory = mkdtempSync(join(tmpdir(), "murage-failure-naming-"));
  try {
    const coordinator = new BackupCoordinator({ stateDirectory: directory, acquire: () => ({ release() {} }) });
    const job = "a".repeat(64);
    coordinator.recordSkipped(job, { count: 1, items: [{ path: "workspaces/mira/site/node_modules", reason: "rebuildable" }], bots: { mira: "Mira" } });
    const state = JSON.parse(readFileSync(join(directory, "backup-last-skipped.json"), "utf8"));
    expect(state).toEqual({ jobId: job, count: 1, items: [{ path: "workspaces/mira/site/node_modules", reason: "rebuildable" }], bots: { mira: "Mira" } });
    // Nothing left out: the old note goes.
    coordinator.recordSkipped(job, undefined);
    expect(() => readFileSync(join(directory, "backup-last-skipped.json"))).toThrow();
    // A malformed list is not kept.
    coordinator.recordSkipped(job, { count: 1, items: [{ path: "workspaces/mira/x", reason: "because" }], bots: {} });
    expect(() => readFileSync(join(directory, "backup-last-skipped.json"))).toThrow();
    writeFileSync(join(directory, "unrelated"), "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
