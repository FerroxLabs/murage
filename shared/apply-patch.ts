// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one apply_patch reader (Codex's hook route, server/drivers/codex-hook.ts, and Fuigo's codex/apply_patch over ACP,
// server/drivers/acp/core.ts). It reports every place a patch writes or removes, or null when the patch is not one whole
// envelope it reads exactly as the engines' own parser does (codex-rs apply-patch, fuigo-tools codex/apply_patch
// parser.rs). Those parsers trim each hunk header line before matching it, so a header this reader would have skipped as a
// context line (an indented `  *** Add File: /x` after an Add hunk) is a header to them: any such line, and any header path
// with whitespace at either end, makes the patch unread here, never read differently (r#7, 1.0.7).

import { GATE_MESSAGE_BYTES } from "./scan-limits.ts";

export interface ParsedApplyPatch {
  /** every destination in order: Add, Update and Delete paths and every Move target */
  destinations: string[];
  /** the body each destination receives (an Update's added lines; a Move carries its update's body) */
  added: Map<string, string>;
  /** the files the patch removes: each Delete path and the source of each Update that moves */
  deletes: string[];
}

/** Rust's `char::is_whitespace` set (str::trim), with JS's own \s: U+0085 is whitespace to Rust and not to JS. */
const EDGE_SPACE = /^[\s\u0085]|[\s\u0085]$/;
const LEAD_SPACE = /^[\s\u0085]+/;
const HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/;

/** apply_patch destinations: `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` headers. A patch that is not
 *  one whole well-formed envelope is unread (null). */
export function parseApplyPatch(patch: unknown): ParsedApplyPatch | null {
  if (typeof patch !== "string" || Buffer.byteLength(patch, "utf8") > GATE_MESSAGE_BYTES) return null;
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") return null;
  const destinations: string[] = [];
  const deletes: string[] = [];
  const added = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(1, -1)) {
    const header = HEADER.exec(line);
    if (header) {
      const path = header[2]!;
      if (!path.trim() || EDGE_SPACE.test(path) || path.includes("\0")) return null;
      destinations.push(path);
      // Rule 64: every body a destination receives is read (an Update's added lines too, and a Move carries the update's body to
      // its new name), so a template file is never written unread
      if (header[1] === "Move to") {
        if (!current) return null;
        deletes.push(current);
        added.set(path, added.get(current)!);
        continue;
      }
      if (header[1] === "Delete File") deletes.push(path);
      current = header[1] === "Delete File" ? null : path;
      if (current && !added.has(current)) added.set(current, []);
      continue;
    }
    // a line the engines' parser would trim into a header (or into any `***` marker) is never read as context here
    if (line !== "*** End of File" && (line.startsWith("*** ") || (LEAD_SPACE.test(line) && line.replace(LEAD_SPACE, "").startsWith("*** ")))) return null;
    if (line === "" || line.startsWith("@@") || line === "*** End of File" || /^[ +\-]/.test(line)) {
      if (current && line.startsWith("+")) added.get(current)!.push(line.slice(1));
      continue;
    }
    return null;
  }
  if (!destinations.length) return null;
  return { destinations, added: new Map([...added].map(([k, v]) => [k, v.join("\n")])), deletes };
}

/** The patch text of Fuigo's codex/apply_patch call as the engine reads its arguments (fuigo-tools ApplyPatchInput): the bare
 *  string, or an object whose ONLY key is one of `patch`, `raw` or `input`, as a string. Anything else (a second key beside it,
 *  such as a `command` that would let the call be judged as a shell line instead of the patch it runs) is undefined (unread). */
export function patchTextOf(input: unknown, murageKeys: readonly string[] = []): string | undefined {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  // `murageKeys`: keys Murage itself put beside the engine's arguments (the ACP driver's `paths`), never the engine's
  const keys = Object.keys(body).filter((key) => !murageKeys.includes(key));
  if (keys.length !== 1 || !["patch", "raw", "input"].includes(keys[0]!)) return undefined;
  const text = body[keys[0]!];
  return typeof text === "string" ? text : undefined;
}
