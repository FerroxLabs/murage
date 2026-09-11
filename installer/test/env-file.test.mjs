/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { setupEnvBag } from "../bin/murage.mjs";
import {
  envFilePermissions,
  inspectEnvFile,
  isSecretKey,
  parseEnv,
  readEnvFile,
  redact,
  retainRecoveryCopy,
  serializeEnv,
  writeEnvFile,
} from "../lib/env-file.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "murage-env-test-"));

test("round-trips through a 0600 file in a 0700 directory", () => {
  const dir = join(scratch(), "nested");
  const path = join(dir, "murage.env");
  writeEnvFile(path, { MURAGE_PORT: "8799", ANTHROPIC_API_KEY: "sk-ant-secret" });
  assert.deepEqual(readEnvFile(path), { MURAGE_PORT: "8799", ANTHROPIC_API_KEY: "sk-ant-secret" });
  assert.equal(statSync(path).mode & 0o777, 0o600, "must be 0600 even under a permissive umask");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the written file never contains a wildcard-bind switch", () => {
  const text = serializeEnv({ MURAGE_BIND_MODE: "loopback", MURAGE_PORT: "8799" });
  // Wayland's equivalent writes ALLOW_REMOTE=true here, which is what puts its
  // admin UI on a public IP. Assert the shape of ours can never say that.
  assert.ok(!/ALLOW_REMOTE/i.test(text));
  assert.ok(!/0\.0\.0\.0/.test(text));
  assert.match(text, /^MURAGE_BIND_MODE=loopback$/m);
});

test("a newline in a value is refused, so one setting cannot inject another", () => {
  assert.throws(() => serializeEnv({ A: "one\nMURAGE_BIND_MODE=public" }), /contains a newline/);
  assert.throws(() => serializeEnv({ A: "one\rtwo" }), /contains a newline/);
});

test("a malformed key is refused", () => {
  for (const key of ["has space", "1leading", "has=equals", ""]) {
    assert.throws(() => serializeEnv({ [key]: "v" }), /malformed env key/, key);
  }
});

test("parseEnv ignores comments and blanks, and keeps '=' inside values", () => {
  const parsed = parseEnv("# c\n\nA=1\nB=x=y\n  C=3  \n=novalue\n");
  assert.deepEqual(parsed, { A: "1", B: "x=y", C: "3" });
});

test("a missing file reads as empty rather than throwing", () => {
  assert.deepEqual(readEnvFile(join(scratch(), "absent.env")), {});
});

