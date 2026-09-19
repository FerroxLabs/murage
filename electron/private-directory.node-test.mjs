import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { tightenOwnedDirectory } from "./private-directory.mjs";

const POSIX_ONLY = process.platform === "win32" && "directory modes are POSIX-only";
function place(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-private-dir-")));
  t.after(() => safeWipeSync(root));
  return root;
}

test("a group-writable data folder this user owns loses only its group and other write bits", { skip: POSIX_ONLY }, t => {
  const root = place(t), data = path.join(root, ".murage");
  mkdirSync(data); chmodSync(data, 0o775);
  assert.equal(tightenOwnedDirectory(data), true);
  assert.equal(lstatSync(data).mode & 0o7777, 0o755);
  // Already private: nothing to change.
  assert.equal(tightenOwnedDirectory(data), false);
  chmodSync(data, 0o777); tightenOwnedDirectory(data);
  assert.equal(lstatSync(data).mode & 0o7777, 0o755);
});

test("a folder owned by someone else, a symlink or a missing folder is left alone", { skip: POSIX_ONLY }, t => {
  const root = place(t), data = path.join(root, "shared");
  mkdirSync(data); chmodSync(data, 0o775);
  assert.equal(tightenOwnedDirectory(data, { uid: process.getuid() + 1 }), false);
  assert.equal(lstatSync(data).mode & 0o7777, 0o775);
  const link = path.join(root, "link"); symlinkSync(data, link, "dir");
  assert.equal(tightenOwnedDirectory(link), false);
  assert.equal(lstatSync(data).mode & 0o7777, 0o775);
  assert.equal(tightenOwnedDirectory(path.join(root, "missing")), false);
});

test("Windows has no POSIX modes to tighten", () => {
  assert.equal(tightenOwnedDirectory("C:\\Users\\me\\.murage", { platform: "win32", uid: 0 }), false);
});
