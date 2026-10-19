// Settings L5: setup ends verified. Every step done is not "finished" while
// the first backup is still owed; a checked backup of the folder and key in
// use now, or the person's choice to keep backups off, finishes it. The
// harness derives that from the desktop backup host's own files: nothing a
// caller sends is taken as a fact.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SETUP_STEPS, emptySetupState, setupView, type SetupLiveState, type SetupState } from "../shared/setup.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { deriveSetupBackup, initializeSetupBackup, setupBackupRequest, type SetupBackupSources } from "./setup-backup.ts";
import { SetupChecklist } from "./setup.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });
const sources = (): SetupBackupSources & { root: string } => {
  const root = mkdtempSync(join(tmpdir(), "murage-setup-backup-")); roots.push(root);
  const dataDir = join(root, "data"), controlDirectory = join(root, "control");
  mkdirSync(dataDir); mkdirSync(controlDirectory);
  return { root, dataDir, controlDirectory, setupFile: join(dataDir, "setup.json"), now: () => 5 };
};
const own = (s: SetupBackupSources) => JSON.parse(readFileSync(join(s.dataDir, "setup-backup.json"), "utf8"));
const hex = (c: string) => c.repeat(64);
const schedule = (over: Record<string, unknown> = {}) => ({
  enabled: true, installationRef: "i", destinationRef: "d", recoveryRef: "r", timezone: "UTC", time: "09:00", catchupMs: 86400000,
  maxBytes: 100000000, maxDurationMs: 60000, selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" }, preUpgrade: false, ...over,
});
const receipt = { jobId: hex("a"), installationRef: "i", destinationRef: "d", selectionHash: hex("b"), snapshotId: "00000000-0000-4000-8000-000000000000", artifactRef: hex("a"), sha256: hex("c"), bytes: 10, verifiedAt: 1 };
/** The desktop host's coordinator file, as it writes it. */
const hostState = (s: SetupBackupSources, over: Record<string, unknown> = {}) =>
  writeFileSync(join(s.controlDirectory!, "backup-coordinator.json"), JSON.stringify({ version: 1, revision: 2, configuredAt: 1, schedule: schedule(), seen: [], watermark: 0, lastVerified: receipt, ...over }));
const firstRun = (s: SetupBackupSources, value: unknown) => writeFileSync(join(s.controlDirectory!, "backup-first-run.json"), typeof value === "string" ? value : JSON.stringify(value));

const live = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
  ownerName: "Sam", agents: [], signedOutAgents: [],
  flux: { configured: false, conflict: false, looksValid: false }, bundledEngine: { ready: true },
  chiefInstanceId: "", chiefAnsweredBy: [], chiefRefusal: null, chiefUsesFlux: false, crewSize: 0,
  connectedApps: 0, connectedAppIds: [], botReplyExists: false, routines: { total: 0, briefId: null, briefRan: false },
  ...patch,
});
/** Every step passed over: the checklist alone has nothing left to ask. */
const finishedSteps = (): SetupState => {
  const state = emptySetupState(1);
  for (const step of SETUP_STEPS) state.steps[step] = { done: false, skipped: true, at: 1 };
  return state;
};

describe("setup completion waits for the first backup", () => {
  it("is not complete while the backup is owed, and says which ending it reached", () => {
    const pending = setupView(finishedSteps(), live({ backupSetup: "pending" }));
    expect(pending.next).toBeNull();
    expect(pending.complete).toBe(false);
    expect(pending.backup).toBe("pending");
    for (const ending of ["verified", "off"] as const) {
      const view = setupView(finishedSteps(), live({ backupSetup: ending }));
      expect(view.complete).toBe(true);
      expect(view.backup).toBe(ending);
    }
    // A folder that never owed the step is not held.
    expect(setupView(finishedSteps(), live()).complete).toBe(true);
  });

  it("durable initialization: only a fresh setup on a desktop that never had backups owes the step", () => {
    const fresh = sources();
    initializeSetupBackup(true, fresh);
    expect(own(fresh)).toEqual({ version: 2, owed: true, ending: null, at: 5 });
    expect(deriveSetupBackup(fresh)).toBe("pending");
    // Setup already started here, or backups were set up before: never marked.
    const started = sources(); initializeSetupBackup(false, started);
    expect(deriveSetupBackup(started)).toBeNull();
    const hadBackups = sources(); hostState(hadBackups); initializeSetupBackup(true, hadBackups);
    expect(() => own(hadBackups)).toThrow();
    // Off the desktop there is no backup host: never marked.
    const web = { ...sources(), controlDirectory: undefined }; initializeSetupBackup(true, web);
    expect(deriveSetupBackup(web)).toBeNull();
  });
});

