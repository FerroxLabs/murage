/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The staged unit: who it runs as, how its fields are spelled, and where it is
 * staged before the operator installs it.
 *
 *   I1  the unit used to have no User=, so the agent stack ran as root;
 *   I4  it was staged at a fixed shared path with an ordinary write;
 *   I5  paths went into ExecStart=/Environment=/ReadWritePaths= unquoted and
 *       unescaped, so a space or a `%` changed what systemd ran.
 *
 * Everything here uses synthetic scratch files. Nothing runs sudo, systemctl
 * or useradd.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { writeExclusiveFile } from "../lib/private-files.mjs";
import {
  ServiceAccountRefused,
  accountCanReach,
  chooseServiceUser,
  lookupAccount,
  parseSetupArgs,
  prepareDataDir,
  setupPaths,
} from "../lib/service-account.mjs";
import {
  UNIT_PATH,
  UnitRefused,
  environmentLine,
  operatorCommands,
  shellWord,
  stageUnit,
  unitText,
} from "../lib/systemd.mjs";

const scratchDirs = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-systemd-test-")));
  scratchDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const DEPLOY = { user: "deploy", uid: 1001, gid: 1001, group: "deploy", home: "/home/deploy" };
const unitOpts = (extra = {}) => ({
  execPath: "/usr/bin/node",
  cliPath: "/opt/murage/installer/bin/murage.mjs",
  dataDir: "/home/deploy/.murage-server",
  envFile: "/home/deploy/.murage-server/murage.env",
  tailscale: true,
  account: DEPLOY,
  ...extra,
});
const lineOf = (text, prefix) => text.split("\n").find((l) => l.startsWith(prefix));

/**
 * systemd's reading of the words this installer emits: double-quoted or bare
 * words, `%%` for a literal `%`, and in ExecStart= `$$` for a literal `$`.
 * @param {string} value
 * @param {{ dollars?: boolean }} [opts]
 */
function unitWords(value, { dollars = false } = {}) {
  const words = [];
  const re = /"([^"]*)"|([^\s"]+)/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    let word = (m[1] ?? m[2]).replace(/%%/g, () => "%");
    if (dollars) word = word.replace(/\$\$/g, () => "$");
    words.push(word);
  }
  return words;
}

// ── I1: never root ────────────────────────────────────────────────────────

test("the unit runs as the named non-root account, with its HOME and a private umask", () => {
  const text = unitText(unitOpts());
  assert.match(text, /^User=deploy$/m);
  assert.match(text, /^Group=deploy$/m);
  assert.match(text, /^Environment=HOME=\/home\/deploy$/m);
  assert.match(text, /^UMask=0077$/m);
  assert.match(text, /^ReadWritePaths=\/home\/deploy\/\.murage-server$/m);
});

test("a unit with no account is refused, because systemd would run it as root", () => {
  const { account: _drop, ...noAccount } = unitOpts();
  assert.throws(() => unitText(noAccount), (e) => e instanceof UnitRefused && /runs as root/.test(e.message));
  for (const account of [
    { ...DEPLOY, user: "root", uid: 0 },
    { ...DEPLOY, user: "toor", uid: 0 },
    { ...DEPLOY, group: "root", gid: 0 },
    { ...DEPLOY, gid: 0 },
    { ...DEPLOY, user: "has space" },
    { ...DEPLOY, user: "" },
  ]) {
    assert.throws(() => unitText(unitOpts({ account })), UnitRefused, JSON.stringify(account));
  }
});

// ── I5: escaping ──────────────────────────────────────────────────────────

test("simple paths keep their plain spelling", () => {
  const text = unitText(unitOpts());
  assert.equal(lineOf(text, "ExecStart="), "ExecStart=/usr/bin/node /opt/murage/installer/bin/murage.mjs start");
  assert.equal(lineOf(text, "Environment=MURAGE_DATA_DIR"), "Environment=MURAGE_DATA_DIR=/home/deploy/.murage-server");
  assert.equal(lineOf(text, "Environment=MURAGE_ENV_FILE"), "Environment=MURAGE_ENV_FILE=/home/deploy/.murage-server/murage.env");
  assert.match(text, /^Environment=PATH=\/usr\/bin:\/usr\/local\/sbin:/m);
});

