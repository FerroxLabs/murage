import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

test("the window does not wait for the off-site backup host", () => {
  assert.doesNotMatch(main, /await\s+initializeBackupRemoteHost\(\)/);
  assert.match(main, /backupRemoteReady=initializeBackupRemoteHost\(\)\.catch\(/);
});

test("the automatic off-site upload poll starts once that host is ready", () => {
  assert.match(main, /void backupRemoteReady\.then\(\(\)=>\{[^}]*startAutomaticRemoteBackups\(\);\}\)/);
});
