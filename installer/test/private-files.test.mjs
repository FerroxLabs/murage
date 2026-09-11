/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The primitives setup uses when root works inside a directory that another
 * account (the service account) controls. The account can swap any path there
 * for a symlink at any moment, so the checks work from an fd, and the file
 * work itself runs as the account (`asAccount`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inspectEnvFile, retainRecoveryCopy, writeEnvFile } from "../lib/env-file.mjs";
import { NotPlainFile, asAccount, openOwnedDir, readRegularFile } from "../lib/private-files.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "murage-private-test-"));

/** A process stand-in that records identity changes, for the non-root runs. */
function fakeProcess(euid) {
  const calls = [];
  const state = { euid, egid: 20, groups: [20, 12] };
  return {
    calls,
    state,
    proc: {
      geteuid: () => state.euid,
      getegid: () => state.egid,
      getgroups: () => [...state.groups],
      setgroups: (g) => {
        if (state.euid !== 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        calls.push(["setgroups", g]);
        state.groups = [...g];
      },
      setegid: (g) => {
        if (state.euid !== 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        calls.push(["setegid", g]);
        state.egid = g;
      },
      seteuid: (u) => {
        calls.push(["seteuid", u]);
        state.euid = u;
      },
    },
  };
}

test("asAccount runs the work with the account's uid, gid and groups, and gives root back afterwards", () => {
  const fake = fakeProcess(0);
  const seen = asAccount({ uid: 1001, gid: 1001, groups: [1001, 27] }, () => ({ ...fake.state, groups: [...fake.state.groups] }), {
    proc: fake.proc,
  });
  assert.deepEqual(seen, { euid: 1001, egid: 1001, groups: [1001, 27] }, "the work ran as the account");
  assert.deepEqual(fake.calls, [
    ["setgroups", [1001, 27]],
    ["setegid", 1001],
    ["seteuid", 1001],
    // back: euid first, since only root can put the gid and groups back
    ["seteuid", 0],
    ["setegid", 20],
    ["setgroups", [20, 12]],
  ]);
  assert.deepEqual(fake.state, { euid: 0, egid: 20, groups: [20, 12] });
});

test("asAccount gives root back when the work throws", () => {
  const fake = fakeProcess(0);
  assert.throws(
    () =>
      asAccount({ uid: 1001, gid: 1001 }, () => {
        throw new Error("the work failed");
      }, { proc: fake.proc }),
    /the work failed/
  );
  assert.deepEqual(fake.state, { euid: 0, egid: 20, groups: [20, 12] });
});

test("asAccount changes nothing when the process is not root, or has no account to act for", () => {
  const user = fakeProcess(501);
  assert.equal(asAccount({ uid: 1001, gid: 1001 }, () => "ran", { proc: user.proc }), "ran");
  const root = fakeProcess(0);
  assert.equal(asAccount(null, () => "ran", { proc: root.proc }), "ran");
  assert.equal(asAccount({ uid: 0, gid: 0 }, () => "ran", { proc: root.proc }), "ran");
  assert.deepEqual([...user.calls, ...root.calls], []);
});

test("readRegularFile reads through an fd: it refuses a symlink, a FIFO and a file with the wrong owner", () => {
  const dir = scratch();
  const file = join(dir, "real.env");
  writeFileSync(file, "A=1\n");
  assert.deepEqual(readRegularFile(file)?.bytes, Buffer.from("A=1\n"));
  assert.equal(readRegularFile(join(dir, "absent")), null);

  const victim = join(dir, "victim");
  writeFileSync(victim, "ROOT_ONLY_CONTENT\n", { mode: 0o600 });
  const link = join(dir, "link.env");
  symlinkSync(victim, link);
  assert.throws(() => readRegularFile(link), NotPlainFile);

  const fifo = join(dir, "fifo.env");
  const made = spawnSync("mkfifo", [fifo]);
  assert.equal(made.status, 0, "mkfifo is available on the platforms the installer runs on");
  // O_NONBLOCK: a FIFO planted at the path must not hang setup on open().
  assert.throws(() => readRegularFile(fifo), NotPlainFile);

  assert.throws(() => readRegularFile(file, { uid: process.getuid() + 1 }), /is owned by uid/);
});

test("openOwnedDir refuses a symlinked, foreign or shared-writable directory", () => {
  const root = scratch();
  const real = join(root, "real");
  mkdirSync(real);
  chmodSync(real, 0o755);
  const { fd, mode } = openOwnedDir(real);
  assert.ok(Number.isInteger(fd));
  assert.equal(mode, 0o755);
  closeSync(fd);

  const link = join(root, "link");
  symlinkSync(real, link);
  assert.throws(() => openOwnedDir(link), /not a plain directory/);
  assert.throws(() => openOwnedDir(real, { uid: process.getuid() + 1 }), /is owned by uid/);
  chmodSync(real, 0o775);
  assert.throws(() => openOwnedDir(real), /writable by other accounts/);
});

// ── Real identity switching: root only ────────────────────────────────────
// A non-root test process cannot change its uid, so these run where the test
// runner is root: the Linux container in the lane report (the same image the
// sudo proofs use). Everywhere else the fake-process tests above cover the
// call sequence.

const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
const NOBODY = { uid: 65534, gid: 65534 };

test(
  "as root: the service account's swap of the env file for a symlink to a root-only file leaks nothing",
  { skip: isRoot ? false : "needs a root test runner (the Linux container run in the lane report)" },
  () => {
    const top = scratch();
    chmodSync(top, 0o755);
    const secret = join(top, "root-only");
    writeFileSync(secret, "ROOT_ONLY_CONTENT\n", { mode: 0o600 });
    const data = join(top, "data");
    mkdirSync(data, { mode: 0o700 });
    chownSync(data, NOBODY.uid, NOBODY.gid);
    const env = join(data, "murage.env");
    asAccount(NOBODY, () => writeFileSync(env, "ANTHROPIC_API_KEY=sk-ant-OLD\n", { mode: 0o600 }));

    const inspected = asAccount(NOBODY, () => inspectEnvFile(env, { uid: NOBODY.uid }));
    assert.deepEqual(inspected.problems, []);

    // The account swaps the file during the prompts.
    asAccount(NOBODY, () => {
      spawnSync("rm", [env]);
      symlinkSync(secret, env);
    });
    assert.ok(lstatSync(env).isSymbolicLink());

    // Even a plain read that follows the link is denied while acting as the account.
    assert.throws(() => asAccount(NOBODY, () => readFileSync(env)), { code: "EACCES" });
    // A copy with no inspected bytes is refused outright.
    assert.throws(() => asAccount(NOBODY, () => retainRecoveryCopy(env, { owner: NOBODY })), NotPlainFile);
    // The copy setup makes holds the bytes it inspected, and belongs to the account.
    const copy = asAccount(NOBODY, () => retainRecoveryCopy(env, { owner: NOBODY, bytes: inspected.bytes }));
    assert.equal(readFileSync(copy, "utf8"), "ANTHROPIC_API_KEY=sk-ant-OLD\n");
    assert.equal(statSync(copy).uid, NOBODY.uid);
    assert.equal(process.geteuid(), 0, "root is given back");
  }
);

test(
  "as root: a data directory swapped for a symlink to a root directory is neither chmodded nor written",
  { skip: isRoot ? false : "needs a root test runner (the Linux container run in the lane report)" },
  () => {
    const top = scratch();
    chmodSync(top, 0o755);
    const home = join(top, "home");
    mkdirSync(home, { mode: 0o755 });
    chownSync(home, NOBODY.uid, NOBODY.gid);
    const rootDir = join(top, "etc-like");
    mkdirSync(rootDir, { mode: 0o755 });
    chmodSync(rootDir, 0o755);
    const data = join(home, "data");
    asAccount(NOBODY, () => symlinkSync(rootDir, data));

    assert.throws(() => asAccount(NOBODY, () => writeEnvFile(join(data, "murage.env"), { A: "1" }, { owner: NOBODY })));
    assert.equal(statSync(rootDir).mode & 0o777, 0o755, "the link's target keeps its mode");
    assert.throws(() => lstatSync(join(rootDir, "murage.env")), { code: "ENOENT" });
    assert.equal(process.geteuid(), 0, "root is given back");
  }
);
