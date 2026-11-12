import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { augmentedPath } from "../env-path.ts";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { basename, delimiter, dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { isCloudHome } from "../box-relay.ts";
import { cloudHomeCopy } from "./copy.ts";

/** The owner's own server, reached from a Cloud home. The existing "own
 * server" computer code drives Docker through `docker -H ssh://<alias>`; on
 * a home there is no ssh config, key or known_hosts, so this module owns
 * them under <data>/own-server and hands the child processes an `ssh`
 * wrapper (first on PATH) that carries every connection setting itself.
 *
 * Threat model: the own-server directory is owned by the server uid (murage). Agent turns run as a separate uid
 * (murage-turn) and cannot write it; the children that receive the wrapper PATH are spawned by the server and run
 * as the server uid. Tampering by the server uid itself is out of scope beyond the content, symlink and
 * ownership checks in this file. */
export const OWN_SERVER_ALIAS = "murage-own-server";
/** The one ssh the wrapper runs. Fixed: never taken from PATH or from the wrapper's own text. */
export const SSH_PATH = "/usr/bin/ssh";
/** The noVNC port inside a managed VPS container. vps-computer.ts forwards to it; the wrapper's viewer tunnel mode accepts only this target port. */
export const INTERNAL_VIEWER_PORT = 6901;

/** Strict dotted-decimal IPv4 in Docker's private bridge ranges (10/8, 172.16/12, 192.168/16). No leading zeros, no
 * empty parts, no hex or exponent forms. The wrapper's shell check mirrors this rule exactly; both must agree. */
export function isPrivateDockerIpv4(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export type OwnServerConnection = { host: string; port: number; user: string };
export type OwnServerRunResult = { stdout: string; stderr: string };
export type OwnServerRunner = (file: string, args: string[], options: { timeoutMs: number }) => Promise<OwnServerRunResult>;
export type OwnServerDeps = {
  dataDir?: string;
  /** Test hook only: replaces SSH_PATH in the rendered wrapper. Production never sets it. */
  sshPath?: string;
  run?: OwnServerRunner;
  /** Every address a name resolves to; only used to refuse private targets. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test hook: called before every file write with the file name and the running write count; throwing simulates a failed write. */
  beforeWrite?: (file: string, count: number) => void;
};

export class OwnServerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const defaultRun: OwnServerRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    // docker finds the home's ssh config only through the wrapper directory on PATH.
    execFile(file, [...args], withHideInherit({ timeout: options.timeoutMs, maxBuffer: 1024 * 1024, shell: false, windowsHide: true, env: ownServerChildEnv({ ...process.env, PATH: augmentedPath() }) }), (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

function dirOf(deps: OwnServerDeps): string {
  return join(deps.dataDir ?? DATA_DIR, "own-server");
}
const keyPath = (deps: OwnServerDeps) => join(dirOf(deps), "id_ed25519");
const configPath = (deps: OwnServerDeps) => join(dirOf(deps), "config");
const knownHostsPath = (deps: OwnServerDeps) => join(dirOf(deps), "known_hosts");
const connectionPath = (deps: OwnServerDeps) => join(dirOf(deps), "connection.json");
const binDir = (deps: OwnServerDeps) => join(dirOf(deps), "bin");
const pinnedPath = (deps: OwnServerDeps) => join(dirOf(deps), "pinned-address");

const serverUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** lstat (never follow a link): a real directory or regular file, owned by this process, with no group or world
 * write. A file must also be executable by its owner when `executable`. */
function plainNode(path: string, kind: "dir" | "file", executable = false): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) return false;
    const uid = serverUid();
    if (uid !== undefined && st.uid !== uid) return false;
    if ((st.mode & 0o022) !== 0) return false;
    return !executable || (st.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/** Makes `dir` a real 0700 directory owned by this process. A symlink or foreign directory in its place is removed
 * (a symlink is unlinked, never followed) and recreated. */
function ensurePlainDir(dir: string): void {
  if (!plainNode(dir, "dir")) {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) rmSync(dir, { recursive: true, force: true });
      else chmodSync(dir, 0o700);
    } catch { /* absent */ }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!plainNode(dir, "dir")) {
    try { chmodSync(dir, 0o700); } catch { /* checked next */ }
    if (!plainNode(dir, "dir")) throw new OwnServerError(500, cloudHomeCopy.ownServerNotConfirmed);
  }
}

function privateDir(deps: OwnServerDeps): string {
  const dir = dirOf(deps);
  ensurePlainDir(dir);
  return dir;
}

let writeCount = 0;
/** Every file in the own-server directory is written as temp + fsync + rename, so a failed write (ENOSPC, a crash)
 * leaves the old file whole or no file, never a truncated one. */
function writeAtomic(path: string, content: string, mode: number, deps: OwnServerDeps): void {
  deps.beforeWrite?.(basename(path), ++writeCount);
  const tmp = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w", mode);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already failing */ } }
    rmSync(tmp, { force: true });
    throw error;
  }
  try {
    const dfd = openSync(dirname(path), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* a directory fsync is best effort */ }
}

/** Homes whose start-up refresh failed. Their own-server is off until a save or confirm succeeds: no alias, no wrapper on PATH. */
const disabledDirs = new Set<string>();

// ---- validation ---------------------------------------------------------

function ipv4Public(address: string): boolean {
  const o = address.split(".").map(Number);
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  // an embedded IPv4 tail counts as two groups
  const expand = (items: string[]) => items.flatMap((item) => {
    if (!item.includes(".")) return [parseInt(item, 16)];
    const q = item.split(".").map(Number) as [number, number, number, number];
    return [q[0] * 256 + q[1], q[2] * 256 + q[3]];
  });
  const h = expand(head);
  const t = expand(tail);
  const fill = 8 - h.length - t.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...h, ...Array<number>(Math.max(fill, 0)).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Only global unicast (2000::/3) outside the documentation range. Mapped,
 * loopback, unique-local, link-local, multicast and the rest are refused. */
function ipv6Public(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return false;
  if (g[0]! < 0x2000 || g[0]! > 0x3fff) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x2002) return false; // 6to4 embeds an IPv4 address we do not check
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo (2001::/32) embeds one too
  return true;
}

export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4Public(address);
  if (isIPv6(address) && !address.includes("%")) return ipv6Public(address);
  return false;
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|lan|home|corp|intranet|home\.arpa)$/;

/** A DNS name or a public IP literal, nothing else. Throws OwnServerError. */
export function validateHost(raw: unknown): string {
  if (typeof raw !== "string") throw new OwnServerError(400, cloudHomeCopy.ownServerHostInvalid);
  const host = raw.trim().toLowerCase();
  if (host.length < 1 || host.length > 253 || host.startsWith("-")) throw new OwnServerError(400, cloudHomeCopy.ownServerHostInvalid);
  if (isIPv4(host) || isIPv6(host)) {
    if (!isPublicAddress(host)) throw new OwnServerError(400, cloudHomeCopy.ownServerHostNotPublic);
    return host;
  }
  // anything that is not a plain DNS name (spaces, slashes, brackets, '%',
  // ssh-config or shell metacharacters, a bare number like 2130706433) is out
  const labels = host.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label)) || /^[0-9]+$/.test(labels[labels.length - 1]!)) {
    throw new OwnServerError(400, cloudHomeCopy.ownServerHostInvalid);
  }
  if (labels.length < 2 || BLOCKED_SUFFIX.test(host)) throw new OwnServerError(400, cloudHomeCopy.ownServerHostNotPublic);
  return host;
}

