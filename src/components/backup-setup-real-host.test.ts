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

const fakeKey = "# public key: age1" + "q".repeat(58) + "\nAGE-SECRET-KEY-1" + "A".repeat(60) + "\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });

function realHost() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-setup-real-host-")));
  roots.push(root);
  const installation = path.join(root, "installation"), destination = path.join(root, "backups"), keys = path.join(root, "keys");
  for (const folder of [installation, destination, keys]) mkdirSync(folder);
  let binding: string | undefined;
  const calls: string[] = [];
  const host = createBackupScheduleHost({
    coordinator: new BackupCoordinator({ stateDirectory: path.join(root, "control") }),
    installation: () => installation, supported: () => true,
    readProtected: async () => binding, writeProtected: async (_key: string, value: string) => { binding = value; },
    chooseDestination: async () => { calls.push("folder"); return destination; },
    chooseKey: async () => null,
    createRecoveryKey: async () => { calls.push("create-key"); const file = path.join(keys, "murage-recovery-key.txt"); writeFileSync(file, fakeKey, { mode: 0o600 }); return { file, label: "murage-recovery-key.txt", publicKey: "age1" + "q".repeat(58) }; },
    confirmReferences: async () => { calls.push("confirm"); return true; },
    prepare: async () => { calls.push("prepare"); return async () => { calls.push("release"); }; },
    cleanupIdle: async () => { calls.push("cleanup"); },
    relaunch: async (mode: string) => { calls.push("relaunch:" + mode); },
    capture: async () => { throw Error("not reached"); },
  });
  // What electron/main.mjs's "backup-schedule:set-up" handler does with the
  // preload's forwarded options slot, then the host call it makes.
  const bridge = {
    setUp: async (options?: { existingKey?: boolean }) => { const request = setUpBackupsRequest([options]); if (!request) throw Error("INVALID_BACKUP_REQUEST"); return host.setUpBackups(request); },
    configure: (revision: number, choices: unknown) => host.configure(revision, choices),
    runNow: (revision: number) => host.runNow(revision),
    status: () => host.status(),
  } as unknown as BackupScheduleBridge;
  return { host, bridge, calls };
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
