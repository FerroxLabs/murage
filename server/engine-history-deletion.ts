// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-engine removal of one conversation's history for the ACP engines whose
// storage was mapped from their own source (research notes in the 0.1.60
// delete lane, DELETE-NOTES.md). Every key below is the engine's own, for the
// conversation's own working folder or its own session ids; nothing broader.
//
//   Gemini CLI 0.47  <GEMINI_CLI_HOME|home>/.gemini/{tmp,history}/<slug>, the
//                    slug from projects.json and confirmed by .project_root;
//                    legacy sha256(folder) names.
//   Qwen Code 0.15   <QWEN_RUNTIME_DIR|~/.qwen>/projects/<sanitize(folder)>,
//                    tmp|history/<sha256(folder)>, todos|debug/<session>,
//                    ~/.qwen/plans/<session>.md.
//   OpenCode 1.15    rows for the folder's sessions in its SQLite store
//                    (<XDG_DATA_HOME|~/.local/share>/opencode/opencode*.db or
//                    OPENCODE_DB), storage/session_diff/<session>.json.
//   Kimi Code 2.1    <KIMI_CODE_HOME|~/.kimi-code>/sessions/<workdir key>,
//                    its session_index.jsonl lines, user-history/<md5>.jsonl.
//   Cursor agent     <data>/projects/<slug(folder)>, <config>/chats/<md5>,
//                    <config>/acp-sessions/<session>.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AcpHistoryEngine = "gemini" | "qwen" | "opencode" | "kimi" | "cursor" | "droid";

export interface EngineRemoval {
  remove: (root: string, target: string) => void;
  rewriteJsonl: (path: string, drop: (row: Record<string, unknown>) => boolean) => void;
  failed: (path: string) => void;
  removed: (path: string) => void;
}

const SESSION_ID = /^[\w.-]{1,200}$/;
const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
const api = (path: string) => (isWindowsPath(path) || process.platform === "win32" ? nodePath.win32 : nodePath.posix);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

function list(dir: string): string[] {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}
function read(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// ── keys, each as the engine computes it ────────────────────────────────

/** Gemini CLI projectRegistry.ts: the registry key and the new-slug rule. */
export function geminiNormalizedPath(folder: string): string {
  const resolved = api(folder).resolve(folder);
  return isWindowsPath(folder) ? resolved.toLowerCase() : resolved;
}
export function geminiSlug(folder: string): string {
  return api(folder).basename(folder).toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
}
/** Qwen Code Storage: `sanitizeCwd` and `getProjectHash`. */
export function qwenProjectKey(folder: string): string {
  return (isWindowsPath(folder) ? folder.toLowerCase() : folder).replace(/[^a-zA-Z0-9]/g, "-");
}
export function qwenProjectHash(folder: string): string {
  return sha256(isWindowsPath(folder) ? folder.toLowerCase() : folder);
}
/** Kimi Code agent-core-v2 workdir-slug.ts `encodeWorkDirKey`. */
export function kimiWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").pop() ?? normalized;
  let slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
  if (slug === "" || slug === "." || slug === "..") slug = "workspace";
  return `wd_${slug}_${sha256(normalized).slice(0, 12)}`;
}
/** Factory Droid (shipped bundle, function `bo`): "-" + the realpath with
 * trailing separators cut, leading slashes cut and slashes turned to "-". */