// Astra r2 R1-4: completion can never be claimed. The renderer holds the
// desktop secret, so the route takes no state at all; a missing desktop
// report leaves an owed step pending.
describe("completion is derived, never accepted from a caller", () => {
  it("refuses a body that claims verified or off, and stays pending", () => {
    const s = sources(); initializeSetupBackup(true, s);
    for (const claim of [{ state: "verified" }, { state: "off" }, { verified: true }]) {
      expect(setupBackupRequest(claim, s)).toEqual({ status: 400, body: { error: "INVALID_SETUP_BACKUP" } });
    }
    expect(setupBackupRequest({}, s)).toEqual({ status: 200, body: { state: "pending" } });
    expect(own(s).ending).toBeNull();
    expect(setupView(finishedSteps(), live({ backupSetup: deriveSetupBackup(s) })).complete).toBe(false);
  });

  it("the person's request to keep backups off ends an owed step as off, never as verified", () => {
    const s = sources(); initializeSetupBackup(true, s);
    expect(setupBackupRequest({ choice: "off" }, s)).toEqual({ status: 200, body: { state: "off" } });
    expect(setupBackupRequest({ choice: "verified" }, s).status).toBe(400);
    // A folder that never owed the step is not changed by the request.
    const legacy = sources();
    expect(setupBackupRequest({ choice: "off" }, legacy)).toEqual({ status: 200, body: { state: null } });
  });

  it("a first-run record saying verified, with no current receipt behind it, is not verified", () => {
    const s = sources(); initializeSetupBackup(true, s);
    firstRun(s, { version: 1, state: "verified", at: 1, jobId: hex("a"), sha256: hex("c"), installationRef: "i", destinationRef: "d", recoveryRef: "r" });
    expect(deriveSetupBackup(s)).toBe("pending");
    hostState(s);
    expect(deriveSetupBackup(s)).toBe("verified");
    expect(own(s).ending).toBe("verified");
  });
});

// Astra r2 R1-5: a verified ending never answers for a folder or key that
// changed after it.
describe("verified is checked against the current folder and key", () => {
  it("a receipt of another folder, or backups now off, is not verified", () => {
    const s = sources(); initializeSetupBackup(true, s); hostState(s);
    expect(deriveSetupBackup(s)).toBe("verified");
    hostState(s, { revision: 3, schedule: schedule({ destinationRef: "d2" }) });
    expect(deriveSetupBackup(s)).toBe("pending");
    hostState(s, { revision: 4, schedule: schedule({ enabled: false }) });
    expect(deriveSetupBackup(s)).toBe("pending");
  });
});

// Astra r2 High: losing the desktop's opt-out record never reopens the step.
describe("an ending is kept in the harness's own record", () => {
  it("off stays off after backup-first-run.json is lost", () => {
    const s = sources(); initializeSetupBackup(true, s);
    hostState(s, { revision: 1, schedule: { enabled: false, preUpgrade: false }, lastVerified: undefined });
    firstRun(s, { version: 1, state: "off", at: 1 });
    expect(deriveSetupBackup(s)).toBe("off");
    rmSync(join(s.controlDirectory!, "backup-first-run.json"));
    expect(deriveSetupBackup(s)).toBe("off");
    expect(own(s)).toMatchObject({ owed: true, ending: "off" });
  });

  it("an unreadable record of its own holds the step open until an ending is derived", () => {
    const s = sources(); writeFileSync(join(s.dataDir, "setup-backup.json"), "not json");
    expect(deriveSetupBackup(s)).toBe("pending");
    firstRun(s, { version: 1, state: "off", at: 1 });
    expect(deriveSetupBackup(s)).toBe("off");
    expect(own(s)).toMatchObject({ version: 2, owed: true, ending: "off" });
  });
});

