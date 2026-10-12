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
import nodePath from "node:path";

// The planners for these engines are in engine-plan-acp.ts; the executor is engine-exec.ts. This file keeps each engine's own
// key rules (slugs, hashes, ownership comparisons) exactly as mapped from the engine, plus what older importers still use.
export { Known } from "./engine-plan-core.ts";

export type AcpHistoryEngine = "gemini" | "qwen" | "opencode" | "kimi" | "cursor" | "droid" | "hermes" | "antigravity";

export const SESSION_ID = /^[\w.-]{1,200}$/;
export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
export const api = (path: string) => (isWindowsPath(path) || process.platform === "win32" ? nodePath.win32 : nodePath.posix);
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const md5 = (value: string) => createHash("md5").update(value).digest("hex");

// ── keys, each as the engine computes it ────────────────────────────────

/** Gemini CLI projectRegistry.ts: the registry key and the new-slug rule.
 * Gemini lowercases every path on a Windows host (os.platform() === "win32"),
 * and compares a .project_root marker only after normalizing it the same way. */
export function geminiNormalizedPath(folder: string): string {
  const resolved = api(folder).resolve(folder);
  return isWindowsPath(folder) || process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

export interface AcpEngineHome {
  engine: AcpHistoryEngine;
  /** gemini: the .gemini dir; qwen: runtime dir; opencode: data dir; kimi: root; cursor: data dir */
  home: string;
  /** qwen: ~/.qwen (plans, memory); cursor: the config dir */
  secondary?: string;
  /** opencode: OPENCODE_DB when set */
  db?: string;
}