export function validateUser(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(raw)) throw new OwnServerError(400, cloudHomeCopy.ownServerUserInvalid);
  return raw;
}

export function validatePort(raw: unknown): number {
  const port = raw === undefined || raw === null || raw === "" ? 22 : typeof raw === "string" && /^[0-9]{1,5}$/.test(raw) ? Number(raw) : raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new OwnServerError(400, cloudHomeCopy.ownServerPortInvalid);
  return port;
}

export function validateConnection(input: unknown): OwnServerConnection {
  const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return { host: validateHost(body.host), port: validatePort(body.port), user: validateUser(body.user) };
}

// ---- key, connection, config -------------------------------------------

/** Creates the key pair once; returns the public key line. */
export async function ensureKey(deps: OwnServerDeps = {}): Promise<string> {
  const run = deps.run ?? defaultRun;
  privateDir(deps);
  const pub = `${keyPath(deps)}.pub`;
  if (!existsSync(keyPath(deps)) || !existsSync(pub)) {
    rmSync(keyPath(deps), { force: true });
    rmSync(pub, { force: true });
    try {
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "murage-cloud-home", "-f", keyPath(deps)], { timeoutMs: 20_000 });
    } catch {
      throw new OwnServerError(500, cloudHomeCopy.ownServerKeyUnavailable);
    }
  }
  try {
    chmodSync(keyPath(deps), 0o600);
    return readFileSync(pub, "utf8").trim();
  } catch {
    throw new OwnServerError(500, cloudHomeCopy.ownServerKeyUnavailable);
  }
}

export function readConnection(deps: OwnServerDeps = {}): OwnServerConnection | null {
  try {
    return validateConnection(JSON.parse(readFileSync(connectionPath(deps), "utf8")));
  } catch {
    return null;
  }
}

