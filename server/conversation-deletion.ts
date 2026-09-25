// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deleting a conversation removes what it left on disk, not only its rows.
//
// A conversation's content lives in more places than messages.db: the
// harness event log and the engine protocol log (events/, native/), the
// conversation's own working folder (workspaces/<bot>/threads/<thread>),
// its pinned skill bundles (skill-state/<bot>/task-bundles/<thread>), the
// checkpoints of that folder, pictures and files it produced, and the
// engine's own transcript of the session it ran in that folder. Delete
// promises the conversation is gone, so every one of those goes with it.
//
// Rules this module keeps:
//  - Every path is built from checked ids under a known root, and removal
//    refuses anything that is not strictly inside that root or that passes
//    through a symlink on the way. A symlink is removed, never followed.
//  - A folder another conversation may use is never removed: the bot's own
//    folder and any folder the person picked stay. What the engine kept for
//    such a folder is reported as a leftover instead.
//  - Engine transcripts are removed only where the engine's own key for a
//    folder maps exactly to this conversation's working folder. Where the
//    key cannot be computed or confirmed, the place is reported, not guessed.
//  - The work is durable: a pending record is written before the rows go
//    and cleared only after the files are gone; boot finishes any record a
//    crash left behind.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, ftruncateSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "./atomic.ts";
import { blake3Hex } from "./blake3.ts";

const ID = /^[\w-]+$/;
const ATTACHMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/i;
const ATTACHMENT_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}/gi;
const ARTIFACT_BLOB = /^[a-f0-9]{64}\.[a-z0-9]{1,12}$/;
const FIRST_LINE_BYTES = 1024 * 1024;

export type DeletionEngine = "fuigo" | "grok" | "claude" | "codex";
export interface DeletionEngineHome { engine: DeletionEngine; home: string }
/** Something this deletion could not remove, in words the owner can act on. */
export interface DeletionLeftover { place: string; reason: string }
export interface DeletionReport { leftovers: DeletionLeftover[]; failed: string[] }

/** A deletion that has started. Everything a crash needs to finish it. */
export interface PendingConversationDeletion {
  id: string;
  createdAt: number;
  threadIds: string[];
  /** one entry per working folder found for a thread (a channel has one per member) */
  desks: Array<{ botId: string; threadId: string; checkpointKey?: string; memoryFolder?: string }>;
  engineHomes: DeletionEngineHome[];
  /** bots deleted with these conversations: their own folder was theirs alone */
  botIds?: string[];
  attachments: string[];
  artifactBlobs: string[];
  leftovers: DeletionLeftover[];
}

export interface DeletionInput {
  threadIds: string[];
  /** folders these conversations ran in that are not their own working folder */
  sharedFolders?: string[];
  /** engine kinds (driverKind) the conversations ran on */
  engineKinds?: string[];
  engineHomes?: DeletionEngineHome[];
  /** the bot is being deleted too: its own folder, and the engine history
   * kept for it, belonged to it alone */
  botIds?: string[];
}

// ── pure path helpers ───────────────────────────────────────────────────

type PathApi = typeof nodePath.posix;

