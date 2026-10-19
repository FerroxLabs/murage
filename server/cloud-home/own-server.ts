// SPDX-License-Identifier: AGPL-3.0-or-later
import { augmentedPath } from "../env-path.ts";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { delimiter, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { isCloudHome } from "../box-relay.ts";
import { cloudHomeCopy } from "./copy.ts";

/** The owner's own server, reached from a Cloud home. The existing "own
 * server" computer code drives Docker through `docker -H ssh://<alias>`; on
 * a home there is no ssh config, key or known_hosts, so this module owns
 * them under <data>/own-server and hands the child processes an `ssh`
 * wrapper (first on PATH) that always reads that config. */
export const OWN_SERVER_ALIAS = "murage-own-server";

export type OwnServerConnection = { host: string; port: number; user: string };
export type OwnServerRunResult = { stdout: string; stderr: string };
export type OwnServerRunner = (file: string, args: string[], options: { timeoutMs: number }) => Promise<OwnServerRunResult>;
export type OwnServerDeps = {
  dataDir?: string;
  run?: OwnServerRunner;
  /** Every address a name resolves to; only used to refuse private targets. */
  resolve?: (host: string) => Promise<string[]>;
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
    execFile(file, args, { timeout: options.timeoutMs, maxBuffer: 1024 * 1024, shell: false, windowsHide: true, env: ownServerChildEnv({ ...process.env, PATH: augmentedPath() }) }, (error, stdout, stderr) => {
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

function privateDir(deps: OwnServerDeps): string {
  const dir = dirOf(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

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

export function hostKeyConfirmed(deps: OwnServerDeps = {}): boolean {
  try {
    return readFileSync(knownHostsPath(deps), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function pathValue(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** The whole ssh config: one Host block, values already validated. */
export function renderSshConfig(connection: OwnServerConnection, deps: OwnServerDeps = {}): string {
  return [
    `Host ${OWN_SERVER_ALIAS}`,
    `  HostName ${connection.host}`,
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
    "",
  ].join("\n");
}

function realSsh(basePath: string | undefined, deps: OwnServerDeps): string {
  const skip = binDir(deps);
  for (const dir of (basePath ?? "").split(delimiter)) {
    if (!dir || dir === skip) continue;
    const candidate = join(dir, "ssh");
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/bin/ssh";
}

function writeWrapper(deps: OwnServerDeps): void {
  mkdirSync(binDir(deps), { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh\nexec ${shellQuote(realSsh(process.env.PATH, deps))} -F ${shellQuote(configPath(deps))} "$@"\n`;
  const path = join(binDir(deps), "ssh");
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---- host key -----------------------------------------------------------

const pendingScans = new Map<string, { fingerprint: string; line: string }>();

function knownHostsEntry(connection: OwnServerConnection): string {
  return connection.port === 22 ? connection.host : `[${connection.host}]:${connection.port}`;
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
  if (!isIPv4(connection.host) && !isIPv6(connection.host)) {
    // a name that points inside a private network is refused too
    let addresses: string[];
    try {
      addresses = await (deps.resolve ?? defaultResolve)(connection.host);
    } catch {
      throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new OwnServerError(400, cloudHomeCopy.ownServerHostNotPublic);
  }
  let result: OwnServerRunResult;
  try {
    result = await run("ssh-keyscan", ["-T", "10", "-p", String(connection.port), "-t", "ed25519", connection.host], { timeoutMs: 20_000 });
  } catch {
    throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
  }
  const parsed = parseKeyscan(result.stdout, connection);
  if (!parsed) throw new OwnServerError(502, cloudHomeCopy.ownServerScanFailed);
  pendingScans.set(dirOf(deps), parsed);
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
  writeFileSync(knownHostsPath(deps), pending.line, { mode: 0o600 });
  pendingScans.delete(dirOf(deps));
}

/** Saves the connection and rewrites the ssh config and wrapper. A different
 * host or port forgets the old host key. Returns whether it was forgotten. */
export function saveConnection(input: unknown, deps: OwnServerDeps = {}): { connection: OwnServerConnection; hostKeyCleared: boolean } {
  const connection = validateConnection(input);
  const previous = readConnection(deps);
  privateDir(deps);
  const changed = !previous || previous.host !== connection.host || previous.port !== connection.port;
  if (changed) {
    rmSync(knownHostsPath(deps), { force: true });
    pendingScans.delete(dirOf(deps));
  }
  writeFileSync(connectionPath(deps), `${JSON.stringify(connection)}\n`, { mode: 0o600 });
  writeFileSync(configPath(deps), renderSshConfig(connection, deps), { mode: 0o600 });
  writeWrapper(deps);
  return { connection, hostKeyCleared: changed };
}

/** Deletes the connection and host key; the key pair stays. */
export function removeConnection(deps: OwnServerDeps = {}): void {
  for (const path of [connectionPath(deps), configPath(deps), knownHostsPath(deps)]) rmSync(path, { force: true });
  rmSync(binDir(deps), { recursive: true, force: true });
  pendingScans.delete(dirOf(deps));
}

export type OwnServerTestResult = { ok: true; dockerVersion: string } | { ok: false; problem: string };

/** One real round trip: ssh in, ask the Docker engine for its version. */
export async function testConnection(deps: OwnServerDeps = {}): Promise<OwnServerTestResult> {
  if (!readConnection(deps)) return { ok: false, problem: cloudHomeCopy.ownServerNotSetUp };
  if (!hostKeyConfirmed(deps)) return { ok: false, problem: cloudHomeCopy.ownServerNotConfirmed };
  writeWrapper(deps);
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
  if (!home || !existsSync(join(binDir(deps), "ssh"))) return env;
  return { ...env, PATH: [binDir(deps), env.PATH].filter(Boolean).join(delimiter) };
}

/** The alias the lifecycle code should use on a home: ours once confirmed. */
export function ownServerAlias(deps: OwnServerDeps = {}, home: boolean = isCloudHome()): string | null {
  return home && readConnection(deps) && hostKeyConfirmed(deps) ? OWN_SERVER_ALIAS : null;
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
