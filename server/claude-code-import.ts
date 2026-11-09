// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claude Code copy import (CONTRACTS-B section 1 and 1.1, Murage 1.0.19).
//
// A one-time, opt-in COPY of Claude Code's user skills and MCP servers into Murage's own
// stores, on a person's press. Murage never reads Claude Code's folders live (isolation
// M18): files are read only on Review; its in-memory snapshot expires after 15 minutes.
// Only counts are persisted. Only two things are ever opened under the signed-in user's home:
//   - the direct children of <home>/.claude/skills (SKILL.md and allow-listed text files)
//   - <home>/.claude.json, of which only the top-level mcpServers object is kept
// Opens are kernel-confined (Darwin O_NOFOLLOW_ANY or a Linux descriptor walk),
// then checked with fstat on the open handle. Secrets are default-deny: a value
// that is not on a short allow-list is dropped and the server is marked "needs your key".
// Nothing read (no value, no path) goes into a response, a log or telemetry.
import * as nodeFs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { release } from "node:os";

import { urlHasSecret } from "../shared/mcp-secret-url.mjs";
import { credentialShaped, commandCredentialRefusal } from "./mcp-bot-add.ts";
import {
  MAX_MCP_SERVERS,
  isHarnessOwnedMcpEnvName,
  isRefusedMcpHeaderName,
  mcpEntryRev,
  mcpServerNameError,
  parseAnyStoredMcpServer,
  toStoredMcpEntry,
} from "./mcp-registry.ts";
import type { AppConfig } from "./config.ts";
import { normalizeSkillFiles } from "./skill-collection.ts";
import { isSkillName, parseSkillMd } from "./skills.ts";

export const CLAUDE_CODE_IMPORT_PATH = "/api/claude-code-import";
export const COULD_NOT_READ = "Could not read Claude Code files.";
const REACHED_THROUGH_LINK = "Claude Code files are reached through a link, so Murage did not read them.";

export const MAX_IMPORT_SERVERS = 200;
export const MAX_IMPORT_SKILLS = 200;
export const MAX_SKILL_FOLDER_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
export const MAX_CLAUDE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_DEPTH = 8;
export const READ_TIMEOUT_MS = 10_000;
const MAX_SKILL_DEPTH = 4;
const MAX_FILES_PER_SKILL_WALK = 200;
const DRY_RUN_TTL_MS = 15 * 60_000;

/** A directory or server name from Claude Code. Hostile names are skipped and counted. */
export const IMPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".py", ".sh", ".js", ".ts"]);
const NEVER_COPIED = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /^credentials/i, /^\.(npmrc|netrc|pypirc)$/i, /secret|token|password|passwd/i];
/** Env names a copied server keeps. Anything else is dropped and the server is marked "needs your key". */
const ENV_ALLOW = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ", "PATH", "DEBUG", "NODE_ENV", "LOG_LEVEL", "NO_COLOR", "FORCE_COLOR", "PYTHONUNBUFFERED", "CI"]);
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/i;

export type ImportScope = "skills" | "mcp" | "both";

/** Only the calls the importer makes, so a test can spy on exactly what is opened. */
export interface ImportFs {
  realpathSync(path: string): string;
  readlinkSync(path: string): string;
  readdirSync(path: string): string[];
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): Pick<nodeFs.Stats, "isFile" | "isDirectory" | "size" | "dev" | "ino" | "uid" | "mode" | "nlink">;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  platform(): NodeJS.Platform;
  release(): string;
  getuid(): number | undefined;
  openAnchoredWin(absPath: string, kind: "file" | "dir"): number;
}

/** Unsupported until the native Windows implementation can retain every component. */
export function openAnchoredWin(_absPath: string, _kind: "file" | "dir"): never {
  // native helper lands in this train: open each component with FILE_FLAG_OPEN_REPARSE_POINT and exclusive sharing, reject any reparse point on that retained handle
  throw Object.assign(new Error("Unsupported operation"), { code: "ENOTSUP" });
}

export const realImportFs: ImportFs = {
  realpathSync: (path) => nodeFs.realpathSync(path),
  readlinkSync: (path) => nodeFs.readlinkSync(path),
  readdirSync: (path) => nodeFs.readdirSync(path),
  openSync: (path, flags) => nodeFs.openSync(path, flags),
  fstatSync: (fd) => nodeFs.fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) => nodeFs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => nodeFs.closeSync(fd),
  platform: () => process.platform,
  release: () => release(),
  getuid: () => process.getuid?.(),
  openAnchoredWin,
};