export function droidCwdKey(realFolder: string): string {
  return `-${realFolder.replace(/[\\/]+$/, "").replace(/^\/+/, "").replace(/\/+/g, "-")}`;
}
/** Cursor agent utils workspace-paths.js project slug, and the chats key. */
export function cursorProjectSlug(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
export function cursorChatsKey(folder: string): string {
  return md5(api(folder).resolve(folder));
}

// ── removal ──────────────────────────────────────────────────────────────

export interface AcpEngineHome {
  engine: AcpHistoryEngine;
  /** gemini: the .gemini dir; qwen: runtime dir; opencode: data dir; kimi: root; cursor: data dir */
  home: string;
  /** qwen: ~/.qwen (plans, memory); cursor: the config dir */
  secondary?: string;
  /** opencode: OPENCODE_DB when set */
  db?: string;
}

export function removeAcpEngineHistory(target: AcpEngineHome, folders: string[], sessionIds: string[], out: EngineRemoval): void {
  const ids = sessionIds.filter((id) => SESSION_ID.test(id));
  switch (target.engine) {
    case "gemini": return removeGemini(target.home, folders, out);
    case "qwen": return removeQwen(target.home, target.secondary, folders, ids, out);
    case "opencode": return removeOpenCode(target.home, target.db, folders, out);
    case "kimi": return removeKimi(target.home, folders, out);
    case "cursor": return removeCursor(target.home, target.secondary, folders, ids, out);
    case "droid": return removeDroid(target.home, folders, ids, out);
  }
}

function removeGemini(geminiDir: string, folders: string[], out: EngineRemoval): void {
  const p = api(geminiDir);
  let registry: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(read(p.join(geminiDir, "projects.json")) ?? "{}") as { projects?: Record<string, unknown> };
    registry = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
  } catch { registry = {}; }
  for (const folder of folders) {
    const normalized = geminiNormalizedPath(folder);
    const slugs = new Set<string>();
    const registered = registry[normalized];
    if (typeof registered === "string" && /^[\w.-]+$/.test(registered)) slugs.add(registered);
    // The registry may not have caught up; the marker inside each folder is
    // the engine's own ownership proof.
    for (const name of list(p.join(geminiDir, "tmp"))) {
      if (name.startsWith(geminiSlug(folder)) && read(p.join(geminiDir, "tmp", name, ".project_root"))?.trim() === normalized) slugs.add(name);
    }
    for (const slug of slugs) {
      for (const base of ["tmp", "history"]) {
        const dir = p.join(geminiDir, base, slug);
        const marker = read(p.join(dir, ".project_root"))?.trim();
        if (marker === undefined && base === "history" && !list(dir).length) continue;
        if (marker !== undefined && marker !== normalized) continue;
        out.remove(p.join(geminiDir, base), dir);
      }
    }
    for (const base of ["tmp", "history"]) out.remove(p.join(geminiDir, base), p.join(geminiDir, base, sha256(folder)));
  }
}

function removeQwen(runtime: string, global: string | undefined, folders: string[], ids: string[], out: EngineRemoval): void {
  const p = api(runtime);
  const sessions = new Set(ids);
  for (const folder of folders) {
    const key = qwenProjectKey(folder);
    for (const root of new Set([runtime, global].filter((dir): dir is string => Boolean(dir)))) {
      const project = p.join(root, "projects", key);
      for (const name of list(p.join(project, "chats"))) if (name.endsWith(".jsonl")) sessions.add(name.slice(0, -".jsonl".length));
      // The key is lossy; a chat that names another folder keeps the project.
      const others = list(p.join(project, "chats")).some((name) => (read(p.join(project, "chats", name)) ?? "").split("\n").some((line) => {
        try { const row = JSON.parse(line) as { cwd?: unknown }; return typeof row.cwd === "string" && row.cwd !== folder; } catch { return false; }
      }));
      if (others) out.failed(project);
      else out.remove(p.join(root, "projects"), project);
    }
    for (const base of ["tmp", "history"]) out.remove(p.join(runtime, base), p.join(runtime, base, qwenProjectHash(folder)));
  }
  for (const id of sessions) {
    if (!SESSION_ID.test(id)) continue;
    out.remove(p.join(runtime, "todos"), p.join(runtime, "todos", `${id}.json`));
    out.remove(p.join(runtime, "debug"), p.join(runtime, "debug", `${id}.txt`));
    if (global) out.remove(p.join(global, "plans"), p.join(global, "plans", `${id}.md`));
  }
}

