// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run by link-removal.electron.test.ts under the app's own runtime
// (ELECTRON_RUN_AS_NODE=1 electron) and under plain Node. Works only inside
// the temp folder it is given. argv: <bundled link-removal.cjs> <temp folder>.
// Prints one JSON line: what the runtime's own calls do to a directory link,
// and what the helper does.
const fs = require("node:fs");
const path = require("node:path");
const helper = require(process.argv[2]);
const base = process.argv[3];
const type = process.platform === "win32" ? "junction" : "dir";
let n = 0;

function skill() {
  const dir = path.join(base, `case-${++n}`);
  const target = path.join(dir, "installed-skill");
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), "skill");
  fs.writeFileSync(path.join(target, "scripts", "run.txt"), "script");
  const discovery = path.join(dir, "discovery");
  fs.mkdirSync(discovery);
  const link = path.join(discovery, "my-skill");
  fs.symlinkSync(target, link, type);
  return { dir, target, discovery, link };
}
const intact = target => fs.existsSync(path.join(target, "SKILL.md")) && fs.existsSync(path.join(target, "scripts", "run.txt"));
const gone = p => { try { fs.lstatSync(p); return false; } catch (error) { return error.code === "ENOENT"; } };
const attempt = fn => { try { fn(); return null; } catch (error) { return String(error.code || error.message); } };

const out = { runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, platform: process.platform, raw: {}, helper: {} };

// What the runtime's own calls do (recorded, not asserted: this is the evidence).
for (const [name, fn] of Object.entries({
  rmSync: l => fs.rmSync(l),
  rmSyncRecursiveForce: l => fs.rmSync(l, { recursive: true, force: true }),
  unlinkSync: l => fs.unlinkSync(l),
  rmdirSync: l => fs.rmdirSync(l),
})) {
  const c = skill();
  const error = attempt(() => fn(c.link));
  out.raw[name] = { error, linkRemoved: gone(c.link), targetIntact: intact(c.target) };
}
{
  const c = skill();
  const stat = fs.lstatSync(c.link);
  out.raw.lstat = { isSymbolicLink: stat.isSymbolicLink(), isDirectory: stat.isDirectory() };
}

// removeLink: the link goes, the installed skill keeps every file.
{
  const c = skill();
  const removed = helper.removeLink(c.link);
  out.helper.removeLink = { removed, linkRemoved: gone(c.link), targetIntact: intact(c.target), again: helper.removeLink(c.link) };
}
// removeLink refuses a real folder.
{
  const c = skill();
  const real = path.join(c.discovery, "real-folder");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "keep.txt"), "keep");
  const error = attempt(() => helper.removeLink(real));
  out.helper.refusesRealFolder = { error, kept: fs.existsSync(path.join(real, "keep.txt")) };
}
// relinkDirectory: an earlier pin's link moves to the new projection.
{
  const c = skill();
  const next = path.join(c.dir, "next-pin-skill");
  fs.mkdirSync(next);
  fs.writeFileSync(path.join(next, "SKILL.md"), "next");
  helper.relinkDirectory(c.link, next);
  out.helper.relinkDirectory = {
    pointsAtNext: fs.readFileSync(path.join(c.link, "SKILL.md"), "utf8") === "next",
    oldTargetIntact: intact(c.target),
  };
}
// installNoFollowRmSync: from here on every fs.rmSync in this process removes
// links as links (a no-op off Windows, where rmSync already does).
out.helper.installed = helper.installNoFollowRmSync();
{
  const c = skill();
  fs.rmSync(c.link);
  const plain = { linkRemoved: gone(c.link), targetIntact: intact(c.target) };
  const d = skill();
  fs.rmSync(d.link, { recursive: true, force: true });
  const recursive = { linkRemoved: gone(d.link), targetIntact: intact(d.target) };
  // A folder holding links, one of them nested: the folder goes, the
  // folders the links point to keep every file.
  const e = skill();
  fs.writeFileSync(path.join(e.discovery, "plain.txt"), "plain");
  fs.mkdirSync(path.join(e.discovery, "nested"));
  fs.symlinkSync(e.target, path.join(e.discovery, "nested", "deeper-link"), type);
  fs.rmSync(e.discovery, { recursive: true, force: true });
  const tree = { treeRemoved: gone(e.discovery), targetIntact: intact(e.target) };
  const missing = attempt(() => fs.rmSync(path.join(base, "never-there"), { force: true }));
  out.helper.rmSync = { plain, recursive, tree, missing };
}
console.log(JSON.stringify(out));
