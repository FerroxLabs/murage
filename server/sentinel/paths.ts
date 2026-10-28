// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel descriptor and path guards (1.0.9, GAP-SENTINEL-109 sections 3.1, 3.3, 7 and 10.1).
//
// The descriptor is the scanner's only configuration: version, opaque installation id, the canonical installation root
// (DATA_DIR), `inputRoot` fixed to its `health` child, the separate canonical output root, the fixed source-role paths,
// the executable identity and the schedule revision. It holds no token, credential or provider setting. It lives at
// `<outputRoot>/descriptor.json` (owner-only); lane C writes it with writeDescriptor().
//
// Guards, all fail closed: absolute normalized paths only (no UNC, no NUL); inputRoot === <installationRoot>/health and
// every source is exactly <inputRoot>/<fixed name>; the output root is <...>/MurageSentinel/<installationId>, outside the
// installation root and outside any repository; symlinks, junctions and reparse points (lstat + realpath), hard links
// (nlink > 1), non-regular files, owner mismatch and path escape are refused; the output root is owner-only (0700 / 0600
// on POSIX; on Windows an injectable DACL check, never chmod). Paths are never derived from log or manifest values,
// except the sealed stats generation, whose name is checked against the fixed generation pattern.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync, chmodSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { HEALTH_BOUNDS, HEALTH_DIR, HEALTH_FILES, HEALTH_TOKEN_PATTERN } from "../../shared/health-protocol.mjs";
import { windowsAclCheck, windowsAclRestrict, type AclCheck } from "./win-acl.ts";

export const DESCRIPTOR_VERSION = 1;
export const DESCRIPTOR_FILE = "descriptor.json";
export const DESCRIPTOR_MAX_BYTES = 8 * 1024;
export const OUTPUT_PARENT = "MurageSentinel";
const MAX_PATH_CHARS = 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type SourceRole = keyof typeof HEALTH_FILES;
export const SOURCE_ROLES = Object.freeze(Object.keys(HEALTH_FILES) as SourceRole[]);

export interface ExecutableIdentity {
  /** Absolute path of the runtime (the installed desktop executable with ELECTRON_RUN_AS_NODE, or a pinned Node). */
  path: string;
  /** Absolute path of the bundled scanner entry (server/sentinel/cli.js). */
  entry: string;
  /** Lowercase hex SHA-256 of the entry file when known, else null. */
  sha256: string | null;
}

/** The producers an installation runs. A desktop installation has both; a server-only one (self-host, Cloud) has no
 * desktop producer, so its absence there is not-applicable rather than unavailable. */
export type DescriptorProducer = "server" | "desktop";

export interface SentinelDescriptor {
  version: 1;
  installationId: string;
  installationRoot: string;
  inputRoot: string;
  outputRoot: string;
  sources: Readonly<Record<SourceRole, string>>;
  executable: ExecutableIdentity;
  scheduleRevision: number;
  /** The producers this installation runs (always including `server`). Optional: when absent, a producer that has never
   * published anything is not-applicable, and one that published before and went missing is unavailable. */
  producers?: readonly DescriptorProducer[];
}

export type PathResult<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export interface PlatformOptions {
  platform?: NodeJS.Platform;
  /** Expected owner uid on POSIX (default: this process). */
  uid?: number;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Absolute, normalized, bounded, no NUL, no UNC/device prefix. */
export function isCleanAbsolute(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS || value.includes("\0")) return false;
  const p = pathFor(platform);
  if (!p.isAbsolute(value)) return false;
  if (platform === "win32") {
    if (!/^[A-Za-z]:\\/.test(value)) return false; // drive paths only: no \\server\share, \\?\ or \\.\ device paths
  } else if (value.startsWith("//")) return false;
  const normalized = p.normalize(value);
  const trimmed = normalized.length > 1 && (normalized.endsWith(p.sep)) && !/^[A-Za-z]:\\$/.test(normalized) ? normalized.slice(0, -1) : normalized;
  return trimmed === value;
}

