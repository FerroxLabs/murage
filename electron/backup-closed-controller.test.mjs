import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it } from "vitest";
import { createClosedBackupController, closedControlDirectory } from "./backup-closed-controller.mjs";
import { closedInstallationIdentity } from "./backup-closed-profile.mjs";
import { readClosedBackupStage } from "./backup-closed-jobs.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const start = main.indexOf("  // An upgrade brings a new trigger");
const continuation = main.slice(start, main.indexOf("  const choose=", start));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-restage-"))); roots.push(root);
  const installation = path.join(root, "data"), userData = path.join(root, "user"), executable = path.join(root, "Murage"), triggerSource = path.join(root, "trigger.js");
  for (const directory of [installation, userData]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(executable, "fixture", { mode: 0o700 });
  writeFileSync(triggerSource, "export const version=1;", { mode: 0o600 });
  const profile = { version: 1, platform: process.platform, owner: { uid: process.getuid() }, requestedRoot: installation, userData, installation, installationIdentity: closedInstallationIdentity(installation), executable };
  let ready = true, registration = null, installs = 0, resolveCheck;
  const scope = {
    closedBackupRequested: false, desktopShutdownStarted: false, desktopRecoveryMode: false,
    desktopDataOwner: {}, installation, ownedDesktopDataDir: () => installation,
    desktopBackupTool: { currentTool: () => ready ? "fixture-tool" : null },
    backupToolCheck: new Promise(resolve => { resolveCheck = resolve; }),
  };
  const provider = { supported: true, read: async () => registration,
    install: async job => { installs++; registration = { jobId: job.jobId, owner: job.owner, files: job.files, registered: true, running: false }; },
    remove: async () => { registration = null; } };
  const controller = createClosedBackupController({ profile: () => profile, triggerSource, provider,
    backupSupported: () => Boolean(!scope.desktopShutdownStarted && scope.desktopDataOwner && scope.desktopBackupTool.currentTool()),
    backup: () => ({ internalStatus: () => ({ enabled: false }) }), confirmInstall: async () => true, volumeProblem: () => null });
  scope.closedBackupController = controller;
  await controller.stage(); await controller.install();
  const stage = () => { const control = closedControlDirectory(installation), pointer = JSON.parse(readFileSync(path.join(control, "closed-job-pointer.json"), "utf8")); return readClosedBackupStage(path.join(control, pointer.directory)); };
  const original = stage().descriptor.triggerSha256;
  writeFileSync(triggerSource, "export const version=2;", { mode: 0o600 });
  ready = false;
  const initialize = vm.runInNewContext(`(async () => {${continuation}})`, scope);
  return { scope, initialize, original, stage, installs: () => installs, settle: (available = true) => { ready = available; resolveCheck(); } };
}

it.skipIf(process.platform === "win32")("restages an outdated registration after slow tool attestation without delaying startup", async () => {
  const f = await fixture();
  await f.initialize();
  expect(f.installs()).toBe(1);
  expect(f.stage().descriptor.triggerSha256).toBe(f.original);
  f.settle(); await f.scope.backupToolCheck;
  expect(f.installs()).toBe(2);
  expect(f.stage().descriptor.triggerSha256).not.toBe(f.original);
});

it.skipIf(process.platform === "win32").each(["shutdown", "owner", "installation", "controller", "unavailable"])("keeps pending restaging bound to tool readiness and ownership: %s", async change => {
  const f = await fixture();
  await f.initialize();
  if (change === "shutdown") f.scope.desktopShutdownStarted = true;
  if (change === "owner") f.scope.desktopDataOwner = {};
  if (change === "installation") f.scope.ownedDesktopDataDir = () => "another-installation";
  if (change === "controller") f.scope.closedBackupController = {};
  f.settle(change !== "unavailable"); await f.scope.backupToolCheck;
  expect(f.installs()).toBe(1);
  expect(f.stage().descriptor.triggerSha256).toBe(f.original);
});

it("joins background restaging before releasing desktop ownership", () => {
  const cleanup = main.slice(main.indexOf("function cleanupDesktopForExit() {"));
  const join = cleanup.indexOf("await awaitOwnedWork(backupToolCheck,");
  expect(join).toBeGreaterThan(-1);
  expect(join).toBeLessThan(cleanup.indexOf("desktopDataOwner.release()"));
});
