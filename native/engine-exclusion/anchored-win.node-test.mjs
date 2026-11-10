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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
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
// A hosted-runner administrator's Node process holds SeBackupPrivilege/SeRestorePrivilege ENABLED, which the helper refuses by design
// (a standard user never has them). The test build can remove them from this process first; the real addon then sees the same token.
if (hooks) hooks.anchorTestDropPrivileges();
const needTestBuild =!onWindows ? "not windows" : hooks ? false : process.env.CI ? false : "no test-hooks build here";

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

// R18 and R22b share the reparse-convert fixture (native/engine-exclusion/test/reparse-convert.c, built with the test hooks).
const fixture = path.join(root, "dist-native", "engine-exclusion-test", `win32-${arch}`, "reparse-convert.exe");

test("R18: a home emptied and converted in place to a mount point by a restricted-token process is ELOOP from anchorBegin", { skip: needTestBuild }, () => {
  assert.ok(existsSync(fixture), "reparse-convert.exe must exist on CI");
  const home = temp();
  const outside = temp();
  mkdirSync(path.join(outside, ".claude"));
  writeFileSync(path.join(outside, ".claude.json"), "{}");
  execFileSync(fixture, ["--restricted", home, outside], { windowsHide: true, timeout: 60000 });
  assert.ok(lstatSync(home).isSymbolicLink(), "the home is now a reparse point");
  assert.equal(code(() => addon.anchorBegin(home, 5000)), "ELOOP");
  assert.equal(code(() => hooks.anchorBegin(home, 5000)), "ELOOP");
});

