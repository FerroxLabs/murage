// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreWindowOpenOnDisk } from "./restore-window.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "j5-rw-"));
const journal = (dir, phase) => fs.writeFileSync(path.join(dir, "restore-job.json"), JSON.stringify({ version: 1, id: "j", archiveId: "a", source: "s", at: 1, phase }));

test("the window is open for armed, captured, swapped; closed for none, prepared, aborted", () => {
  const dir = tmp();
  try {
    assert.equal(restoreWindowOpenOnDisk(dir), false);
    for (const [phase, open] of [["armed", true], ["captured", true], ["swapped", true], ["prepared", false], ["aborted", false]]) { journal(dir, phase); assert.equal(restoreWindowOpenOnDisk(dir), open, phase); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("an unreadable journal fails closed", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "restore-job.json"), "{nope"); assert.equal(restoreWindowOpenOnDisk(dir), true);
    fs.writeFileSync(path.join(dir, "restore-job.json"), JSON.stringify({ version: 1, phase: "bogus" })); assert.equal(restoreWindowOpenOnDisk(dir), true);
    fs.rmSync(path.join(dir, "restore-job.json")); fs.mkdirSync(path.join(dir, "restore-job.json")); assert.equal(restoreWindowOpenOnDisk(dir), true);
    fs.rmdirSync(path.join(dir, "restore-job.json")); journal(dir, "prepared"); fs.chmodSync(path.join(dir, "restore-job.json"), 0o000);
    if (process.getuid?.() !== 0) assert.equal(restoreWindowOpenOnDisk(dir), true, "a journal that cannot be read fails closed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("main.mjs builds the host BackupCoordinator with the restore window (the J2 backup-side gate is not inert on desktop)", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /new BackupCoordinator\(\{stateDirectory,restoreWindow:\(\)=>restoreWindowOpenOnDisk\(installation\),/);
  assert.match(main, /import \{ restoreWindowOpenOnDisk \} from "\.\/restore-window\.mjs";/);
});
test("a scheduled backup during an open restore window is refused by the coordinator the host builds (real BackupCoordinator, the host's own gate)", async () => {
  const { BackupCoordinator } = await import("../server/backup-coordinator.ts");
  const dir = tmp(), state = path.join(dir, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  try {
    let worked = 0;
    const open = () => restoreWindowOpenOnDisk(dir);
    const c = new BackupCoordinator({ stateDirectory: state, restoreWindow: open });
    c.work = async () => { worked += 1; return c.status(); };
    journal(dir, "captured");
    await c.tick();
    assert.equal(worked, 0, "a scheduled tick must not start work while the window is open");
    assert.equal(c.closedEligibility().status, "not-due");
    fs.rmSync(path.join(dir, "restore-job.json"));
    await c.tick();
    assert.equal(worked, 1, "with no restore open the tick runs");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
