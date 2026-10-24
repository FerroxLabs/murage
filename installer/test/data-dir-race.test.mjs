/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Audit 08-1: `murage setup --service-user <account>` run as root created the
 * data directory, then opened it again by path and chowned what it opened.
 * O_NOFOLLOW guards only the last component, so the account could swap a
 * parent it owns for a symlink in between and have root re-own a system
 * directory (`/etc/systemd/system`). Root must not act inside directories the
 * account controls; that work runs as the account.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import * as serviceAccount from "../lib/service-account.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const fs = createRequire(import.meta.url)("node:fs");

const scratchDirs = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-data-dir-race-")));
  scratchDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratchDirs) safeWipeSync(dir);
});

/**
 * Pretend this process is root that can wear another account's identity, and
 * record the effective uid behind every file operation setup makes. The real
 * kernel still checks the real (unprivileged) test user, so nothing escapes.
 */
function asFakeRoot(run, onMkdir) {
  let euid = 0;
  const saved = {
    geteuid: process.geteuid, getegid: process.getegid, getgroups: process.getgroups,
    setgroups: process.setgroups, setegid: process.setegid, seteuid: process.seteuid,
  };
  const fsSaved = { mkdirSync: fs.mkdirSync, openSync: fs.openSync, fchmodSync: fs.fchmodSync, fchownSync: fs.fchownSync };
  /** @type {Array<{ op: string, euid: number, path?: string }>} */
  const ops = [];
  process.geteuid = () => euid;
  process.getegid = () => 0;
  process.getgroups = () => [0];
  process.setgroups = () => {};
  process.setegid = () => {};
  process.seteuid = (uid) => { euid = uid; };
  fs.mkdirSync = (path, options) => {
    ops.push({ op: "mkdir", euid, path: String(path) });
    const made = fsSaved.mkdirSync(path, options);
    onMkdir?.(String(path));
    return made;
  };
  fs.openSync = (path, ...rest) => { ops.push({ op: "open", euid, path: String(path) }); return fsSaved.openSync(path, ...rest); };
  fs.fchmodSync = (fd, mode) => { ops.push({ op: "fchmod", euid }); return fsSaved.fchmodSync(fd, mode); };
  fs.fchownSync = () => { ops.push({ op: "fchown", euid }); };
  syncBuiltinESMExports();
  try {
    return { result: run(), ops };
  } catch (error) {
    return { error, ops };
  } finally {
    Object.assign(process, saved);
    Object.assign(fs, fsSaved);
    syncBuiltinESMExports();
  }
}

test("root preparing the data directory for another account does nothing as root inside directories that account controls (08-1)", () => {
  const root = scratch();
  const state = join(root, "state"); // the service account's own directory
  mkdirSync(state, { mode: 0o755 });
  const system = join(root, "etc-systemd", "system"); // stands in for /etc/systemd/system
  mkdirSync(system, { recursive: true, mode: 0o755 });
  const dataDir = join(state, "system");
  const account = { user: "svc", uid: process.getuid(), gid: process.getgid(), groups: [process.getgid()] };

  let swapped = false;
  const { ops, error } = asFakeRoot(
    () => serviceAccount.prepareDataDir(dataDir, account, { euid: 0 }),
    (path) => {
      // The account races setup: as soon as the directory exists, its parent
      // becomes a link to the system directory's parent.
      if (swapped || !path.startsWith(state)) return;
      swapped = true;
      renameSync(state, `${state}-aside`);
      symlinkSync(join(root, "etc-systemd"), state);
    }
  );
  void error; // refusing is fine; acting as root is not
  assert.ok(swapped, "the race was run");
  const underAccount = ops.filter((op) => op.path === undefined || op.path.startsWith(root));
  assert.ok(underAccount.length > 0);
  assert.deepEqual(underAccount.filter((op) => op.euid === 0), [], "no operation inside the account's directories ran as root");
  assert.deepEqual(ops.filter((op) => op.op === "fchown" && op.euid === 0), [], "root re-owned nothing");
  // Whatever the planted link reached was reached as the account, so on a real
  // host the kernel refuses it for a root-owned directory. (Here the test user
  // owns the stand-in, so its mode says nothing either way.)
});

test("root acts on its own only under directories only root can change, and creates at most the first missing one", () => {
  const dir = (uid, mode) => ({ uid, mode, isDirectory: () => true, isSymbolicLink: () => false });
  const link = () => ({ uid: 0, mode: 0o777, isDirectory: () => false, isSymbolicLink: () => true });
  const tree = {
    "/": dir(0, 0o755),
    "/var": dir(0, 0o755),
    "/var/lib": dir(0, 0o755),
    "/home": dir(0, 0o755),
    "/home/svc": dir(1001, 0o750),
    "/srv": dir(0, 0o775),
    "/tmp": dir(0, 0o1777),
    "/data": link(),
    "/mnt": dir(0, 0o755),
    "/mnt/data": dir(0, 0o755),
    "/opt": link(),
    "/home/svc/opt": dir(1001, 0o755),
  };
  const lstat = (p) => {
    if (!tree[p]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return tree[p];
  };
  const realpath = (p) => ({ "/data": "/mnt/data", "/opt": "/home/svc/opt" })[p] ?? p;
  const at = (path) => serviceAccount.rootTrustedPrefix(path, { lstat, realpath });
  assert.equal(typeof serviceAccount.rootTrustedPrefix, "function");
  assert.deepEqual(at("/var/lib/murage/data"), { trusted: "/var/lib", next: "/var/lib/murage" });
  assert.deepEqual(at("/home/svc/.murage-server"), { trusted: "/home", next: null }, "the account's home is the account's to work in");
  assert.deepEqual(at("/home/other/.murage-server"), { trusted: "/home", next: "/home/other" });
  assert.deepEqual(at("/srv/murage"), { trusted: "/", next: null }, "a group-writable directory is not root's alone");
  assert.deepEqual(at("/tmp/murage"), { trusted: "/", next: null });
  assert.deepEqual(at("/data/murage"), { trusted: "/mnt/data", next: "/mnt/data/murage" }, "a link in a closed directory is followed to a closed place");
  assert.deepEqual(at("/opt/murage"), { trusted: "/", next: null }, "a link into the account's directories is not");
});
