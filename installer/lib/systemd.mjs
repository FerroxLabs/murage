/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The systemd unit `murage setup` stages.
 *
 * Two lessons taken from Wayland's version, which learned them the hard way:
 *  - systemd starts with a minimal PATH, so the runtime's own bin directory has
 *    to be named explicitly or the service dies with runtime-not-found;
 *  - the unit is STAGED and the operator runs the install themselves, rather
 *    than the installer silently writing to /etc as root.
 *
 * Added here and absent there: `After=tailscaled.service`. Murage's cloud
 * deployment is only reachable through the tailnet, so starting the app before
 * the tailnet daemon means the first boot after a reboot comes up unreachable
 * and, in tailnet bind mode, fails its own bind check.
 *
 * And three things the first version of this file got wrong:
 *
 *  - It had no `User=` unless a caller supplied one, and the only caller never
 *    did, so the agent stack ran as root. A unit is now refused outright
 *    without a named non-root account (see `lib/service-account.mjs`).
 *  - It staged to the fixed path `/tmp/murage.service` with an ordinary write,
 *    which reuses whatever file or symlink is already there. It now stages
 *    into a fresh private directory, and the install command checks the bytes
 *    against the digest of what setup generated before copying them.
 *  - It interpolated paths straight into ExecStart=, Environment= and
 *    ReadWritePaths=. systemd splits those on spaces and expands `%`
 *    specifiers (and `$` in ExecStart=), so a path with a space in it ran the
 *    wrong thing. Values are now quoted and escaped per directive, and values
 *    that cannot be represented safely are refused.
 */

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { makePrivateTempDir, writeExclusiveFile } from "./private-files.mjs";
import { isAccountName, isGroupName } from "./service-account.mjs";

export const UNIT_NAME = "murage.service";
export const UNIT_PATH = "/etc/systemd/system/murage.service";

export class UnitRefused extends Error {
  /** @param {string} field @param {string} reason */
  constructor(field, reason) {
    super(`refusing to put ${field} into the systemd unit: ${reason}`);
    this.name = "UnitRefused";
    this.code = "UNIT_REFUSED";
    this.field = field;
  }
}

// Newline, carriage return, tab, NUL and every other C0 control, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters that need no quoting in a unit file or in a POSIX shell. */
const PLAIN = /^[A-Za-z0-9_/.:@+,=-]+$/;

