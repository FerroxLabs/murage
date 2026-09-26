// @vitest-environment node
// "Turn on backups" end to end through the REAL desktop schedule host and the
// REAL IPC argument check, not a mocked bridge. The page's completeBackupSetup
// is fed exactly what createBackupScheduleHost answers.
//
// Regression: setUpBackups() read its status while its own "preparing" flag was
// still held, so the answer said pending:true. The page refuses to switch on a
// pending schedule, so after the one "Back up every day" confirmation daily
// backups stayed OFF and no first backup ran (found in the packaged 0.1.60 app,
// 2026-09-26). Every existing test mocked the bridge with pending:false.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupCoordinator } from "../../server/backup-coordinator";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { createBackupScheduleHost, setUpBackupsRequest } from "../../electron/backup-schedule-host.mjs";
import { completeBackupSetup, type BackupScheduleBridge } from "./backups-section-ui";
import { enabledSchedule, scheduleDraft } from "./backup-schedule-ui";

const fakeKey = "# public key: age1" + "q".repeat(58) + "\nAGE-SECRET-KEY-1" + "A".repeat(60) + "\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });

function realHost(options: { closedApp?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-setup-real-host-")));
  roots.push(root);
  const installation = path.join(root, "installation"), keys = path.join(root, "keys");
  const folders = { first: path.join(root, "backups"), second: path.join(root, "other-backups") };
  for (const folder of [installation, keys, folders.first, folders.second]) mkdirSync(folder);
  let destination = folders.first, keyCount = 0;
  let binding: string | undefined;
  const calls: string[] = [];
  const host = createBackupScheduleHost({
    coordinator: new BackupCoordinator({ stateDirectory: path.join(root, "control") }),
    installation: () => installation, supported: () => true,
    readProtected: async () => binding, writeProtected: async (_key: string, value: string) => { binding = value; },
    chooseDestination: async () => { calls.push("folder"); return destination; },
    chooseKey: async () => null,
    createRecoveryKey: async () => { calls.push("create-key"); const file = path.join(keys, ++keyCount === 1 ? "murage-recovery-key.txt" : `murage-recovery-key-${keyCount}.txt`); writeFileSync(file, fakeKey, { mode: 0o600 }); return { file, label: "murage-recovery-key.txt", publicKey: "age1" + "q".repeat(58) }; },
    confirmReferences: async () => { calls.push("confirm"); return true; },
    prepare: async () => { calls.push("prepare"); return async () => { calls.push("release"); }; },
    cleanupIdle: async () => { calls.push("cleanup"); },
    relaunch: async (mode: string) => { calls.push("relaunch:" + mode); },
    capture: async () => { throw Error("not reached"); },
    ...(options.closedApp ? { assertClosedAllowed: async () => {} } : {}),
  });
  // What electron/main.mjs's "backup-schedule:set-up" handler does with the
  // preload's forwarded options slot, then the host call it makes.
  const bridge = {
    setUp: async (options?: { existingKey?: boolean }) => { const request = setUpBackupsRequest([options]); if (!request) throw Error("INVALID_BACKUP_REQUEST"); return host.setUpBackups(request); },
    configure: (revision: number, choices: unknown) => host.configure(revision, choices),
    runNow: (revision: number) => host.runNow(revision),
    status: () => host.status(),
  } as unknown as BackupScheduleBridge;
  return { host, bridge, calls, useSecondFolder: () => { destination = folders.second; } };
}

describe("Turn on backups through the real schedule host", () => {
  it("answers setup with a status that is not pending", async () => {
    const { host } = realHost();
    const status = await host.setUpBackups({ existingKey: false });
    expect(status.pending).toBe(false);
    host.stopPolling();
  });

  it("one confirmation turns daily backups on and starts the first backup", async () => {
    const { host, bridge, calls } = realHost();
    const notices: string[] = [];
    const outcome = await completeBackupSetup(bridge, undefined, { applyStatus: () => {}, createdKey: () => {}, notice: text => notices.push(text) });
    host.stopPolling();
    expect(notices).not.toContain("Backup folder and recovery key saved. Choose a time below, then turn on daily backups.");
    expect(outcome.state).toBe("capturing");
    expect((await host.status()).enabled).toBe(true);
    expect(calls.filter(call => call !== "cleanup")).toEqual(["folder", "create-key", "confirm", "prepare", "relaunch:backup"]);
  });
});

// Regression (Linux re-test 3, 2026-09-27): after Turn off, then Choose a
// different folder, "Back up every day" left daily backups off. Turn off keeps
// the saved schedule, including "Also back up when Murage is closed"; setup
// sent that choice back without the closed-app permission, the host refused
// it, and the page was left saying daily backups are off. First-time setup
// never had closedApp saved, so it never hit this. Setup now always starts
// with closed-app backups off, like a first setup.
describe("Choose a different folder after Turn off", () => {
  it("turns daily backups back on and starts the first backup, with closed-app backups off", async () => {
    const { host, bridge, calls, useSecondFolder } = realHost({ closedApp: true });
    // Earlier: set up, daily backups on with closed-app backups, then Turn off.
    const first = await host.setUpBackups({ existingKey: false });
    const choice = enabledSchedule({ ...scheduleDraft(first.schedule), closedApp: true }, first, true);
    expect(choice).not.toBeNull();
    const on = await host.configure(first.revision, { ...choice!, allowIdleRestart: true, allowClosedApp: true });
    expect(on.enabled).toBe(true);
    const off = await host.configure(on.revision, { ...on.schedule, enabled: false });
    host.stopPolling();
    expect(off.enabled).toBe(false);
    expect(off.schedule.closedApp).toBe(true);

    useSecondFolder();
    calls.length = 0;
    const notices: string[] = [];
    const outcome = await completeBackupSetup(bridge, undefined, { applyStatus: () => {}, createdKey: () => {}, notice: text => notices.push(text) });
    host.stopPolling();
    expect(outcome.state).toBe("capturing");
    const now = await host.status();
    expect(now.enabled).toBe(true);
    expect(now.schedule.closedApp).toBe(false);
    expect(now.refs?.destinationLabel).toBe("other-backups");
    expect(now.refs?.recoveryLabel).toBe("murage-recovery-key-2.txt");
    expect(calls.filter(call => call !== "cleanup")).toEqual(["folder", "create-key", "confirm", "prepare", "relaunch:backup"]);
  });

  it("still turns daily backups on when closed-app backups can no longer run", async () => {
    const { host, bridge } = realHost({ closedApp: true });
    const first = await host.setUpBackups({ existingKey: false });
    const choice = enabledSchedule({ ...scheduleDraft(first.schedule), closedApp: true }, first, true);
    const on = await host.configure(first.revision, { ...choice!, allowIdleRestart: true, allowClosedApp: true });
    await host.configure(on.revision, { ...on.schedule, enabled: false });
    host.stopPolling();
    // The background job was removed in the meantime.
    const status = await host.status();
    const bridgeWithoutClosed = { ...bridge, status: async () => ({ ...(await bridge.status()), closedAppSupported: false }), setUp: async (options?: { existingKey?: boolean }) => ({ ...(await bridge.setUp!(options)), closedAppSupported: false }) } as BackupScheduleBridge;
    expect(status.enabled).toBe(false);
    const outcome = await completeBackupSetup(bridgeWithoutClosed, undefined, { applyStatus: () => {}, createdKey: () => {}, notice: () => {} });
    host.stopPolling();
    expect(outcome.state).toBe("capturing");
    const now = await host.status();
    expect(now.enabled).toBe(true);
    expect(now.schedule.closedApp).toBe(false);
  });
});