function knownHostsPresent(deps: OwnServerDeps): boolean {
  try {
    return readFileSync(knownHostsPath(deps), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function knownHostsMatches(connection: OwnServerConnection, deps: OwnServerDeps): boolean {
  try {
    return readFileSync(knownHostsPath(deps), "utf8").split("\n").some((line) => line.startsWith(`${knownHostsName(connection)} ssh-ed25519 `));
  } catch {
    return false;
  }
}

/** The trust files agree with each other: known_hosts holds this host's key and the pin is a public address. The
 * wrapper carries every connection setting itself and never reads the config file, so the config is not part of
 * the trust. File presence alone is not enough. */
function trustConsistent(deps: OwnServerDeps): boolean {
  const connection = readConnection(deps);
  if (!connection || !knownHostsPresent(deps) || !knownHostsMatches(connection, deps)) return false;
  return readPinnedAddress(deps) !== null;
}

/** A host key is confirmed only when known_hosts, the pinned address and the config agree and the wrapper is the
 * connecting one, and the start-up refresh did not fail. */
export function hostKeyConfirmed(deps: OwnServerDeps = {}): boolean {
  return !disabledDirs.has(dirOf(deps)) && trustConsistent(deps) && wrapperKind(deps) === "connecting";
}

/** known_hosts is there but the trust files do not agree (an older form with nothing pinned, or an interrupted
 * confirm). The owner checks the identity once more; we never fall back to connecting by name. */
export function rescanNeeded(deps: OwnServerDeps = {}): boolean {
  return knownHostsPresent(deps) && !trustConsistent(deps);
}

/** The address the owner confirmed together with the host key, or null. */
export function readPinnedAddress(deps: OwnServerDeps = {}): string | null {
  try {
    const value = readFileSync(pinnedPath(deps), "utf8").trim();
    return isPublicAddress(value) ? value : null;
  } catch {
    return null;
  }
}

function pathValue(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** The whole ssh config: one Host block, values already validated. */
export function renderSshConfig(connection: OwnServerConnection, deps: OwnServerDeps = {}, pinned?: string): string {
  // ssh connects to the address that was checked and pinned with the host key, never to a name it would resolve
  // again. A public IP literal is its own pin. With no pin yet there is no HostName, so ssh cannot connect.
  const address = isIPv4(connection.host) || isIPv6(connection.host) ? connection.host : pinned ?? readPinnedAddress(deps);
  return [
    `Host ${OWN_SERVER_ALIAS}`,
    ...(address ? [`  HostName ${address}`] : []),
    `  HostKeyAlias ${knownHostsName(connection)}`,
    "  CheckHostIP no",
    `  Port ${connection.port}`,
    `  User ${connection.user}`,
    `  IdentityFile ${pathValue(keyPath(deps))}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${pathValue(knownHostsPath(deps))}`,
    "  StrictHostKeyChecking yes",
    "  HashKnownHosts no",
    "  BatchMode yes",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  GatewayPorts no",
    "  PermitLocalCommand no",
    "  ClearAllForwardings yes",
    "",
  ].join("\n");
}

const REFUSING_SCRIPT = `#!/bin/sh\necho "murage: your server's identity has not been confirmed, so no connection is made" >&2\nexit 255\n`;
/** Stands in for ssh on PATH when own-server is unusable, so ssh refuses while every other tool keeps working. */
const SHIM_SCRIPT = `#!/bin/sh\necho "murage: the connection to your own server is not available, so no connection is made" >&2\nexit 255\n`;

function connectingScript(connection: OwnServerConnection, pin: string, deps: OwnServerDeps): string {
  // Docker CLI 27 runs: ssh -o "ConnectTimeout=30" -T [-l user] [-p port] -- host docker system dial-stdio.
  // OpenSSH keeps parsing options after the host when no "--" came first, so this wrapper never forwards the
  // caller's argv. It accepts -T, ConnectTimeout=<digits>, and -l / -p values that are well formed (dropped: the
  // saved user and port are baked in), requires the destination to be exactly the alias, and runs the fixed ssh
  // with -F /dev/null (no config file is read, so Host *, Match and Include in any file are irrelevant), every
  // connection setting as a -o option, then "--", the alias and the remote command.
  const base = [
    `HostName=${pin}`,
    `Port=${connection.port}`,
    `User=${connection.user}`,
    `HostKeyAlias=${knownHostsName(connection)}`,
    `UserKnownHostsFile=${pathValue(knownHostsPath(deps))}`,
    "GlobalKnownHostsFile=/dev/null",
    "StrictHostKeyChecking=yes",
    "CheckHostIP=no",
    `IdentityFile=${pathValue(keyPath(deps))}`,
    "IdentitiesOnly=yes",
    "BatchMode=yes",
    "ProxyCommand=none",
    "ProxyJump=none",
    "ForwardAgent=no",
    "ForwardX11=no",
    "PermitLocalCommand=no",
    "ControlMaster=no",
    "ControlPath=none",
  ];
  const fixed = [...base.slice(0, base.indexOf("ProxyJump=none") + 1), "ClearAllForwardings=yes", ...base.slice(base.indexOf("ProxyJump=none") + 1)];
  // Viewer tunnel mode: the one argv shape vpsSshTunnelArgs produces, and nothing else. No ClearAllForwardings, so the
  // single validated -L works; every other forward kind stays off (no agent, X11, -R or -D is ever passed).
  const tunnelFixed = [...base, "GatewayPorts=no"];
  const tunnel = [
    "ipok() {",
    "  case \"$1\" in ''|.*|*.|*..*|*[!0-9.]*) return 1 ;; esac",
    "  oi=$IFS; IFS=.; set -f; set -- $1; IFS=$oi; set +f",
    "  [ $# -eq 4 ] || return 1",
    "  for o in \"$@\"; do case \"$o\" in 0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]) ;; *) return 1 ;; esac; [ \"$o\" -le 255 ] || return 1; done",
    "  case \"$1\" in 10) return 0 ;; esac",
    "  case \"$1\" in 172) [ \"$2\" -ge 16 ] && [ \"$2\" -le 31 ] && return 0 ;; 192) [ \"$2\" = 168 ] && return 0 ;; esac",
    "  return 1",
    "}",
    "digits() { case \"$1\" in ''|*[!0-9]*) return 1 ;; esac; return 0; }",
    "if [ \"$1\" = -N ]; then",
    "  [ $# -eq 14 ] || deny tunnel-shape",
    "  [ \"$2\" = -o ] && [ \"$3\" = BatchMode=yes ] && [ \"$4\" = -o ] && [ \"$5\" = ExitOnForwardFailure=yes ] || deny tunnel-shape",
    "  [ \"$6\" = -o ] && [ \"$7\" = PermitLocalCommand=no ] && [ \"$8\" = -o ] && [ \"${10}\" = -o ] && [ \"${12}\" = -L ] || deny tunnel-shape",
    "  case \"$9\" in ServerAliveInterval=?*) sai=${9#ServerAliveInterval=} ;; *) deny \"$9\" ;; esac",
    "  case \"${11}\" in ServerAliveCountMax=?*) sac=${11#ServerAliveCountMax=} ;; *) deny \"${11}\" ;; esac",
    "  digits \"$sai\" || deny \"$9\"; digits \"$sac\" || deny \"${11}\"",
    "  [ \"${14}\" = \"$alias\" ] || deny \"${14}\"",
    "  spec=${13}",
    "  case \"$spec\" in *[!0-9.:]*) deny \"$spec\" ;; 127.0.0.1:*) ;; *) deny \"$spec\" ;; esac",
    "  rest=${spec#127.0.0.1:}",
    "  case \"$rest\" in *:*:*:*) deny \"$spec\" ;; *:*:*) ;; *) deny \"$spec\" ;; esac",
    "  lport=${rest%%:*}; rest=${rest#*:}; tip=${rest%%:*}; tport=${rest#*:}",
    "  digits \"$lport\" || deny \"$spec\"",
    "  case \"$lport\" in 0*) deny \"$spec\" ;; esac",
    "  [ ${#lport} -le 5 ] && [ \"$lport\" -ge 1024 ] && [ \"$lport\" -le 65535 ] || deny \"$spec\"",
    "  ipok \"$tip\" || deny \"$spec\"",
    `  [ "$tport" = ${INTERNAL_VIEWER_PORT} ] || deny "$spec"`,
    `  exec ${shellQuote(deps.sshPath ?? SSH_PATH)} -F /dev/null ${tunnelFixed.map((o) => `-o ${shellQuote(o)}`).join(" ")} -o "BatchMode=yes" -o "ExitOnForwardFailure=yes" -o "PermitLocalCommand=no" -o "ServerAliveInterval=$sai" -o "ServerAliveCountMax=$sac" -N -L "$spec" -- "$alias"`,
    "fi",
  ];
  const lines = [
    "#!/bin/sh",
    `alias=${OWN_SERVER_ALIAS}`,
    "deny() { echo \"murage: ssh argument $1 is not allowed for the own server\" >&2; exit 255; }",
    "settimeout() { v=${1# }; case \"$v\" in ConnectTimeout=?*) d=${v#ConnectTimeout=}; case \"$d\" in *[!0-9]*) deny \"$1\" ;; esac; ct=$d ;; *) deny \"$1\" ;; esac; }",
    ...tunnel,
    "t=''; ct=''",
    "while [ $# -gt 0 ]; do",
    "  a=$1",
    "  case \"$a\" in",
    "    --) shift; break ;;",
    "    -T) t=1; shift ;;",
    "    -o) [ $# -ge 2 ] || deny missing-value; settimeout \"$2\"; shift 2 ;;",
    "    -o*) settimeout \"${a#-o}\"; shift ;;",
    "    -l) [ $# -ge 2 ] || deny missing-value; case \"$2\" in ''|-*) deny \"$2\" ;; esac; shift 2 ;;",
    "    -p) [ $# -ge 2 ] || deny missing-value; case \"$2\" in ''|*[!0-9]*) deny \"$2\" ;; esac; shift 2 ;;",
    "    -*) deny \"$a\" ;;",
    "    *) break ;;",
    "  esac",
    "done",
    "[ $# -ge 1 ] || deny missing-destination",
    "[ \"$1\" = \"$alias\" ] || deny \"$1\"",
    "shift",
    "set -- -- \"$alias\" \"$@\"",
    "[ -z \"$ct\" ] || set -- -o \"ConnectTimeout=$ct\" \"$@\"",
    "[ -z \"$t\" ] || set -- -T \"$@\"",
    `exec ${shellQuote(deps.sshPath ?? SSH_PATH)} -F /dev/null ${fixed.map((o) => `-o ${shellQuote(o)}`).join(" ")} "$@"`,
    "",
  ];
  return lines.join("\n");
}

/** What bin/ssh must contain, computed from the server's own state and never from the file: the refusing script
 * until a pin exists, otherwise the connecting script when the trust files agree. */
function expectedWrapper(deps: OwnServerDeps): { kind: "refusing" | "connecting"; text: string } | null {
  const connection = readConnection(deps);
  if (!connection) return null;
  const pin = readPinnedAddress(deps);
  if (!pin || !trustConsistent(deps)) return { kind: "refusing", text: REFUSING_SCRIPT };
  return { kind: "connecting", text: connectingScript(connection, pin, deps) };
}

/** What is installed as bin/ssh: "refusing" when it is the refusing script, "connecting" when its bytes equal the
 * connecting script rendered from the saved state, null when anything else, or when the own-server directory, bin
 * directory or file is a symlink, foreign-owned, group or world writable, or not executable. */
function wrapperKind(deps: OwnServerDeps): "refusing" | "connecting" | null {
  const path = join(binDir(deps), "ssh");
  if (!plainNode(dirOf(deps), "dir") || !plainNode(binDir(deps), "dir") || !plainNode(path, "file", true)) return null;
  try {
    const content = readFileSync(path, "utf8");
    if (content === REFUSING_SCRIPT) return "refusing";
    const connection = readConnection(deps);
    const pin = readPinnedAddress(deps);
    if (!connection || !pin) return null;
    return content === connectingScript(connection, pin, deps) ? "connecting" : null;
  } catch {
    return null;
  }
}

/** Removes the pinned address and fsyncs the directory, so a crash or a failed later write can never leave the old
 * address standing next to a replaced known_hosts. Without a pin the trust files do not agree and the wrapper refuses. */
function invalidatePin(deps: OwnServerDeps): void {
  rmSync(pinnedPath(deps), { force: true });
  try {
    const dfd = openSync(dirOf(deps), "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* a directory fsync is best effort */ }
}

/** Replaces the wrapper with the refusing one and drops the pin, in that order. If the wrapper cannot be written the
 * pin is still dropped and the wrapper directory removed, so the home fails closed. */
function closeTrust(deps: OwnServerDeps): void {
  try {
    writeRefusingWrapper(deps);
  } catch (error) {
    try { invalidatePin(deps); } catch { /* the error below is the one to report */ }
    try { rmSync(binDir(deps), { recursive: true, force: true }); } catch { /* disabled in memory regardless */ }
    disabledDirs.add(dirOf(deps));
    throw error;
  }
  invalidatePin(deps);
}

function writeRefusingWrapper(deps: OwnServerDeps): void {
  ensurePlainDir(binDir(deps));
  writeAtomic(join(binDir(deps), "ssh"), REFUSING_SCRIPT, 0o700, deps);
}

/** Installs the connecting wrapper only when the trust files agree; otherwise the refusing one. */
function writeWrapper(deps: OwnServerDeps): void {
  const want = expectedWrapper(deps);
  if (!want || want.kind === "refusing") return writeRefusingWrapper(deps);
  ensurePlainDir(binDir(deps));
  writeAtomic(join(binDir(deps), "ssh"), want.text, 0o700, deps);
}

const shimDir = (deps: OwnServerDeps) => join(dirOf(deps), "refuse-bin");

/** The directory holding the refusing `ssh` shim, checked with the same lstat and owner rules. Throws the plain
 * "not confirmed" refusal when it cannot be provided, so a child never starts with a usable ssh by accident. */
function ensureShimDir(deps: OwnServerDeps): string {
  const dir = shimDir(deps);
  const file = join(dir, "ssh");
  const good = () => plainNode(dirOf(deps), "dir") && plainNode(dir, "dir") && plainNode(file, "file", true) && readFileSync(file, "utf8") === SHIM_SCRIPT;
  try {
    if (good()) return dir;
    privateDir(deps);
    ensurePlainDir(dir);
    writeAtomic(file, SHIM_SCRIPT, 0o700, deps);
    if (good()) return dir;
  } catch { /* refused below */ }
  throw new OwnServerError(409, cloudHomeCopy.ownServerNotConfirmed);
}

/** Re-renders the ssh config and wrapper from the saved state. Run at server start so a home that was set up by an
 * older build never keeps its old wrapper or a config that connects by name. Fails closed: on any error the wrapper
 * directory is removed and own-server is switched off in memory (no alias, and children get a refusing ssh first on PATH) until
 * the owner saves or confirms again. The rest of the app keeps starting, as it does for other optional features.
 * Returns false when it failed. */
export function refreshOwnServerFiles(deps: OwnServerDeps = {}): boolean {
  const connection = readConnection(deps);
  if (!connection) {
    try { rmSync(binDir(deps), { recursive: true, force: true }); } catch { /* nothing left to use anyway */ }
    disabledDirs.delete(dirOf(deps));
    return true;
  }
  try {
    privateDir(deps);
    ensureShimDir(deps);
    writeAtomic(configPath(deps), renderSshConfig(connection, deps), 0o600, deps);
    writeWrapper(deps);
    disabledDirs.delete(dirOf(deps));
    return true;
  } catch {
    disabledDirs.add(dirOf(deps));
    try { rmSync(binDir(deps), { recursive: true, force: true }); } catch { /* disabled in memory regardless */ }
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---- host key -----------------------------------------------------------

type PendingScan = { fingerprint: string; line: string; address: string; host: string; port: number; generation: number };
const pendingScans = new Map<string, PendingScan>();
/** Bumped by every save and removal. A scan only counts if the connection it scanned is still the saved one. */
const generations = new Map<string, number>();
const generationOf = (deps: OwnServerDeps) => generations.get(dirOf(deps)) ?? 0;
const bumpGeneration = (deps: OwnServerDeps) => { generations.set(dirOf(deps), generationOf(deps) + 1); pendingScans.delete(dirOf(deps)); };

/** The name ssh looks the host key up under (HostKeyAlias): the owner's host, so the key follows the server the
 * owner named while the connection itself goes to the pinned address. */
function knownHostsName(connection: OwnServerConnection): string {
  return connection.host;
}

function knownHostsEntry(connection: OwnServerConnection): string {
  return knownHostsName(connection);
}

/** Parses ssh-keyscan output; returns the first ed25519 key as a known_hosts
 * line (rewritten for this host/port, never copied from the scan output)
 * plus its OpenSSH SHA256 fingerprint. */
export function parseKeyscan(output: string, connection: OwnServerConnection): { fingerprint: string; line: string } | null {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const type = fields[1];
    const blob = fields[2];
    if (type !== "ssh-ed25519" || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) continue;
    const bytes = Buffer.from(blob, "base64");
    if (bytes.length === 0) continue;
    const fingerprint = `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
    return { fingerprint, line: `${knownHostsEntry(connection)} ${type} ${blob}\n` };
  }
  return null;
}

/** Reads the server's host key and returns its fingerprint for the owner to
 * compare. Nothing is trusted until confirmHostKey. */
export async function scanHostKey(deps: OwnServerDeps = {}): Promise<string> {
  const connection = readConnection(deps);
  if (!connection) throw new OwnServerError(409, cloudHomeCopy.ownServerNotSetUp);
  const run = deps.run ?? defaultRun;
  const generation = generationOf(deps);
  // Resolve once, require every answer to be public, then talk only to one pinned literal address so a second
  // lookup cannot be answered differently.
  let address: string;
  if (isIPv4(connection.host) || isIPv6(connection.host)) {
    address = connection.host;
  } else {
    let addresses: string[];
    try {
      addresses = await (deps.resolve ?? defaultResolve)(connection.host);
    } catch {
      throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new OwnServerError(400, cloudHomeCopy.ownServerHostNotPublic);
    address = addresses.find((a) => isIPv4(a)) ?? addresses[0]!;
  }
  let result: OwnServerRunResult;
  try {
    result = await run("ssh-keyscan", ["-T", "10", "-p", String(connection.port), "-t", "ed25519", address], { timeoutMs: 20_000 });
  } catch {
    throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
  }
  const parsed = parseKeyscan(result.stdout, connection);
  if (!parsed) throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
  const current = readConnection(deps);
  if (generationOf(deps) !== generation || !current || current.host !== connection.host || current.port !== connection.port) {
    throw new OwnServerError(409, cloudHomeCopy.ownServerNoScanPending);
  }
  pendingScans.set(dirOf(deps), { ...parsed, address, host: connection.host, port: connection.port, generation });
  return parsed.fingerprint;
}

/** Writes known_hosts only when the owner's fingerprint is the scanned one. */
export function confirmHostKey(fingerprint: unknown, deps: OwnServerDeps = {}): void {
  const pending = pendingScans.get(dirOf(deps));
  if (!pending) throw new OwnServerError(409, cloudHomeCopy.ownServerNoScanPending);
  const given = Buffer.from(typeof fingerprint === "string" ? fingerprint.trim() : "");
  const wanted = Buffer.from(pending.fingerprint);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new OwnServerError(409, cloudHomeCopy.ownServerFingerprintMismatch);
  privateDir(deps);
  const connection = readConnection(deps);
  if (!connection) throw new OwnServerError(409, cloudHomeCopy.ownServerNotSetUp);
  if (pending.generation !== generationOf(deps) || pending.host !== connection.host || pending.port !== connection.port) {
    pendingScans.delete(dirOf(deps));
    throw new OwnServerError(409, cloudHomeCopy.ownServerNoScanPending);
  }
  // Order: the wrapper goes to refusing first; known_hosts and the config follow; the pin is the commit point (the
  // trust files only agree once it exists); the connecting wrapper is last. Any failure in between leaves the home
  // refusing, and a retry starts again from a fresh scan. The old pin is removed before known_hosts is touched, so
  // a re-confirm that fails part way can never leave the old address next to the new key.
  closeTrust(deps);
  writeAtomic(knownHostsPath(deps), pending.line, 0o600, deps);
  writeAtomic(configPath(deps), renderSshConfig(connection, deps, pending.address), 0o600, deps);
  writeAtomic(pinnedPath(deps), `${pending.address}\n`, 0o600, deps);
  writeWrapper(deps);
  disabledDirs.delete(dirOf(deps));
  pendingScans.delete(dirOf(deps));
}

/** Saves the connection and rewrites the ssh config and wrapper. A different
 * host or port forgets the old host key. Returns whether it was forgotten. */
export function saveConnection(input: unknown, deps: OwnServerDeps = {}): { connection: OwnServerConnection; hostKeyCleared: boolean } {
  const connection = validateConnection(input);
  const previous = readConnection(deps);
  privateDir(deps);
  bumpGeneration(deps);
  const changed = !previous || previous.host !== connection.host || previous.port !== connection.port;
  if (changed) {
    closeTrust(deps);
    rmSync(knownHostsPath(deps), { force: true });
    pendingScans.delete(dirOf(deps));
  }
  else writeRefusingWrapper(deps);
  writeAtomic(connectionPath(deps), `${JSON.stringify(connection)}\n`, 0o600, deps);
  writeAtomic(configPath(deps), renderSshConfig(connection, deps), 0o600, deps);
  writeWrapper(deps);
  disabledDirs.delete(dirOf(deps));
  return { connection, hostKeyCleared: changed };
}

/** Deletes the connection and host key; the key pair stays. */
export function removeConnection(deps: OwnServerDeps = {}): void {
  // Same order as saveConnection: the wrapper goes to refusing and the pin is removed first, so a live child with bin
  // first on PATH is refused at once and a crash part way leaves the home refusing. The trust files follow; bin is last.
  try { closeTrust(deps); } catch { /* it already dropped the pin and bin; the removal below finishes the job */ }
  for (const path of [knownHostsPath(deps), connectionPath(deps), configPath(deps)]) rmSync(path, { force: true });
  rmSync(binDir(deps), { recursive: true, force: true });
  disabledDirs.delete(dirOf(deps));
  bumpGeneration(deps);
}

export type OwnServerTestResult = { ok: true; dockerVersion: string } | { ok: false; problem: string };

/** One real round trip: ssh in, ask the Docker engine for its version. */
export async function testConnection(deps: OwnServerDeps = {}): Promise<OwnServerTestResult> {
  if (!readConnection(deps)) return { ok: false, problem: cloudHomeCopy.ownServerNotSetUp };
  if (rescanNeeded(deps)) return { ok: false, problem: cloudHomeCopy.ownServerRescanNeeded };
  if (disabledDirs.has(dirOf(deps)) || !trustConsistent(deps)) return { ok: false, problem: cloudHomeCopy.ownServerNotConfirmed };
  try {
    writeWrapper(deps);
  } catch {
    return { ok: false, problem: cloudHomeCopy.ownServerNotConfirmed };
  }
  if (!hostKeyConfirmed(deps)) return { ok: false, problem: cloudHomeCopy.ownServerNotConfirmed };
  const run = deps.run ?? defaultRun;
  try {
    const out = await run("docker", ["-H", `ssh://${OWN_SERVER_ALIAS}`, "version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
    return { ok: true, dockerVersion: out.stdout.trim() };
  } catch (error) {
    const text = String((error as { stderr?: unknown }).stderr ?? "") + " " + String((error as Error).message ?? "");
    if (/host key verification failed|remote host identification has changed/i.test(text)) return { ok: false, problem: cloudHomeCopy.ownServerTestHostKeyChanged };
    if (/permission denied \((?:publickey|keyboard)/i.test(text)) return { ok: false, problem: cloudHomeCopy.ownServerTestKeyNotInstalled };
    if (/could not resolve hostname|connection refused|connection timed out|no route to host|network is unreachable/i.test(text)) return { ok: false, problem: cloudHomeCopy.ownServerTestUnreachable };
    if (/docker\.sock|docker daemon|dial-stdio|command not found|docker: not found|executable file not found/i.test(text)) return { ok: false, problem: cloudHomeCopy.ownServerTestNoDocker };
    return { ok: false, problem: cloudHomeCopy.ownServerTestUnreachable };
  }
}

// ---- child environment --------------------------------------------------

/** Docker's ssh transport runs plain `ssh` found on PATH, with no setting for
 * a config file. On a home with a saved connection the wrapper directory goes
 * first on PATH for those children only. Anything else is returned as given,
 * so a desktop is never touched. */
export function ownServerChildEnv(env: NodeJS.ProcessEnv, deps: OwnServerDeps = {}, home: boolean = isCloudHome()): NodeJS.ProcessEnv {
  if (!home) return env;
  const off = disabledDirs.has(dirOf(deps));
  const kind = off ? null : wrapperKind(deps);
  if (kind === "refusing" || (kind === "connecting" && trustConsistent(deps))) {
    // The refusing shim always follows bin. A child that outlives a failed re-confirm (which removes bin) then
    // still finds the shim, never /usr/bin/ssh. ensureShimDir throws when the shim cannot be provided or verified.
    return { ...env, PATH: [binDir(deps), ensureShimDir(deps), env.PATH].filter(Boolean).join(delimiter) };
  }
  if (off || readConnection(deps)) {
    // Own-server is set up but its wrapper is missing, changed or not usable. No PATH entry is removed (the
    // other tools in /usr/bin and friends must keep working); a refusing ssh goes first instead.
    return { ...env, PATH: [ensureShimDir(deps), env.PATH].filter(Boolean).join(delimiter) };
  }
  return env;
}

/** The alias the lifecycle code should use on a home: ours once confirmed, and only while the wrapper is the exact
 * connecting one and own-server has not been switched off. Otherwise null. */
export function ownServerAlias(deps: OwnServerDeps = {}, home: boolean = isCloudHome()): string | null {
  return home && hostKeyConfirmed(deps) ? OWN_SERVER_ALIAS : null;
}

// ---- HTTP ---------------------------------------------------------------

export type OwnServerApiRequest = {
  method: string;
  path: string;
  readBody: () => Promise<unknown>;
  /** Sets (alias) or clears ("") vps.sshAlias. Returns a refusal text, or null. */
  setAlias: (alias: string) => string | null;
  deps?: OwnServerDeps;
};
export type OwnServerApiAnswer = { status: number; body: unknown };

async function state(deps: OwnServerDeps, extra: Record<string, unknown> = {}) {
  return {
    publicKey: await ensureKey(deps),
    connection: readConnection(deps),
    hostKeyConfirmed: hostKeyConfirmed(deps),
    rescanNeeded: rescanNeeded(deps),
    ...extra,
  };
}

/** Owner routes under /api/cloud/own-server. The caller has already checked
 * that this is an owner on a Cloud home. Returns null for other paths. */
export async function handleOwnServerApi(req: OwnServerApiRequest): Promise<OwnServerApiAnswer | null> {
  const { method, path } = req;
  const deps = req.deps ?? {};
  const base = "/api/cloud/own-server";
  if (path !== base && path !== `${base}/confirm` && path !== `${base}/test`) return null;
  try {
    if (path === base && method === "GET") return { status: 200, body: await state(deps) };
    if (path === base && method === "PUT") {
      await ensureKey(deps);
      const saved = saveConnection(await req.readBody(), deps);
      // the old host key is gone, so the alias must not point at an unproven server
      if (saved.hostKeyCleared) {
        const refusal = req.setAlias("");
        if (refusal) return { status: 409, body: { error: refusal } };
      }
      let fingerprint: string | null = null;
      let problem: string | null = null;
      try {
        fingerprint = await scanHostKey(deps);
      } catch (error) {
        if (!(error instanceof OwnServerError)) throw error;
        problem = error.message;
      }
      return { status: 200, body: await state(deps, { fingerprint, problem }) };
    }
    if (path === `${base}/confirm` && method === "POST") {
      const body = await req.readBody();
      const fingerprint = body && typeof body === "object" ? (body as Record<string, unknown>).fingerprint : undefined;
      confirmHostKey(fingerprint, deps);
      const refusal = req.setAlias(OWN_SERVER_ALIAS);
      if (refusal) return { status: 409, body: { error: refusal } };
      return { status: 200, body: await state(deps) };
    }
    if (path === `${base}/test` && method === "POST") {
      const result = await testConnection(deps);
      return { status: 200, body: result.ok ? { ok: true, message: cloudHomeCopy.ownServerTestOk, dockerVersion: result.dockerVersion } : { ok: false, problem: result.problem } };
    }
    if (path === base && method === "DELETE") {
      const refusal = req.setAlias("");
      if (refusal) return { status: 409, body: { error: refusal } };
      removeConnection(deps);
      return { status: 200, body: await state(deps) };
    }
  } catch (error) {
    if (error instanceof OwnServerError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
  return { status: 405, body: { error: cloudHomeCopy.ownServerBadRequest } };
}