/** @param {string} field @param {unknown} value @returns {string} */
function unitValue(field, value) {
  const s = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (!s) throw new UnitRefused(field, "it is empty");
  if (CONTROL.test(s)) throw new UnitRefused(field, "it contains a control character such as a newline, tab or NUL");
  // Both have directive-specific escape rules in systemd. Rather than depend
  // on each one being right, a value containing either is refused.
  if (/["\\]/.test(s)) throw new UnitRefused(field, "it contains a double quote or a backslash");
  return s;
}

/** @param {string} field @param {unknown} value @returns {string} */
function absolutePath(field, value) {
  const s = unitValue(field, value);
  if (!s.startsWith("/")) throw new UnitRefused(field, "it is not an absolute path");
  return s;
}

/** `%` starts a specifier in every directive used here. */
const escapeSpecifiers = (s) => s.replace(/%/g, () => "%%");

/**
 * The executable of `ExecStart=`. systemd expands `%` specifiers in it but
 * not `$` variables (a doubled `$$` stays doubled in the path it executes),
 * and refuses an executable name containing an apostrophe outright:
 * "Executable name contains special characters". Both observed against
 * systemd 252 with `systemd-analyze verify`.
 * @param {string} field @param {unknown} value @returns {string}
 */
export function execStartExecutable(field, value) {
  const s = absolutePath(field, value);
  if (s.includes("'")) throw new UnitRefused(field, "systemd refuses an executable path containing an apostrophe");
  const escaped = escapeSpecifiers(s);
  return PLAIN.test(s) ? escaped : `"${escaped}"`;
}

/**
 * An argument of `ExecStart=` (every word after the executable). Quoted when
 * it needs to be; `%` and `$` doubled, because systemd expands both there.
 * @param {string} field @param {unknown} value @returns {string}
 */
export function execStartWord(field, value) {
  const s = unitValue(field, value);
  const escaped = escapeSpecifiers(s).replace(/\$/g, () => "$$");
  return PLAIN.test(s) ? escaped : `"${escaped}"`;
}

/**
 * One `Environment=` line. The whole assignment is quoted when the value
 * needs it; `$` has no special meaning in Environment=, `%` does.
 * @param {string} name @param {unknown} value @returns {string}
 */
export function environmentLine(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UnitRefused("an environment name", "it is not a valid name");
  const s = unitValue(name, value);
  const assignment = `${name}=${escapeSpecifiers(s)}`;
  return `Environment=${PLAIN.test(s) ? assignment : `"${assignment}"`}`;
}

/**
 * One path in a space-separated path list such as `ReadWritePaths=`.
 * @param {string} field @param {unknown} value @returns {string}
 */
export function pathListWord(field, value) {
  const s = absolutePath(field, value);
  const escaped = escapeSpecifiers(s);
  return PLAIN.test(s) ? escaped : `"${escaped}"`;
}

/**
 * One word of a POSIX shell command printed for the operator to run.
 * @param {unknown} value @returns {string}
 */
export function shellWord(value) {
  const s = typeof value === "string" ? value : String(value ?? "");
  if (!s) throw new UnitRefused("a printed command", "an argument is empty");
  if (CONTROL.test(s)) throw new UnitRefused("a printed command", "an argument contains a control character");
  return PLAIN.test(s) ? s : `'${s.replace(/'/g, () => "'\\''")}'`;
}

/**
 * @typedef {{ user: string, uid: number, gid: number, group: string, home: string }} ServiceAccount
 */

/**
 * @param {object} opts
 * @param {string} opts.execPath the node binary
 * @param {string} opts.cliPath absolute path to bin/murage.mjs
 * @param {string} opts.dataDir
 * @param {string} opts.envFile
 * @param {ServiceAccount} opts.account the non-root account the service runs as
 * @param {boolean} [opts.tailscale] whether Tailscale enrolment was configured
 * @returns {string}
 */
export function unitText(opts) {
  const account = opts?.account;
  if (!account) throw new UnitRefused("User=", "no service account was given, and a unit without one runs as root");
  if (!isAccountName(account.user)) throw new UnitRefused("User=", "it is not a valid account name");
  if (account.user === "root" || account.uid === 0) throw new UnitRefused("User=", "the agent service must not run as root");
  if (!isGroupName(account.group)) throw new UnitRefused("Group=", "it is not a valid group name");
  if (account.group === "root" || account.gid === 0) throw new UnitRefused("Group=", "the agent service must not run with the root group");

  const execPath = absolutePath("the node runtime path", opts.execPath);
  const cliPath = absolutePath("the installer path", opts.cliPath);
  const dataDir = absolutePath("MURAGE_DATA_DIR", opts.dataDir);
  const envFile = absolutePath("MURAGE_ENV_FILE", opts.envFile);
  const home = absolutePath("HOME", account.home);
  const nodeDir = dirname(execPath);
  if (nodeDir.includes(":")) throw new UnitRefused("PATH", "the node runtime's directory contains ':', which PATH cannot hold");

  const wants = opts.tailscale ? "\nWants=tailscaled.service\nAfter=tailscaled.service" : "";
  return `[Unit]
Description=Murage headless server (tailnet-only)
After=network-online.target${wants}

[Service]
Type=simple
# Never root. \`murage setup\` will not stage this unit without a named,
# non-root account, and it prints which one it chose.
User=${account.user}
Group=${account.group}
ExecStart=${execStartExecutable("the node runtime path", execPath)} ${execStartWord("the installer path", cliPath)} start
Restart=always
RestartSec=3
${environmentLine("HOME", home)}
${environmentLine("MURAGE_DATA_DIR", dataDir)}
${environmentLine("MURAGE_ENV_FILE", envFile)}
# systemd starts with a minimal PATH that excludes the directory the node
# runtime actually lives in, so name it explicitly or ExecStart dies at boot.
${environmentLine("PATH", `${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)}
# What the service creates is readable by its own account only.
UMask=0077

# The listener is loopback-only or tailnet-only by policy (see lib/bind.mjs);
# these make that structural rather than merely intended.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${pathListWord("MURAGE_DATA_DIR", dataDir)}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Write the unit somewhere private for the operator to inspect, and return the
 * commands they run. Never installs it itself.
 *
 * The unit is generated (and refused, if it has to be) before anything is
 * created. It goes into a new randomly named 0700 directory as a new file, so
 * nothing that already existed is written through. The install command checks
 * the staged bytes against the digest of what setup generated, then copies
 * them into place owned by root with mode 0644.
 * @param {Parameters<typeof unitText>[0]} opts
 * @param {{ stagingRoot?: string }} [where]
 * @returns {{ stagingDir: string, stagedPath: string, sha256: string, text: string, commands: string[] }}
 */
export function stageUnit(opts, { stagingRoot = tmpdir() } = {}) {
  const text = unitText(opts);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const stagingDir = makePrivateTempDir("murage-unit-", stagingRoot);
  const stagedPath = join(stagingDir, UNIT_NAME);
  writeExclusiveFile(stagedPath, text, { mode: 0o600 });
  // Who can open what was just staged is decided by who owns it, not by who
  // will read the instructions: under `sudo murage setup` both are root's and
  // 0700/0600, and the operator pastes the commands into the shell that ran
  // sudo. Reading the owner back keeps the commands true for either case.
  const rootOwned = lstatSync(stagingDir).uid === 0;
  return {
    stagingDir,
    stagedPath,
    sha256,
    text,
    commands: operatorCommands({ stagingDir, stagedPath, sha256, rootOwned }),
  };
}

/**
 * The commands printed for the operator, in order: check the staged bytes and
 * install them, remove the staging directory, enable, follow the log.
 *
 * When the staging directory is root's (setup ran as root, usually through
 * sudo), every command that opens it carries `sudo`, so it works from the
 * unprivileged shell that ran `sudo murage setup` as well as from a root
 * shell. The staged file is deliberately not handed to the invoking account:
 * a file it owned could be swapped between the digest check and the install.
 * @param {{ stagingDir: string, stagedPath: string, sha256: string, rootOwned: boolean }} staged
 * @returns {string[]}
 */
export function operatorCommands({ stagingDir, stagedPath, sha256, rootOwned }) {
  const asOwner = rootOwned ? "sudo " : "";
  const check = shellWord(`${sha256}  ${stagedPath}`);
  return [
    `echo ${check} | ${asOwner}sha256sum --check --strict - && sudo install -o root -g root -m 0644 ${shellWord(stagedPath)} ${UNIT_PATH}`,
    `${asOwner}rm -r ${shellWord(stagingDir)}`,
    "sudo systemctl daemon-reload && sudo systemctl enable --now murage",
    "sudo journalctl -u murage -f",
  ];
}