class ReadRefused extends Error {
  kind: "missing" | "refused" | "linked" | "not-directory";
  constructor(kind: "missing" | "refused" | "linked" | "not-directory") { super(kind); this.kind = kind; }
}

interface Budget { deadline: number; bytes: number; reader?: AnchoredImport }
const newBudget = (now: () => number): Budget => ({ deadline: now() + READ_TIMEOUT_MS, bytes: 0 });

function checkBudget(budget: Budget, now: () => number): void {
  if (now() > budget.deadline || budget.bytes > MAX_REQUEST_BYTES) throw new ReadRefused("refused");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A name safe to show: never shows characters outside the allowed set. */
export function shownName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return IMPORT_NAME.test(text) ? text : "(unusable name)";
}

interface ImportHandle { fd: number; stat: ReturnType<ImportFs["fstatSync"]> }

function importPlatform(fs: ImportFs, home: string): "linux" | "darwin" {
  const platform = fs.platform();
  // Platform gates precede even realpath(home). Windows calls only its separate seam.
  if (platform === "win32") {
    fs.openAnchoredWin(home, "dir");
    throw new ReadRefused("refused");
  }
  if (platform !== "linux" && platform !== "darwin") throw new ReadRefused("refused");
  if (platform === "darwin" && !(Number(fs.release().split(".")[0]) >= 20)) throw new ReadRefused("refused");
  return platform;
}

class AnchoredImport {
  readonly fs: ImportFs;
  readonly realHome: string;
  readonly platform: "linux" | "darwin";
  readonly uid: number;

  constructor(fs: ImportFs, home: string) {
    this.fs = fs;
    this.platform = importPlatform(fs, home);
    const uid = fs.getuid();
    if (uid === undefined) throw new ReadRefused("refused");
    this.uid = uid;
    this.realHome = fs.realpathSync(home);
  }

  close(fd: number): void {
    try { this.fs.closeSync(fd); } catch { /* nothing to report */ }
  }

  validate(fd: number, kind: "file" | "dir"): ImportHandle {
    const stat = this.fs.fstatSync(fd);
    if (stat.uid !== this.uid || (kind === "dir"
      ? !stat.isDirectory() || (stat.mode & 0o002) !== 0
      : !stat.isFile() || stat.nlink !== 1)) throw new ReadRefused("refused");
    return { fd, stat };
  }

  verifyLocation(fd: number, expected: string): void {
    try {
      if (this.fs.readlinkSync(`/proc/self/fd/${fd}`) === expected) return;
    } catch { /* Unavailable proc is a refusal, including ENOENT. */ }
    throw new ReadRefused("refused");
  }

  openAnchored(absPath: string, kind: "file" | "dir"): ImportHandle {
    if (!inside(this.realHome, absPath)) throw new ReadRefused("refused");
    const parts = relative(this.realHome, absPath).split(sep);
    if (parts[0] !== ".claude.json" && parts[0] !== ".claude") throw new ReadRefused("refused");
    if (parts[0] === ".claude.json" && parts.length !== 1) throw new ReadRefused("refused");
    if (parts[0] === ".claude" && parts.length > 1 && parts[1] !== "skills") throw new ReadRefused("refused");
    if (parts.slice(2).some((part) => !IMPORT_NAME.test(part))) throw new ReadRefused("refused");
    const flags = (entryKind: "file" | "dir") => nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK
      | (entryKind === "dir" ? nodeFs.constants.O_DIRECTORY : 0)
      | (this.platform === "darwin" ? 0x20000000 : nodeFs.constants.O_NOFOLLOW);
    const held: number[] = [];
    let current = this.realHome;
    let opening = false;
    const open = (path: string, entryKind: "file" | "dir") => {
      opening = true;
      const fd = this.fs.openSync(path, flags(entryKind));
      opening = false;
      return fd;
    };
    try {
      if (this.platform === "darwin") {
        current = absPath;
        const fd = open(absPath, kind);
        held.push(fd);
        const handle = this.validate(fd, kind);
        held.pop();
        return handle;
      }
      let fd = open(this.realHome, "dir");
      held.push(fd);
      this.validate(fd, "dir");
      this.verifyLocation(fd, current);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        const entryKind = index === parts.length - 1 ? kind : "dir";
        current = join(current, part);
        fd = open(`/proc/self/fd/${fd}/${part}`, entryKind);
        held.push(fd);
        const handle = this.validate(fd, entryKind);
        this.verifyLocation(fd, current);
        if (index === parts.length - 1) {
          held.pop();
          return handle;
        }
      }
      throw new ReadRefused("refused");
    } catch (error) {
      if (error instanceof ReadRefused) throw error;
      // Only an open's ENOENT can mean an absent input; metadata errors refuse it.
      const code = opening ? (error as NodeJS.ErrnoException)?.code : undefined;
      // O_NOFOLLOW | O_DIRECTORY reports ENOTDIR for a Linux directory symlink.
      // Classify the failed .claude open itself, without a racy diagnostic lookup.
      if (current === join(this.realHome, ".claude") && (code === "ELOOP" || (this.platform === "linux" && code === "ENOTDIR"))) throw new ReadRefused("linked");
      if (current === absPath && kind === "dir" && code === "ENOTDIR") throw new ReadRefused("not-directory");
      throw new ReadRefused(code === "ENOENT" ? "missing" : "refused");
    } finally {
      for (const fd of held.reverse()) this.close(fd);
    }
  }

  list(absPath: string, fd: number): string[] {
    return this.fs.readdirSync(this.platform === "linux" ? `/proc/self/fd/${fd}` : absPath).sort();
  }
}

