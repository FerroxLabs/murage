import assert from "node:assert/strict";
import test from "node:test";
import { windowsElevated } from "./windows-elevation.mjs";

const medium = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""\r\n';
const high = '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""\r\n';

test("only an elevated Windows token counts as elevated", () => {
  assert.equal(windowsElevated({ platform: "win32", run: () => high }), true);
  assert.equal(windowsElevated({ platform: "win32", run: () => '"NT AUTHORITY\\SYSTEM","Label","S-1-16-16384",""' }), true);
  assert.equal(windowsElevated({ platform: "win32", run: () => medium }), false);
});

test("an unknown answer never blocks, and other systems are never elevated here", () => {
  assert.equal(windowsElevated({ platform: "win32", run: () => { throw new Error("whoami missing"); } }), false);
  assert.equal(windowsElevated({ platform: "darwin", run: () => high }), false);
  assert.equal(windowsElevated({ platform: "linux", run: () => high }), false);
});