/** The path module a path is written for: a drive letter or UNC prefix is Windows. */
export function pathApiFor(path: string): PathApi {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? nodePath.win32 : process.platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** True only for a path strictly below `root` (never `root` itself). */
export function isStrictlyInside(root: string, target: string, api: PathApi = pathApiFor(root)): boolean {
  if (!api.isAbsolute(root) || !api.isAbsolute(target)) return false;
  const rel = api.relative(api.resolve(root), api.resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/** The `urlencoding` crate's `encode`: every UTF-8 byte except ASCII
 * letters, digits and `-._~` becomes `%XX` in upper-case hex. Fuigo and Grok
 * name a folder's session directory with it (fuigo-config paths.rs
 * `encode_cwd_dirname`). encodeURIComponent differs on `!*'()`. */
export function rustUrlEncode(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** fuigo-config paths.rs `slugify`. */
export function engineSlug(input: string, maxLength: number): string {
  let result = "";
  let previousDash = false;
  for (const ch of input.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) {
      result += ch;
      previousDash = false;
    } else if (!previousDash) {
      result += "-";
      previousDash = true;
    }
  }
  return [...result.replace(/^-+|-+$/g, "")].slice(0, maxLength).join("");
}

/** Fuigo/Grok `sessions/<key>` for a folder (fuigo-config paths.rs
 * `encode_cwd_dirname`): the urlencoded folder, or past 255 bytes
 * `<slug of the leaf>-<first 16 hex of blake3(folder)>`. */
export function fuigoSessionKey(cwd: string): string {
  const encoded = rustUrlEncode(cwd);
  if (Buffer.byteLength(encoded) <= 255) return encoded;
  const leaf = pathApiFor(cwd).basename(cwd) || "workspace";
  return `${engineSlug(leaf, 40) || "workspace"}-${blake3Hex(cwd).slice(0, 16)}`;
}

/** Fuigo/Grok memory folder `memory/<slug>-<first 8 hex of blake3>` for a
 * folder outside any git repository (fuigo-memory storage.rs
 * `compute_workspace_hash`): slug and hash both come from the canonical
 * path. Inside a repository the name follows the repository's remote and is
 * shared by every clone, so it is never computed here. */
export function fuigoMemoryKey(canonicalFolder: string): string {
  const leaf = pathApiFor(canonicalFolder).basename(canonicalFolder) || "workspace";
  return `${engineSlug(leaf, 40) || "workspace"}-${blake3Hex(canonicalFolder).slice(0, 8)}`;
}

/** Is `folder` inside a git repository (a `.git` entry in it or any parent)? */
export function insideGitRepository(folder: string): boolean {
  const api = pathApiFor(folder);
  let at = api.resolve(folder);
  for (;;) {
    if (lstatOrNull(api.join(at, ".git"))) return true;
    const parent = api.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}

/** Remove the lines a predicate picks from a shared JSONL log, keeping the
 * file's inode: Fuigo writers hold O_APPEND handles on it and its own trim
 * rewrites in place for that reason (fuigo-telemetry unified_log.rs
 * `trim_file`). Kept lines are written over the head, then the file is cut. */
export function scrubJsonlInPlace(path: string, drop: (row: Record<string, unknown>) => boolean): number {
  const stat = lstatOrNull(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return 0;
  const text = readFileSync(path, "utf8");
  let removed = 0;
  const kept = text.split("\n").filter((line) => {
    if (!line.trim()) return true;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === "object" && drop(row as Record<string, unknown>)) {
        removed++;
        return false;
      }
    } catch { /* a torn line is kept as it is */ }
    return true;
  });
  if (!removed) return 0;
  const bytes = Buffer.from(kept.join("\n"), "utf8");
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return removed;
}

/** Claude Code `projects/<key>`: every character that is not an ASCII letter
 * or digit becomes `-`; over 200 characters the key is cut and a hash is
 * appended (read from the shipped 2.1.x bundle). The mapping is lossy, so a
 * directory is removed only when the sessions inside it name this folder. */
export function claudeProjectKey(cwd: string): { exact: string } | { prefix: string } {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return key.length <= 200 ? { exact: key } : { prefix: `${key.slice(0, 200)}-` };
}

/** checkpoints.ts `shadowDir` key for a folder. */
export function checkpointKey(realFolder: string): string {
  return createHash("sha256").update(nodePath.resolve(realFolder)).digest("hex").slice(0, 16);
}

function sameFolder(a: string, b: string): boolean {
  const api = pathApiFor(a);
  if (api === nodePath.win32) return nodePath.win32.normalize(a).toLowerCase() === nodePath.win32.normalize(b).toLowerCase();
  return nodePath.posix.normalize(a) === nodePath.posix.normalize(b);
}

// ── confined removal ────────────────────────────────────────────────────

export type RemoveOutcome = "removed" | "absent" | "refused" | "failed";

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/** Remove `target`, which must sit strictly inside `root`, without
 * following a symlink anywhere between them. A symlink target is unlinked
 * as a link. */
export function removeConfined(root: string, target: string): RemoveOutcome {
  const api = pathApiFor(root);
  if (!isStrictlyInside(root, target, api)) return "refused";
  try {
    const parts = api.relative(api.resolve(root), api.resolve(target)).split(api.sep);
    let at = api.resolve(root);
    const rootStat = lstatOrNull(at);
    if (!rootStat) return "absent";
    for (const part of parts.slice(0, -1)) {
      at = api.join(at, part);
      const stat = lstatOrNull(at);
      if (!stat) return "absent";
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "refused";
    }
    const full = api.join(at, parts[parts.length - 1]!);
    const stat = lstatOrNull(full);
    if (!stat) return "absent";
    if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(full);
    else rmSync(full, { recursive: true, force: true });
    return "removed";
  } catch {
    return "failed";
  }
}

function listDir(path: string): string[] {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readHead(path: string, bytes = FIRST_LINE_BYTES): string | null {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(Math.min(bytes, stat.size));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── engine transcripts ──────────────────────────────────────────────────

/** Fuigo and Grok: `<home>/sessions/<key>` for each exact folder. */
/** Fuigo and Grok: `<home>/sessions/<key>` for each folder, the lines those
 * sessions wrote to the shared `logs/unified.jsonl` (keyed `sid`), and the
 * folder's memory notes when the folder is outside any repository. */
function removeFuigoSessions(home: string, folders: string[], memoryFolders: string[], removed: string[], failed: string[]): void {
  const api = pathApiFor(home);
  const sessions = api.join(home, "sessions");
  const sessionIds = new Set<string>();
  for (const folder of folders) {
    const dir = api.join(sessions, fuigoSessionKey(folder));
    for (const name of listDir(dir)) if (lstatOrNull(api.join(dir, name))?.isDirectory()) sessionIds.add(name);
    record(removeConfined(sessions, dir), dir, removed, failed);
  }
  if (sessionIds.size) {
    const log = api.join(home, "logs", "unified.jsonl");
    try {
      if (scrubJsonlInPlace(log, (row) => typeof row.sid === "string" && sessionIds.has(row.sid))) removed.push(log);
    } catch {
      failed.push(log);
    }
  }
  const memory = api.join(home, "memory");
  for (const folder of new Set(memoryFolders)) {
    const dir = api.join(memory, fuigoMemoryKey(folder));
    record(removeConfined(memory, dir), dir, removed, failed);
  }
}

/** Every `cwd` the Claude Code session files in `dir` name. */
function claudeSessionFolders(dir: string): string[] {
  const found: string[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const head = readHead(nodePath.join(dir, name), 256 * 1024);
    if (head === null) continue;
    for (const line of head.split("\n")) {
      try {
        const row = JSON.parse(line) as { cwd?: unknown };
        if (typeof row.cwd === "string") found.push(row.cwd);
      } catch { /* a cut last line */ }
    }
  }
  return found;
}

function removeClaudeProjects(home: string, folders: string[], removed: string[], failed: string[], leftovers: DeletionLeftover[]): void {
  const api = pathApiFor(home);
  const projects = api.join(home, "projects");
  const ours = (cwd: string) => folders.some((folder) => sameFolder(folder, cwd));
  for (const folder of folders) {
    const key = claudeProjectKey(folder);
    const names = "exact" in key ? [key.exact] : listDir(projects).filter((name) => name.startsWith(key.prefix));
    for (const name of names) {
      const dir = api.join(projects, name);
      if (!lstatOrNull(dir)) continue;
      const named = claudeSessionFolders(dir);
      // A lossy key: another folder can share it. Remove only when every
      // session inside names this conversation's folder (and, for the cut
      // long form, at least one does).
      if (named.some((cwd) => !ours(cwd)) || ("prefix" in key && !named.length)) {
        if ("exact" in key) leftovers.push({ place: dir, reason: "Claude Code keeps this folder's history under a name another folder also uses, so it was left in place." });
        continue;
      }
      record(removeConfined(projects, dir), dir, removed, failed);
    }
  }
}

/** Codex keeps one rollout file per session under sessions/YYYY/MM/DD and
 * archived_sessions/, whose first line (`session_meta`) names the folder. */
function removeCodexRollouts(home: string, folders: string[], removed: string[], failed: string[]): void {
  const api = pathApiFor(home);
  const candidates: string[] = [];
  const sessions = api.join(home, "sessions");
  for (const year of listDir(sessions).filter((name) => /^\d{4}$/.test(name)))
    for (const month of listDir(api.join(sessions, year)).filter((name) => /^\d{2}$/.test(name)))
      for (const day of listDir(api.join(sessions, year, month)).filter((name) => /^\d{2}$/.test(name)))
        for (const file of listDir(api.join(sessions, year, month, day))) candidates.push(api.join(sessions, year, month, day, file));
  const archived = api.join(home, "archived_sessions");
  for (const file of listDir(archived)) candidates.push(api.join(archived, file));
  for (const file of candidates) {
    if (!/^rollout-.+\.jsonl$/.test(api.basename(file))) continue;
    const head = readHead(file);
    const first = head?.split("\n", 1)[0];
    if (!first) continue;
    try {
      const row = JSON.parse(first) as { type?: unknown; payload?: { cwd?: unknown } };
      const cwd = row.payload?.cwd;
      if (row.type !== "session_meta" || typeof cwd !== "string" || !folders.some((folder) => sameFolder(folder, cwd))) continue;
    } catch {
      continue;
    }
    record(removeConfined(home, file), file, removed, failed);
  }
}

function record(outcome: RemoveOutcome, path: string, removed: string[], failed: string[]): void {
  if (outcome === "removed") removed.push(path);
  else if (outcome === "refused" || outcome === "failed") failed.push(path);
}

/** Where each supported engine keeps its own history, from the environment
 * it is started with (the same resolution as each driver). */
export function engineHomeFor(engine: DeletionEngine, env: Record<string, string | undefined>, claudeConfigDir?: string): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const withReal = (path: string) => {
    try {
      const real = realpathSync.native(path);
      return real === path ? [path] : [path, real];
    } catch {
      return [path];
    }
  };
  switch (engine) {
    case "fuigo": return env.FUIGO_HOME ? [env.FUIGO_HOME] : withReal(home).map((dir) => nodePath.join(dir, ".fuigo"));
    case "grok": return env.GROK_HOME ? [env.GROK_HOME] : withReal(home).map((dir) => nodePath.join(dir, ".grok"));
    case "claude": return [claudeConfigDir || env.CLAUDE_CONFIG_DIR || nodePath.join(home, ".claude")];
    case "codex": return [env.CODEX_HOME || nodePath.join(home, ".codex")];
  }
}

export const ENGINE_FOR_DRIVER: Readonly<Record<string, DeletionEngine>> = {
  fuigoAgent: "fuigo",
  grokAgent: "grok",
  claudeAgent: "claude",
  codex: "codex",
};
/** Engines that run remotely and keep nothing on this computer. */
const NO_LOCAL_HISTORY = new Set(["grok", "minimax", "openai-compat", "boxAgent"]);

// ── the deletion service ────────────────────────────────────────────────

export interface DeletionServiceOptions {
  dataDir: string;
  database: () => DatabaseSync;
  /** attachments go through the quota-aware remover when one is given */
  deleteAttachment?: (path: string) => void;
  /** other per-conversation records to drop once the rows are gone */
  forgetThreads?: (threadIds: string[]) => void;
}

export class ConversationDeletions {
  readonly journal: string;
  private readonly options: DeletionServiceOptions;
  constructor(options: DeletionServiceOptions) {
    this.options = options;
    this.journal = nodePath.join(options.dataDir, "pending-deletions.json");
  }

  pending(): PendingConversationDeletion[] {
    try {
      const parsed = JSON.parse(readFileSync(this.journal, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as PendingConversationDeletion[]).filter((entry) => entry && typeof entry.id === "string" && Array.isArray(entry.threadIds)) : [];
    } catch {
      return [];
    }
  }

  private save(entries: PendingConversationDeletion[]): void {
    writeFileAtomic(this.journal, JSON.stringify(entries), { mode: 0o600 });
  }

  private get dir() {
    const data = this.options.dataDir;
    return {
      events: nodePath.join(data, "events"),
      native: nodePath.join(data, "native"),
      grokContext: nodePath.join(data, "native", "grok-provider-context"),
      workspaces: nodePath.join(data, "workspaces"),
      skillState: nodePath.join(data, "skill-state"),
      checkpoints: nodePath.join(data, "checkpoints"),
      attachments: nodePath.join(data, "attachments"),
      artifacts: nodePath.join(data, "artifact-files"),
    };
  }

  /** Record what a deletion will remove, before any of it is removed. Throws
   * when the record cannot be written, so nothing is deleted without it. */
  begin(input: DeletionInput): PendingConversationDeletion {
    const threadIds = [...new Set(input.threadIds)].filter((id) => ID.test(id));
    const dirs = this.dir;
    const desks: PendingConversationDeletion["desks"] = [];
    for (const botId of listDir(dirs.workspaces).filter((name) => ID.test(name))) {
      for (const threadId of threadIds) {
        const desk = nodePath.join(dirs.workspaces, botId, "threads", threadId);
        const stat = lstatOrNull(desk);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        let real: string | undefined;
        try { real = realpathSync.native(desk); } catch { real = undefined; }
        // Engines that file notes by folder (Fuigo/Grok memory) name them by
        // the canonical path only outside a git repository.
        const memoryFolder = real && !insideGitRepository(real) ? real : undefined;
        desks.push({ botId, threadId, ...(real ? { checkpointKey: checkpointKey(real) } : {}), ...(memoryFolder ? { memoryFolder } : {}) });
      }
    }
    const leftovers: DeletionLeftover[] = [];
    for (const folder of new Set(input.sharedFolders ?? [])) {
      leftovers.push({ place: folder, reason: "This conversation worked in a folder other conversations can use. Its files there and the engine's history for that folder were kept." });
    }
    for (const kind of new Set(input.engineKinds ?? [])) {
      if (ENGINE_FOR_DRIVER[kind] || NO_LOCAL_HISTORY.has(kind)) continue;
      leftovers.push({ place: kind, reason: "This engine keeps its own history in a place Murage cannot find exactly, so its copy of this conversation was not removed." });
    }
    const entry: PendingConversationDeletion = {
      id: randomUUID(),
      createdAt: Date.now(),
      threadIds,
      desks,
      botIds: [...new Set(input.botIds ?? [])].filter((id) => ID.test(id)),
      engineHomes: (input.engineHomes ?? []).filter((home) => Object.values(ENGINE_FOR_DRIVER).includes(home.engine) && typeof home.home === "string" && pathApiFor(home.home).isAbsolute(home.home)),
      attachments: this.attachmentsOnlyIn(threadIds),
      artifactBlobs: this.artifactBlobsOf(threadIds),
      leftovers,
    };
    this.save([...this.pending(), entry]);
    return entry;
  }

  /** The deletion was refused or failed before it committed. */
  abandon(entry: PendingConversationDeletion): void {
    const rest = this.pending().filter((other) => other.id !== entry.id);
    if (rest.length !== this.pending().length) this.save(rest);
  }

  /** Remove everything the record names, then clear the record. */
  finish(entry: PendingConversationDeletion): DeletionReport {
    const dirs = this.dir;
    const removed: string[] = [];
    const failed: string[] = [];
    const leftovers = [...entry.leftovers];
    const threadIds = entry.threadIds.filter((id) => ID.test(id));
    this.deleteArtifactRows(threadIds);
    try { this.options.forgetThreads?.(threadIds); } catch (error) { console.error("conversation deletion: could not drop records", error); }
    for (const threadId of threadIds) {
      for (const dir of [dirs.events, dirs.native]) {
        for (const name of [`${threadId}.ndjson`, `${threadId}.previous.ndjson`]) record(removeConfined(dir, nodePath.join(dir, name)), nodePath.join(dir, name), removed, failed);
      }
      const grok = nodePath.join(dirs.grokContext, createHash("sha256").update(threadId).digest("hex"));
      record(removeConfined(dirs.grokContext, grok), grok, removed, failed);
    }
    const folders: string[] = [];
    let realWorkspaces: string | undefined;
    try { realWorkspaces = realpathSync.native(dirs.workspaces); } catch { realWorkspaces = undefined; }
    for (const desk of entry.desks) {
      if (!ID.test(desk.botId) || !ID.test(desk.threadId) || !threadIds.includes(desk.threadId)) continue;
      for (const root of new Set([dirs.workspaces, realWorkspaces].filter((dir): dir is string => Boolean(dir)))) folders.push(nodePath.join(root, desk.botId, "threads", desk.threadId));
      const folder = nodePath.join(dirs.workspaces, desk.botId, "threads", desk.threadId);
      record(removeConfined(dirs.workspaces, folder), folder, removed, failed);
      const bundles = nodePath.join(dirs.skillState, desk.botId, "task-bundles", desk.threadId);
      record(removeConfined(dirs.skillState, bundles), bundles, removed, failed);
      if (desk.checkpointKey && /^[a-f0-9]{16}$/.test(desk.checkpointKey)) {
        const shadow = nodePath.join(dirs.checkpoints, desk.botId, desk.checkpointKey);
        record(removeConfined(dirs.checkpoints, shadow), shadow, removed, failed);
      }
    }
    for (const botId of (entry.botIds ?? []).filter((id) => ID.test(id))) {
      for (const root of new Set([dirs.workspaces, realWorkspaces].filter((dir): dir is string => Boolean(dir)))) folders.push(nodePath.join(root, botId));
      for (const root of [dirs.workspaces, dirs.skillState, dirs.checkpoints]) record(removeConfined(root, nodePath.join(root, botId)), nodePath.join(root, botId), removed, failed);
    }
    // pinned bundles can exist for a thread whose folder was never made
    for (const botId of listDir(dirs.skillState).filter((name) => ID.test(name))) {
      for (const threadId of threadIds) {
        const bundles = nodePath.join(dirs.skillState, botId, "task-bundles", threadId);
        record(removeConfined(dirs.skillState, bundles), bundles, removed, failed);
      }
    }
    for (const name of entry.attachments.filter((item) => ATTACHMENT_NAME.test(item))) {
      const path = nodePath.join(dirs.attachments, name);
      if (this.options.deleteAttachment) {
        try { this.options.deleteAttachment(path); } catch { failed.push(path); }
        if (lstatOrNull(path)) failed.push(path);
        else removed.push(path);
      } else record(removeConfined(dirs.attachments, path), path, removed, failed);
    }
    for (const name of entry.artifactBlobs.filter((item) => ARTIFACT_BLOB.test(item))) {
      if (this.artifactBlobStillUsed(name)) continue;
      const path = nodePath.join(dirs.artifacts, name);
      record(removeConfined(dirs.artifacts, path), path, removed, failed);
    }
    const memoryFolders = entry.desks.filter((desk) => threadIds.includes(desk.threadId) && typeof desk.memoryFolder === "string" && desk.memoryFolder.endsWith(desk.threadId)).map((desk) => desk.memoryFolder!);
    if (folders.length) this.removeEngineHistory(entry.engineHomes, [...new Set(folders)], memoryFolders, removed, failed, leftovers);
    // The rows are gone and overwritten (secure_delete); the write-ahead log
    // still holds the old pages until it is checkpointed and truncated.
    try { this.options.database().exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* the next checkpoint takes it */ }
    if (!failed.length) this.abandon(entry);
    return { leftovers: dedupeLeftovers(leftovers), failed };
  }

  /** Finish every deletion a crash interrupted. A record whose thread is
   * still live never committed and is dropped; the owner can delete again. */
  reconcile(isLive: (threadId: string) => boolean, deleteRows: (threadId: string) => void): number {
    let finished = 0;
    for (const entry of this.pending()) {
      if (entry.threadIds.some(isLive)) {
        this.abandon(entry);
        continue;
      }
      try {
        for (const threadId of entry.threadIds) deleteRows(threadId);
        this.finish(entry);
        finished++;
      } catch (error) {
        console.error("conversation deletion: could not finish an interrupted delete", error);
      }
    }
    return finished;
  }

  private removeEngineHistory(homes: DeletionEngineHome[], folders: string[], memoryFolders: string[], removed: string[], failed: string[], leftovers: DeletionLeftover[]): void {
    const seen = new Set<string>();
    for (const { engine, home } of homes) {
      if (seen.has(`${engine}\0${home}`)) continue;
      seen.add(`${engine}\0${home}`);
      const before = removed.length;
      if (engine === "fuigo" || engine === "grok") removeFuigoSessions(home, folders, memoryFolders, removed, failed);
      else if (engine === "claude") removeClaudeProjects(home, folders, removed, failed, leftovers);
      else if (engine === "codex") removeCodexRollouts(home, folders, removed, failed);
      if (removed.length === before) continue;
      const name = { fuigo: "Fuigo", grok: "Grok", claude: "Claude Code", codex: "Codex" }[engine];
      const shared = { fuigo: "its logs and memory folders", grok: "its logs and memory folders", claude: "history.jsonl and its per-session side files", codex: "history.jsonl and its logs" }[engine];
      leftovers.push({ place: home, reason: `${name}'s transcript of this conversation was removed. ${name} also keeps ${shared}, which every conversation shares, so they were left in place.` });
    }
  }

  private hasTable(name: string): boolean {
    try {
      return Boolean(this.options.database().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    } catch {
      return false;
    }
  }

  /** Attachment files these threads' messages name that no other thread names. */
  private attachmentsOnlyIn(threadIds: string[]): string[] {
    if (!threadIds.length || !this.hasTable("messages")) return [];
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    const names = new Set<string>();
    for (const row of db.prepare(`SELECT json FROM messages WHERE thread_id IN (${marks})`).all(...threadIds) as Array<{ json: string }>) {
      for (const match of row.json.matchAll(ATTACHMENT_IN_TEXT)) names.add(match[0].toLowerCase());
    }
    const elsewhere = db.prepare(`SELECT 1 FROM messages WHERE thread_id NOT IN (${marks}) AND instr(lower(json), ?) > 0 LIMIT 1`);
    return [...names].filter((name) => ATTACHMENT_NAME.test(name) && !elsewhere.get(...threadIds, name) && lstatOrNull(nodePath.join(this.dir.attachments, name))?.isFile());
  }

  private artifactBlobsOf(threadIds: string[]): string[] {
    if (!threadIds.length || !this.hasTable("artifacts")) return [];
    const marks = threadIds.map(() => "?").join(",");
    const rows = this.options.database().prepare(`SELECT DISTINCT sha256, extension FROM artifacts WHERE thread_id IN (${marks})`).all(...threadIds) as Array<{ sha256: string; extension: string }>;
    return rows.map((row) => `${row.sha256}${row.extension}`).filter((name) => ARTIFACT_BLOB.test(name));
  }

  private artifactBlobStillUsed(name: string): boolean {
    if (!this.hasTable("artifacts")) return false;
    const dot = name.indexOf(".");
    return Boolean(this.options.database().prepare("SELECT 1 FROM artifacts WHERE sha256=? AND extension=? LIMIT 1").get(name.slice(0, dot), name.slice(dot)));
  }

  private deleteArtifactRows(threadIds: string[]): void {
    if (!threadIds.length) return;
    const db = this.options.database();
    const marks = threadIds.map(() => "?").join(",");
    if (this.hasTable("output_publications")) db.prepare(`DELETE FROM output_publications WHERE thread_id IN (${marks})`).run(...threadIds);
    if (this.hasTable("artifacts")) db.prepare(`DELETE FROM artifacts WHERE thread_id IN (${marks})`).run(...threadIds);
  }
}

function dedupeLeftovers(leftovers: DeletionLeftover[]): DeletionLeftover[] {
  const seen = new Set<string>();
  return leftovers.filter((item) => {
    const key = `${item.place}\0${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Begin, commit, settle, finish. `commit` returns a falsy value when it
 * refused; the record is then dropped and nothing is removed. `settle` runs
 * after the commit and before any file goes (retire idle engine sessions, so
 * nothing writes to a transcript after it is removed). */
export async function runConversationDeletion<T>(deletions: ConversationDeletions, input: DeletionInput, commit: () => T, settle?: () => Promise<void>): Promise<{ result: T; report: DeletionReport }> {
  const entry = deletions.begin(input);
  let result: T;
  try {
    result = commit();
  } catch (error) {
    deletions.abandon(entry);
    throw error;
  }
  if (!result) {
    deletions.abandon(entry);
    return { result, report: { leftovers: [], failed: [] } };
  }
  try { await settle?.(); } catch { /* the files go regardless */ }
  return { result, report: deletions.finish(entry) };
}
