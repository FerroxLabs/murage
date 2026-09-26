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
import { SETUP_FIRST_BACKUP_RUNNING, SETUP_NO_FIRST_BACKUP, backupSummary, closedJobNotice, completeBackupSetup, formatBackupSize, recoveryKeyError, recoveryKeyResult, runNowError, setUpClosedJob, timeZoneChoices, type BackupSummaryInput } from "./backups-section-ui";
import { BackupStatusCard, ScheduleCard, ScheduleSetup, type ScheduleController } from "./BackupSettings";
import { scheduleError, schedulePhase } from "./backup-schedule-ui";
import { remoteBackupStatus, type RemoteController } from "./BackupRemoteSettings";

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
  // Mac customer re-test 2: the first launch after an install or update said
  // "Needs a supported desktop app" while Murage was still checking its tool.
  it("says it is getting ready, not that the app is unsupported, while the backup tool is checked", () => {
    const checking = backupSummary({ ...healthy, schedule: { ...healthy.schedule!, supported: false, checking: true }, remote: { supported: false, pending: false, configured: false, state: "unavailable", checking: true } }, () => "WHEN");
    expect(checking.schedule).toBe("Getting ready…");
    expect(checking.offsite).toBe("Getting ready…");
    const final = backupSummary({ ...healthy, schedule: { ...healthy.schedule!, supported: false }, remote: { supported: false, pending: false, configured: false, state: "unavailable" } }, () => "WHEN");
    expect(final.schedule).toBe("Needs a supported desktop app");
    expect(final.offsite).toBe("Not available in this app");
  });
  it("keeps asking for status while the tool is checked, and reads the checking flag", () => {
    const settings = read("./BackupSettings.tsx"), remote = read("./BackupRemoteSettings.tsx");
    expect(settings).toContain("!(status&&!status.supported&&status.checking)");
    expect(settings).toMatch(/if\(!value\.supported\)timer=window\.setTimeout\(read,3000\)/);
    expect(remote).toContain("if(!status||status.supported||!status.checking||!bridge)return;");
    expect(remoteBackupStatus({ supported: false, pending: false, configured: false, state: "unavailable", checking: true })).toMatchObject({ checking: true });
    expect(remoteBackupStatus({ supported: false, pending: false, configured: false, state: "unavailable" }).checking).toBeUndefined();
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
      [{ schedule: { ...s, error: "BACKUP_REVIEW_REQUIRED PRIVATE" } }, /daily backups are paused/],
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
  it("prints a schedule refusal once on the page, not in the summary and the card", () => {
    const source = read("./BackupSettings.tsx");
    // The card's own line is decided by the shared helper, and it is handed
    // the very list the "Needs attention" block renders above it.
    expect(source).toContain("scheduleCardNotice(local,status?.error,attention)");
    expect(source).not.toContain("{local??scheduleError(status?.error)}");
    expect(source).toContain("<ScheduleCard s={s} attention={summary.attention}/>");
    expect(source).toContain("<ScheduleSetup s={s} attention={summary.attention}");
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
    // The old line read as an instruction to let Murage close, and the
    // owner quit it mid-recovery. See the dedicated describe block below.
    expect(runNowError(Error("BACKUP_SCHEDULE_CONSENT_REQUIRED"))).toBe("Backups aren't switched on yet. Turn them on first: Murage takes a backup by closing and reopening its own window, and Murage does that itself, so you never need to quit it.");
    // A daily run refused for the same reason shows it too, not a generic line.
    const blocked = "Murage can't restart itself on this computer, so backups that reopen Murage can't run. Reinstalling Murage usually fixes this.";
    expect(runNowError(Error("Error invoking remote method 'backup-schedule:run-now': Error: BACKUP_RELAUNCH_BLOCKED"))).toBe(blocked);
    expect(backupSummary({ ...healthy, schedule: { ...healthy.schedule!, error: "BACKUP_RELAUNCH_BLOCKED" } }).attention).toContain(blocked);
    // 0.1.60 Linux D9: said before setup, and in AppImage terms when the
    // AppImage file itself is gone. Never "Reinstalling" for an AppImage.
    const off = { ...healthy.schedule!, enabled: false, lastVerified: undefined, error: null };
    const moved = backupSummary({ ...healthy, schedule: { ...off, relaunchBlocked: "BACKUP_RELAUNCH_APPIMAGE_MISSING" } }).attention;
    expect(moved).toContain("Murage can't reopen itself because its AppImage file was moved or deleted while Murage was open, so backups can't run. Close Murage, then open it again from the AppImage file.");
    expect(moved.join(" ")).not.toContain("Reinstalling");
    expect(backupSummary({ ...healthy, schedule: { ...off, relaunchBlocked: "BACKUP_RELAUNCH_BLOCKED" } }).attention).toContain(blocked);
    // not said twice when the status error is the same refusal
    expect(backupSummary({ ...healthy, schedule: { ...off, error: "BACKUP_RELAUNCH_BLOCKED", relaunchBlocked: "BACKUP_RELAUNCH_BLOCKED" } }).attention.filter(line => line === blocked)).toHaveLength(1);
    expect(runNowError(Error("BACKUP_REFERENCE_CHANGED"))).toContain("backup folder or recovery key has moved or changed");
    expect(runNowError(Error("BACKUP_REVIEW_REQUIRED"))).toContain("daily backups are paused");
    expect(runNowError(Error("BACKUP_UNAVAILABLE"))).toContain("aren't available in this copy");
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
    unavailable: false, locked: false, editingLocked: false, closedRegistered: false, closedAllowed: false, choices: null, lastClosed: null, edit: noop, closedOperation: noop, setClosedApp: noop, selectReferences: noop, setUp: noop, saveKeyCopy: noop, keyCopy: null,
    enable: noop, disable: noop, canRunNow: false, runNow: noop, refreshNow: noop, ...patch } as unknown as ScheduleController;
}
const off: BackupScheduleStatus = { supported: true, pending: false, enabled: false, revision: 1, phase: "idle", schedule: { enabled: false, preUpgrade: false }, refs };
const on: BackupScheduleStatus = { ...off, enabled: true, schedule: enabledSchedule };

describe("setup collapses into a schedule card", () => {
  // The folder and the key are chosen in one act, so the old
  // "1. Where to save" / "2. Recovery key" / "3. When" ladder is two steps,
  // and the two competing buttons are gone.
  it("with a folder and key already chosen: the remaining settings, the permission and a disabled turn-on", () => {
    const html = renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ status: off, closedBridge: {} as ScheduleController["closedBridge"] }), onSetLimits: () => {} }));
    for (const text of ["Set up backups", "1. Where your backups go", "2. When", "Also back up", "close and reopen its own window", "nobody, including you"]) expect(html).toContain(text);
    expect(html).toMatch(/disabled=""[^>]*>Turn on daily backups</);
    expect(html).not.toContain(">Turn off<");
    expect(html).not.toContain("Create my recovery key");
    expect(html).not.toContain(">Choose backup folder and recovery key<");
  });
  it("falls back to the old two-step selection on a desktop app with no one-act setup", () => {
    const html = renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ status: { ...off, refs: undefined } as BackupScheduleStatus, setUp: undefined }), onSetLimits: () => {} }));
    expect(html).toMatch(/<button[^>]*>Choose backup folder and recovery key</);
    expect(html).not.toContain("Turn on backups");
  });
  // Setup takes the first backup at once and the window reopens, so the key
  // note from setup is gone. The copy must still be offered (found on the
  // packaged 0.1.60 app, 2026-09-26: no way to save a copy after setup).
  it("while on, after the window reopened: still offers a copy of the recovery key", () => {
    const html = renderToStaticMarkup(createElement(ScheduleCard, { s: controller({ status: on, createdKey: null }) }));
    expect(html).toContain(`Your recovery key is ${refs.recoveryLabel}.`);
    expect(html).toMatch(/<button[^>]*>Save a copy…</);
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

  // The app or the data folder on another volume: a background job can't
  // read it (electron/backup-closed-volume.mjs), so say what to move where.
  it.each([["volume-app", "need Murage in your Applications folder on this Mac&#x27;s own disk. Move Murage there"], ["volume-data", "need Murage&#x27;s data folder on this Mac&#x27;s own disk, not on another drive"], ["volume-both", "Move both there"]] as const)("says what to move when %s blocks backups while Murage is closed", (blocked, text) => {
    const html = setup({ closed: { supported: true, state: "unavailable", closedApp: false, blocked } });
    expect(html).toContain(text);
    expect(html).not.toContain(REASON);
    expect(checkboxTag(html)).toContain('disabled=""');
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

// The owner read "Turn on daily backups once to allow Murage to close and
// reopen the window for a backup." — shown in red under "Needs attention" — as
// an instruction, and quit Murage during a live data recovery. Copy on this
// page must still say plainly that Murage may close and reopen its window, and
// must also say that Murage does that itself, so it can never be read as an
// instruction to quit.
describe("the backup restart is a permission, never an instruction to quit", () => {
  const SAYS_MURAGE_DOES_IT = /Murage does (this|that) itself|you never need to quit|never quit Murage/i;
  it("the Back up now consent refusal explains the permission without nudging a quit", () => {
    const message = runNowError(Error("BACKUP_SCHEDULE_CONSENT_REQUIRED"));
    expect(message).toMatch(/clos(e|ing) and reopen(ing)?/i);
    expect(message).toMatch(SAYS_MURAGE_DOES_IT);
    expect(message).not.toBe("Turn on daily backups once to allow Murage to close and reopen the window for a backup.");
  });
  it("the schedule's consent refusals say the same thing in plain words, not jargon", () => {
    for (const code of ["BACKUP_SCHEDULE_CONSENT_REQUIRED", "BACKUP_CLOSED_CONSENT_REQUIRED"]) {
      const message = scheduleError(Error(code));
      expect(message, code).not.toMatch(/idle-restart|idle restart consent/i);
      expect(message, code).toMatch(SAYS_MURAGE_DOES_IT);
    }
  });
});

// Setting up backups was two buttons offering overlapping things
// ("Create my recovery key" and "Choose backup folder and recovery key"), four
// native dialogs, and an instruction to go and select the file the app had just
// written. It took the owner three attempts and he still had no backup.
describe("setup is one button", () => {
  const fresh: BackupScheduleStatus = { ...off, refs: undefined };
  const render = (patch: Partial<ScheduleController> = {}) =>
    renderToStaticMarkup(createElement(ScheduleSetup, { s: controller({ ...patch, status: (patch.status ?? fresh) as BackupScheduleStatus }), onSetLimits: () => {} }));
  it("offers exactly one way to start, and never two overlapping ones", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*>Turn on backups</);
    expect(html).not.toContain(">Create my recovery key<");
    expect(html).not.toContain(">Choose backup folder and recovery key<");
    // No jargon on the ordinary road.
    for (const word of ["age key", "recipient", "identity header"]) expect(html.toLowerCase(), word).not.toContain(word);
  });
  it("keeps the existing-key path, off the default road", () => {
    const html = render();
    expect(html).toContain("already have");
    expect(html).toMatch(/<button[^>]*>Use a key I already have</);
  });
  it("after setup, keeping a copy of the key is one action with the reason next to it", () => {
    const html = render({ status: { ...off }, createdKey: { label: "murage-recovery-key.txt", publicKey: "age1" + "q".repeat(58), folder: "Documents" } });
    expect(html).toContain("murage-recovery-key.txt");
    expect(html).toContain("Documents");
    expect(html).toMatch(/<button[^>]*>Save a copy…</);
    expect(html).toContain("nobody, including you");
    // Never the secret, and never the old "go and select it again" homework.
    expect(html).not.toContain("AGE-SECRET");
    expect(html).not.toContain("the key picker opens in that folder");
  });
});

describe("a schedule with no backup behind it says so, and says what to do", () => {
  it("names the gap the owner's screenshot showed", () => {
    const summary = backupSummary({ ...healthy, schedule: { ...healthy.schedule!, enabled: true, lastVerified: undefined } });
    expect(summary.attention).toContain("Daily backups are on, but no backup has been taken yet. Use Back up now to take the first one.");
  });
  it("and stays quiet once one has been verified", () => {
    expect(backupSummary(healthy).attention).not.toContain("Daily backups are on, but no backup has been taken yet. Use Back up now to take the first one.");
  });
});

// Setup has to END with a backup. The owner walked the old flow to its
// end and the page still said "No verified backup on this computer yet" — a
// schedule with nothing behind it reads as success and protects nobody. He
// lost two weeks of live business work the same day.
describe("setup ends with a verified backup, not a to-do", () => {
  const verified = { jobId: "a".repeat(64), installationRef: "i", destinationRef: "d", selectionHash: "b".repeat(64), snapshotId: "00000000-0000-4000-8000-000000000000", artifactRef: "x", sha256: "c".repeat(64), bytes: 1234567890, verifiedAt: 1700000000000 };
  /** Behaves as the desktop host does: setUp binds the folder and the key it
   * wrote, configure turns the schedule on, runNow hands off to the backup
   * restart, and the status the page reads afterwards carries the receipt. */
  function hostBridge({ firstBackup = true, capture = true }: { firstBackup?: boolean; capture?: boolean } = {}) {
    const calls: string[] = [];
    let status: BackupScheduleStatus = { supported: true, pending: false, enabled: false, revision: 1, phase: "idle", schedule: { enabled: false, preUpgrade: false } };
    const bridge = {
      status: async () => status,
      setUp: async () => { calls.push("setUp"); status = { ...status, refs }; return { ...status, created: { label: "murage-recovery-key.txt", publicKey: "age1" + "q".repeat(58), folder: "Documents" } }; },
      configure: async (revision: number, choices: Record<string, unknown>) => {
        calls.push(`configure:${choices.allowIdleRestart}`);
        const { allowIdleRestart: _consent, ...schedule } = choices;
        status = { ...status, enabled: schedule.enabled === true, schedule: schedule as BackupScheduleStatus["schedule"], revision: revision + 1 };
        return status;
      },
      ...(firstBackup ? { runNow: async (revision: number) => {
        calls.push(`runNow:${revision}`);
        // The desktop app closes and reopens around the capture; what the page
        // reads next is the state it comes back to.
        status = capture ? { ...status, phase: "returned", lastVerified: verified } : { ...status, phase: "handoff-armed" };
        return status;
      } } : {}),
    } as unknown as ScheduleController["bridge"];
    return { bridge: bridge!, calls, latest: () => status };
  }
  const drive = async (host: ReturnType<typeof hostBridge>) => {
    const notices: string[] = [], keys: { label: string; folder: string }[] = [];
    let shown: BackupScheduleStatus | null = null;
    const outcome = await completeBackupSetup(host.bridge!, undefined, { applyStatus: (next) => { shown = next; }, createdKey: (note) => keys.push(note), notice: (text) => notices.push(text) });
    return { outcome, notices, keys, shown: shown as BackupScheduleStatus | null };
  };
  const summaryFor = (schedule: BackupScheduleStatus) => backupSummary({ scheduleBridge: true, schedule, scheduleStale: false, scheduleFailure: null, closed: null, closedStale: false, remoteBridge: false, remote: null, remoteStale: false, remoteFailure: null }, () => "WHEN");

  it("takes the first backup itself and finishes on a verified state", async () => {
    const host = hostBridge();
    const { outcome, notices, keys, shown } = await drive(host);
    // THE GATE: the state setup ends on is protected, not merely configured.
    const summary = summaryFor(shown!);
    expect(summary.last).not.toBe("No verified backup on this computer yet");
    expect(summary.last).toBe("WHEN · 1.2 GB");
    expect(summary.attention).toEqual([]);
    expect(outcome).toEqual({ state: "capturing" });
    // One act: bind, turn on, back up. No extra question in between.
    expect(host.calls).toEqual(["setUp", "configure:true", "runNow:2"]);
    expect(keys).toEqual([{ label: "murage-recovery-key.txt", publicKey: "age1" + "q".repeat(58), folder: "Documents" }]);
    expect(notices).toContain(SETUP_FIRST_BACKUP_RUNNING);
  });

  it("a first backup that cannot start is said plainly, and never reads as one that happened", async () => {
    for (const [code, named] of [["BACKUP_WORK_ACTIVE", "Finish or stop current work first."], ["BACKUP_BUSY", "A backup is already running."]] as const) {
      const host = hostBridge();
      (host.bridge as unknown as { runNow: () => Promise<never> }).runNow = async () => { throw Error(code); };
      const { outcome, shown } = await drive(host);
      expect(outcome.state, code).toBe("first-backup-failed");
      expect(outcome).toMatchObject({ message: expect.stringContaining(named) });
      expect(outcome).toMatchObject({ message: expect.stringContaining("Nothing has been backed up yet") });
      // The schedule is genuinely on, so the page says so — and the summary
      // still names the gap rather than implying a backup exists.
      expect(shown!.enabled).toBe(true);
      expect(summaryFor(shown!).last).toBe("No verified backup on this computer yet");
      expect(summaryFor(shown!).attention).toContain("Daily backups are on, but no backup has been taken yet. Use Back up now to take the first one.");
    }
  });

  // 0.1.60 Linux D6: a routine card waiting on the owner stopped the first
  // backup with only "Finish or stop current work first".
  it("a first backup held up by a waiting bot names it, and the page keeps saying so until it is answered", async () => {
    const host = hostBridge();
    const ember = { botId: "ember", name: "Log writer", threadId: "t1", messageId: "m1" };
    const bridge = host.bridge as unknown as { runNow: () => Promise<never>; status: () => Promise<BackupScheduleStatus> };
    bridge.runNow = async () => { throw Error("Error invoking remote method 'backup-schedule:run-now': Error: BACKUP_WAITING_ON_YOU"); };
    bridge.status = async () => ({ ...host.latest(), heldBy: { occasion: "manual", since: 1, bots: [ember] } });
    const { outcome, shown } = await drive(host);
    expect(outcome).toEqual({ state: "first-backup-failed",
      message: "Daily backups are on, but nothing has been backed up yet. The backup can't start because Log writer is waiting for your answer. Answer it, or end that run, then back up again." });
    expect(shown!.enabled).toBe(true);
    // A due daily backup that waits says so, and says so again when it is skipped.
    const daily = { ...shown!, heldBy: { occasion: "daily" as const, since: 1, bots: [ember] }, error: "BACKUP_WAITING_ON_YOU" };
    expect(summaryFor(daily).attention).toContain("Today's backup is waiting because Log writer is waiting for your answer. Answer it, or end that run, and the backup starts by itself.");
    expect(summaryFor(daily).attention.join(" ")).not.toContain("Murage was busy");
    const skipped = summaryFor({ ...daily, phase: "skipped" }).attention;
    expect(skipped).toContain("The last daily backup was skipped because Log writer was waiting for your answer. Answer it, or end that run, so the next backup can run.");
    expect(skipped.join(" ")).not.toContain("Murage was busy");
    // Without a name (an older desktop app), still never "Murage was busy".
    expect(runNowError(Error("BACKUP_WAITING_ON_YOU"))).toBe("A bot is waiting for your answer. Answer it, or end that run, then back up again.");
  });

  it("an older desktop app with no Back up now is told to take one, not left thinking it is done", async () => {
    const host = hostBridge({ firstBackup: false });
    const { outcome, notices } = await drive(host);
    expect(outcome).toEqual({ state: "no-first-backup" });
    expect(notices).toContain(SETUP_NO_FIRST_BACKUP);
    expect(SETUP_NO_FIRST_BACKUP).toContain("Use Back up now so you actually have a backup");
  });

  it("a cancelled folder picker turns nothing on and still says where the key went", async () => {
    const host = hostBridge();
    (host.bridge as unknown as { setUp: () => Promise<unknown> }).setUp = async () => ({ cancelled: true, created: { label: "murage-recovery-key.txt", publicKey: null, folder: "Documents" } });
    const { outcome, notices, keys } = await drive(host);
    expect(outcome).toEqual({ state: "cancelled" });
    expect(keys).toHaveLength(1);
    expect(notices[0]).toContain("left in Documents");
    expect(host.calls).toEqual([]);
  });

  it("an expected refusal answered as a value is still a failure", async () => {
    const host = hostBridge();
    (host.bridge as unknown as { setUp: () => Promise<unknown> }).setUp = async () => ({ refused: "BACKUP_RECOVERY_KEY_LOCATION_INVALID" });
    await expect(drive(host)).rejects.toThrow("BACKUP_RECOVERY_KEY_LOCATION_INVALID");
    (host.bridge as unknown as { setUp: () => Promise<unknown> }).setUp = async () => ({ refused: "/Users/someone/secret" });
    await expect(drive(host)).rejects.toThrow("INVALID_BACKUP_SETUP_RESULT");
  });
});

describe("backups while Murage is closed, from another volume", () => {
  const onClosed = { ...healthy.schedule!, schedule: { ...healthy.schedule!.schedule, closedApp: true } };
  it("the summary says what to move when the job is blocked by where Murage lives", () => {
    const summary = backupSummary({ ...healthy, schedule: onClosed, closed: { supported: true, state: "unavailable", closedApp: true, blocked: "volume-data" } });
    expect(summary.attention).toContain("Backups while Murage is closed need Murage's data folder on this Mac's own disk, not on another drive. Move the data folder there, then turn this on again.");
    expect(summary.attention).not.toContain("Backing up while Murage is closed isn't set up yet.");
  });
  it("a run that ended because of it says so too", () => {
    const summary = backupSummary({ ...healthy, schedule: { ...healthy.schedule!, lastClosedResult: { status: "unavailable", reason: "volume-unreadable", at: 1, revision: 3 } } });
    expect(summary.attention.some(line => line.includes("Applications folder on this Mac's own disk"))).toBe(true);
  });
});
