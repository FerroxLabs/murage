// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Direct calls into the Windows anchored-open helper (CONTRACTS-B 1.3, R1-R22), against the addon built from native/engine-exclusion.
// win32 only. Run by native-addon-msvc.yml on x64 and on windows-11-arm:
//   node --expose-gc --test native/engine-exclusion/anchored-win.node-test.mjs
// The stall, forced-failure and lifetime cases need the test-hooks build (dist-native/engine-exclusion-test/, never packaged); on a CI
// runner a missing test build FAILS those cases, elsewhere they are skipped.
//
// Known bounds, not bugs (R16, R10, R18): a non-cancellable filter wait can keep ONE stalled call's pins past the budget (capped at one
// by the admission slot); WOF-compressed and cloud-placeholder files and a junctioned profile folder are refused.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const arch = process.arch;
const mainFile = path.join(root, "dist-native", "engine-exclusion", `win32-${arch}`, "engine-exclusion.node");
const testFile = path.join(root, "dist-native", "engine-exclusion-test", `win32-${arch}`, "engine-exclusion.node");
const PLAIN = "Could not read Claude Code files.";
const onWindows = process.platform === "win32";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const addon = onWindows ? require(mainFile) : null;
let hooks = null;
if (onWindows) { try { hooks = require(testFile); } catch { hooks = null; } }
const needTestBuild = !onWindows ? "not windows" : hooks ? false : process.env.CI ? false : "no test-hooks build here";

const dirs = [];
function temp() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "anchor-")));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });

function code(fn) {
  try { fn(); } catch (error) { assert.equal(error.message, PLAIN, "message is the one plain sentence"); return error.code; }
  return "none";
}
function layout() {
  const home = temp();
  const outside = temp();
  mkdirSync(path.join(home, ".claude", "skills", "Alpha"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "skills", "Alpha", "SKILL.md"), "alpha body");
  writeFileSync(path.join(home, ".claude", "skills", "Alpha", "other.md"), "other");
  writeFileSync(path.join(outside, "canary.md"), "canary");
  return { home, outside };
}

test("the helper is exported (fails on a CI Windows runner when absent)", { skip: !onWindows && "not windows" }, () => {
  for (const name of ["anchorBegin", "anchorOpen", "anchorList", "anchorRead", "anchorStat", "anchorClose", "anchorEnd"]) {
    assert.equal(typeof addon[name], "function", name);
  }
  assert.equal(addon.version(), 11);
  assert.equal(addon.anchorTestStall, undefined, "the packaged build exports no test hook");
  assert.equal(addon.anchorTestFail, undefined);
});

test("diagnosis: which check refused a begin on a plain temp home (prints only; asserts nothing)", { skip: !hooks && "no test-hooks build" }, () => {
  const { home } = layout();
  try { hooks.anchorEnd(hooks.anchorBegin(home, 5000)); console.log("DIAG begin ok"); } catch (error) { console.log("DIAG begin refused", error.code, "why", hooks.anchorTestWhy()); }
});

test("bad names are EINVAL with no syscall effect", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  const session = addon.anchorBegin(home, 5000);
  try {
    for (const name of ["", ".", "..", "a\\b", "a/b", "a:b", "a*", "a?", 'a"', "a<", "a>", "a|", "a\u0000b", "a\u0001", "x".repeat(256)]) {
      assert.equal(code(() => addon.anchorOpen(session, name, "dir")), "EINVAL", JSON.stringify(name));
    }
  } finally { addon.anchorEnd(session); }
});

test("a non-absolute, UNC, device or extended home is EINVAL", { skip: !onWindows && "not windows" }, () => {
  for (const home of ["relative", ".\\x", "\\\\server\\share", "\\\\?\\C:\\x", "\\\\.\\C:\\x", "C:x", "C:\\a\u0000b", ""]) {
    assert.equal(code(() => addon.anchorBegin(home, 5000)), "EINVAL", JSON.stringify(home));
  }
});