test("secret keys are recognised and redacted for display", () => {
  for (const k of ["ANTHROPIC_API_KEY", "MURAGE_TS_AUTHKEY", "X_TOKEN", "Y_SECRET", "ADMIN_PASSWORD"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  assert.equal(isSecretKey("MURAGE_PORT"), false);
  assert.deepEqual(redact({ MURAGE_PORT: "8799", OPENAI_API_KEY: "sk-live" }), {
    MURAGE_PORT: "8799",
    OPENAI_API_KEY: "<redacted>",
  });
});

test("envFilePermissions reports a world-readable key file as NOT private", () => {
  const dir = scratch();
  const path = join(dir, "leaky.env");
  writeFileSync(path, "OPENAI_API_KEY=sk-live\n", { mode: 0o644 });
  const perms = envFilePermissions(path);
  assert.equal(perms.exists, true);
  assert.equal(perms.private, false, "0644 holds an API key readable by every user on the box");

  writeEnvFile(path, { OPENAI_API_KEY: "sk-live" });
  assert.equal(envFilePermissions(path).private, true);
  assert.deepEqual(envFilePermissions(join(dir, "nope.env")), { exists: false, mode: null, private: false });
});

// ── I3: a rerun edits the file; it does not start it over ─────────────────

test("an interrupted replacement leaves the previous complete file and no stray temp file", () => {
  const dir = scratch();
  const path = join(dir, "murage.env");
  writeEnvFile(path, { ANTHROPIC_API_KEY: "sk-ant-old", MURAGE_PORT: "9100" });
  const before = readFileSync(path, "utf8");
  const crash = () => {
    throw Object.assign(new Error("simulated crash before the rename"), { code: "EIO" });
  };
  assert.throws(() => writeEnvFile(path, { MURAGE_PORT: "8799" }, { rename: crash }), /simulated crash/);
  assert.equal(readFileSync(path, "utf8"), before, "the old file is complete and unchanged");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["murage.env"], "the half-published temp file is removed");
});

test("the replacement is a new private file, and a symlinked env file is never written through", () => {
  const dir = scratch();
  const path = join(dir, "murage.env");
  writeFileSync(path, "OPENAI_API_KEY=sk-live\n", { mode: 0o644 });
  chmodSync(path, 0o644);
  const oldInode = statSync(path).ino;
  writeEnvFile(path, { OPENAI_API_KEY: "sk-live", MURAGE_PORT: "8799" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.notEqual(statSync(path).ino, oldInode, "published by rename, not by truncating the old file in place");

  const target = join(dir, "elsewhere.env");
  writeFileSync(target, "A=1\n");
  const link = join(dir, "linked.env");
  symlinkSync(target, link);
  assert.deepEqual(inspectEnvFile(link), {
    exists: true,
    bag: {},
    problems: [`${link} is not a regular file (a symlink or something else)`],
    bytes: null,
  });
  writeEnvFile(link, { B: "2" });
  assert.equal(readFileSync(target, "utf8"), "A=1\n", "the link's target is untouched");
});

test("inspectEnvFile carries a valid file over, and refuses one it cannot without quoting any line", () => {
  const dir = scratch();
  assert.deepEqual(inspectEnvFile(join(dir, "absent.env")), { exists: false, bag: {}, problems: [], bytes: null });

  const good = join(dir, "good.env");
  writeFileSync(good, "# comment\nANTHROPIC_API_KEY=sk-ant-1\nCUSTOM=a=b\n\n");
  assert.deepEqual(inspectEnvFile(good), {
    exists: true,
    bag: { ANTHROPIC_API_KEY: "sk-ant-1", CUSTOM: "a=b" },
    problems: [],
    bytes: Buffer.from("# comment\nANTHROPIC_API_KEY=sk-ant-1\nCUSTOM=a=b\n\n"),
  });

  const bad = join(dir, "bad.env");
  writeFileSync(bad, "OPENAI_API_KEY=sk-SECRETVALUE\nsk-proj-PASTEDWITHOUTANAME\nhas space=1\n");
  const r = inspectEnvFile(bad);
  assert.deepEqual(r.problems, ["line 2 is not KEY=value", "line 3 has a key that is not a valid name"]);
  assert.deepEqual(r.bag, {}, "a file with problems is not partially carried over");
  assert.ok(!/SECRETVALUE|PASTEDWITHOUTANAME/.test(r.problems.join("\n")));
});

test("retainRecoveryCopy keeps the exact previous bytes beside the file, private", () => {
  const dir = scratch();
  const path = join(dir, "murage.env");
  assert.equal(retainRecoveryCopy(path), null, "nothing to keep when there is no file");
  writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-only-copy\n# a comment setup would not write\n");
  const copy = retainRecoveryCopy(path);
  assert.equal(copy, `${path}.previous`);
  assert.equal(readFileSync(copy, "utf8"), "ANTHROPIC_API_KEY=sk-ant-only-copy\n# a comment setup would not write\n");
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-second\n");
  retainRecoveryCopy(path);
  assert.equal(readFileSync(copy, "utf8"), "ANTHROPIC_API_KEY=sk-ant-second\n");
});

// ── the file or its directory swapped for a symlink after inspection ──────
// When root runs setup for the service account, that account owns the data
// directory and has the whole enrolment and key prompt to swap things. Root's
// own protection is `asAccount` (private-files.test.mjs runs it as root); these
// check that the env-file code never re-reads or re-follows a path either.

test("a file swapped for a symlink between inspection and the recovery copy: the copy holds the inspected bytes", () => {
  const dir = scratch();
  const victim = join(dir, "victim-secret");
  writeFileSync(victim, "ROOT_ONLY_CONTENT\n", { mode: 0o600 });
  const path = join(dir, "murage.env");
  writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-OLD\n", { mode: 0o600 });

  const inspected = inspectEnvFile(path, { uid: process.getuid() });
  assert.deepEqual(inspected.problems, []);
  unlinkSync(path);
  symlinkSync(victim, path);

  const copy = retainRecoveryCopy(path, { bytes: inspected.bytes });
  assert.equal(readFileSync(copy, "utf8"), "ANTHROPIC_API_KEY=sk-ant-OLD\n", "the bytes that were checked, not the link's target");
  assert.ok(!readFileSync(copy, "utf8").includes("ROOT_ONLY_CONTENT"));

  // Without the inspected bytes, the path is read through a no-follow fd, and
  // the link is refused: no copy is made at all.
  rmSync(copy);
  assert.throws(() => retainRecoveryCopy(path), /not a regular file/);
  assert.throws(() => lstatSync(copy), { code: "ENOENT" });
  // A regular file that belongs to someone other than the account is refused too.
  unlinkSync(path);
  writeFileSync(path, "A=1\n");
  assert.throws(() => retainRecoveryCopy(path, { owner: { uid: process.getuid() + 1, gid: process.getgid() } }), /is owned by uid/);
  assert.throws(() => lstatSync(copy), { code: "ENOENT" });
});

test("inspectEnvFile reports a file with the wrong owner, and a FIFO, without hanging or reading them", () => {
  const dir = scratch();
  const path = join(dir, "murage.env");
  writeFileSync(path, "A=1\n");
  const foreign = inspectEnvFile(path, { uid: process.getuid() + 1 });
  assert.equal(foreign.bytes, null);
  assert.deepEqual(foreign.bag, {});
  assert.match(foreign.problems.join("\n"), /is owned by uid/);

  const fifo = join(dir, "fifo.env");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.deepEqual(inspectEnvFile(fifo).problems, [`${fifo} is not a regular file (a symlink or something else)`]);
});

test("writeEnvFile refuses a symlinked directory: the target is not chmodded and nothing is published in it", () => {
  const root = scratch();
  const real = join(root, "elsewhere");
  mkdirSync(real);
  chmodSync(real, 0o755);
  const link = join(root, "datalink");
  symlinkSync(real, link);

  assert.throws(() => writeEnvFile(join(link, "murage.env"), { A: "1" }), /not a plain directory/);
  assert.equal(statSync(real).mode & 0o777, 0o755, "the link's target keeps its mode");
  assert.deepEqual(readdirSync(real), [], "nothing was published through the link");
});

test("writeEnvFile writes only into a directory the owner holds and nobody else can write, and chmods only one it created", () => {
  const root = scratch();
  const existing = join(root, "existing");
  mkdirSync(existing);
  chmodSync(existing, 0o755);
  writeEnvFile(join(existing, "murage.env"), { A: "1" });
  assert.equal(statSync(join(existing, "murage.env")).mode & 0o777, 0o600);
  // Behaviour change in this fix: an existing directory is no longer chmodded
  // (setup tightens the data directory itself, through an fd, in prepareDataDir).
  assert.equal(statSync(existing).mode & 0o777, 0o755);

  const other = { uid: process.getuid() + 1, gid: process.getgid() };
  assert.throws(() => writeEnvFile(join(existing, "murage.env"), { A: "2" }, { owner: other }), /is owned by uid/);
  assert.equal(readFileSync(join(existing, "murage.env"), "utf8").includes("A=1"), true, "the refused write changed nothing");

  const shared = join(root, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o775);
  assert.throws(() => writeEnvFile(join(shared, "murage.env"), { A: "1" }), /writable by other accounts/);
  assert.equal(statSync(shared).mode & 0o777, 0o775);
  assert.deepEqual(readdirSync(shared), []);
});

const STORED = {
  MURAGE_DATA_DIR: "/home/deploy/.murage-server",
  MURAGE_PORT: "9100",
  MURAGE_BIND_MODE: "loopback",
  NODE_ENV: "production",
  ANTHROPIC_API_KEY: "sk-ant-stored",
  OPENAI_API_KEY: "sk-stored",
  MURAGE_BROWSER_PORT: "9313",
  MURAGE_TRUSTED_PROXY: "1",
  CUSTOM_SETTING: "kept",
};

test("a rerun that skips the key keeps every stored key and setting, whether enrolment worked or not", () => {
  for (const proxyVerified of [false, true]) {
    const r = setupEnvBag({ existing: STORED, processEnv: {}, dataDir: STORED.MURAGE_DATA_DIR, providerEnv: {}, proxyVerified });
    assert.deepEqual(r.bag, STORED, `proxyVerified=${proxyVerified}`);
    assert.deepEqual(r.replaced, []);
    assert.deepEqual(r.changed, []);
  }
});

test("a run that could not see the proxy does not remove an existing proxy declaration", () => {
  const r = setupEnvBag({ existing: STORED, processEnv: {}, dataDir: STORED.MURAGE_DATA_DIR, providerEnv: {}, proxyVerified: false });
  assert.equal(r.bag.MURAGE_TRUSTED_PROXY, "1");
});

test("only the fields setup selects change, and each change is reported", () => {
  const r = setupEnvBag({
    existing: { ...STORED, MURAGE_BIND_MODE: "public" },
    processEnv: { MURAGE_PORT: "9200" },
    dataDir: "/srv/murage",
    providerEnv: { XAI_API_KEY: "xai-new" },
    proxyVerified: true,
  });
  assert.deepEqual(r.bag, {
    ...STORED,
    MURAGE_DATA_DIR: "/srv/murage",
    MURAGE_PORT: "9200",
    MURAGE_BIND_MODE: "loopback",
    XAI_API_KEY: "xai-new",
  });
  assert.deepEqual([...r.changed].sort(), ["MURAGE_BIND_MODE", "MURAGE_DATA_DIR", "MURAGE_PORT"]);
  assert.deepEqual(r.replaced, [], "adding a second provider replaces nothing");
});

test("entering a key replaces only that provider, and a replacement is reported", () => {
  const base = { existing: STORED, processEnv: {}, dataDir: STORED.MURAGE_DATA_DIR, proxyVerified: false };
  const r = setupEnvBag({ ...base, providerEnv: { ANTHROPIC_API_KEY: "sk-ant-new" } });
  assert.equal(r.bag.ANTHROPIC_API_KEY, "sk-ant-new");
  assert.equal(r.bag.OPENAI_API_KEY, "sk-stored");
  assert.equal(r.bag.CUSTOM_SETTING, "kept");
  assert.deepEqual(r.replaced, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(setupEnvBag({ ...base, providerEnv: { OPENAI_API_KEY: "sk-stored" } }).replaced, [], "the same key again is not a replacement");
});

test("a first setup writes the defaults, and declares a proxy only when one was verified", () => {
  const first = { existing: {}, processEnv: {}, dataDir: "/d", providerEnv: {} };
  assert.deepEqual(setupEnvBag({ ...first, proxyVerified: false }).bag, {
    MURAGE_DATA_DIR: "/d",
    MURAGE_PORT: "8799",
    MURAGE_BIND_MODE: "loopback",
    NODE_ENV: "production",
  });
  assert.equal(setupEnvBag({ ...first, proxyVerified: true }).bag.MURAGE_TRUSTED_PROXY, "1");
});
