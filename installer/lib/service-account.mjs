/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The account the headless service runs as.
 *
 * The unit `murage setup` used to stage had no `User=`, so systemd ran the
 * whole agent stack as root: an ordinary operator who followed the printed
 * `sudo` commands got a root-owned, long-running agent runtime writing into
 * their own home directory. This file picks the account, checks it, and makes
 * the choice visible:
 *
 *  - `--service-user <account>` names it explicitly;
 *  - setup running as root without that flag refuses. It never silently
 *    chooses root, and never silently moves a root session's data into
 *    another account's home. When sudo recorded who invoked it, the refusal
 *    names that account as the value to pass;
 *  - otherwise the service runs as the account running setup.
 *
 * Root is refused as a service account however it is spelled, including a
 * different name with uid 0. Existing data is never re-owned: a data directory
 * that belongs to a different account is a reason to stop, not to chown.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { asAccount } from "./private-files.mjs";

export class ServiceAccountRefused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ServiceAccountRefused";
    this.code = code;
  }
}

const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const GROUP_NAME = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,31}|\d{1,10})$/;
const CREATE_HINT = "useradd --create-home --shell /usr/sbin/nologin murage";

/** @param {unknown} name @returns {boolean} */
export function isAccountName(name) {
  return typeof name === "string" && ACCOUNT_NAME.test(name);
}

/** @param {unknown} name @returns {boolean} */
export function isGroupName(name) {
  return typeof name === "string" && GROUP_NAME.test(name);
}

/**
 * Parse `murage setup`'s arguments. The only option is `--service-user`.
 *
 * An unrecognised argument is refused WITHOUT being echoed: the most likely
 * stray argument to this command is an auth key somebody tried to pass on the
 * command line, and printing it would put it in the scrollback as well.
 * @param {string[]} argv
 * @returns {{ serviceUser: string | null, error?: undefined } | { error: string }}
 */
export function parseSetupArgs(argv = []) {
  let serviceUser = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === "--service-user") {
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("-")) {
        return { error: "--service-user needs an account name, for example --service-user murage" };
      }
      serviceUser = String(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--service-user=")) {
      serviceUser = arg.slice("--service-user=".length);
      if (!serviceUser) return { error: "--service-user needs an account name, for example --service-user murage" };
      continue;
    }
    return {
      error:
        `setup does not take argument #${i + 1} (not shown, in case it is a secret). ` +
        "The only option is --service-user <account>. Auth keys go on the prompt or in MURAGE_TS_AUTHKEY.",
    };
  }
  if (serviceUser !== null && !isAccountName(serviceUser)) {
    return { error: "--service-user must be an account name: a letter or _, then letters, digits, _ or -, up to 32 characters" };
  }
  return { serviceUser };
}

/**
 * Decide which account name the service runs as. Pure: the caller supplies
 * the facts, so every branch is testable without being root.
 * @param {{ flag?: string | null, euid?: number | null, sudoUser?: string, invokingUser?: string }} facts
 * @returns {{ name: string, source: string }}
 */
export function chooseServiceUser({ flag = null, euid = null, sudoUser, invokingUser } = {}) {
  if (flag) {
    if (flag === "root") {
      throw new ServiceAccountRefused("ROOT_SERVICE_REFUSED", "--service-user root is refused: the agent service must not run as root.");
    }
    return { name: flag, source: "--service-user" };
  }
  if (euid === 0) {
    const viaSudo = typeof sudoUser === "string" && sudoUser !== "root" && isAccountName(sudoUser);
    const next = viaSudo
      ? `sudo sets SUDO_USER=${sudoUser}; to run the service as that account: murage setup --service-user ${sudoUser}`
      : `create an account for it first (for example: ${CREATE_HINT}), then: murage setup --service-user murage`;
    throw new ServiceAccountRefused(
      "ROOT_NEEDS_SERVICE_USER",
      "setup is running as root, and will not stage an agent service that runs as root or put its data in " +
        `root's home. Name the account the service runs as with --service-user. Next: ${next}`
    );
  }
  if (!isAccountName(invokingUser)) {
    throw new ServiceAccountRefused("NO_INVOKING_USER", "could not tell which account is running setup; pass --service-user <account>.");
  }
  if (invokingUser === "root") {
    throw new ServiceAccountRefused("ROOT_SERVICE_REFUSED", "the account running setup is named root; pass --service-user <account>.");
  }
  return { name: invokingUser, source: "the account running setup" };
}