test("R22b: the held, emptied parent turned into a mount point between the parent re-query and the open is ELOOP, with no byte read", { skip: needTestBuild }, async () => {
  assert.ok(hooks && existsSync(fixture), "the test-hooks build and reparse-convert.exe must exist on CI");
  const home = temp();
  const outside = temp();
  mkdirSync(path.join(outside, ".claude"));
  writeFileSync(path.join(outside, ".claude", "canary.md"), "canary");
  const tag = `${process.pid}-${Date.now()}`;
  const release = `Local\\anchor-open-release-${tag}`;
  const arrived = `Local\\anchor-open-arrived-${tag}`;
  const session = hooks.anchorBegin(home, 15000);
  try {
    hooks.anchorTestStallOpen(release, arrived);
    const child = spawn(fixture, [home, outside, arrived, release], { stdio: "ignore", windowsHide: true });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const result = code(() => hooks.anchorOpen(session, ".claude", "dir"));
    assert.equal(await exited, 0, "the fixture converted the parent");
    assert.ok(lstatSync(home).isSymbolicLink(), "the swap took effect");
    assert.equal(result, "ELOOP");
  } finally {
    hooks.anchorEnd(session);
  }
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
  let foreign;
  try {
    foreign = addon.openFile(path.join(home, ".claude", "skills", "Alpha", "SKILL.md"), 2);  // kind 2: shared
    addon.anchorClose(claudeOne.handle);
    addon.anchorClose(claudeOne.handle); // idempotent
    assert.equal(code(() => addon.anchorOpen(claudeOne.handle, "skills", "dir")), "EBADF");
    assert.equal(code(() => addon.anchorOpen(foreign, "skills", "dir")), "EBADF");
    assert.equal(code(() => addon.anchorStat(foreign)), "EBADF");
  } finally {
    if (foreign) addon.handleClose?.(foreign);
    addon.anchorEnd(one);  // always: a failed assertion must not leave the admission slot taken for every later case
  }
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
  assert.ok(Date.now() - started < 600 + 250, `returned within budget + 250 ms (R14), took ${Date.now() - started} ms`);
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
// native-addon-msvc.yml creates a ReFS volume on a virtual disk and points ANCHOR_REFS_ROOT at it. Where the workflow expects that volume
// (ANCHOR_REFS_EXPECTED=1, the x64 job) a missing volume FAILS this case; it skips only on a machine nobody expects one on.
test("a home on a ReFS volume is accepted and read exactly like NTFS", { skip: !onWindows ? "not windows" : !process.env.ANCHOR_REFS_ROOT && !process.env.ANCHOR_REFS_EXPECTED && "no ReFS volume on this machine" }, () => {
  assert.ok(process.env.ANCHOR_REFS_ROOT, "ANCHOR_REFS_EXPECTED is set, so the ReFS volume must exist (its setup step must not be skipped or ignored)");
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

// ---- Astra acct6 review round 1: tests for each item (these were written first and failed against the unfixed helper) ----
const stats = () => hooks.anchorTestStats();
async function settle(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await wait(25); }
  return predicate();
}
async function collect(rounds = 10) { for (let i = 0; i < rounds; i++) { global.gc?.(); await wait(30); } }
/** anchorBegin that rides out the previous worker's exit (EBUSY) for up to ~2 s; any other failure is rethrown. */
async function beginWhenFree(home, budget) {
  for (let i = 0; i < 400; i++) {
    try { return hooks.anchorBegin(home, budget); } catch (error) { if (error.code !== "EBUSY") throw error; await wait(5); }
  }
  return hooks.anchorBegin(home, budget);
}

test("R22b (Astra item 4): an open is compared with the FileNameInfo cached at begin (Session) and at open (Entry), not with a fresh query", { skip: needTestBuild }, () => {
  const { home } = layout();
  const session = hooks.anchorBegin(home, 5000);
  try {
    const claude = hooks.anchorOpen(session, ".claude", "dir");
    hooks.anchorTestCorruptName(session);
    assert.equal(code(() => hooks.anchorOpen(session, ".claude", "dir")), "ELOOP", "the Session's cached home name is what a child is compared with");
    hooks.anchorTestCorruptName(claude.handle);
    assert.equal(code(() => hooks.anchorOpen(claude.handle, "skills", "dir")), "ELOOP", "the Entry's cached name is what its child is compared with");
  } finally { hooks.anchorEnd(session); }
});

test("R21 (Astra item 5): a stalled CLOSE holds the admission slot, so the next begin is EBUSY until release and cleanup, then succeeds", { skip: needTestBuild }, async () => {
  const { home } = layout();
  const event = `Local\\anchor-closestall-${process.pid}-${Date.now()}`;
  const session = await beginWhenFree(home, 5000);
  const claude = hooks.anchorOpen(session, ".claude", "dir");
  hooks.anchorTestStall(event);
  hooks.anchorClose(claude.handle);
  hooks.anchorEnd(session);
  assert.equal(code(() => hooks.anchorBegin(home, 300)), "EBUSY", "the worker is parked on the close and still owns the slot");
  hooks.anchorTestRelease(event);
  const next = await beginWhenFree(home, 5000);
  hooks.anchorEnd(next);
});

test("R2/R12 (Astra item 3): a begin that fails for a non-timeout reason has closed its handles before it throws", { skip: needTestBuild }, async () => {
  const { home } = layout();
  const event = `Local\\anchor-exitstall-${process.pid}-${Date.now()}`;
  await beginWhenFree(home, 5000).then((s) => hooks.anchorEnd(s));
  hooks.anchorTestStallExit(event);   // the exiting worker parks just before its final close-all, so only cleanup done BEFORE the throw counts
  hooks.anchorTestFail("device");
  let moved = false;
  try {
    assert.notEqual(code(() => hooks.anchorBegin(home, 5000)), "none", "the forced failure refuses the begin");
    renameSync(home, `${home}-moved`);   // fails with a sharing violation while the failed begin still holds the home
    moved = true;
    renameSync(`${home}-moved`, home);
  } finally {
    hooks.anchorTestRelease(event);
    if (!moved) await wait(200);
  }
  assert.ok(moved, "the home of a failed begin is free the moment the error is thrown");
  hooks.anchorEnd(await beginWhenFree(home, 5000));
});

test("R13 (Astra item 5): the completion/timeout race, 1,000 runs with the stall ending at the boundary, leaks no handle and frees nothing twice", { skip: needTestBuild, timeout: 600000 }, async () => {
  const { home } = layout();
  hooks.anchorEnd(await beginWhenFree(home, 5000));
  await collect();
  const base = stats().handles;
  const runs = Number(process.env.ANCHOR_RACE_RUNS ?? 1000);
  const outcome = { none: 0, ETIMEDOUT: 0, other: 0 };
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    let session;
    try { session = await beginWhenFree(home, 30); } catch { outcome.other++; continue; }
    const remaining = 30 - (Date.now() - t0);
    hooks.anchorTestStallMs(Math.max(0, remaining + ((i % 9) - 4)));
    let entry = null;
    const result = code(() => { entry = hooks.anchorOpen(session, ".claude", "dir"); });
    outcome[result === "none" || result === "ETIMEDOUT" ? result : "other"]++;
    if (entry) hooks.anchorClose(entry.handle);
    hooks.anchorEnd(session);
    entry = null;
    session = null;
  }
  assert.ok(outcome.none + outcome.ETIMEDOUT > runs / 2, `most runs end as a completion or a timeout: ${JSON.stringify(outcome)}`);
  const clean = await settle(() => { global.gc(); const s = stats(); return s.handles - base <= 2 && s.sessions === 0 && s.entries === 0; }, 20000);
  assert.ok(clean, `the process handle count returns to its baseline (${base}) and every Session and Entry is freed: ${JSON.stringify(stats())}`);
  assert.equal(stats().badFinalize, 0, "no finalizer ran on a freed struct");
  const ok = await beginWhenFree(home, 5000);
  hooks.anchorEnd(ok);
});

test("R19 (Astra item 2): an external that was created but could not be tagged keeps its finalizer as the one owner (no double release)", { skip: needTestBuild }, async () => {
  const { home } = layout();
  await collect();
  hooks.anchorTestFail("tag");
  assert.equal(code(() => hooks.anchorBegin(home, 5000)), "EIO");
  const session = await beginWhenFree(home, 5000);
  hooks.anchorTestFail("tag");
  assert.equal(code(() => hooks.anchorOpen(session, ".claude", "dir")), "EIO");
  hooks.anchorEnd(session);
  await collect(20);
  assert.equal(stats().badFinalize, 0, "no finalizer ran on a struct that had already been freed");
  assert.equal(stats().entries, 0, "the Entry was freed exactly once");
  hooks.anchorEnd(await beginWhenFree(home, 5000));
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

// Keep this case LAST: against an unfixed helper the lost close-all leaves the worker parked for good (the admission slot stays taken).
test("R2/R13 (Astra item 1): a close-all that cannot be allocated is still carried out (shutdown needs no allocation)", { skip: needTestBuild }, async () => {
  const { home } = layout();
  const session = await beginWhenFree(home, 5000);
  hooks.anchorOpen(session, ".claude", "dir");
  hooks.anchorTestFail("closealloc");
  hooks.anchorEnd(session);
  const claude = path.join(home, ".claude");
  const freed = await settle(() => { try { renameSync(claude, `${claude}2`); return true; } catch { return false; } }, 4000);
  hooks.anchorTestFail("none");
  assert.ok(freed, "the held folder is released although the close-all request could not be allocated");
});