test("spaces, apostrophes, percent and dollar signs reach systemd as the same paths", () => {
  const opts = unitOpts({
    execPath: "/opt/my node/100% real $HOME/bin/node",
    cliPath: "/srv/it's here/$HOME/murage.mjs",
    dataDir: "/home/deploy/data dir %h $USER",
    envFile: "/home/deploy/data dir %h $USER/murage.env",
  });
  const text = unitText(opts);

  // The executable: `%` doubled, `$` left alone (systemd does not expand
  // variables in it). Its arguments: both doubled.
  const exec = lineOf(text, "ExecStart=");
  assert.equal(exec, `ExecStart="/opt/my node/100%% real $HOME/bin/node" "/srv/it's here/$$HOME/murage.mjs" start`);
  const [executable, ...args] = unitWords(exec.slice("ExecStart=".length));
  assert.equal(executable, opts.execPath);
  assert.deepEqual(args.map((word) => word.replace(/\$\$/g, () => "$")), [opts.cliPath, "start"]);

  // `$` means nothing in Environment= and ReadWritePaths=, so it stays single.
  const data = lineOf(text, "Environment=\"MURAGE_DATA_DIR");
  assert.equal(data, `Environment="MURAGE_DATA_DIR=/home/deploy/data dir %%h $USER"`);
  assert.deepEqual(unitWords(data.slice("Environment=".length)), [`MURAGE_DATA_DIR=${opts.dataDir}`]);
  assert.deepEqual(unitWords(lineOf(text, "Environment=\"MURAGE_ENV_FILE").slice("Environment=".length)), [
    `MURAGE_ENV_FILE=${opts.envFile}`,
  ]);
  assert.deepEqual(unitWords(lineOf(text, "Environment=\"PATH").slice("Environment=".length)), [
    "PATH=/opt/my node/100% real $HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ]);

  const rw = lineOf(text, "ReadWritePaths=");
  assert.equal(rw, `ReadWritePaths="/home/deploy/data dir %%h $USER"`);
  assert.deepEqual(unitWords(rw.slice("ReadWritePaths=".length)), [opts.dataDir]);
});

test("backslashes, double quotes and control characters are refused rather than encoded", () => {
  const bad = ["/opt/a\\b/node", '/opt/a"b/node', "/opt/a\nExecStartPre=/bin/sh", "/opt/a\rb", "/opt/a\tb", "/opt/a\0b", "/opt/ab"];
  for (const field of ["execPath", "cliPath", "dataDir", "envFile"]) {
    for (const value of bad) {
      assert.throws(() => unitText(unitOpts({ [field]: value })), UnitRefused, `${field}=${JSON.stringify(value)}`);
    }
  }
  for (const home of bad) {
    assert.throws(() => unitText(unitOpts({ account: { ...DEPLOY, home } })), UnitRefused, JSON.stringify(home));
  }
});

test("an apostrophe is refused in the executable path, where systemd refuses it, and allowed in an argument", () => {
  assert.throws(() => unitText(unitOpts({ execPath: "/opt/it's/bin/node" })), (e) => e instanceof UnitRefused && /apostrophe/.test(e.message));
  assert.match(unitText(unitOpts({ cliPath: "/srv/it's/murage.mjs" })), /^ExecStart=\/usr\/bin\/node "\/srv\/it's\/murage\.mjs" start$/m);
});

test("relative paths, and a node directory PATH cannot hold, are refused", () => {
  for (const field of ["execPath", "cliPath", "dataDir", "envFile"]) {
    assert.throws(() => unitText(unitOpts({ [field]: "relative/path" })), /not an absolute path/, field);
  }
  assert.throws(() => unitText(unitOpts({ execPath: "/opt/node:22/bin/node" })), /PATH cannot hold/);
  assert.throws(() => environmentLine("NOT A NAME", "/x"), UnitRefused);
});

test("printed shell words survive the shell unchanged, and control characters are refused", () => {
  assert.equal(shellWord("/tmp/murage-unit-Ab12/murage.service"), "/tmp/murage-unit-Ab12/murage.service");
  for (const value of ["/tmp/with space/x", "/tmp/it's/x", "/tmp/$HOME/`id`/x", "/tmp/a;b|c&d/x", "/tmp/a*b?/x", "/tmp/a\\b"]) {
    const word = shellWord(value);
    assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${word}`], { encoding: "utf8" }), value, word);
  }
  for (const value of ["/tmp/a\nb", "/tmp/a\0b", ""]) assert.throws(() => shellWord(value), UnitRefused);
});

// ── I4: private staging ───────────────────────────────────────────────────

test("the unit is staged in a new private directory, and the install command checks its bytes", () => {
  const root = scratch();
  const a = stageUnit(unitOpts(), { stagingRoot: root });
  const b = stageUnit(unitOpts(), { stagingRoot: root });
  assert.notEqual(a.stagingDir, b.stagingDir, "each staging gets its own directory");
  assert.equal(dirname(a.stagingDir), root);
  assert.match(a.stagingDir, /murage-unit-[A-Za-z0-9]{6}$/);

  const dir = lstatSync(a.stagingDir);
  assert.ok(dir.isDirectory() && !dir.isSymbolicLink());
  assert.equal(dir.mode & 0o777, 0o700);
  assert.equal(dir.uid, process.getuid());
  const file = lstatSync(a.stagedPath);
  assert.ok(file.isFile());
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(file.nlink, 1);

  const bytes = readFileSync(a.stagedPath, "utf8");
  assert.equal(bytes, unitText(unitOpts()));
  assert.equal(a.sha256, createHash("sha256").update(bytes).digest("hex"));

  const [install, cleanup, enable] = a.commands;
  assert.ok(install.startsWith(`echo ${shellWord(`${a.sha256}  ${a.stagedPath}`)} | sha256sum --check --strict - && `), install);
  assert.ok(install.endsWith(`sudo install -o root -g root -m 0644 ${shellWord(a.stagedPath)} ${UNIT_PATH}`), install);
  assert.equal(cleanup, `rm -r ${shellWord(a.stagingDir)}`);
  assert.equal(enable, "sudo systemctl daemon-reload && sudo systemctl enable --now murage");
  assert.ok(!a.commands.some((cmd) => /\bmv\b|\/tmp\/murage\.service/.test(cmd)), a.commands.join("\n"));
});

// Fix round 1: under `sudo murage setup --service-user $SUDO_USER` the
// staging directory is root's 0700 and the file root's 0600, and the operator
// pastes the printed commands into the shell that ran sudo. A check or cleanup
// without sudo there cannot open the file, so nothing was installable.
test("a root-owned staging gets sudo on every command that opens it", () => {
  const stagingDir = "/tmp/murage-unit-AbC123";
  const stagedPath = `${stagingDir}/murage.service`;
  const sha256 = "a".repeat(64);
  const root = operatorCommands({ stagingDir, stagedPath, sha256, rootOwned: true });
  const [install, cleanup] = root;
  assert.equal(
    install,
    `echo ${shellWord(`${sha256}  ${stagedPath}`)} | sudo sha256sum --check --strict - && sudo install -o root -g root -m 0644 ${shellWord(stagedPath)} ${UNIT_PATH}`
  );
  assert.equal(cleanup, `sudo rm -r ${shellWord(stagingDir)}`);
  // Every program that is handed the staged path runs under sudo; `echo`
  // only prints the digest line and opens nothing.
  for (const cmd of root) {
    for (const part of cmd.split(/\s*(?:\|\||&&|\|)\s*/)) {
      if (part.startsWith("echo ")) continue;
      if (part.includes(stagingDir) || /^(sha256sum|install|rm|systemctl|journalctl)\b/.test(part)) {
        assert.ok(part.startsWith("sudo "), `runs without sudo from the invoking shell: ${part}`);
      }
    }
  }

  // Staged by an ordinary account: that account can open its own files, so
  // the check and the cleanup stay unprivileged.
  const own = operatorCommands({ stagingDir, stagedPath, sha256, rootOwned: false });
  assert.ok(own[0].startsWith(`echo ${shellWord(`${sha256}  ${stagedPath}`)} | sha256sum --check --strict - && sudo install `), own[0]);
  assert.equal(own[1], `rm -r ${shellWord(stagingDir)}`);
  assert.deepEqual(own.slice(2), root.slice(2));
});

test("the printed commands run as printed from a shell that cannot open the staging directory", () => {
  // This process is not root, so a root-owned directory cannot be made here.
  // A 0000 staging directory is the same situation from the invoking shell:
  // it cannot list or read it. A `sudo` shim on PATH stands in for real sudo:
  // it records each call and restores the owner's access for the command it
  // runs, the way root has it. `install` into /etc is recorded, not run.
  const root = scratch();
  const staged = stageUnit(unitOpts(), { stagingRoot: root });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "sudo.log");
  writeFileSync(
    join(bin, "sudo"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellWord(log)}`,
      `[ "$1" = install ] && exit 0`,
      `chmod 700 ${shellWord(staged.stagingDir)} 2>/dev/null`,
      `"$@"; status=$?`,
      `[ -d ${shellWord(staged.stagingDir)} ] && chmod 000 ${shellWord(staged.stagingDir)}`,
      "exit $status",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const run = (cmd) =>
    execFileSync("/bin/sh", ["-c", cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  const [install, cleanup] = operatorCommands({ ...staged, rootOwned: true });
  chmodSync(staged.stagingDir, 0o000);
  try {
    // Without sudo on the check, exactly the reported failure.
    assert.throws(() => run(`echo ${shellWord(`${staged.sha256}  ${staged.stagedPath}`)} | sha256sum --check --strict -`));
    assert.match(run(install), /OK/);
    run(cleanup);
  } finally {
    try {
      chmodSync(staged.stagingDir, 0o700);
    } catch {
      // Removed by the cleanup command.
    }
  }
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    "sha256sum --check --strict -",
    `install -o root -g root -m 0644 ${staged.stagedPath} ${UNIT_PATH}`,
    `rm -r ${staged.stagingDir}`,
  ]);
  assert.throws(() => lstatSync(staged.stagingDir), { code: "ENOENT" }, "the cleanup command removed the staging");

  // A digest that no longer matches stops the install.
  const again = stageUnit(unitOpts(), { stagingRoot: root });
  const [tampered] = operatorCommands({ ...again, sha256: "0".repeat(64), rootOwned: true });
  writeFileSync(log, "");
  chmodSync(again.stagingDir, 0o000);
  try {
    assert.throws(() => run(tampered));
  } finally {
    chmodSync(again.stagingDir, 0o700);
  }
  assert.ok(!readFileSync(log, "utf8").includes("install "), "install must not run after a failed check");
});

test("files planted in the staging root are never written through or reused", () => {
  const root = scratch();
  const planted = join(root, "murage.service");
  writeFileSync(planted, "planted\n", { mode: 0o666 });
  chmodSync(planted, 0o666);
  const victim = join(root, "victim");
  writeFileSync(victim, "victim\n");
  symlinkSync(victim, join(root, "murage-unit-link"));
  linkSync(victim, join(root, "murage-unit-hardlink"));
  const before = readdirSync(root).sort();

  const staged = stageUnit(unitOpts(), { stagingRoot: root });
  assert.equal(readFileSync(planted, "utf8"), "planted\n");
  assert.equal(statSync(planted).mode & 0o777, 0o666);
  assert.equal(readFileSync(victim, "utf8"), "victim\n");
  assert.equal(statSync(victim).nlink, 2);
  assert.deepEqual(readdirSync(root).filter((n) => n !== staged.stagingDir.split("/").pop()).sort(), before);
});

test("a refused unit creates nothing at all", () => {
  const root = scratch();
  assert.throws(() => stageUnit(unitOpts({ account: undefined }), { stagingRoot: root }), UnitRefused);
  assert.throws(() => stageUnit(unitOpts({ dataDir: "/x\ny" }), { stagingRoot: root }), UnitRefused);
  assert.deepEqual(readdirSync(root), []);
});

test("an exclusive write refuses an existing file or symlink and leaves it as it was", () => {
  const root = scratch();
  const existing = join(root, "existing");
  writeFileSync(existing, "keep me");
  assert.throws(() => writeExclusiveFile(existing, "overwrite"), { code: "EEXIST" });
  assert.equal(readFileSync(existing, "utf8"), "keep me");

  const target = join(root, "target");
  writeFileSync(target, "target");
  const link = join(root, "link");
  symlinkSync(target, link);
  assert.throws(() => writeExclusiveFile(link, "through the link"), { code: "EEXIST" });
  assert.equal(readFileSync(target, "utf8"), "target");

  const dangling = join(root, "dangling");
  symlinkSync(join(root, "nowhere"), dangling);
  assert.throws(() => writeExclusiveFile(dangling, "create the target"), { code: "EEXIST" });
  assert.deepEqual(readdirSync(root).sort(), ["dangling", "existing", "link", "target"]);
});

// ── the service account ───────────────────────────────────────────────────

test("setup's only option is --service-user, and a stray argument is refused without being echoed", () => {
  assert.deepEqual(parseSetupArgs([]), { serviceUser: null });
  assert.deepEqual(parseSetupArgs(["--service-user", "murage"]), { serviceUser: "murage" });
  assert.deepEqual(parseSetupArgs(["--service-user=deploy"]), { serviceUser: "deploy" });
  for (const argv of [["--service-user"], ["--service-user", "--other"], ["--service-user="], ["--service-user", "bad name"], ["--service-user", "a;b"]]) {
    assert.ok(parseSetupArgs(argv).error, JSON.stringify(argv));
  }
  const secret = "tskey-auth-kSTRAYARG-NOTSHOWN";
  for (const argv of [[secret], [`--auth-key=${secret}`], ["--service-user", "murage", secret]]) {
    const { error } = parseSetupArgs(argv);
    assert.ok(error);
    assert.ok(!error.includes("STRAYARG"), error);
  }
});

test("root must name the service account; root itself is never chosen", () => {
  assert.throws(
    () => chooseServiceUser({ euid: 0, invokingUser: "root" }),
    (e) => e instanceof ServiceAccountRefused && e.code === "ROOT_NEEDS_SERVICE_USER" && /--service-user/.test(e.message)
  );
  assert.throws(
    () => chooseServiceUser({ euid: 0, sudoUser: "ubuntu", invokingUser: "root" }),
    (e) => e.code === "ROOT_NEEDS_SERVICE_USER" && /--service-user ubuntu/.test(e.message),
    "under sudo the refusal names the account that invoked it"
  );
  assert.deepEqual(chooseServiceUser({ euid: 0, flag: "murage", invokingUser: "root" }), { name: "murage", source: "--service-user" });
  assert.throws(() => chooseServiceUser({ euid: 0, flag: "root" }), { code: "ROOT_SERVICE_REFUSED" });
  assert.deepEqual(chooseServiceUser({ euid: 1000, invokingUser: "deploy", sudoUser: "admin" }), {
    name: "deploy",
    source: "the account running setup",
  });
  assert.throws(() => chooseServiceUser({ euid: 1000, invokingUser: "root" }), { code: "ROOT_SERVICE_REFUSED" });
  assert.throws(() => chooseServiceUser({ euid: 1000 }), { code: "NO_INVOKING_USER" });
});

/** A fake `getent`/`id` answering from a tiny account database. */
function accountDb(passwd, groups = {}, memberships = {}) {
  return (cmd, args) => {
    const [a, b] = args;
    if (cmd === "getent" && a === "passwd" && passwd[b]) return { status: 0, stdout: `${passwd[b]}\n` };
    if (cmd === "getent" && a === "group" && groups[b]) return { status: 0, stdout: `${groups[b]}:x:${b}:\n` };
    if (cmd === "id" && a === "-G" && memberships[b]) return { status: 0, stdout: `${memberships[b]}\n` };
    return { status: 2, stdout: "" };
  };
}

test("an account is looked up for its uid, groups and home, and uid 0 is refused under any name", () => {
  const run = accountDb(
    {
      murage: "murage:x:998:997:Murage:/var/lib/murage:/usr/sbin/nologin",
      toor: "toor:x:0:0::/root:/bin/sh",
      nohome: "nohome:x:1002:1002:::/bin/sh",
    },
    { 997: "murage" },
    { murage: "997 44" }
  );
  assert.deepEqual(lookupAccount("murage", { run }), {
    user: "murage",
    uid: 998,
    gid: 997,
    group: "murage",
    home: "/var/lib/murage",
    groups: [997, 44],
  });
  assert.throws(() => lookupAccount("toor", { run }), { code: "ROOT_SERVICE_REFUSED" });
  assert.throws(() => lookupAccount("nohome", { run }), { code: "NO_ACCOUNT_HOME" });
  assert.throws(() => lookupAccount("ghost", { run }), (e) => e.code === "NO_SUCH_ACCOUNT" && /useradd .* ghost/.test(e.message));
  assert.throws(() => lookupAccount("bad name", { run }), { code: "BAD_ACCOUNT_NAME" });
});

test("the account running this test resolves to its real identity", () => {
  const me = userInfo();
  const account = lookupAccount(me.username, { current: me });
  assert.equal(account.uid, process.getuid());
  assert.equal(account.gid, process.getgid());
  assert.ok(account.groups.includes(process.getgid()));
  assert.ok(account.home.startsWith("/"));
});

test("root acting for an account keeps the data in that account's home; everyone else keeps their own", () => {
  const account = { uid: 998, home: "/var/lib/murage" };
  assert.deepEqual(setupPaths({ env: {}, account, euid: 0, home: "/root" }), {
    dataDir: "/var/lib/murage/.murage-server",
    envFile: "/var/lib/murage/.murage-server/murage.env",
  });
  assert.deepEqual(setupPaths({ env: {}, account: { uid: 1000, home: "/home/deploy" }, euid: 1000, home: "/home/deploy" }).dataDir, "/home/deploy/.murage-server");
  assert.deepEqual(setupPaths({ env: { MURAGE_DATA_DIR: "/srv/murage", MURAGE_ENV_FILE: "/etc/murage.env" }, account, euid: 0, home: "/root" }), {
    dataDir: "/srv/murage",
    envFile: "/etc/murage.env",
  });
});

test("the data directory is created private, and a foreign, linked or non-directory one is refused untouched", () => {
  const root = scratch();
  const me = { user: "me", uid: process.getuid(), gid: process.getgid() };

  const fresh = join(root, "fresh", "data");
  assert.deepEqual(prepareDataDir(fresh, me, { euid: process.geteuid() }), { created: true });
  assert.equal(statSync(fresh).mode & 0o777, 0o700);

  const loose = join(root, "loose");
  mkdirSync(loose);
  chmodSync(loose, 0o755);
  assert.deepEqual(prepareDataDir(loose, me, { euid: process.geteuid() }), { created: false });
  assert.equal(statSync(loose).mode & 0o777, 0o700);

  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  chmodSync(foreign, 0o755);
  const other = { user: "someone", uid: process.getuid() + 1, gid: process.getgid() };
  assert.throws(() => prepareDataDir(foreign, other, { euid: process.geteuid() }), (e) => e.code === "DATA_DIR_FOREIGN_OWNER" && /does not re-own/.test(e.message));
  assert.equal(statSync(foreign).mode & 0o777, 0o755, "a refused directory is not touched");

  const link = join(root, "link");
  symlinkSync(loose, link);
  assert.throws(() => prepareDataDir(link, me, { euid: process.geteuid() }), { code: "DATA_DIR_NOT_A_DIRECTORY" });
  const file = join(root, "file");
  writeFileSync(file, "");
  assert.throws(() => prepareDataDir(file, me, { euid: process.geteuid() }), { code: "DATA_DIR_NOT_A_DIRECTORY" });
  assert.throws(() => prepareDataDir("relative", me, { euid: process.geteuid() }), { code: "DATA_DIR_NOT_ABSOLUTE" });
});

test("reachability counts owner, primary group, supplementary groups and other bits on every directory", () => {
  const tree = {
    "/": { uid: 0, gid: 0, mode: 0o755 },
    "/usr": { uid: 0, gid: 0, mode: 0o755 },
    "/usr/bin": { uid: 0, gid: 0, mode: 0o755 },
    "/usr/bin/node": { uid: 0, gid: 0, mode: 0o755 },
    "/root": { uid: 0, gid: 0, mode: 0o700 },
    "/root/.nvm": { uid: 0, gid: 0, mode: 0o755 },
    "/root/.nvm/node": { uid: 0, gid: 0, mode: 0o755 },
    "/opt": { uid: 0, gid: 0, mode: 0o755 },
    "/opt/team": { uid: 0, gid: 44, mode: 0o750 },
    "/opt/team/murage.mjs": { uid: 0, gid: 44, mode: 0o640 },
  };
  const stat = (p) => {
    if (!tree[p]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return tree[p];
  };
  const seams = { stat, realpath: (p) => p };
  const murage = { uid: 998, gid: 997, groups: [997] };
  assert.deepEqual(accountCanReach("/usr/bin/node", murage, 5, seams), { ok: true });
  assert.deepEqual(accountCanReach("/root/.nvm/node", murage, 5, seams), { ok: false, blockedAt: "/root" });
  assert.deepEqual(accountCanReach("/opt/team/murage.mjs", murage, 4, seams), { ok: false, blockedAt: "/opt/team" });
  assert.deepEqual(accountCanReach("/opt/team/murage.mjs", { ...murage, groups: [997, 44] }, 4, seams), { ok: true });
  assert.deepEqual(accountCanReach("/nowhere", murage, 4, seams), { ok: false, blockedAt: "/nowhere" });
  assert.deepEqual(
    accountCanReach("/usr/bin/node", murage, 5, { stat, realpath: () => "/root/.nvm/node" }),
    { ok: false, blockedAt: "/root" },
    "a symlink into an unreachable directory is unreachable"
  );
});