function importReader(home: string, fs: ImportFs, budget: Budget): AnchoredImport {
  // A shared request budget also owns the one canonical-home lookup for both scopes.
  return budget.reader ??= new AnchoredImport(fs, home);
}

/** Read only the bounded fstat size, through the already-verified handle. */
function readConfinedFile(reader: AnchoredImport, handle: ImportHandle, maxBytes: number, budget: Budget, now: () => number): Buffer {
  const { fs } = reader;
  const { fd, stat } = handle;
  try {
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw new ReadRefused("refused");
    budget.bytes += stat.size;
    checkBudget(budget, now);
    const buffer = Buffer.alloc(stat.size);
    let done = 0;
    while (done < stat.size) {
      checkBudget(budget, now);
      const n = fs.readSync(fd, buffer, done, stat.size - done, done);
      if (n <= 0) break;
      done += n;
    }
    const { stat: after } = reader.validate(fd, "file");
    if (done !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new ReadRefused("refused");
    checkBudget(budget, now);
    return buffer;
  } finally {
    reader.close(fd);
  }
}

// ---------------------------------------------------------------- skills

export interface ReadSkill { name: string; files: Array<{ path: string; content: string }> }
interface SkipReason { name: string; reason: string }
export interface SkillsRead { skills: ReadSkill[]; skipped: string[]; skippedReasons?: SkipReason[] }

function allowedSkillFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && name !== "SKILL.md") return false;
  if (!TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase())) return false;
  return !NEVER_COPIED.some((pattern) => pattern.test(name));
}