/** True when `child` equals `parent` or lies below it (case-insensitive on Windows and macOS). */
export function within(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathFor(platform);
  const fold = (s: string) => (platform === "win32" || platform === "darwin" ? s.toLowerCase() : s);
  const rel = p.relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Names an explicit state folder for every party of one installation (the Cloud scanner unit and the home server). */
export const SENTINEL_STATE_DIR_ENV = "MURAGE_SENTINEL_STATE_DIR";

/** The default output root per OS (section 10.1), or null when the environment gives no usable base.
 * MURAGE_SENTINEL_STATE_DIR, when it is a clean absolute path, is the base on every OS, so the writer and every reader
 * of one installation resolve the same folder. */
export function defaultOutputRoot(installationId: string, opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  if (!HEALTH_TOKEN_PATTERN.test(installationId)) return null;
  const p = pathFor(platform);
  let base: string | undefined;
  const explicit = env[SENTINEL_STATE_DIR_ENV];
  if (explicit) base = isCleanAbsolute(explicit, platform) ? explicit : undefined;
  else if (platform === "darwin") base = isCleanAbsolute(home, platform) ? p.join(home, "Library", "Application Support") : undefined;
  else if (platform === "win32") base = env.LOCALAPPDATA && isCleanAbsolute(p.normalize(env.LOCALAPPDATA).replace(/\\$/, ""), platform) ? p.normalize(env.LOCALAPPDATA).replace(/\\$/, "") : undefined;
  else {
    const xdg = env.XDG_STATE_HOME;
    if (xdg && isCleanAbsolute(xdg, platform)) base = xdg;
    else if (isCleanAbsolute(home, platform)) base = p.join(home, ".local", "state");
  }
  return base ? p.join(base, OUTPUT_PARENT, installationId) : null;
}

/** The fixed source paths for an input root. */
export function sourcePaths(inputRoot: string, platform: NodeJS.Platform = process.platform): Record<SourceRole, string> {
  const p = pathFor(platform);
  return Object.fromEntries(SOURCE_ROLES.map(role => [role, p.join(inputRoot, HEALTH_FILES[role])])) as Record<SourceRole, string>;
}

const DESCRIPTOR_KEYS = ["version", "installationId", "installationRoot", "inputRoot", "outputRoot", "sources", "executable", "scheduleRevision"];
const exactKeys = (value: unknown, keys: readonly string[]) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

/** Pure shape and relationship validation (no filesystem access). */
export function validateDescriptor(raw: unknown, platform: NodeJS.Platform = process.platform): PathResult<SentinelDescriptor> {
  const hasProducers = typeof raw === "object" && raw !== null && Object.prototype.hasOwnProperty.call(raw, "producers");
  if (!exactKeys(raw, hasProducers ? [...DESCRIPTOR_KEYS, "producers"] : DESCRIPTOR_KEYS)) return fail("descriptor-shape");
  const d = raw as Record<string, unknown>;
  let producers: DescriptorProducer[] | undefined;
  if (hasProducers) {
    const list = d.producers;
    if (!Array.isArray(list) || list.length < 1 || list.length > 2 || new Set(list).size !== list.length || !list.every(v => v === "server" || v === "desktop") || !list.includes("server")) return fail("producers");
    producers = [...list] as DescriptorProducer[];
  }
  if (d.version !== DESCRIPTOR_VERSION) return fail("descriptor-version");
  if (typeof d.installationId !== "string" || !HEALTH_TOKEN_PATTERN.test(d.installationId)) return fail("installation-id");
  for (const key of ["installationRoot", "inputRoot", "outputRoot"] as const) if (!isCleanAbsolute(d[key], platform)) return fail(`path:${key}`);
  const p = pathFor(platform);
  const installationRoot = d.installationRoot as string;
  const inputRoot = d.inputRoot as string;
  const outputRoot = d.outputRoot as string;
  if (inputRoot !== p.join(installationRoot, HEALTH_DIR)) return fail("input-root");
  if (p.basename(outputRoot) !== d.installationId || p.basename(p.dirname(outputRoot)) !== OUTPUT_PARENT) return fail("output-root-name");
  if (within(installationRoot, outputRoot, platform) || within(outputRoot, installationRoot, platform)) return fail("output-root-containment");
  if (!exactKeys(d.sources, SOURCE_ROLES)) return fail("sources-shape");
  const expected = sourcePaths(inputRoot, platform);
  for (const role of SOURCE_ROLES) if ((d.sources as Record<string, unknown>)[role] !== expected[role]) return fail(`source:${role}`);
  if (!exactKeys(d.executable, ["path", "entry", "sha256"])) return fail("executable-shape");
  const exe = d.executable as Record<string, unknown>;
  if (!isCleanAbsolute(exe.path, platform) || !isCleanAbsolute(exe.entry, platform)) return fail("executable-path");
  if (exe.sha256 !== null && (typeof exe.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(exe.sha256))) return fail("executable-digest");
  if (within(installationRoot, exe.entry as string, platform)) return fail("executable-containment");
  if (typeof d.scheduleRevision !== "number" || !Number.isSafeInteger(d.scheduleRevision) || d.scheduleRevision < 0 || d.scheduleRevision > HEALTH_BOUNDS.revision) return fail("schedule-revision");
  return {
    ok: true,
    value: {
      version: 1, installationId: d.installationId, installationRoot, inputRoot, outputRoot,
      sources: Object.freeze({ ...expected }), executable: { path: exe.path as string, entry: exe.entry as string, sha256: exe.sha256 as string | null },
      scheduleRevision: d.scheduleRevision,
      ...(producers ? { producers: Object.freeze(producers) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem guards
// ---------------------------------------------------------------------------

export interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number }
export const identityOf = (s: Stats): FileIdentity => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs });
export const sameFile = (a: Pick<FileIdentity, "dev" | "ino"> | null | undefined, b: Pick<FileIdentity, "dev" | "ino"> | null | undefined) =>
  !!a && !!b && a.dev === b.dev && a.ino === b.ino;
export const sameIdentity = (a: FileIdentity | null | undefined, b: FileIdentity | null | undefined) =>
  sameFile(a, b) && a!.size === b!.size && a!.mtimeMs === b!.mtimeMs;

const lstatOrNull = (path: string): Stats | null => { try { return lstatSync(path); } catch { return null; } };
const realOrNull = (path: string): string | null => { try { return realpathSync.native(path); } catch { return null; } };

function ownerOk(stat: Stats, opts: PlatformOptions): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return true; // ownership on Windows is part of the DACL check
  const uid = opts.uid ?? currentUid();
  return uid < 0 || stat.uid === uid;
}

/** A directory that is real (not a link or reparse point), canonical, and owned by us. */
export function checkDirectory(path: string, opts: PlatformOptions = {}): PathResult<Stats> {
  const stat = lstatOrNull(path);
  if (!stat) return fail("missing");
  if (stat.isSymbolicLink()) return fail("link");
  if (!stat.isDirectory()) return fail("not-directory");
  if (realOrNull(path) !== path) return fail("alias");
  if (!ownerOk(stat, opts)) return fail("owner");
  return { ok: true, value: stat };
}

/** The producer input root: a real canonical directory we own, not writable by group or others (POSIX), or with a
 * verified owner-only DACL (Windows: anything else, including an unknown verdict, is refused). */
export function checkInputRoot(inputRoot: string, opts: PlatformOptions & { aclCheck?: AclCheck } = {}): PathResult<Stats> {
  const dir = checkDirectory(inputRoot, opts);
  if (!dir.ok) return dir;
  if ((opts.platform ?? process.platform) === "win32") {
    let verdict: string;
    try { verdict = (opts.aclCheck ?? (path => windowsAclCheck(path)))(inputRoot); } catch { verdict = "unknown"; }
    if (verdict !== "owner-only") return fail("acl");
    return dir;
  }
  if ((dir.value.mode & 0o022) !== 0) return fail("permissions");
  return dir;
}

/** One fixed input file directly inside `inputRoot`: regular, single link, ours, not a link. Null identity = absent. */
export function checkInputFile(path: string, inputRoot: string, opts: PlatformOptions = {}): PathResult<FileIdentity | null> {
  const p = pathFor(opts.platform ?? process.platform);
  if (p.dirname(path) !== inputRoot) return fail("escape");
  const stat = lstatOrNull(path);
  if (!stat) return { ok: true, value: null };
  if (stat.isSymbolicLink()) return fail("link");
  if (!stat.isFile()) return fail("not-file");
  if (stat.nlink !== 1) return fail("hard-link");
  if (!ownerOk(stat, opts)) return fail("owner");
  return { ok: true, value: identityOf(stat) };
}

/** Opens a checked input read-only without following links and proves the opened file is the inspected one. */
export function openVerified(path: string, expected: Pick<FileIdentity, "dev" | "ino">): PathResult<number> {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW); } catch { return fail("open"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !sameFile(identityOf(stat), { dev: expected.dev, ino: expected.ino })) { closeSync(fd); return fail("identity"); }
  } catch { closeSync(fd); return fail("identity"); }
  return { ok: true, value: fd };
}