/**
 * Look an account up: uid, primary gid and group name, home, and every group
 * it is in. Uses `getent`/`id`, with the current process's own identity as the
 * fallback when the name is this process's.
 * @param {string} name
 * @param {{ run?: typeof spawnSync, current?: { username: string, uid: number, gid: number, homedir: string } }} [seams]
 * @returns {{ user: string, uid: number, gid: number, group: string, home: string, groups: number[] }}
 */
export function lookupAccount(name, { run = spawnSync, current } = {}) {
  if (!isAccountName(name)) throw new ServiceAccountRefused("BAD_ACCOUNT_NAME", "that is not a valid account name");
  const call = (cmd, args) => {
    const r = run(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return (r?.status ?? 1) === 0 ? String(r.stdout ?? "").trim() : null;
  };

  let uid = NaN;
  let gid = NaN;
  let home = "";
  const passwd = call("getent", ["passwd", name]);
  const fields = passwd ? passwd.split("\n")[0].split(":") : [];
  if (fields.length >= 7 && fields[0] === name) {
    uid = Number(fields[2]);
    gid = Number(fields[3]);
    home = fields[5];
  } else if (current && current.username === name) {
    uid = current.uid;
    gid = current.gid;
    home = current.homedir;
  } else {
    const idUid = call("id", ["-u", name]);
    const idGid = call("id", ["-g", name]);
    if (idUid !== null && idGid !== null) {
      uid = Number(idUid);
      gid = Number(idGid);
    }
  }
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) {
    throw new ServiceAccountRefused(
      "NO_SUCH_ACCOUNT",
      `there is no account named ${name} on this host. Create it first (for example: ${CREATE_HINT.replace("murage", name)}).`
    );
  }
  if (uid === 0) {
    throw new ServiceAccountRefused("ROOT_SERVICE_REFUSED", `${name} has uid 0: that is root by another name, and the agent service must not run as root.`);
  }
  if (!home || !isAbsolute(home)) {
    throw new ServiceAccountRefused("NO_ACCOUNT_HOME", `${name} has no absolute home directory, so there is nowhere consistent to keep its data.`);
  }

  const groupLine = call("getent", ["group", String(gid)]);
  const groupFromDb = groupLine ? groupLine.split("\n")[0].split(":")[0] : "";
  const group = [groupFromDb, call("id", ["-gn", name]) ?? "", String(gid)].find((candidate) => isGroupName(candidate));
  const groups = (call("id", ["-G", name]) ?? String(gid))
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (!groups.includes(gid)) groups.push(gid);
  return { user: name, uid, gid, group: /** @type {string} */ (group), home, groups };
}

/**
 * Where setup keeps data for this account. An explicit MURAGE_DATA_DIR wins.
 * Otherwise, when setup runs as root for another account, the data belongs in
 * that account's home, not in root's; in every other case it is the invoking
 * account's own home, as before.
 * @param {{ env: Record<string, string | undefined>, account: { uid: number, home: string } | null, euid: number | null, home: string }} opts
 * @returns {{ dataDir: string, envFile: string }}
 */
export function setupPaths({ env, account, euid, home }) {
  const base = account && euid === 0 && account.uid !== 0 ? account.home : home;
  const dataDir = resolve(env.MURAGE_DATA_DIR || join(base, ".murage-server"));
  const envFile = resolve(env.MURAGE_ENV_FILE || join(dataDir, "murage.env"));
  return { dataDir, envFile };
}

/**
 * A directory only root can change: owned by uid 0, not writable by its group
 * or by others. Nobody but root can rename, replace or add an entry in it, so
 * a path that runs through such directories cannot be redirected under root.
 * @param {import("node:fs").Stats} st
 */
