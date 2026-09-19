// Settings → Backups: its own section, out of General, and every pointer to
// backup settings names the new place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "@/state/store";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const modal = read("./SettingsModal.tsx");

function generalPane(source: string) {
  const start = source.indexOf('{section === "general" && (');
  expect(start, "General pane not found").toBeGreaterThan(0);
  // The General block closes at its first top-level `)}`.
  const end = source.indexOf("\n            )}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Backups settings section", () => {
  it("is its own desktop-only section placed right after General", () => {
    const general = modal.indexOf('{ id: "general"');
    const backups = modal.indexOf('{ id: "backups"');
    expect(backups, "no backups section").toBeGreaterThan(general);
    const between = modal.slice(general, backups);
    expect(between.match(/\{ id: "/g)).toHaveLength(1);
    const entry = modal.slice(backups, modal.indexOf("\n", backups));
    expect(entry).toContain('label: "Backups"');
    expect(entry).toContain("desktopOnly: true");
    expect(entry).toContain("icon: Archive");
    for (const keyword of ["backup", "restore", "recovery", "schedule", "s3", "off-site", "remote", "restic", "age", "key"]) expect(entry).toContain(`"${keyword}"`);
  });

  it("General no longer renders backups, and the Backups pane is surface-gated", () => {
    expect(generalPane(modal)).not.toContain("BackupSettings");
    expect(modal).toContain('desktop === true && section === "backups" && <BackupSettings />');
  });

  it("deep link: opening settings on Backups selects the Backups pane", () => {
    const next = reducer(initialState, { type: "toggleAppSettings", open: true, section: "backups" });
    expect(next.appSettingsOpen).toBe(true);
    expect(next.appSettingsSection).toBe("backups");
  });

  it("update guidance points at Settings → Backups, not General's old Backup settings", () => {
    for (const source of [modal, read("./UpdateBanner.tsx")]) {
      expect(source).toContain("Review Settings → Backups if it needs attention.");
      expect(source).not.toContain("Review Backup settings");
    }
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { backupSummary, closedJobNotice, formatBackupSize, recoveryKeyError, recoveryKeyResult, runNowError, setUpClosedJob, timeZoneChoices, type BackupSummaryInput } from "./backups-section-ui";
import { BackupStatusCard, ScheduleCard, ScheduleSetup, type ScheduleController } from "./BackupSettings";
import { schedulePhase } from "./backup-schedule-ui";
import type { RemoteController } from "./BackupRemoteSettings";

const refs = { installationRef: "fixture_install", destinationRef: "fixture_dest", recoveryRef: "fixture_key", destinationLabel: "Fixture backups", recoveryLabel: "Recovery.age" };
const enabledSchedule = { enabled: true, preUpgrade: false, time: "22:15", timezone: "Asia/Bangkok", catchupMs: 7200000, maxBytes: 1073741824, maxDurationMs: 600000, ...refs, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const } };
const healthy: BackupSummaryInput = {
  scheduleBridge: true, scheduleStale: false, scheduleFailure: null, closed: { supported: true, state: "installed", closedApp: false }, closedStale: false,
  schedule: { supported: true, pending: false, enabled: true, revision: 3, phase: "idle", schedule: enabledSchedule, refs, lastVerified: { jobId: "a".repeat(64), installationRef: "i", destinationRef: "d", selectionHash: "b".repeat(64), snapshotId: "00000000-0000-4000-8000-000000000000", artifactRef: "x", sha256: "c".repeat(64), bytes: 1234567890, verifiedAt: 1700000000000 } },
  remoteBridge: true, remoteStale: false, remoteFailure: null,
  remote: { supported: true, pending: false, configured: true, state: "connected", revision: 2, remoteRef: "remote-one", lastUpload: { state: "verified", jobId: "a".repeat(64) }, automaticUpload: { enabled: true, state: "enabled" } },
};

describe("backup summary", () => {
  it("formats sizes for people, not bytes", () => {
    expect(formatBackupSize(999)).toBe("999 bytes");
    expect(formatBackupSize(2048)).toBe("2 KB");
    expect(formatBackupSize(1_000_000)).toBe("1 MB");
    expect(formatBackupSize(1234567890)).toBe("1.2 GB");
    expect(formatBackupSize(15_000_000_000)).toBe("15 GB");
  });
  it("summarises a healthy setup in one line each with no attention", () => {
    const summary = backupSummary(healthy, () => "WHEN");
    expect(summary).toEqual({ last: "WHEN · 1.2 GB", schedule: "On · daily at 22:15 (Asia/Bangkok)", offsite: "Connected · last copy verified · automatic uploads on", attention: [] });
    expect(backupSummary({ ...healthy, schedule: { ...healthy.schedule!, schedule: { ...enabledSchedule, closedApp: true } } }).schedule).toContain("also while Murage is closed");
  });
  it("raises an attention line for every stale, pending, review and error state", () => {
    const s = healthy.schedule!, r = healthy.remote!;
    const cases: [Partial<BackupSummaryInput>, RegExp][] = [
      [{ scheduleStale: true }, /Schedule status couldn't be refreshed/],
      [{ scheduleFailure: "Settings changed." }, /Settings changed/],
      [{ schedule: { ...s, error: "BACKUP_REVIEW_REQUIRED PRIVATE" } }, /Automatic retry is paused/],
      [{ schedule: { ...s, pending: true } }, /backup is running/],
      [{ schedule: { ...s, phase: "needs-review" } }, /didn't finish; backups are paused until you clear it/],
      [{ schedule: { ...s, schedule: { ...enabledSchedule, preUpgrade: true } } }, /Pre-upgrade backups are unavailable/],
      [{ schedule: { ...s, lastClosedResult: { status: "needs-review", at: 1, revision: 1 } } }, /closed needs review/],
      [{ closedStale: true }, /Background job status couldn't be refreshed/],
      [{ closed: { supported: true, state: "disabled-removal-pending", closedApp: false } }, /Removing the background job/],
      [{ schedule: { ...s, schedule: { ...enabledSchedule, closedApp: true } }, closed: { supported: true, state: "staged", closedApp: true } }, /isn't set up yet/],
      [{ remoteStale: true }, /Off-site status needs a refresh/],
      [{ remoteFailure: "The saved destination changed." }, /destination changed/],
      [{ remote: { ...r, pending: true } }, /Off-site work is in progress/],
      [{ remote: { ...r, state: "needs-review" } }, /off-site copy needs review/],
      [{ remote: { ...r, lastUpload: { state: "needs-review", jobId: "a".repeat(64) } } }, /last off-site upload needs review/],
      [{ remote: { ...r, lastUpload: { state: "verified", jobId: "a".repeat(64), lockRelease: "unconfirmed" } } }, /lock was released/],
      [{ remote: { ...r, automaticUpload: { enabled: true, state: "needs-review" } } }, /paused for review/],
      [{ remote: { ...r, retention: { state: "pruning" } } }, /Cleaning up old off-site copies/],
      [{ schedule: { ...s, phase: "skipped" } }, /^Backup skipped\. Murage was busy/],
    ];
    for (const [patch, pattern] of cases) {
      const attention = backupSummary({ ...healthy, ...patch }).attention;
      expect(attention.join(" "), JSON.stringify(patch)).toMatch(pattern);
      expect(attention.join(" ")).not.toContain("PRIVATE");
    }
  });
  it("says a closed-app backup could not start without a desktop session, until a newer backup lands", () => {
    const s = healthy.schedule!, verifiedAt = s.lastVerified!.verifiedAt;
    const noDesktop = (at: number) => backupSummary({ ...healthy, schedule: { ...s, lastClosedResult: { status: "unavailable", reason: "capability-unavailable", at, revision: 1 } } }).attention.join(" ");
    expect(noDesktop(verifiedAt + 1)).toMatch(/couldn't start because you weren't signed in to your desktop/);
    expect(noDesktop(verifiedAt)).not.toMatch(/signed in to your desktop/);
    expect(backupSummary({ ...healthy, schedule: { ...s, lastClosedResult: { status: "needs-review", reason: "capture-unconfirmed", at: verifiedAt + 1, revision: 1 } } }).attention.join(" ")).toMatch(/closed needs review/);
  });
  it("says why a backup stopped, in plain words, and never prints a path", () => {
    const s = healthy.schedule!;
    const failed = (captureFailure: { stage: string; code: string }) =>
      backupSummary({ ...healthy, schedule: { ...s, phase: "needs-review", reviewReason: "capture-unconfirmed", captureFailure } }).attention.join(" ");
    const unknownFile = failed({ stage: "capture", code: "BACKUP_UNCLASSIFIED_COMPONENT" });
    expect(unknownFile).toMatch(/didn't finish/);
    expect(unknownFile).toMatch(/stopped while copying your workspace/);
    expect(unknownFile).toMatch(/doesn't recognise/);
    expect(failed({ stage: "references", code: "BACKUP_REFERENCE_CHANGED" })).toMatch(/stopped while checking your backup folder and recovery key/);
    expect(failed({ stage: "artifact-readback", code: "BACKUP_RECEIPT_MISMATCH" })).toMatch(/couldn't confirm the backup file/);
    // An unrecognised code still gets a sentence, never a raw code or a path.
    const strange = failed({ stage: "nowhere", code: "SOMETHING_ELSE" } as { stage: string; code: string });
    expect(strange).toMatch(/Murage couldn't say why/);
    for (const text of [unknownFile, strange]) {
      expect(text).not.toMatch(/[A-Z]{4,}_[A-Z_]+/);
      expect(text).not.toMatch(/[/\\]/);
    }
    // No failure recorded: the page says no more than it knows.
    expect(backupSummary({ ...healthy, schedule: { ...s, phase: "needs-review" } }).attention.join(" ")).not.toMatch(/stopped while/);
  });
  it("never claims availability without a bridge", () => {
    const summary = backupSummary({ ...healthy, scheduleBridge: false, schedule: null, remoteBridge: false, remote: null });
    expect(summary.schedule).toBe("Not available in this window");
    expect(summary.offsite).toBe("Not available in this window");
    expect(summary.last).toBe("Not available in this window");
  });
});

describe("closed-app job setup from one checkbox", () => {
  const bridge = (install: () => Promise<BackupClosedStatus & { cancelled?: boolean }> = async () => ({ supported: true, state: "installed", closedApp: false })) => {
    const calls: string[] = [];
    return { calls, stage: vi.fn(async (): Promise<BackupClosedStatus> => { calls.push("stage"); return { supported: true, state: "staged", closedApp: false }; }), install: vi.fn(async () => { calls.push("install"); return install(); }) };
  };
  it("prepares then registers, in that order, applying each result", async () => {
    const b = bridge(), applied: string[] = [];
    expect(await setUpClosedJob(b, "unconfigured", next => applied.push(next.state))).toMatchObject({ action: "install", next: { state: "installed" } });
    expect(b.calls).toEqual(["stage", "install"]); expect(applied).toEqual(["staged", "installed"]);
  });
  it("skips steps already done and stops when preparing did not succeed", async () => {
    for (const [state, calls] of [["staged", ["install"]], ["disabled", ["install"]], ["installed", []]] as const) {
      const b = bridge(); await setUpClosedJob(b, state, () => {}); expect(b.calls).toEqual(calls);
    }
    const b = bridge(); b.stage.mockResolvedValueOnce({ supported: true, state: "unavailable", closedApp: false });
    expect(await setUpClosedJob(b, "unconfigured", () => {})).toMatchObject({ action: "stage" }); expect(b.install).not.toHaveBeenCalled();
  });
  it("reports cancel and propagates errors after the prepared step was applied", async () => {
    expect((await setUpClosedJob(bridge(async () => ({ supported: true, state: "staged", closedApp: false, cancelled: true })), "staged", () => {}))?.next.cancelled).toBe(true);
    const applied: string[] = [];
    await expect(setUpClosedJob(bridge(async () => { throw Error("PRIVATE"); }), "unconfigured", next => applied.push(next.state))).rejects.toThrow();
    expect(applied).toEqual(["staged"]);
  });
  it("keeps the existing prepare/register/remove notices", () => {
    expect(closedJobNotice("stage", { supported: true, state: "staged", closedApp: false })).toBe("Job prepared. It is not registered; scheduling settings are unchanged.");
    expect(closedJobNotice("install", { supported: true, state: "staged", closedApp: false, cancelled: true })).toBe("Job registration cancelled. Scheduling settings are unchanged.");
    expect(closedJobNotice("install", { supported: true, state: "installed", closedApp: false })).toBe("Job registration confirmed. Scheduling settings are unchanged.");
    expect(closedJobNotice("install", { supported: true, state: "staged", closedApp: false })).toContain("Registration is not confirmed");
    expect(closedJobNotice("disable", { supported: true, state: "disabled-removal-pending", closedApp: false })).toContain("Job removal is pending");
  });
});

describe("optional recovery-key and back-up-now bridges", () => {
  it("projects a created key to its label and public key only", () => {
    const publicKey = "age1" + "q".repeat(58);
    expect(recoveryKeyResult({ cancelled: true, label: "x" })).toEqual({ cancelled: true });
    expect(recoveryKeyResult({ saved: true, label: "Murage recovery.age", publicKey, secretKey: "AGE-SECRET-KEY-CANARY" })).toEqual({ saved: true, label: "Murage recovery.age", publicKey });
    expect(JSON.stringify(recoveryKeyResult({ saved: true, label: "k", publicKey: "AGE-SECRET-KEY-1CANARY" }))).not.toContain("CANARY");
    for (const value of [null, {}, { saved: true }, { saved: true, label: "" }, { saved: true, label: "bad\nlabel" }, { saved: "true", label: "k" }]) expect(() => recoveryKeyResult(value)).toThrow();
  });
  it("names the three back-up-now cases and stays generic otherwise", () => {
    expect(runNowError(Error("BACKUP_WORK_ACTIVE"))).toBe("Finish or stop current work first.");
    expect(runNowError(Error("BACKUP_BUSY"))).toBe("A backup is already running.");
    expect(runNowError(Error("BACKUP_SCHEDULE_CONSENT_REQUIRED"))).toBe("Turn on daily backups once to allow Murage to close and reopen the window for a backup.");
    // A daily run refused for the same reason shows it too, not a generic line.
    const blocked = "Murage can't restart itself on this computer, so backups that reopen Murage can't run. Reinstalling Murage usually fixes this.";
    expect(runNowError(Error("Error invoking remote method 'backup-schedule:run-now': Error: BACKUP_RELAUNCH_BLOCKED"))).toBe(blocked);
    expect(backupSummary({ ...healthy, schedule: { ...healthy.schedule!, error: "BACKUP_RELAUNCH_BLOCKED" } }).attention).toContain(blocked);
    expect(runNowError(Error("BACKUP_REFERENCE_CHANGED"))).toContain("destination or recovery key changed");
    expect(runNowError(Error("BACKUP_REVIEW_REQUIRED"))).toContain("Automatic retry is paused");
    expect(runNowError(Error("BACKUP_UNAVAILABLE"))).toContain("unavailable in this app");
    expect(runNowError(Error("BACKUP_SCHEDULE_CHANGED"))).toContain("Settings changed");
    expect(runNowError(Error("PRIVATE_CANARY fixture-path"))).toBe("Backup settings could not be updated. Your data is preserved. Refresh status before trying again.");
  });
  it("names each recovery-key failure and stays generic for unknown codes", () => {
    const cases: [string, string][] = [["BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "outside the Murage data folder"], ["BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "outside your backup folder"], ["BACKUP_RECOVERY_KEY_EXISTS", "Choose a new name"], ["BACKUP_RECOVERY_KEY_LOCATION_INVALID", "Choose another folder"], ["BACKUP_RECOVERY_KEY_WRITE_FAILED", "nothing was saved"], ["BACKUP_RECOVERY_KEY_UNVERIFIED", "nothing was saved"], ["BACKUP_BINDINGS_UNAVAILABLE", "Refresh status"], ["BACKUP_BUSY", "backup is running"], ["BACKUP_UNAVAILABLE", "supported desktop app"]];
    for (const [code, text] of cases) expect(recoveryKeyError(Error(`IPC ${code} PRIVATE_PATH`)), code).toContain(text);
    for (const code of ["INVALID_BACKUP_REQUEST", "PRIVATE_CANARY"]) { const message = recoveryKeyError(Error(code)); expect(message).toBe("The recovery key could not be created. Nothing was changed. Try again."); }
  });
  it("offers the system time zone and UTC in a sorted list", () => {
    const zones = timeZoneChoices();
    expect(zones).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone); expect(zones).toContain("UTC");
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });
});

function controller(patch: Partial<ScheduleController> & { status: BackupScheduleStatus }): ScheduleController {
  const noop = () => {};
  return { bridge: { status: noop, selectReferences: noop, configure: noop }, closedBridge: undefined, draft: { time: "22:15", timezone: "Asia/Bangkok", catchup: "2", size: "1", duration: "10", preUpgrade: false, closedApp: false },
    consent: false, setConsent: noop, busy: false, stale: false, error: null, notice: null, area: "schedule", closed: null, closedStale: false, closedAction: null, createdKey: null, confirmRun: false, setConfirmRun: noop,
    unavailable: false, locked: false, editingLocked: false, closedRegistered: false, closedAllowed: false, choices: null, lastClosed: null, edit: noop, closedOperation: noop, setClosedApp: noop, selectReferences: noop, createRecoveryKey: undefined,
    enable: noop, disable: noop, canRunNow: false, runNow: noop, refreshNow: noop, ...patch } as unknown as ScheduleController;
}
const off: BackupScheduleStatus = { supported: true, pending: false, enabled: false, revision: 1, phase: "idle", schedule: { enabled: false, preUpgrade: false }, refs };
const on: BackupScheduleStatus = { ...off, enabled: true, schedule: enabledSchedule };

describe("setup collapses into a schedule card", () => {
  it("while off: numbered steps, mandatory idle-restart consent and a disabled turn-on without choices", () => {
    const html = renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ status: off, closedBridge: {} as ScheduleController["closedBridge"] }), onSetLimits: () => {} }));
    for (const text of ["Set up backups", "1. Where to save", "2. Recovery key", "3. When", "Choose backup folder and recovery key", "Also back up", "Murage may close and reopen this window when it&#x27;s idle to take the backup.", "nobody, including you"]) expect(html).toContain(text);
    expect(html).toMatch(/disabled=""[^>]*>Turn on daily backups</);
    expect(html).not.toContain(">Turn off<");
    expect(html).not.toContain("Create my recovery key");
  });
  it("offers Create a recovery key only when the desktop app provides it, and shows no secret", () => {
    const html = renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ status: off, createRecoveryKey: () => {}, createdKey: { label: "Murage recovery.age", publicKey: "age1" + "q".repeat(58) } }), onSetLimits: () => {} }));
    expect(html).toContain(">Create my recovery key<"); expect(html).toContain("Recovery key saved as Murage recovery.age");
    expect(html).toContain("password manager or a USB drive"); expect(html).toContain("<details>"); expect(html).not.toContain("AGE-SECRET-KEY");
  });
  it("while on: settings summary and Turn off, no setup controls", () => {
    const html = renderToStaticMarkup(createElement(ScheduleCard, { s: controller({ status: on }) }));
    expect(html).toContain(">Turn off<"); expect(html).toContain("Daily at 22:15 (Asia/Bangkok)"); expect(html).toContain("Turn off daily backups before changing");
    expect(html).not.toContain("Turn on daily backups"); expect(html).not.toContain("Choose backup folder");
  });
});

describe("Your backups card", () => {
  const remote = { stale: false, busy: null, refreshNow: () => {} } as unknown as RemoteController;
  const summary = { last: "L", schedule: "S", offsite: "O", attention: ["A backup is running. Settings are locked until it finishes."] };
  it("shows Back up now only when the desktop app provides it, with the attention list", () => {
    const without = renderToStaticMarkup(createElement(BackupStatusCard, { summary, s: controller({ status: on }), r: remote, onRestore: () => {} }));
    expect(without).not.toContain("Back up now"); expect(without).toContain(">Restore…<"); expect(without).toMatch(/role="status"[^>]*>.*Needs attention.*A backup is running/);
    const withRun = renderToStaticMarkup(createElement(BackupStatusCard, { summary, s: controller({ status: on, bridge: { runNow: () => {} } as unknown as ScheduleController["bridge"], canRunNow: true }), r: remote, onRestore: () => {} }));
    expect(withRun).toMatch(/<button[^>]*>Back up now</); expect(withRun).not.toMatch(/disabled=""[^>]*>Back up now</);
    const confirm = renderToStaticMarkup(createElement(BackupStatusCard, { summary, s: controller({ status: on, bridge: { runNow: () => {} } as unknown as ScheduleController["bridge"], canRunNow: true, confirmRun: true }), r: remote, onRestore: () => {} }));
    expect(confirm).toContain("Murage will close and reopen this window to take the backup."); expect(confirm).toContain(">Continue<");
    const locked = renderToStaticMarkup(createElement(BackupStatusCard, { summary, s: controller({ status: on, bridge: { runNow: () => {} } as unknown as ScheduleController["bridge"], canRunNow: false }), r: remote, onRestore: () => {} }));
    expect(locked).toMatch(/disabled=""[^>]*>Back up now</);
  });
});

describe("customer findings: plain words and reasons where the control is", () => {
  const closedBridge = {} as ScheduleController["closedBridge"];
  // As React writes it into markup: the apostrophe is escaped.
  const REASON = "Your system didn&#x27;t let Murage register a background job, so backups run only while Murage is open.";
  const setup = (patch: Partial<Omit<ScheduleController, "status">>) => renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ ...patch, status: off, closedBridge: patch.closedBridge ?? closedBridge }), onSetLimits: () => {} }));
  const checkboxTag = (html: string) => /<input type="checkbox"[^>]*aria-describedby="[^"]*backup-closed-help[^"]*"[^>]*>/.exec(html)?.[0] ?? "";

  it("says under the closed-app checkbox why it is greyed out when the system refused the job", () => {
    const html = setup({ closed: { supported: true, state: "unavailable", closedApp: false } });
    expect(html).toContain(REASON);
    // Tied to the checkbox, so a screen reader hears it with the control.
    expect(checkboxTag(html)).toContain("backup-closed-reason");
    expect(checkboxTag(html)).toContain('disabled=""');
    expect(html.indexOf(REASON)).toBeLessThan(html.indexOf("Backup limits"));
  });

  it("names the data folder when that, not the system, is why the job can't be set up", () => {
    const html = setup({ closed: { supported: true, state: "unavailable", closedApp: false, blocked: "data-folder-shared" } });
    expect(html).toContain("Other accounts on this computer can change Murage&#x27;s data folder, so backups run only while Murage is open.");
    expect(html).not.toContain(REASON);
    expect(checkboxTag(html)).toContain("backup-closed-reason");
  });

  it("says it after a failed setup attempt even while the job can be retried", () => {
    const html = setup({ closed: { supported: true, state: "staged", closedApp: false }, closedAllowed: true, closedSetupFailed: true });
    expect(html).toContain(REASON);
    expect(checkboxTag(html)).not.toContain('disabled=""');
  });

  it("stays quiet when nothing went wrong, or when another line already explains it", () => {
    for (const patch of [
      { closed: { supported: true, state: "unconfigured", closedApp: false } },
      { closed: { supported: true, state: "installed", closedApp: false }, closedRegistered: true },
      { closed: { supported: false, state: "unavailable", closedApp: false } },
      { closed: { supported: true, state: "unavailable", closedApp: false }, closedStale: true },
    ] as Partial<Omit<ScheduleController, "status">>[]) {
      const html = setup(patch);
      expect(html, JSON.stringify(patch)).not.toContain(REASON);
      expect(checkboxTag(html)).not.toContain("backup-closed-reason");
    }
  });

  it("drops the leftover jargon from the Backups copy", () => {
    const summary = { last: "L", schedule: "S", offsite: "O", attention: [] };
    const remote = { stale: false, busy: null, refreshNow: () => {} } as unknown as RemoteController;
    const lastVerified = healthy.schedule!.lastVerified;
    const card = renderToStaticMarkup(createElement(BackupStatusCard, { summary, s: controller({ status: { ...on, lastVerified } }), r: remote, onRestore: () => {} }));
    expect(card).not.toContain("restore-drill");
    expect(card).toContain("The last backup was checked on this computer.");
    expect(schedulePhase("returned")).not.toContain("Backup mode returned");
    expect(schedulePhase("returned")).toBe("The last backup finished and Murage reopened");
  });

  it("an expected refusal from the desktop app reads as its own message", () => {
    for (const [code, text] of [["BACKUP_RECOVERY_KEY_EXISTS", "Choose a new name"], ["BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "outside your backup folder"]] as const) {
      let caught: unknown;
      try { recoveryKeyResult({ refused: code }); } catch (error) { caught = error; }
      expect(caught, code).toBeInstanceOf(Error);
      expect(recoveryKeyError(caught), code).toContain(text);
    }
    // Only a code-shaped refusal is honoured; anything else is a malformed answer.
    expect(() => recoveryKeyResult({ refused: "PRIVATE path /home/someone" })).toThrow("Invalid recovery key result");
  });
});
