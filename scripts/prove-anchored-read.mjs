// Native gate: isolated temporary files only; no app, account, credentials or live data.
import { renameWithRetrySync, windowsRenameDenied } from "./rename-retry.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { proveAnchoredReadResource } from "./anchored-read-resource.mjs";
const file = resolve(process.argv[2] ?? `dist-native/anchored-read/${process.platform}-${process.arch}/anchored-read.node`);
const addon = createRequire(import.meta.url)(file);
assert.equal(addon.version(), 1);
const root = fs.mkdtempSync(join(tmpdir(), "murage-anchored-native-"));
let sequence = 0;
function fixture() {
  const dir = join(root, String(sequence++)); fs.mkdirSync(dir); fs.mkdirSync(join(dir, "dir"));
  fs.writeFileSync(join(dir, "dir", "file"), "inside");
  const outside = join(root, String(sequence++)); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "file"), "SECRET");
  return { dir, outside };
}
function read(dir, parts = ["dir", "file"], hook, max = 100) { return addon.read(fs.realpathSync(dir), parts, max, hook); }
try {
  for (const point of ["root", "dir", "file", "read"]) {
    const {dir, outside} = fixture(); let deniedMutation = false;
    // Replace the next path component at root; replace an already held parent at later steps.
    const perform = () => read(dir, undefined, step => {
      if (step.kind !== point) return;
      try { renameWithRetrySync(join(dir, "dir"), join(dir, "held")); }
      catch (error) { if (!windowsRenameDenied(error)) throw error; deniedMutation = true; return; }
      fs.symlinkSync(outside, join(dir, "dir"), process.platform === "win32" ? "junction" : "dir");
    });
    if (point === "root") assert.throws(perform); else assert.equal(Buffer.from(perform().bytes).toString(), "inside");
    void deniedMutation;
  }
  console.log("PASS T-A1 anchored.dirSwappedToLinkAfterEveryStep");
  for (const point of ["root", "dir", "file"]) {
    const {dir, outside} = fixture(); let swapped = false, restoreDenied = false;
    const perform = () => read(dir, undefined, step => {
      if (restoreDenied) return;
      if (swapped) {
        fs.unlinkSync(join(dir, "dir")); swapped = false;
        try { renameWithRetrySync(join(dir, "held"), join(dir, "dir")); }
        catch (error) { if (!windowsRenameDenied(error)) throw error; restoreDenied = true; return; }
      }
      if (step.kind !== point) return;
      try { renameWithRetrySync(join(dir, "dir"), join(dir, "held")); }
      catch (error) { if (!windowsRenameDenied(error)) throw error; return; }
      fs.symlinkSync(outside, join(dir, "dir"), process.platform === "win32" ? "junction" : "dir"); swapped = true;
    });
    if (point === "root") assert.throws(perform); else assert.equal(Buffer.from(perform().bytes).toString(), "inside");
  }
  console.log("PASS T-A2 anchored.swapAndRestoreBetweenSteps");
  {
    const {dir, outside} = fixture(); fs.symlinkSync(join(outside, "file"), join(dir, "link"), "file");
    assert.throws(() => read(dir, ["link"]), {code:"link"});
    console.log("PASS T-A3 anchored.finalLinkRefused");
    if (process.platform === "win32") console.log("PASS T-A5 anchored.reparseFileRefused");
    fs.linkSync(join(dir, "dir", "file"), join(dir, "hard"));
    assert.throws(() => read(dir, ["hard"]), {code:"hard_link"});
    console.log("PASS T-A4 anchored.hardLinkRefused");
  }
  if (process.platform !== "win32") {
    const {dir} = fixture(); execFileSync("mkfifo", [join(dir, "fifo")]);
    assert.throws(() => read(dir, ["fifo"]), {code:"not_regular"}); console.log("PASS T-A7 anchored.fifoNeverBlocks");
  }
  {
    const {dir} = fixture(); const run = () => read(dir, undefined, step => {
      if (step.kind === "file") {
        if (process.platform === "win32") assert.throws(() => fs.appendFileSync(join(dir, "dir", "file"), "growth"));
        else fs.appendFileSync(join(dir, "dir", "file"), "growth");
      }
    });
    if (process.platform === "win32") assert.equal(Buffer.from(run().bytes).toString(), "inside"); else assert.throws(run, {code:"changed"});
    console.log("PASS T-A8 anchored.growthDuringReadRefused");
  }
  {
    const {dir} = fixture();
    for (const part of ["..", "a:b", "CON.txt", "trailing.", "space ", "a\0", "a/b", "a\\b", "x\r", "x\n", "", "x".repeat(256)]) assert.throws(() => read(dir, [part]), {code:"invalid_name"});
    for (const step of ["root", "dir", "file", "read"]) assert.throws(() => read(dir, undefined, value => { if (value.kind === step) throw Error("hook failure"); }), /hook failure/);
    assert.equal(Buffer.from(read(dir).bytes).toString(), "inside");
    assert.throws(() => read(dir, undefined, undefined, 1), {code:"too_large"});
    console.log("PASS T-A9 anchored.invalidNames and hook cleanup");
  }
  console.log(proveAnchoredReadResource(file, process.argv[3] ?? process.execPath));
  console.log("PASS anchored-native " + process.platform + "-" + process.arch);
} finally { fs.rmSync(root, {recursive:true, force:true}); }
