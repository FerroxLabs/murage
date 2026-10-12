// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How Fuigo/Grok and Claude Code name a folder's storage, each as the engine computes it. Pure functions: the planners
// (engine-plan-files.ts) and conversation-deletion.ts both use them.
import { blake3Hex } from "./blake3.ts";
import { pathApiFor } from "./engine-plan-core.ts";

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

/** Claude Code `projects/<key>`: every character that is not an ASCII letter
 * or digit becomes `-`; over 200 characters the key is cut and a hash is
 * appended (read from the shipped 2.1.x bundle). The mapping is lossy, so a
 * directory is removed only when the sessions inside it name this folder. */
export function claudeProjectKey(cwd: string): { exact: string } | { prefix: string } {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return key.length <= 200 ? { exact: key } : { prefix: `${key.slice(0, 200)}-` };
}