function rootOnly(st) {
  return !st.isSymbolicLink() && st.isDirectory() && st.uid === 0 && (st.mode & 0o022) === 0;
}

/** Every directory on a resolved path, from `/`, is one only root can change. */
function rootOnlyChain(real, lstat) {
  let dir = sep;
  if (!rootOnly(lstat(dir))) return false;
  for (const name of real.split(sep).filter(Boolean)) {
    dir = join(dir, name);
    let st;
    try {
      st = lstat(dir);
    } catch {
      return false;
    }
    if (!rootOnly(st)) return false;
  }
  return true;
}

/**
 * How far down `dataDir` root may act on its own: the deepest existing
 * directory on the path that only root can change (`trusted`), and the first
 * component under it (`next`), which root may create when it is missing.
 * Everything below that is the service account's to create, as the account.
 * Exported for tests; `lstat` and `realpath` are seams.
 * @param {string} dataDir absolute
 * @param {{ lstat?: typeof lstatSync, realpath?: (p: string) => string }} [seams]
 * @returns {{ trusted: string | null, next: string | null }}
 */
export function rootTrustedPrefix(dataDir, { lstat = lstatSync, realpath = realpathSync } = {}) {
  let trusted = sep;
  try {
    if (!rootOnly(lstat(trusted))) return { trusted: null, next: null };
  } catch {
    return { trusted: null, next: null };
  }
  for (const name of dataDir.split(sep).filter(Boolean)) {
    const next = join(trusted, name);
    let st;
    try {
      st = lstat(next);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { trusted, next };
      return { trusted, next: null };
    }
    if (st.isSymbolicLink()) {
      // The link sits in a directory only root can change, so it is stable;
      // follow it only to a place that is just as closed.
      let real;
      try {
        real = realpath(next);
      } catch {
        return { trusted, next: null };
      }
      if (!rootOnlyChain(real, lstat)) return { trusted, next: null };
      trusted = real;
      continue;
    }
    if (!rootOnly(st)) return { trusted, next: null };
    trusted = next;
  }
  return { trusted, next: null };
}

/**
 * Make sure the data directory exists, belongs to the service account, and is
 * 0700. Creates it (owned by the account) when missing. Refuses, and changes
 * nothing, when it is a symlink, not a directory, or owned by someone else.
 *
 * When root prepares the directory for another account, root itself acts only
 * inside directories only root can change, and creates at most the one missing
 * directory directly under them, handing it to the account. Everything else
 * (creating the rest of the path, opening, checking and tightening the data
 * directory) runs AS the account (`asAccount`). The account can rename its own
 * directories and plant symlinks at any moment; done as the account, a planted
 * link reaches only what the account could already change, never a system
 * directory (audit 08-1: `state` swapped for a link to /etc/systemd).
 * @param {string} dataDir
 * @param {{ user: string, uid: number, gid: number, groups?: number[] }} account
 * @param {{ euid: number | null }} opts
 * @returns {{ created: boolean }}
 */