/** Walk one proven skill folder; a refused child skips the whole skill. */
function readSkillFolder(reader: AnchoredImport, name: string, folder: ImportHandle, budget: Budget, now: () => number): ReadSkill | null {
  const base = join(reader.realHome, ".claude", "skills", name);
  const files: Array<{ path: string; content: string }> = [];
  let folderBytes = 0;
  let seen = 0;
  const walk = (relative: string[], depth: number, dirHandle: ImportHandle): boolean => {
    checkBudget(budget, now);
    if (depth > MAX_SKILL_DEPTH) return false;
    const dir = join(base, ...relative);
    const entries = reader.list(dir, dirHandle.fd);
    for (const entry of entries) {
      checkBudget(budget, now);
      if (++seen > MAX_FILES_PER_SKILL_WALK) return false;
      if (!IMPORT_NAME.test(entry)) {
        if (NEVER_COPIED.some((pattern) => pattern.test(entry))) continue;
        return false;
      }
      const path = join(dir, entry);
      let child: ImportHandle;
      try { child = reader.openAnchored(path, "dir"); } catch (error) {
        // Only a wrong-kind open gets a second attempt; failed handle checks stay refused.
        if (!(error instanceof ReadRefused) || error.kind !== "not-directory") throw error;
        child = reader.openAnchored(path, "file");
      }
      if (child.stat.isDirectory()) {
        try {
          if (!walk([...relative, entry], depth + 1, child)) return false;
        } finally { reader.close(child.fd); }
        continue;
      }
      if (!allowedSkillFile(entry)) { reader.close(child.fd); continue; }
      const bytes = readConfinedFile(reader, child, MAX_SKILL_FOLDER_BYTES - folderBytes, budget, now);
      folderBytes += bytes.length;
      if (folderBytes > MAX_SKILL_FOLDER_BYTES) return false;
      if (bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      // Keep exactly the reviewed bytes; never silently replace invalid UTF-8.
      if (!Buffer.from(content, "utf8").equals(bytes)) return false;
      files.push({ path: [...relative, entry].join("/"), content });
    }
    return true;
  };
  if (!walk([], 0, folder)) return null;
  if (!files.some((file) => file.path === "SKILL.md")) return null;
  return { name, files };
}

export function readClaudeCodeSkills(home: string, fs: ImportFs = realImportFs, now: () => number = Date.now, budget: Budget = newBudget(now)): SkillsRead {
  const result: SkillsRead = { skills: [], skipped: [] };
  const skipUnreadable = (name: string) => {
    result.skipped.push(name);
    (result.skippedReasons ??= []).push({ name, reason: COULD_NOT_READ });
  };
  let names: string[];
  let reader: AnchoredImport;
  try {
    checkBudget(budget, now);
    reader = importReader(home, fs, budget);
    // Open .claude separately so a linked dotfiles setup has the same plain refusal
    // whether its target contains a skills child or not.
    const claude = reader.openAnchored(join(reader.realHome, ".claude"), "dir");
    reader.close(claude.fd);
    const path = join(reader.realHome, ".claude", "skills");
    const dir = reader.openAnchored(path, "dir");
    try { names = reader.list(path, dir.fd); } finally { reader.close(dir.fd); }
  } catch (error) {
    if (error instanceof ReadRefused && error.kind === "missing") return result;
    if (error instanceof ReadRefused) throw error;
    throw new ReadRefused("refused");
  }
  let unreadable = names.length > MAX_IMPORT_SKILLS;
  for (const name of names.slice(0, MAX_IMPORT_SKILLS)) {
    checkBudget(budget, now);
    if (!IMPORT_NAME.test(name)) { unreadable = true; continue; }
    let dir: ImportHandle;
    try { dir = reader.openAnchored(join(reader.realHome, ".claude", "skills", name), "dir"); } catch { unreadable = true; continue; }
    let folder: ReadSkill | null;
    try { folder = readSkillFolder(reader, name, dir, budget, now); } catch {
      checkBudget(budget, now);
      folder = null;
    } finally { reader.close(dir.fd); }
    if (folder) result.skills.push(folder); else skipUnreadable(name);
  }
  // Unproven listing entries never disclose their names or their number.
  if (unreadable) skipUnreadable("(could not read)");
  return result;
}

// ---------------------------------------------------------------- MCP servers

export interface PlannedServer { name: string; slug: string; kind: "local" | "remote"; needsKey: boolean; entry: Record<string, unknown> }
export interface ServersRead { servers: PlannedServer[]; skipped: string[] }

function jsonDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== "object") return depth;
  let deepest = depth;
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    const d = jsonDepth(child, depth + 1);
    if (d > deepest) deepest = d;
    if (deepest > MAX_JSON_DEPTH + 1) break;
  }
  return deepest;
}

/** A value that looks like a credential: a known key shape, user:pass@, or 32+ mixed characters with no path separators. */
export function looksSecret(value: string): boolean {
  if (credentialShaped(value) || URL_USERINFO.test(value)) return true;
  return value.split(/\s+/).some((token) => {
    if (token.length < 32 || /[/\\.:@]/.test(token)) return false;
    if (!/^[A-Za-z0-9_+=-]+$/.test(token)) return false;
    return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(token)).length >= 2;
  });
}

const DISABLED_REASON = "Copied from Claude Code; turn on to use it";

function slugFor(name: string): string {
  let slug = name.toLowerCase().replace(/[ .]+/g, "-");
  if (/^[0-9]/.test(slug)) slug = `cc-${slug}`;
  return slug.slice(0, 32).replace(/-+$/, "");
}

