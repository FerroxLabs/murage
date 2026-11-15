// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S1: which files a write-type tool line names, so a finished-job receipt counts FILES, not tool lines.
// Pure. A line that names no path counts nothing (the count never overstates). A count phrase ("Edited 3 files") cannot say which
// files, so its distinctness is unknown: counts are never added together (the largest is kept) and the caller uses one only when no
// path was named anywhere.

const MAX_PATHS = 100;
const PREFIX = /^(?:\*\*\*\s*(?:update|add|delete|move to)\s+file:\s*|(?:edit|write|create|update|patch|delete|save)(?:d|ed)?\s+|diff --git\s+)/i;
const COUNT = /^(?:edited|changed|wrote|updated|created|touched|saved)\s+(\d{1,4})\s+files?\b/i;

function normalise(raw: string, allowSpaces: boolean, gitDiff = false): string | null {
  let value = raw.trim().replace(/^["'`]|["'`,;:]$/g, "").replace(/\\/g, "/");
  // The a/ and b/ prefixes belong to git diff paths only; an ordinary a/config.ts and b/config.ts are two files.
  if (gitDiff) value = value.replace(/^(?:a|b)\//, "");
  value = value.replace(/^\.\//, "");
  if (value.length === 0 || value.length > 400 || (!allowSpaces && /\s/.test(value))) return null;
  // Path-like: has a directory separator or a short extension; never a bare word.
  return /\//.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value) ? value : null;
}

export function filesNamedByToolLine(_toolName: string, summary: string | undefined): { paths: string[]; anonymous: number } {
  if (typeof summary !== "string" || summary.length === 0) return { paths: [], anonymous: 0 };
  const paths = new Set<string>();
  let anonymous = 0;
  for (const line of summary.slice(0, 20_000).split(/\r?\n/)) {
    const text = line.trim();
    const count = COUNT.exec(text);
    if (count) { anonymous = Math.max(anonymous, Number(count[1])); continue; }
    let rest = text.replace(PREFIX, "");
    // `diff --git a/x b/x` names the file twice; the first token is the file.
    const gitDiff = /^diff --git\s/i.test(text);
    if (gitDiff) rest = rest.split(/\s+/)[0] ?? "";
    // Quoted paths keep their spaces.
    for (const match of rest.matchAll(/(["'`])(.+?)\1/g)) {
      const path = normalise(match[2]!, true);
      if (path) paths.add(path);
    }
    rest = rest.replace(/(["'`])(.+?)\1/g, " ");
    // The rest is a complete list separated by commas or semicolons; a piece with spaces is prose, never a path.
    for (const piece of rest.split(/[,;]/)) {
      const path = normalise(piece, false, gitDiff);
      if (path) paths.add(path);
    }
    if (paths.size >= MAX_PATHS) break;
  }
  return { paths: [...paths].slice(0, MAX_PATHS), anonymous: paths.size > 0 ? 0 : anonymous };
}