// Astra r3 R1-4: owed is kept in two places. Losing setup-backup.json once setup.json exists (so initialization never runs again)
// must not let setup finish without a checked backup or the person's choice to keep backups off.
describe("owed outlives the loss of either file", () => {
  const setupJson = (s: SetupBackupSources) => JSON.parse(readFileSync(s.setupFile!, "utf8"));
  /** The harness's boot: initialization runs only while setup.json is absent, then the checklist loads it. */
  const boot = (s: SetupBackupSources, at = 5) => { initializeSetupBackup(!existsSync(s.setupFile!), s); return new SetupChecklist(s.setupFile!, () => at); };

  it("losing setup-backup.json after setup.json exists keeps the step pending, and restores the record the desktop reads", () => {
    const s = sources();
    const checklist = boot(s);
    expect(checklist.read(live({ backupSetup: deriveSetupBackup(s) }))).toMatchObject({ backupOwed: true });
    expect(setupJson(s)).toMatchObject({ backupOwed: true });
    rmSync(join(s.dataDir, "setup-backup.json"));
    boot(s, 6);
    expect(deriveSetupBackup(s)).toBe("pending");
    expect(setupView(finishedSteps(), live({ backupSetup: deriveSetupBackup(s) })).complete).toBe(false);
    expect(own(s)).toMatchObject({ owed: true, ending: null });
    // the way forward stays open: the person's choice to keep backups off ends it
    expect(setupBackupRequest({ choice: "off" }, s).body.state).toBe("off");
    expect(setupView(finishedSteps(), live({ backupSetup: deriveSetupBackup(s) })).complete).toBe(true);
  });

  it("losing setup-backup.json and the desktop's own records still leaves the step pending", () => {
    const s = sources(); boot(s);
    rmSync(join(s.dataDir, "setup-backup.json"));
    expect(deriveSetupBackup(s)).toBe("pending");
  });

  it("losing or damaging setup.json keeps owed from setup-backup.json, and the new checklist records it again", () => {
    const s = sources(); boot(s);
    writeFileSync(s.setupFile!, "not json");
    expect(deriveSetupBackup(s)).toBe("pending");
    boot(s, 7);
    expect(setupJson(s)).toMatchObject({ backupOwed: true });
    rmSync(s.setupFile!);
    boot(s, 8);
    expect(setupJson(s)).toMatchObject({ backupOwed: true });
    expect(deriveSetupBackup(s)).toBe("pending");
  });

  it("a verified ending keeps the marker: after the folder or key changes and setup-backup.json is lost, the step is pending again", () => {
    const s = sources(); boot(s);
    hostState(s);
    expect(deriveSetupBackup(s)).toBe("verified");
    boot(s, 9);
    expect(setupJson(s)).toMatchObject({ backupOwed: true });
    // the folder changes, so the receipt is no longer of the current folder; then the harness's own record is lost
    hostState(s, { schedule: schedule({ destinationRef: "d2" }) });
    boot(s, 10);
    rmSync(join(s.dataDir, "setup-backup.json"));
    expect(deriveSetupBackup(s)).toBe("pending");
    expect(setupView(finishedSteps(), live({ backupSetup: deriveSetupBackup(s) })).complete).toBe(false);
  });

  it("once the step has ended off, the next boot returns setup.json to the 1.0.2 shape; a 1.0.2 folder is never marked", () => {
    const s = sources(); boot(s);
    expect(setupBackupRequest({ choice: "off" }, s).body.state).toBe("off");
    boot(s, 9);
    expect(setupJson(s)).not.toHaveProperty("backupOwed");
    expect(deriveSetupBackup(s)).toBe("off");
    const old = sources();
    writeFileSync(old.setupFile!, JSON.stringify(emptySetupState(1)));
    boot(old);
    expect(setupJson(old)).not.toHaveProperty("backupOwed");
    expect(deriveSetupBackup(old)).toBeNull();
  });
});

// Astra r2 legacy receipts: what a 1.0.2 data folder upgrades into.
describe("1.0.2 data folders", () => {
  it("are never held, and a 1.0.2 receipt of the current folder and key still reads verified", () => {
    const s = sources(); hostState(s);
    initializeSetupBackup(false, s);
    expect(deriveSetupBackup(s)).toBe("verified");
    expect(setupView(finishedSteps(), live({ backupSetup: deriveSetupBackup(s) })).complete).toBe(true);
    // A 1.0.2 folder that never set backups up is not held either.
    const none = sources(); initializeSetupBackup(false, none);
    expect(deriveSetupBackup(none)).toBeNull();
  });

  it("keep a 1.0.2 receipt through off and on with the same folder and key; a schedule saved without its key reference starts unverified", () => {
    const s = sources(); hostState(s);
    const coordinator = new BackupCoordinator({ stateDirectory: s.controlDirectory!, acquire: () => ({ release() {} }) });
    const off = coordinator.configure(2, schedule({ enabled: false }));
    expect(off.lastVerified).toEqual(receipt);
    expect(coordinator.configure(off.revision, schedule()).lastVerified).toEqual(receipt);
    // An off schedule with no key reference cannot prove which key the receipt
    // used: turning it back on waits for its own checked backup.
    const bare = sources(); hostState(bare, { schedule: { enabled: false, preUpgrade: false } });
    const again = new BackupCoordinator({ stateDirectory: bare.controlDirectory!, acquire: () => ({ release() {} }) });
    expect(again.configure(2, schedule()).lastVerified).toBeUndefined();
  });
});