/** Reads at most `limit` bytes of a whole small file through a verified handle. */
export function readSmallVerified(path: string, expected: FileIdentity, limit: number): PathResult<Buffer> {
  if (expected.size > limit) return fail("too-large");
  const opened = openVerified(path, expected);
  if (!opened.ok) return opened;
  try {
    const buffer = Buffer.alloc(expected.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(opened.value, buffer, read, buffer.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== expected.size) return fail("changed");
    return { ok: true, value: buffer };
  } finally { closeSync(opened.value); }
}

/** True when any ancestor of `path` (inclusive) holds a `.git` entry: a repository or worktree checkout. */
export function insideRepository(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathFor(platform);
  let dir = path;
  for (let depth = 0; depth < 64; depth++) {
    if (lstatOrNull(p.join(dir, ".git"))) return true;
    const parent = p.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return true; // implausibly deep: refuse
}

export interface OutputRootOptions extends PlatformOptions {
  /** Windows owner-only verdict (default: icacls by SID). */
  aclCheck?: AclCheck;
  /** Windows DACL restriction for a directory this call created (default: icacls by SID). */
  aclRestrict?: (path: string) => boolean;
  /** Create the root (and its MurageSentinel parent) when absent. Default true. */
  create?: boolean;
}

/** Makes sure the output root exists, is real, canonical, ours and owner-only. A POSIX directory we own with broader
 * bits is tightened to 0700; anything else (a link, another owner, an unverifiable Windows DACL) fails closed. */
export function ensureOutputRoot(root: string, opts: OutputRootOptions = {}): PathResult<string> {
  const platform = opts.platform ?? process.platform;
  if (!isCleanAbsolute(root, platform)) return fail("path");
  const p = pathFor(platform);
  const parent = p.dirname(root);
  if (p.basename(parent) !== OUTPUT_PARENT) return fail("output-root-name");
  if (insideRepository(root, platform)) return fail("repository");
  for (const dir of [parent, root]) {
    let created = false;
    if (!lstatOrNull(dir)) {
      if (opts.create === false) return fail("missing");
      try { mkdirSync(dir, { mode: 0o700 }); created = true; } catch { return fail("create"); }
    }
    const checked = checkDirectory(dir, opts);
    if (!checked.ok) return checked;
    if (platform === "win32") {
      const check = opts.aclCheck ?? (path => windowsAclCheck(path));
      let verdict = check(dir);
      if (verdict !== "owner-only" && created) {
        const restrict = opts.aclRestrict ?? (path => windowsAclRestrict(path));
        if (restrict(dir)) verdict = check(dir);
      }
      if (verdict !== "owner-only") return fail("acl");
    } else if ((checked.value.mode & 0o077) !== 0) {
      try { chmodSync(dir, 0o700); } catch { return fail("permissions"); }
      const again = lstatOrNull(dir);
      if (!again || (again.mode & 0o077) !== 0) return fail("permissions");
    }
  }
  return { ok: true, value: root };
}

/** Owner-only file checks for scanner-owned files in the output root (descriptor, store, view). */
export function checkOwnedFile(path: string, opts: PlatformOptions = {}): PathResult<FileIdentity | null> {
  const stat = lstatOrNull(path);
  if (!stat) return { ok: true, value: null };
  if (stat.isSymbolicLink()) return fail("link");
  if (!stat.isFile()) return fail("not-file");
  if (stat.nlink !== 1) return fail("hard-link");
  if (!ownerOk(stat, opts)) return fail("owner");
  if ((opts.platform ?? process.platform) !== "win32" && (stat.mode & 0o077) !== 0) return fail("permissions");
  return { ok: true, value: identityOf(stat) };
}

export interface LoadOptions extends OutputRootOptions {
  /** Skip the installation-root existence check (tests of pure relationships only). */
  requireInstallationRoot?: boolean;
}

/** Loads and validates `<outputRoot>/descriptor.json`: the file itself must be owner-only and sit in the output root it
 * names; roots must be canonical (realpath equal), real directories, and outside each other and any repository. */
export function loadDescriptor(path: string, opts: LoadOptions = {}): PathResult<SentinelDescriptor> {
  const platform = opts.platform ?? process.platform;
  if (!isCleanAbsolute(path, platform)) return fail("descriptor-path");
  const p = pathFor(platform);
  if (p.basename(path) !== DESCRIPTOR_FILE) return fail("descriptor-name");
  const file = checkOwnedFile(path, opts);
  if (!file.ok) return fail(`descriptor-${file.reason}`);
  if (!file.value) return fail("descriptor-missing");
  const bytes = readSmallVerified(path, file.value, DESCRIPTOR_MAX_BYTES);
  if (!bytes.ok) return fail(`descriptor-${bytes.reason}`);
  let raw: unknown;
  try { raw = JSON.parse(bytes.value.toString("utf8")); } catch { return fail("descriptor-json"); }
  const parsed = validateDescriptor(raw, platform);
  if (!parsed.ok) return parsed;
  const d = parsed.value;
  if (p.dirname(path) !== d.outputRoot) return fail("descriptor-location");
  if (realOrNull(p.dirname(path)) !== d.outputRoot) return fail("output-root-alias");
  if (opts.requireInstallationRoot !== false) {
    const install = checkDirectory(d.installationRoot, opts);
    if (!install.ok) return fail(`installation-root-${install.reason}`);
  }
  // The input root may not exist yet (waiting coverage), but when it does it must be the canonical real child.
  if (lstatOrNull(d.inputRoot)) {
    const input = checkDirectory(d.inputRoot, opts);
    if (!input.ok) return fail(`input-root-${input.reason}`);
  }
  if (insideRepository(d.outputRoot, platform)) return fail("output-root-repository");
  return parsed;
}

/** Writes a descriptor (lane C's installer helper): validated first, owner-only, atomically replaced. The output root
 * must already be ensured. */
export function writeDescriptor(descriptor: SentinelDescriptor, opts: PlatformOptions = {}): PathResult<string> {
  const platform = opts.platform ?? process.platform;
  const valid = validateDescriptor(JSON.parse(JSON.stringify(descriptor)), platform);
  if (!valid.ok) return valid;
  const p = pathFor(platform);
  const target = p.join(descriptor.outputRoot, DESCRIPTOR_FILE);
  const temp = p.join(descriptor.outputRoot, `.tmp-${randomBytes(8).toString("hex")}.json`);
  try {
    writeFileSync(temp, `${JSON.stringify(valid.value)}\n`, { mode: 0o600, flag: "wx" });
    if (platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch { return fail("write"); }
  return { ok: true, value: target };
}