/** Plan one server: only the allowed fields survive, every other value is dropped and flagged. Returns null to skip it. */
export function planServer(name: string, raw: unknown, takenNames: readonly string[]): PlannedServer | null {
  if (!IMPORT_NAME.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const slug = slugFor(name);
  if (mcpServerNameError(slug, takenNames)) return null;
  const type = typeof source.type === "string" ? source.type.toLowerCase() : "";
  const remote = typeof source.url === "string" && (type === "" || type === "http" || type === "sse" || type === "streamable-http");
  let needsKey = false;
  let stored: Record<string, unknown>;
  if (remote) {
    const url = (source.url as string).trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const pathText = (() => { try { return decodeURIComponent(parsed.pathname); } catch { return parsed.pathname; } })();
    if (credentialShaped(pathText) || looksSecret(pathText.replace(/\//g, " "))) return null;
    let clean = url;
    if (urlHasSecret(url) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      // A secret in the address is dropped from the copy; the server is added without it.
      needsKey = true;
      clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    const headerNames = source.headers && typeof source.headers === "object" && !Array.isArray(source.headers) ? Object.keys(source.headers as Record<string, unknown>) : [];
    const pending: string[] = [];
    for (const header of headerNames) {
      // Content-Type and Accept are set by Murage and never stored; every other header value is dropped.
      if (isRefusedMcpHeaderName(header)) continue;
      needsKey = true;
      if (HEADER_KEY.test(header) && !pending.includes(header) && pending.length < 16) pending.push(header);
    }
    stored = { url: clean, transport: type === "sse" ? "sse" : "http", auth: pending.length ? "header" : "none", headers: {}, ...(pending.length ? { pendingHeaders: pending } : {}), enabled: false, disabledReason: DISABLED_REASON };
  } else {
    if (typeof source.command !== "string" || !source.command.trim()) return null;
    const command = source.command.trim();
    if (looksSecret(command) || commandCredentialRefusal(command, [])) return null;
    let args: string[] = Array.isArray(source.args) ? source.args.filter((arg): arg is string => typeof arg === "string") : [];
    if (args.length > 64 || args.some((arg) => arg.length > 4096)) args = [];
    if (args.some(looksSecret) || commandCredentialRefusal(command, args)) { args = []; needsKey = true; }
    const env: Record<string, string> = {};
    const pending: string[] = [];
    const rawEnv = source.env && typeof source.env === "object" && !Array.isArray(source.env) ? source.env as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (ENV_ALLOW.has(key) && typeof value === "string" && value.length <= 4096 && !looksSecret(value) && !isHarnessOwnedMcpEnvName(key)) { env[key] = value; continue; }
      needsKey = true;
      if (ENV_KEY.test(key) && !isHarnessOwnedMcpEnvName(key) && !pending.includes(key) && pending.length < 64) pending.push(key);
    }
    stored = { command, args, env, ...(pending.length ? { pendingEnv: pending } : {}), enabled: false, disabledReason: DISABLED_REASON };
  }
  const parsed = parseAnyStoredMcpServer(slug, stored);
  if (!parsed.ok || parsed.server.enabled !== false) return null;
  const server = { ...parsed.server, rev: mcpEntryRev(slug, parsed.server) };
  return { name, slug, kind: remote ? "remote" : "local", needsKey, entry: toStoredMcpEntry(server) };
}

export function readClaudeCodeServers(home: string, existingNames: readonly string[], fs: ImportFs = realImportFs, now: () => number = Date.now, budget: Budget = newBudget(now)): ServersRead {
  const result: ServersRead = { servers: [], skipped: [] };
  let buffer: Buffer;
  try {
    checkBudget(budget, now);
    const reader = importReader(home, fs, budget);
    const file = reader.openAnchored(join(reader.realHome, ".claude.json"), "file");
    buffer = readConfinedFile(reader, file, MAX_CLAUDE_JSON_BYTES, budget, now);
  } catch (error) {
    if (error instanceof ReadRefused && error.kind === "missing") return result;
    throw error instanceof ReadRefused ? error : new ReadRefused("refused");
  }
  let servers: unknown;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReadRefused("refused");
    if (jsonDepth(parsed) > MAX_JSON_DEPTH + 1) throw new ReadRefused("refused");
    // Only the top-level mcpServers object is kept; the rest of the file is dropped at once.
    servers = Object.hasOwn(parsed, "mcpServers") ? (parsed as Record<string, unknown>).mcpServers : undefined;
  } catch { throw new ReadRefused("refused"); }
  if (servers === undefined) return result;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new ReadRefused("refused");
  const names = Object.keys(servers as Record<string, unknown>).sort();
  const taken = [...existingNames];
  let room = Math.max(0, MAX_MCP_SERVERS - taken.length);
  for (const name of names.slice(0, MAX_IMPORT_SERVERS)) {
    checkBudget(budget, now);
    const slug = slugFor(name);
    if (IMPORT_NAME.test(name) && taken.includes(slug)) { result.skipped.push(name); continue; }
    const planned = planServer(name, (servers as Record<string, unknown>)[name], taken);
    if (!planned || room <= 0) { result.skipped.push(shownName(name)); continue; }
    result.servers.push(planned);
    taken.push(planned.slug);
    room--;
  }
  for (let extra = names.length - MAX_IMPORT_SERVERS; extra > 0; extra--) result.skipped.push("(more than 200 servers)");
  return result;
}

// ---------------------------------------------------------------- the request

export interface ImportDeps {
  /** Names already in the skills collection. */
  existingSkillNames(): Set<string>;
  /** Includes orphaned destination folders, which must never be overwritten. */
  skillPathExists(name: string): boolean;
  /** The existing skill import (collection). Returns the stored name or an error. */
  addSkill(files: Array<{ path: string; content: string }>, label: string): { name: string } | { error: string; code?: string };
  removeSkill(name: string): void;
  mcpCurrent(): Record<string, unknown>;
  persistMcp(next: Record<string, unknown>): void;
  writeReceipt(receipt: { lastImportedAt: number; skills: number; servers: number; needsKey: number }): void;
  /** Restore the receipt even when writeReceipt threw after changing storage. */
  restoreReceipt(): void;
}

export interface ImportReceipt { skills: number; servers: number; needsKey: number; skipped: string[]; skippedReasons?: SkipReason[] }
export type ImportResult = { status: number; body: unknown };

interface Review {
  scope: ImportScope; expires: number; owner: string; digest: string; bytes: number;
  skills: SkillsRead; servers: ServersRead;
}
const reviews = new Map<string, Review>();
const reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
let importing = false;

function forgetReview(id: string): void {
  reviews.delete(id);
  clearTimeout(reviewTimers.get(id));
  reviewTimers.delete(id);
}

export function resetClaudeCodeImportState(): void {
  for (const id of reviews.keys()) forgetReview(id);
  importing = false;
}

function reviewDigest(skills: SkillsRead, servers: ServersRead): string {
  // UTF-8 was round-trip checked on read: names, file paths and exact content are bound.
  return createHash("sha256").update(JSON.stringify({ skills, servers })).digest("hex");
}

export function claudeCodeImportStatus(cfg: AppConfig): { enabled: boolean; lastImportedAt: number | null; skills: number; servers: number; needsKey: number } {
  const stored = cfg.claudeCodeImport ?? {};
  return { enabled: stored.enabled === true, lastImportedAt: stored.lastImportedAt ?? null, skills: stored.skills ?? 0, servers: stored.servers ?? 0, needsKey: stored.needsKey ?? 0 };
}

const refusal = (status: number, error: string): ImportResult => ({ status, body: { error } });

export interface ImportRequest {
  body: unknown;
  /** config claudeCodeImport.enabled, read server-side. */
  enabled: boolean;
  /** Derived server-side (os.homedir()), never from the request. */
  home: string;
  /** The authenticated desktop owner proof, supplied by the guarded route, never the body. */
  ownerToken: string;
  fs?: ImportFs;
  now?: () => number;
  deps: ImportDeps;
  previous?: { skills?: number; servers?: number; needsKey?: number };
}

function parseBody(body: unknown): { scope: ImportScope; dryRun: boolean; dryRunId?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== "scope" && key !== "dryRun" && key !== "dryRunId") return null;
  if (record.scope !== "skills" && record.scope !== "mcp" && record.scope !== "both") return null;
  if (typeof record.dryRun !== "boolean") return null;
  if (record.dryRunId !== undefined && (typeof record.dryRunId !== "string" || record.dryRunId.length > 80)) return null;
  return { scope: record.scope, dryRun: record.dryRun, ...(record.dryRunId !== undefined ? { dryRunId: record.dryRunId } : {}) };
}

/** The route's logic. The route-policy and desktop guards have already run; nothing here is reached by a phone, a paired browser or a Cloud window. */
export function handleClaudeCodeImport(request: ImportRequest): ImportResult {
  const now = request.now ?? Date.now;
  const fs = request.fs ?? realImportFs;
  const body = parseBody(request.body);
  if (!body) return refusal(400, "Send a scope and dryRun, nothing else.");
  if (!request.ownerToken) return refusal(403, "Use your desktop to import.");
  if (!request.enabled) return refusal(409, "Turn on Also use my Claude Code setup first.");
  if (importing) return refusal(409, "An import is already running. Wait a moment, then try again.");
  importing = true;
  try {
    const budget = newBudget(now);
    // A platform without a safe reader cannot consume an earlier review either.
    try { importPlatform(fs, request.home); } catch { return refusal(422, COULD_NOT_READ); }
    const owner = createHash("sha256").update(request.ownerToken).digest("hex");
    for (const [id, review] of reviews) if (review.expires <= now()) forgetReview(id);
    const wantSkills = body.scope === "skills" || body.scope === "both";
    const wantMcp = body.scope === "mcp" || body.scope === "both";
    let skillsRead: SkillsRead = { skills: [], skipped: [] };
    let serversRead: ServersRead = { servers: [], skipped: [] };
    if (!body.dryRun) {
      const review = body.dryRunId ? reviews.get(body.dryRunId) : undefined;
      if (!review || review.scope !== body.scope || review.owner !== owner) {
        return { status: 409, body: { code: "review-required", error: "Review what will be copied first." } };
      }
      forgetReview(body.dryRunId!);
      skillsRead = review.skills;
      serversRead = review.servers;
      budget.bytes = review.bytes;
      if (reviewDigest(skillsRead, serversRead) !== review.digest) {
        return { status: 409, body: { code: "review-required", error: "The copy changed since you reviewed it. Review again." } };
      }
    }
    try {
      if (body.dryRun) {
        if (wantSkills) skillsRead = readClaudeCodeSkills(request.home, fs, now, budget);
        if (wantMcp) serversRead = readClaudeCodeServers(request.home, Object.keys(request.deps.mcpCurrent()), fs, now, budget);
      }
      checkBudget(budget, now);
    } catch (error) {
      // all-or-nothing per scope: nothing is imported, and nothing about the files is said
      if (error instanceof ReadRefused && error.kind === "linked") {
        return { status: 422, body: { code: "source-linked", error: REACHED_THROUGH_LINK } };
      }
      return refusal(422, COULD_NOT_READ);
    }
    const existing = request.deps.existingSkillNames();
    const newSkills: Array<ReadSkill & { destination: string }> = [];
    const skipped = [...skillsRead.skipped, ...serversRead.skipped];
    const destinations = new Set<string>();
    // The collection's normalizer/parser are the write API's own path, size and name rules.
    // Validate the whole selection before the first mutation, including header-name collisions.
    try {
      for (const skill of skillsRead.skills) {
        checkBudget(budget, now);
        if (existing.has(skill.name.toLowerCase())) { skipped.push(skill.name); continue; }
        const normalized = normalizeSkillFiles(skill.files);
        if (!IMPORT_NAME.test(skill.name) || "error" in normalized) throw new Error("invalid skill");
        const parsed = parseSkillMd(normalized.files[0]!.content);
        if ("error" in parsed || !isSkillName(parsed.name)) throw new Error("invalid skill");
        if (existing.has(parsed.name) || request.deps.skillPathExists(parsed.name)) { skipped.push(skill.name); continue; }
        if (destinations.has(parsed.name) || new Set(normalized.files.map((file) => file.path)).size !== normalized.files.length) throw new Error("collision");
        const paths = new Set(normalized.files.map((file) => file.path));
        for (const path of paths) {
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) throw new Error("collision");
        }
        destinations.add(parsed.name);
        newSkills.push({ ...skill, files: normalized.files, destination: parsed.name });
      }
      checkBudget(budget, now);
    } catch {
      return refusal(422, "Could not prepare the skills to copy. Nothing was changed.");
    }

    const previousMcp = request.deps.mcpCurrent();
    const nextMcp = { ...previousMcp };
    const newServers: PlannedServer[] = [];
    for (const server of serversRead.servers) {
      if (Object.hasOwn(nextMcp, server.slug) || Object.keys(nextMcp).length >= MAX_MCP_SERVERS) { skipped.push(server.name); continue; }
      if (!IMPORT_NAME.test(server.name) || mcpServerNameError(server.slug, Object.keys(nextMcp)) || !parseAnyStoredMcpServer(server.slug, server.entry).ok) {
        return refusal(422, "Could not prepare the tools to copy. Nothing was changed.");
      }
      nextMcp[server.slug] = server.entry;
      newServers.push(server);
    }

    try { checkBudget(budget, now); } catch { return refusal(422, COULD_NOT_READ); }
    if (body.dryRun) {
      const id = randomUUID();
      const skills: SkillsRead = { skills: newSkills.map(({ name, files }) => ({ name, files })), skipped: [],
        ...(skillsRead.skippedReasons ? { skippedReasons: skillsRead.skippedReasons } : {}) };
      const servers = { servers: newServers, skipped };
      const digest = reviewDigest(skills, servers);
      try { checkBudget(budget, now); } catch { return refusal(422, COULD_NOT_READ); }
      reviews.set(id, { scope: body.scope, owner, expires: now() + DRY_RUN_TTL_MS, bytes: budget.bytes,
        skills, servers, digest });
      const timer = setTimeout(() => forgetReview(id), DRY_RUN_TTL_MS);
      timer.unref();
      reviewTimers.set(id, timer);
      return { status: 200, body: {
        dryRunId: id,
        skills: newSkills.map((skill) => ({ name: skill.name })),
        servers: newServers.map((server) => ({ name: server.name, kind: server.kind, needsKey: server.needsKey })),
        skipped: [...skipped],
        ...(skills.skippedReasons ? { skippedReasons: skills.skippedReasons.map((reason) => ({ ...reason })) } : {}),
      } };
    }

    // Commit the staged selection, compensating every attempted write on failure.
    // Failed compensation is reported separately; it must never look like a clean rollback.
    const attemptedSkills: string[] = [];
    let mcpAttempted = false;
    let receiptAttempted = false;
    try {
      checkBudget(budget, now);
      for (const skill of newSkills) {
        checkBudget(budget, now);
        // A collection write can throw after the destination rename, before its record is saved.
        attemptedSkills.push(skill.destination);
        const outcome = request.deps.addSkill(skill.files, "Claude Code");
        if ("error" in outcome || outcome.name !== skill.destination) throw new Error("skill write failed");
      }
      const addedServers = newServers.length;
      const needsKey = newServers.filter((server) => server.needsKey).length;
      if (wantMcp && newServers.length > 0) {
        checkBudget(budget, now);
        mcpAttempted = true;
        request.deps.persistMcp(nextMcp);
      }
      checkBudget(budget, now);
      receiptAttempted = true;
      request.deps.writeReceipt({
        lastImportedAt: now(),
        skills: (request.previous?.skills ?? 0) + attemptedSkills.length,
        servers: (request.previous?.servers ?? 0) + addedServers,
        needsKey: (request.previous?.needsKey ?? 0) + needsKey,
      });
      checkBudget(budget, now);
      const receipt: ImportReceipt = { skills: attemptedSkills.length, servers: addedServers, needsKey, skipped,
        ...(skillsRead.skippedReasons ? { skippedReasons: skillsRead.skippedReasons } : {}) };
      return { status: 201, body: receipt };
    } catch {
      const undone: Array<{ kind: "skill" | "servers" | "receipt"; name?: string; names?: string[] }> = [];
      const notUndone: typeof undone = [];
      const undo = (item: (typeof undone)[number], action: () => void) => {
        try { action(); undone.push(item); } catch { notUndone.push(item); }
      };
      if (receiptAttempted) undo({ kind: "receipt" }, () => request.deps.restoreReceipt());
      if (mcpAttempted) undo({ kind: "servers", names: newServers.map((server) => shownName(server.name)) }, () => request.deps.persistMcp(previousMcp));
      for (const name of attemptedSkills.reverse()) undo({ kind: "skill", name: shownName(name) }, () => request.deps.removeSkill(name));
      if (notUndone.length > 0) return { status: 500, body: { code: "partly-undone",
        error: "Could not finish importing. Some changes could not be undone. Check your skills and tools before trying again.", undone, notUndone } };
      return refusal(500, "Could not finish importing. Nothing was changed.");
    }
  } finally {
    importing = false;
  }
}