test("a junction, a directory symlink and a file symlink are each ELOOP", { skip: !onWindows && "not windows" }, () => {
  const { home, outside } = layout();
  const skills = path.join(home, ".claude", "skills");
  symlinkSync(outside, path.join(skills, "J"), "junction");
  symlinkSync(outside, path.join(skills, "D"), "dir");
  symlinkSync(path.join(outside, "canary.md"), path.join(skills, "Alpha", "F.md"), "file");
  const session = addon.anchorBegin(home, 5000);
  try {
    const claude = addon.anchorOpen(session, ".claude", "dir");
    const dir = addon.anchorOpen(claude.handle, "skills", "dir");
    assert.equal(code(() => addon.anchorOpen(dir.handle, "J", "dir")), "ELOOP");
    assert.equal(code(() => addon.anchorOpen(dir.handle, "D", "dir")), "ELOOP");
    const alpha = addon.anchorOpen(dir.handle, "Alpha", "dir");
    assert.equal(code(() => addon.anchorOpen(alpha.handle, "F.md", "file")), "ELOOP");
  } finally { addon.anchorEnd(session); }
});

test("a hardlink is EMLINK, a wrong kind is ENOTDIR or EISDIR, a missing name is ENOENT", { skip: !onWindows && "not windows" }, () => {
  const { home, outside } = layout();
  linkSync(path.join(outside, "canary.md"), path.join(home, ".claude", "skills", "Alpha", "H.md"));
  const session = addon.anchorBegin(home, 5000);
  try {
    const claude = addon.anchorOpen(session, ".claude", "dir");
    const skills = addon.anchorOpen(claude.handle, "skills", "dir");
    const alpha = addon.anchorOpen(skills.handle, "Alpha", "dir");
    assert.equal(code(() => addon.anchorOpen(alpha.handle, "H.md", "file")), "EMLINK");
    assert.equal(code(() => addon.anchorOpen(alpha.handle, "SKILL.md", "dir")), "ENOTDIR");
    assert.equal(code(() => addon.anchorOpen(skills.handle, "Alpha", "file")), "EISDIR");
    assert.equal(code(() => addon.anchorOpen(alpha.handle, "Nope.md", "file")), "ENOENT");
  } finally { addon.anchorEnd(session); }
});

test("held folders cannot be renamed or deleted, held files cannot be written or deleted, and anchorEnd releases them all", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  const skills = path.join(home, ".claude", "skills");
  const session = addon.anchorBegin(home, 5000);
  const claude = addon.anchorOpen(session, ".claude", "dir");
  const dir = addon.anchorOpen(claude.handle, "skills", "dir");
  const alpha = addon.anchorOpen(dir.handle, "Alpha", "dir");
  const file = addon.anchorOpen(alpha.handle, "SKILL.md", "file");
  const fails = (fn) => { try { fn(); return false; } catch (error) { return ["EBUSY", "EPERM", "EACCES"].includes(error.code); } };
  assert.ok(fails(() => renameSync(skills, `${skills}2`)), "skills pinned");
  assert.ok(fails(() => renameSync(path.join(home, ".claude"), path.join(home, ".claude2"))), ".claude pinned");
  assert.ok(fails(() => renameSync(path.join(skills, "Alpha"), path.join(skills, "Alpha2"))), "Alpha pinned");
  assert.ok(fails(() => rmdirSync(path.join(skills, "Alpha"))), "Alpha not removable");
  assert.ok(fails(() => { const fd = openSync(path.join(skills, "Alpha", "SKILL.md"), "r+"); closeSync(fd); }), "file not writable");
  assert.ok(fails(() => unlinkSync(path.join(skills, "Alpha", "SKILL.md"))), "file not deletable");
  assert.equal(addon.anchorRead(file.handle, 0, 100).toString(), "alpha body");
  addon.anchorEnd(session);
  renameSync(skills, `${skills}2`);
  renameSync(`${skills}2`, skills);
  const fd = openSync(path.join(skills, "Alpha", "SKILL.md"), "r+");
  closeSync(fd);
  addon.anchorEnd(session); // idempotent
});

