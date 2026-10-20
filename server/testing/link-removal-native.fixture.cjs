// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run by link-removal.native.test.ts on Windows under the app's own runtime
// (ELECTRON_RUN_AS_NODE=1 electron) and under plain Node, with the real
// engine-exclusion addon. Works only inside the temp folder it is given.
// argv: <bundled link-removal.cjs> <engine-exclusion.node> <temp folder>.
// Prints one JSON line: what the addon's removeTree does to junctions, to a
// folder swapped for a junction while it runs, and what the path walk does to
// the same swap.
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const helper = require(process.argv[2]);
const addon = require(process.argv[3]);
const base = process.argv[4];
const FILES = 40;

/** A folder outside every tree: what a junction would point the remove at. */
function victim(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "keep");
  fs.writeFileSync(path.join(dir, "inner", "x.txt"), "keep");
  return dir;
}
const intact = dir => fs.existsSync(path.join(dir, "inner", "x.txt")) && Array.from({ length: FILES }, (_, i) => fs.existsSync(path.join(dir, `f${i}.txt`))).every(Boolean);
/** A tree whose folder d holds the same names as the victim, so a remove sent through a junction at d would delete the victim's files. */
function tree(name) {
  const top = path.join(base, name);
  const d = path.join(top, "d");
  fs.mkdirSync(path.join(d, "inner"), { recursive: true });
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "mine");
  fs.writeFileSync(path.join(d, "inner", "x.txt"), "mine");
  return { top, d };
}
const gone = p => { try { fs.lstatSync(p); return false; } catch (error) { return error.code === "ENOENT"; } };
const swap = (d, moved, target) => { fs.renameSync(d, moved); fs.symlinkSync(target, d, "junction"); };
const out = { runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, platform: process.platform, cases: {} };
const cases = out.cases;

