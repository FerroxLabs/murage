// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SENSITIVE_PATHS } from "./sensitive-paths.ts";

// 1.0.4 (09-1 Low): a glob that could match a key file is a read of it.
//
// `cat ~/.aw?/credentials` and `Get-Content ~\.aws\cred*` name no key file
// in so many letters, so the rows above never see them. Every path row's
// Read spellings are turned into one sample path each (`~/.ssh/**` is
// `~/.ssh/x`, `.env.*` is `.env.x`), and a glob in a command's text that
// could match a sample, segment by segment, is held as that row's key read.
// A relative glob may be read from any folder, so it is matched against the
// tail of a sample; a sample that may sit anywhere (`.env`,
// `credentials.json`) is matched against the glob's tail.
//
// Limits, on purpose: a glob of wildcards only (`*`, `*.*`) or a wildcard
// and an extension (`*.json`, `*.pem`) in a folder that names no key folder
// is not read as a key read, or every `prettier "**/*.json"` would hold. A
// hard link to a key file under an ordinary name cannot be told from any
// other file by its path at all: the key guard reads names and where
// symbolic links land (server/auto-approve.ts realKeyPaths), never inodes.

/** One sample path per Read spelling, with the row it belongs to. */
const KEY_SAMPLES: ReadonlyArray<{ re: RegExp; segments: string[] }> = SENSITIVE_PATHS.flatMap((row) =>
  row.read.map((rule) => {
    const sample = rule.replace(/^\*\*\//, "").replace(/\/\*\*$/, "/x").replace(/\*/g, "x");
    return { re: row.re, segments: sample.split("/") };
  }),
);

/** One glob segment as a pattern: `*`, `?` and `[…]` as the shells read them. */
function segmentPattern(segment: string): RegExp {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[" && segment.indexOf("]", i + 2) > i) {
      const end = segment.indexOf("]", i + 2);
      const body = segment.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      out += `[${body}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** Do the glob's segments match the path's, `**` standing for any number of them? */
function segmentsMatch(glob: readonly string[], path: readonly string[]): boolean {
  if (!glob.length) return !path.length;
  if (glob[0] === "**") {
    for (let k = 0; k <= path.length; k++) if (segmentsMatch(glob.slice(1), path.slice(k))) return true;
    return false;
  }
  return path.length > 0 && segmentPattern(glob[0]!).test(path[0]!) && segmentsMatch(glob.slice(1), path.slice(1));
}

const GLOB_CHARS = /[*?]|\[[^\]]+\]/;

/** A path token with its home spelled `~` and its separators `/`. */
function homeForm(token: string): string {
  return token
    .replace(/\\/g, "/")
    .replace(/^(\$\{HOME\}|\$HOME|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=\/|$)/i, "~")
    .replace(/^[a-z]:\/users\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/(users|home)\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

/** Could this glob match the sample? */
function globCouldMatch(glob: string[], sample: string[]): boolean {
  const homeGlob = glob[0] === "~";
  const homeSample = sample[0] === "~";
  const anchored = glob[0] === "" || homeGlob;
  if (anchored && (homeSample || sample[0] === "")) return segmentsMatch(glob, sample);
  // the sample may sit anywhere: the glob's tail is the sample
  if (!homeSample && sample[0] !== "") {
    for (let k = 0; k < glob.length; k++) if (segmentsMatch(glob.slice(k), sample)) return true;
    return false;
  }
  // a relative glob may be read from any folder: it is the sample's tail
  if (!anchored) {
    for (let k = 1; k < sample.length; k++) if (segmentsMatch(glob, sample.slice(k))) return true;
  }
  return false;
}

/** The sensitive row a glob in this command text could read, by its rule's
 * source (the name the verdict logs), or null. */
export function globKeyRead(text: string): string | null {
  if (!text || !GLOB_CHARS.test(text)) return null;
  for (const raw of text.split(/[\s;|&()<>,"'`‘-„]+/)) {
    const token = raw.replace(/^--?[\w-]+[:=]/, "");
    if (!GLOB_CHARS.test(token)) continue;
    const glob = homeForm(token).replace(/^(\.\/)+/, "").split("/").filter((segment, k) => segment !== "." || k === 0);
    // leading `..` steps reach a folder the reader cannot name: drop them, so the glob is read relative
    while (glob[0] === "..") glob.shift();
    if (!glob.length) continue;
    const last = glob[glob.length - 1]!;
    const extensionOnly = /^\*+(\.[^*?[\]/]+)?$/.test(last);
    for (const sample of KEY_SAMPLES) {
      if (!globCouldMatch(glob, sample.segments)) continue;
      // `*.json`, `*`: only in a folder that names a key folder (`~/.ssh/*.pem`)
      if (extensionOnly) {
        const folders = new Set(sample.segments.slice(0, -1).filter((segment) => segment !== "~" && segment !== "").map((segment) => segment.toLowerCase()));
        if (!glob.slice(0, -1).some((segment) => folders.has(segment.toLowerCase()))) continue;
      }
      return sample.re.source;
    }
  }
  return null;
}