test("fileId is a non-zero bigint equal across opens of one file and different from a sibling; size and reads are exact", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  const session = addon.anchorBegin(home, 5000);
  try {
    const claude = addon.anchorOpen(session, ".claude", "dir");
    const skills = addon.anchorOpen(claude.handle, "skills", "dir");
    const alpha = addon.anchorOpen(skills.handle, "Alpha", "dir");
    const a = addon.anchorOpen(alpha.handle, "SKILL.md", "file");
    addon.anchorClose(a.handle);
    const b = addon.anchorOpen(alpha.handle, "SKILL.md", "file");
    const sibling = addon.anchorOpen(alpha.handle, "other.md", "file");
    assert.equal(typeof a.fileId, "bigint");
    assert.ok(a.fileId > 0n);
    assert.equal(a.fileId, b.fileId);
    assert.notEqual(a.fileId, sibling.fileId);
    assert.equal(a.volume, b.volume);
    assert.equal(a.nlink, 1);
    assert.equal(a.size, 10);
    const stat = addon.anchorStat(b.handle);
    assert.equal(stat.kind, "file");
    assert.equal(stat.fileId, b.fileId);
    assert.equal(stat.size, 10);
    assert.equal(addon.anchorRead(b.handle, 6, 100).toString(), "body");
    assert.equal(addon.anchorRead(b.handle, 0, 4).toString(), "alph");
    assert.equal(code(() => addon.anchorRead(b.handle, 0, 1024 * 1024 + 1)), "EINVAL");
    const listing = addon.anchorList(alpha.handle);
    assert.deepEqual([...listing.names].sort(), ["SKILL.md", "other.md"]);
    assert.equal(listing.truncated, false);
  } finally { addon.anchorEnd(session); }
});

test("a closed, foreign or other-session handle is EBADF", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  const one = addon.anchorBegin(home, 5000);
  const claudeOne = addon.anchorOpen(one, ".claude", "dir");
  const foreign = addon.openFile(path.join(home, ".claude", "skills", "Alpha", "SKILL.md"), "r");
  addon.anchorClose(claudeOne.handle);
  addon.anchorClose(claudeOne.handle); // idempotent
  assert.equal(code(() => addon.anchorOpen(claudeOne.handle, "skills", "dir")), "EBADF");
  assert.equal(code(() => addon.anchorOpen(foreign, "skills", "dir")), "EBADF");
  assert.equal(code(() => addon.anchorStat(foreign)), "EBADF");
  addon.handleClose?.(foreign);
  addon.anchorEnd(one);
  const two = addon.anchorBegin(home, 5000);
  try { assert.equal(code(() => addon.anchorOpen(claudeOne.handle, "skills", "dir")), "EBADF"); } finally { addon.anchorEnd(two); }
});

test("a one-millisecond budget then a 20 ms wait is ETIMEDOUT", { skip: !onWindows && "not windows" }, async () => {
  const { home } = layout();
  let session;
  try { session = addon.anchorBegin(home, 1); } catch (error) { assert.equal(error.code, "ETIMEDOUT"); return; }
  await wait(40);
  try { assert.equal(code(() => addon.anchorOpen(session, ".claude", "dir")), "ETIMEDOUT"); } finally { addon.anchorEnd(session); }
});

test("budget expiry, then anchorEnd, then the formerly held folder can be renamed", { skip: !onWindows && "not windows" }, async () => {
  const { home } = layout();
  const session = addon.anchorBegin(home, 400);
  const claude = addon.anchorOpen(session, ".claude", "dir");
  await wait(500);
  assert.equal(code(() => addon.anchorOpen(claude.handle, "skills", "dir")), "ETIMEDOUT");
  addon.anchorEnd(session);
  await wait(100);
  renameSync(path.join(home, ".claude"), path.join(home, ".claude2"));
});

test("no thrown message carries a digit run of 3 or more, or any part of the temp path", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  const parts = home.split(path.sep).filter((part) => part.length > 3);
  const messages = [];
  const grab = (fn) => { try { fn(); } catch (error) { messages.push(error.message); } };
  grab(() => addon.anchorBegin(path.join(home, "missing-folder-12345"), 5000));
  const session = addon.anchorBegin(home, 5000);
  try {
    grab(() => addon.anchorOpen(session, "nothing-98765", "dir"));
    grab(() => addon.anchorOpen(session, "a:b", "dir"));
  } finally { addon.anchorEnd(session); }
  assert.ok(messages.length >= 3);
  for (const message of messages) {
    assert.equal(message, PLAIN);
    assert.doesNotMatch(message, /\d{3,}/);
    for (const part of parts) assert.ok(!message.includes(part));
  }
});

test("a home that is itself a junction is ELOOP", { skip: !onWindows && "not windows" }, () => {
  const { home, outside } = layout();
  const link = path.join(temp(), "home-link");
  symlinkSync(home, link, "junction");
  assert.equal(code(() => addon.anchorBegin(link, 5000)), "ELOOP");
  void outside;
});

