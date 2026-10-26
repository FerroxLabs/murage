// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import type { SkillScanInput } from "./types.ts";

/** Drops the spaces and tabs before each line end, as `/[ \t]+$/gm` does, in one pass: that pattern retries every start inside a long run of spaces. */
export function stripTrailingBlanks(text: string): string {
  const parts: string[] = [];
  let runStart = -1, last = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : -1;
    if (c === 32 || c === 9) { if (runStart < 0) runStart = i; continue; }
    if (runStart >= 0 && (c === -1 || c === 10 || c === 13 || c === 0x2028 || c === 0x2029)) { parts.push(text.slice(last, runStart)); last = i; }
    runStart = -1;
  }
  parts.push(text.slice(last));
  return parts.join("");
}
const normalize = (text: string) => stripTrailingBlanks(text.replace(/\r\n/g, "\n")).trim();

/** Binds a verdict (and an owner's "use it anyway") to exactly the content
 *  scanned: every file, the description and the trigger terms. Fields are
 *  length-prefixed so no text can be moved between them to forge a match. */
export function skillContentHash(input: SkillScanInput): string {
  const hash = createHash("sha256");
  const field = (text: string) => { const value = normalize(text); hash.update(`${Buffer.byteLength(value)}:`).update(value); };
  field(input.description);
  field(input.triggerTerms.join("\n"));
  for (const file of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    field(file.path);
    field(file.content);
  }
  return hash.digest("hex");
}