export function prepareDataDir(dataDir, account, { euid }) {
  if (!isAbsolute(dataDir)) throw new ServiceAccountRefused("DATA_DIR_NOT_ABSOLUTE", `${dataDir} is not an absolute path`);
  if (euid !== 0 || account.uid === 0) return prepareOwnDataDir(dataDir, account, false);
  let rootMade = false;
  const { next } = rootTrustedPrefix(dataDir);
  if (next) {
    // `next` is missing and its parent only root can change: nobody can swap
    // the parent or plant a link at `next` while root works here.
    try {
      mkdirSync(next, { mode: 0o700 });
      rootMade = true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
    if (rootMade) {
      const fd = openSync(next, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
      try {
        fchmodSync(fd, 0o700);
        fchownSync(fd, account.uid, account.gid);
      } finally {
        closeSync(fd);
      }
    }
  }
  const result = asAccount(account, () => prepareOwnDataDir(dataDir, account, true));
  return { created: result.created || (rootMade && next === dataDir) };
}

/**
 * The data directory work done by the account that will own it (the caller is
 * that account, or wears its identity). Nothing here is privileged, so no
 * symlink can make it change anything the account could not change anyway.
 * @param {string} dataDir
 * @param {{ user: string, uid: number }} account
 * @param {boolean} forAnother setup runs as root for this account
 * @returns {{ created: boolean }}
 */
function prepareOwnDataDir(dataDir, account, forAnother) {
  let st = null;
  try {
    st = lstatSync(dataDir);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "EACCES" && forAnother) throw cannotReach(dataDir, account);
    if (code !== "ENOENT") throw error;
  }
  const notPlain = () =>
    new ServiceAccountRefused("DATA_DIR_NOT_A_DIRECTORY", `${dataDir} exists and is not a plain directory; setup will not write through it.`);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw notPlain();

  // Everything below works on an fd opened without following a symlink, not
  // on the path, so a link planted at the data directory itself is refused.
  if (!st) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (forAnother && (code === "EACCES" || code === "EPERM")) throw cannotReach(dataDir, account);
      throw error;
    }
  }
  let fd;
  try {
    fd = openSync(dataDir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") throw notPlain();
    if (code === "EACCES" && forAnother) throw cannotReach(dataDir, account);
    throw error;
  }
  try {
    const now = fstatSync(fd);
    if (!now.isDirectory()) throw notPlain();
    if (now.uid !== account.uid) {
      throw new ServiceAccountRefused(
        "DATA_DIR_FOREIGN_OWNER",
        `${dataDir} belongs to uid ${now.uid}, not to ${account.user} (uid ${account.uid}). Setup does not re-own existing ` +
          `data. Fix the ownership yourself if that data is ${account.user}'s, or choose another MURAGE_DATA_DIR.`
      );
    }
    if (!st || (now.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
    return { created: !st };
  } finally {
    closeSync(fd);
  }
}

/** @param {string} dataDir @param {{ user: string }} account */
function cannotReach(dataDir, account) {
  return new ServiceAccountRefused(
    "DATA_DIR_NOT_REACHABLE",
    `${account.user} cannot create or open ${dataDir}. Setup prepares the data directory as ${account.user}, so pick a ` +
      `MURAGE_DATA_DIR inside a directory ${account.user} owns, or create it for ${account.user} yourself first.`
  );
}

/**
 * Can `account` reach `path` with `need` permission bits (4 read, 2 write,
 * 1 execute), including search permission on every directory on the way?
 * Owner, primary and supplementary groups, and other bits are all counted.
 * Checked on the path as given and on its resolved target.
 * @param {string} path
 * @param {{ uid: number, gid: number, groups?: number[] }} account
 * @param {number} need
 * @param {{ stat?: typeof statSync, realpath?: (p: string) => string }} [seams]
 * @returns {{ ok: boolean, blockedAt?: string }}
 */
export function accountCanReach(path, account, need, { stat = statSync, realpath = realpathSync } = {}) {
  if (account.uid === 0) return { ok: true };
  const groups = new Set([account.gid, ...(account.groups ?? [])]);
  const allowed = (target, bits) => {
    let st;
    try {
      st = stat(target);
    } catch {
      return false;
    }
    const granted = st.uid === account.uid ? (st.mode >> 6) & 7 : groups.has(st.gid) ? (st.mode >> 3) & 7 : st.mode & 7;
    return (granted & bits) === bits;
  };
  let real = path;
  try {
    real = realpath(path);
  } catch {
    return { ok: false, blockedAt: path };
  }
  for (const candidate of new Set([path, real])) {
    const chain = [];
    for (let dir = dirname(candidate); ; dir = dirname(dir)) {
      chain.unshift(dir);
      if (dir === dirname(dir)) break;
    }
    for (const dir of chain) if (!allowed(dir, 1)) return { ok: false, blockedAt: dir };
    if (!allowed(candidate, need)) return { ok: false, blockedAt: candidate };
  }
  return { ok: true };
}