// A junction inside the tree, one nested deeper: the tree goes, the victim keeps every file.
{
  const v = victim("v1"), { top, d } = tree("t1");
  fs.symlinkSync(v, path.join(top, "link"), "junction");
  fs.symlinkSync(v, path.join(d, "inner", "deeper"), "junction");
  const returned = addon.removeTree(top);
  cases.junctionInTree = { returned, removed: gone(top), victimIntact: intact(v) };
}
// The top itself a junction: removed as a link.
{
  const v = victim("v2"), link = path.join(base, "top-link");
  fs.symlinkSync(v, link, "junction");
  const returned = addon.removeTree(link);
  cases.topJunction = { returned, linkRemoved: gone(link), victimIntact: intact(v) };
}
// A read-only file and a read-only folder.
{
  const { top, d } = tree("t3");
  fs.chmodSync(path.join(d, "f0.txt"), 0o444);
  fs.chmodSync(path.join(d, "inner"), 0o555);
  cases.readOnly = { returned: addon.removeTree(top), removed: gone(top) };
}
cases.missing = addon.removeTree(path.join(base, "never-there"));
// A NUL inside the path is refused; the folder before it stays.
{
  const { top } = tree("t4");
  let error = null;
  try { addon.removeTree(top + "\0suffix"); } catch (e) { error = String(e.code); }
  cases.nulInPath = { error, kept: !gone(top) };
}
// A path Windows would read as another (a trailing dot or space, a `..` tail, the \\?\ form of one) is refused; the folder stays.
// Node's realpath cannot open these, so the data-dir guard compares them as written; removing the folder they name was Astra r5's High.
{
  const { top } = tree("t4b");
  const forms = [top + ".", top + " ", top + ". ", top + "..", top + "...", "\\\\?\\" + top + "."];
  cases.rewrittenPath = forms.map(p => { try { return String(addon.removeTree(p)); } catch (e) { return String(e.code); } });
  cases.rewrittenPathKept = !gone(path.join(top, "d", "inner", "x.txt"));
}
// The swap Astra described: the walk has opened d and not yet listed it when d is moved away and a junction to the victim takes
// its name. The walk lists and deletes the folder it holds (now at t5-moved); the junction is removed as a link.
{
  const v = victim("v5"), { top, d } = tree("t5"), moved = path.join(base, "t5-moved"), seen = [];
  const returned = addon.removeTree(top, rel => { seen.push(rel); if (rel === "d") swap(d, moved, v); });
  cases.swapByHandle = { returned, seen, removed: gone(top), movedRemoved: gone(moved), victimIntact: intact(v) };
}
// The top swapped after it was opened: the folder it holds goes; the junction that took its name is never entered.
{
  const v = victim("v6"), { top } = tree("t6"), moved = path.join(base, "t6-moved");
  const returned = addon.removeTree(top, rel => { if (rel === "") swap(top, moved, v); });
  cases.swapTop = { returned, movedRemoved: gone(moved), victimIntact: intact(v) };
  try { fs.unlinkSync(top); } catch { /* left for the temp folder's cleanup */ }
}
// The same swap against the path walk, made after its post-listing check: it follows the junction into the victim. This is the
// race removeTree closes; recorded so the test shows the walk it replaces really had it.
{
  const v = victim("v7"), { top, d } = tree("t7"), moved = path.join(base, "t7-moved");
  let calls = 0, swapped = false;
  const io = { ...helper.nodeTreeFs, lstatEntry: p => {
    const stat = helper.nodeTreeFs.lstatEntry(p);
    if (p === d && ++calls === 2) { swap(d, moved, v); swapped = true; }
    return stat;
  } };
  let error = null;
  try { helper.removeTreeWithoutFollowing(top, io); } catch (e) { error = String(e.code || e.message); }
  cases.swapByPath = { swapped, error, victimIntact: intact(v) };
}
// A real race: another thread swaps d for a junction to the victim, at a random moment, while removeTree runs, over many trees.
// slot 0: swaps made; slot 1: the worker's state (0 idle, 1 trying, 2 done); slot 2: 1 tells it to stop.
{
  const v = victim("v8");
  const shared = new Int32Array(new SharedArrayBuffer(16));
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const s = workerData.shared;
    parentPort.on("message", ({ d, moved, target }) => {
      Atomics.store(s, 1, 1);
      Atomics.notify(s, 1);
      Atomics.wait(s, 2, 0, Math.random() * 3);
      while (Atomics.load(s, 2) === 0) {
        try { fs.renameSync(d, moved); } catch { continue; }
        try { fs.symlinkSync(target, d, "junction"); Atomics.add(s, 0, 1); } catch {}
        break;
      }
      Atomics.store(s, 1, 2);
      Atomics.notify(s, 1);
    });`, { eval: true, workerData: { shared } });
  const rounds = 150;
  // raced: a removeTree that gave up while the other thread was renaming under it (safe: it refuses, never follows);
  // failures: the tree could not be removed once nothing was racing it, which must never happen.
  let raced = 0, failures = 0;
  for (let i = 0; i < rounds; i++) {
    const { top, d } = tree(`race-${i}`), moved = path.join(base, `race-${i}-moved`);
    Atomics.store(shared, 1, 0);
    Atomics.store(shared, 2, 0);
    worker.postMessage({ d, moved, target: v });
    while (Atomics.load(shared, 1) === 0) Atomics.wait(shared, 1, 0, 5);
    try { addon.removeTree(top); } catch { raced++; }
    Atomics.store(shared, 2, 1);
    Atomics.notify(shared, 2);
    while (Atomics.load(shared, 1) !== 2) Atomics.wait(shared, 1, 1, 5);
    // whatever the worker managed: a junction left at d goes as a link, a moved folder by handle
    try { addon.removeTree(top); addon.removeTree(moved); } catch { failures++; }
  }
  worker.terminate();
  cases.race = { rounds, swaps: Atomics.load(shared, 0), raced, failures, victimIntact: intact(v) };
}
// fs.rmSync once installed: recursive removes go through removeTree.
{
  out.installed = helper.installNoFollowRmSync("win32", () => p => addon.removeTree(p));
  const v = victim("v9"), { top } = tree("t9");
  fs.symlinkSync(v, path.join(top, "link"), "junction");
  fs.rmSync(top, { recursive: true, force: true });
  let missing = null;
  try { fs.rmSync(path.join(base, "never-there-either"), { recursive: true }); } catch (e) { missing = String(e.code); }
  const { top: kept } = tree("t9b");
  let dotted = null;
  try { fs.rmSync(kept + ".", { recursive: true, force: true }); } catch (e) { dotted = String(e.code); }
  cases.rmSync = { removed: gone(top), victimIntact: intact(v), missing, dotted, dottedKept: !gone(path.join(kept, "d", "inner", "x.txt")) };
}
console.log(JSON.stringify(out));