test("an entry opened after the session external is gone is EBADF, not a crash (needs --expose-gc)", { skip: !onWindows ? "not windows" : typeof global.gc !== "function" && "run with --expose-gc" }, async () => {
  const { home } = layout();
  let entry;
  (() => {
    const session = addon.anchorBegin(home, 5000);
    entry = addon.anchorOpen(session, ".claude", "dir");
    addon.anchorEnd(session);
  })();
  for (let i = 0; i < 5; i++) { global.gc(); await wait(20); }
  assert.equal(code(() => addon.anchorOpen(entry.handle, "skills", "dir")), "EBADF");
  for (let i = 0; i < 20; i++) addon.anchorClose(entry.handle);
  for (let i = 0; i < 5; i++) { global.gc(); await wait(20); }
});

test("anchorEnd then an immediate anchorBegin succeeds (the admission slot waits for the exiting worker)", { skip: !onWindows && "not windows" }, () => {
  const { home } = layout();
  for (let i = 0; i < 25; i++) {
    const session = addon.anchorBegin(home, 5000);
    addon.anchorOpen(session, ".claude", "dir");
    addon.anchorEnd(session);
  }
});

test("test build: a stall past the budget is ETIMEDOUT within budget + 250 ms, the loop stays live, and the next begin is EBUSY until release", { skip: needTestBuild }, async () => {
  assert.ok(hooks, "the test-hooks build must exist on CI");
  const { home } = layout();
  const event = `Local\\anchor-stall-${process.pid}-${Date.now()}`;
  const session = hooks.anchorBegin(home, 600);
  let timer = false;
  setTimeout(() => { timer = true; }, 50);
  hooks.anchorTestStall(event);
  const started = Date.now();
  assert.equal(code(() => hooks.anchorOpen(session, ".claude", "dir")), "ETIMEDOUT");
  assert.ok(Date.now() - started < 600 + 250 + 400, "returned at the deadline");
  await wait(20);
  assert.equal(timer, true, "a timer scheduled before the call fires right after it");
  assert.equal(code(() => hooks.anchorBegin(home, 5000)), "EBUSY", "one stalled worker per process");
  hooks.anchorTestRelease(event);
  await wait(300);
  hooks.anchorEnd(session);
  const next = hooks.anchorBegin(home, 5000);
  hooks.anchorEnd(next);
});

// R16: the local-storage rule (exact ERROR_INVALID_PARAMETER from FileRemoteProtocolInfo, DRIVE_FIXED, NTFS or ReFS) must pass on ReFS too.
// native-addon-msvc.yml creates a ReFS volume on a virtual disk and points ANCHOR_REFS_ROOT at it; where it cannot, the case says so and skips.
test("a home on a ReFS volume is accepted and read exactly like NTFS", { skip: !onWindows ? "not windows" : !process.env.ANCHOR_REFS_ROOT && "no ReFS volume on this machine" }, () => {
  const home = path.join(process.env.ANCHOR_REFS_ROOT, `anchor-${process.pid}`);
  mkdirSync(path.join(home, ".claude", "skills", "Alpha"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "skills", "Alpha", "SKILL.md"), "refs body");
  try {
    const session = addon.anchorBegin(home, 5000);
    try {
      const claude = addon.anchorOpen(session, ".claude", "dir");
      const skills = addon.anchorOpen(claude.handle, "skills", "dir");
      const alpha = addon.anchorOpen(skills.handle, "Alpha", "dir");
      const file = addon.anchorOpen(alpha.handle, "SKILL.md", "file");
      assert.equal(typeof file.fileId, "bigint");
      assert.equal(addon.anchorRead(file.handle, 0, 100).toString(), "refs body");
    } finally { addon.anchorEnd(session); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("test build: each forced query failure refuses the session", { skip: needTestBuild }, () => {
  const { home } = layout();
  for (const query of ["attributes", "remote", "volume", "device", "drivetype", "filesystem", "thread"]) {
    hooks.anchorTestFail(query);
    assert.notEqual(code(() => { const s = hooks.anchorBegin(home, 5000); hooks.anchorEnd(s); }), "none", query);
  }
  const ok = hooks.anchorBegin(home, 5000); // the local case passes once nothing is forced to fail
  hooks.anchorEnd(ok);
});