function removeOpenCode(dataDir: string, dbOverride: string | undefined, folders: string[], out: EngineRemoval): void {
  const p = api(dataDir);
  const databases = dbOverride ? [dbOverride] : list(dataDir).filter((name) => /^opencode(-[\w.-]+)?\.db$/.test(name)).map((name) => p.join(dataDir, name));
  const removedIds = new Set<string>();
  for (const path of databases) {
    try { if (!lstatSync(path).isFile()) continue; } catch { continue; }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name).filter((name) => /^\w+$/.test(name));
      const columns = (table: string) => new Set((db!.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name));
      if (!tables.includes("session") || !columns("session").has("directory")) continue;
      const marks = folders.map(() => "?").join(",");
      const ids = new Set((db.prepare(`SELECT id FROM session WHERE directory IN (${marks})`).all(...folders) as Array<{ id: string }>).map((row) => String(row.id)));
      if (columns("session").has("parent_id")) {
        for (let grew = true; grew;) {
          grew = false;
          const known = [...ids];
          if (!known.length) break;
          for (const row of db.prepare(`SELECT id FROM session WHERE parent_id IN (${known.map(() => "?").join(",")})`).all(...known) as Array<{ id: string }>) {
            if (!ids.has(String(row.id))) { ids.add(String(row.id)); grew = true; }
          }
        }
      }
      if (!ids.size) continue;
      const list_ = [...ids];
      const idMarks = list_.map(() => "?").join(",");
      for (const table of tables) {
        const has = columns(table);
        for (const column of ["session_id", "aggregate_id"]) if (has.has(column)) db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${idMarks})`).run(...list_);
      }
      db.prepare(`DELETE FROM session WHERE id IN (${idMarks})`).run(...list_);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      for (const id of list_) removedIds.add(id);
      out.removed(path);
    } catch {
      out.failed(path);
    } finally {
      db?.close();
    }
  }
  for (const id of removedIds) {
    if (!SESSION_ID.test(id)) continue;
    const dir = p.join(dataDir, "storage", "session_diff");
    out.remove(dir, p.join(dir, `${id}.json`));
  }
}

function removeKimi(root: string, folders: string[], out: EngineRemoval): void {
  const p = api(root);
  const workDirs = new Set(folders.map((folder) => folder.replace(/\\/g, "/").replace(/\/+$/, "")));
  const removedSessions = new Set<string>();
  for (const folder of folders) {
    const bucket = p.join(root, "sessions", kimiWorkDirKey(folder));
    for (const name of list(bucket)) removedSessions.add(name);
    out.remove(p.join(root, "sessions"), bucket);
    out.remove(p.join(root, "user-history"), p.join(root, "user-history", `${md5(folder)}.jsonl`));
  }
  out.rewriteJsonl(p.join(root, "session_index.jsonl"), (row) =>
    (typeof row.workDir === "string" && workDirs.has(row.workDir.replace(/\\/g, "/").replace(/\/+$/, ""))) || (typeof row.sessionId === "string" && removedSessions.has(row.sessionId)));
}

function removeCursor(dataDir: string, configDir: string | undefined, folders: string[], ids: string[], out: EngineRemoval): void {
  const p = api(dataDir);
  for (const folder of folders) {
    out.remove(p.join(dataDir, "projects"), p.join(dataDir, "projects", cursorProjectSlug(folder)));
    if (configDir) out.remove(p.join(configDir, "chats"), p.join(configDir, "chats", cursorChatsKey(folder)));
  }
  if (configDir) for (const id of ids) out.remove(p.join(configDir, "acp-sessions"), p.join(configDir, "acp-sessions", id));
}

function removeDroid(root: string, folders: string[], ids: string[], out: EngineRemoval): void {
  const p = api(root);
  const sessions = p.join(root, "sessions");
  const found = new Set(ids);
  for (const folder of folders) {
    const bucket = p.join(sessions, droidCwdKey(folder));
    for (const name of list(bucket)) if (name.endsWith(".jsonl")) found.add(name.slice(0, -".jsonl".length));
    out.remove(sessions, bucket);
  }
  for (const id of found) {
    if (!/^[\w-]{1,200}$/.test(id)) continue;
    for (const name of [`${id}.jsonl`, `${id}.settings.json`]) out.remove(sessions, p.join(sessions, name));
    out.remove(p.join(sessions, "btw"), p.join(sessions, "btw", `${id}.jsonl`));
  }
  // Droid's derived session index (cache/session-index/index.db) holds
  // summaries. Its schema is not published: drop rows whose session-id
  // column names one of these sessions, or whose path column names one.
  const index = p.join(root, "cache", "session-index", "index.db");
  const known = [...found].filter((id) => /^[\w-]{8,200}$/.test(id));
  if (!known.length) return;
  try { if (!lstatSync(index).isFile()) return; } catch { return; }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(index);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
    let changed = 0;
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
      if (!/^\w+$/.test(table)) continue;
      for (const { name: column } of db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>) {
        if (!/^\w+$/.test(column)) continue;
        if (/^session_?id$/i.test(column)) changed += Number(db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${known.map(() => "?").join(",")})`).run(...known).changes);
        else if (/path|file/i.test(column)) for (const id of known) changed += Number(db.prepare(`DELETE FROM "${table}" WHERE instr("${column}", ?) > 0`).run(`${id}.jsonl`).changes);
      }
    }
    if (changed) { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); out.removed(index); }
  } catch {
    out.failed(index);
  } finally {
    db?.close();
  }
}
