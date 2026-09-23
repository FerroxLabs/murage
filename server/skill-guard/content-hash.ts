// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import type { SkillScanInput } from "./types.ts";

const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

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
