import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BACKUP_TOOL_STUCK_AFTER, createBackupToolCapability } from "./backup-mode.mjs";

/** The tool check runs on Windows through a resolver module; make it fail on demand. */
async function withCapability(options, work) {
  const root = mkdtempSync(path.join(tmpdir(), "murage-backup-race-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const state = { fail: true };
  const key = `backupRace${Date.now()}${Math.random()}`;
  globalThis[key] = state;
  const resources = path.join(root, "resources");
  mkdirSync(path.join(resources, "server"), { recursive: true });
  writeFileSync(path.join(resources, "server", "windows-backup-resources.js"), `
    import path from 'node:path';
    export function createWindowsBackupResourceResolver(input) {
      return async () => {
        if (globalThis[${JSON.stringify(key)}].fail) throw Error('AGE_TOOL_UNVERIFIED');
        return { executable: path.join(input.resourcesPath, 'backup-tools', 'x64', 'murage-backup-age.exe') };
      };
    }
  `);
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try { await work(createBackupToolCapability({ resourcesPath: resources, currentExecutable: path.join(root, "Murage.exe"), isUsable: () => true, recheckOptions: { delays: [60000], setTimer: () => ({ unref() {} }), clearTimer: () => {} }, ...options(state) }), state); }
  finally { Object.defineProperty(process, "platform", descriptor); delete globalThis[key]; safeWipeSync(root); }
}

it("a tool check that fails while the host is still starting is pending, never a logged failure", async () => {
  const failed = [], pending = [];
  let settling = true;
  await withCapability(() => ({ settling: () => settling, onFailure: value => failed.push(value), onPending: value => pending.push(value) }), async capability => {
    await expect(capability.requireTool({ background: true })).rejects.toMatchObject({ message: "AGE_TOOL_UNVERIFIED" });
    // Base behaviour: this is where "backup tool check failed ... failures:1" was logged.
    expect(failed).toEqual([]);
    expect(pending).toHaveLength(1);
    expect(capability.status()).toMatchObject({ state: "pending", failures: 0, checking: true });
    // Once the start-up window ends, a check that still fails is a real failure.
    settling = false;
    await expect(capability.requireTool({ background: true })).rejects.toBeTruthy();
    expect(failed).toHaveLength(1);
    expect(failed[0].failures).toBe(1);
    expect(BACKUP_TOOL_STUCK_AFTER).toBeGreaterThan(1);
  });
});

it("a start-up pending check that then passes leaves no failure and no 'passed again' line", async () => {
  const failed = [], ready = [];
  await withCapability(() => ({ settling: () => true, onFailure: value => failed.push(value), onReady: () => ready.push(1) }), async (capability, state) => {
    await expect(capability.requireTool({ background: true })).rejects.toBeTruthy();
    state.fail = false;
    await expect(capability.requireTool({ background: true })).resolves.toContain("age.exe");
    expect(failed).toEqual([]);
    expect(ready).toEqual([]);
  });
});

it("main.mjs marks the window at server start and logs the pending line", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  expect(main).toMatch(/slog\(`spawned pid=\$\{proc\.pid\}`\);\s*backupToolSettleUntil = Date\.now\(\)/);
  expect(main).toContain("settling: () => backupRemoteInitializing || Date.now() < backupToolSettleUntil");
  expect(main).toContain("backup tool check pending");
});
