// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { win32Canonical } from "./in-project.ts";
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
export const KEY_SAMPLES: ReadonlyArray<{ re: RegExp; segments: string[] }> = SENSITIVE_PATHS.flatMap((row) =>
  row.read.map((rule) => {
    const sample = rule.replace(/^\*\*\//, "").replace(/\/\*\*$/, "/x").replace(/\*/g, "x");
    return { re: row.re, segments: sample.split("/") };
  }),
);

/** Where the bracket expression opened at `open` closes, as the shells read
 * it, or -1 when it does not (then the `[` is literal). */
function bracketEnd(segment: string, open: number): number {
  let at = open + 1;
  if (segment[at] === "!" || segment[at] === "^") at++;
  if (segment[at] === "]") at++;
  return segment.indexOf("]", at);
}

/** A closed bracket body that compiles exactly: only literal characters and
 * `a-z` ranges, with no leading `!` or `^`, no `]` member, no backslash and
 * no nested `[` (1.0.9, NOLIMITS-NODE-109-CUT section 5). The class it
 * spells, or null when it is not simple or JavaScript refuses it (`z-a`). */
function simpleClass(body: string): string | null {
  if (body === "" || /^[!^]/.test(body) || /[\]\\[]/.test(body)) return null;
  const esc = (c: string): string => (/[\\\]^\-[]/.test(c) ? `\\${c}` : c);
  let out = "";
  for (let k = 0; k < body.length; k++) {
    if (body[k + 1] === "-" && k + 2 < body.length) { out += `${esc(body[k]!)}-${esc(body[k + 2]!)}`; k += 2; }
    else out += esc(body[k]!);
  }
  try { new RegExp(`[${out}]`); } catch { return null; }
  return `[${out}]`;
}

/** Any one segment at all. */
const ANY_SEGMENT = /^[^/]*$/;

/** One glob segment as a pattern: `*`, `?` and `[…]` as the shells read them.
 *
 * 1.0.9 (Sean's log, 10-28: `L[i-1]` threw out of the approval listener;
 * Grok r1-r2 and Astra r4: `[^S]`, `[!]]`, `[!]x]` under case folding each
 * read narrower than bash). A bracket expression ends where the shells end
 * it (after an optional `!` or `^`, a first `]` is a member). A simple one
 * (`simpleClass`) compiles exactly, as 1.0.8 read it, so `[c][r][e]…` still
 * spells `credentials`; any other one (a negation, a `]` member, a POSIX
 * class, `[z-a]`) stands for any one character, a superset of whatever it
 * spells, in any case, valid or not. One holding a nested `[` (`[[:alpha:]]`)
 * ends where this scan cannot be sure: the rest of the segment is then
 * anything. An unclosed `[` is literal, as the shells read it; no key sample
 * holds a
 * bracket (asserted in its test), so it never matches one. It never throws. */
function segmentPattern(segment: string): { test(value: string): boolean } {
  // 1.0.18 (S10): each segment was compiled again for every key sample, 0.6 ms per glob on the server's one thread
  const known = SEGMENT_PATTERNS.get(segment);
  if (known) return known;
  const made = compiledSegment(segment);
  if (SEGMENT_PATTERNS.size >= SEGMENT_PATTERNS_MAX) SEGMENT_PATTERNS.clear();
  if (segment.length <= SEGMENT_PATTERN_MAX_CHARS) SEGMENT_PATTERNS.set(segment, made);
  return made;
}

const SEGMENT_PATTERNS = new Map<string, { test(value: string): boolean }>();
const SEGMENT_PATTERNS_MAX = 512;
const SEGMENT_PATTERN_MAX_CHARS = 256;

function compiledSegment(segment: string): { test(value: string): boolean } {
  // many wildcards in one segment make the pattern's work grow fast: past
  // this many it is any segment at all (a superset, never narrower)
  if ((segment.match(/[*?]/g)?.length ?? 0) > 16) return ANY_SEGMENT;
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") { if (!out.endsWith("[^/]*")) out += "[^/]*"; }
    else if (c === "?") out += "[^/]";
    else if (c === "[" && bracketEnd(segment, i) > i) {
      const end = bracketEnd(segment, i);
      const body = segment.slice(i + 1, end);
      if (body.includes("[")) { out += "[^/]*"; break; }
      // a simple class exactly, as 1.0.8 read it; any other one character
      out += simpleClass(body) ?? "[^/]";
      i = end;
    }
    else out += c.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  }
  // matched with and without case folding: the shells match by case, and a
  // case-insensitive disk makes `~/.AW?/credentials` the key too
  const exact = new RegExp(`^${out}$`);
  const folded = new RegExp(`^${out}$`, "i");
  return { test: (value) => exact.test(value) || folded.test(value) };
}

/** More `**` than this in one glob is read as could-match: the matcher's
 * work grows with each one (Astra r4: `**\/` 20,000 times). */
const MAX_GLOBSTARS = 8;
/** More different globs than this in one text are not read: each costs real time, and the text sets the count. */
const MAX_GLOBS_READ = 128;
/** A longer glob is not read: `*\/*\/*\/...` costs by its square. */
export const MAX_GLOB_CHARS = 1024;

// 1.0.18 (S10, MurageMain's ruling 11-07): one work budget per globKeyRead, linear in the text's length. Each segment match
// spends one unit; a read that spends it all stops and the text is held as a key read (fail closed, with a logged
// reason). It never passes.
// A unit is about 0.1 µs on the rig: 128 KiB of text buys about 60 ms, the base about 30 ms (128 everyday globs spend about
// half of it).
export const GLOB_WORK_PER_CHAR = 4;
export const GLOB_WORK_BASE = 1 << 18;
class GlobBudgetSpent extends Error {}
let globWorkLeft = Infinity;
/** Tests only: how many reads the budget stopped. */
export const globFailClosed = { count: 0 };
export const GLOB_BUDGET_REASON = "a glob that costs more to read than Murage spends could name a key file";

/** Do the glob's segments match the path's, `**` standing for any number of them? */
function segmentsMatch(glob: readonly string[], path: readonly string[]): boolean {
  return segmentsMatchAt(glob, 0, path, 0);
}
/** segmentsMatch on `glob` from `g` and `path` from `p` (indexes, not a slice per step). */
function segmentsMatchAt(glob: readonly string[], g: number, path: readonly string[], p: number): boolean {
  if (--globWorkLeft < 0) throw new GlobBudgetSpent();
  if (g === glob.length) return p === path.length;
  if (glob[g] === "**") {
    for (let k = p; k <= path.length; k++) if (segmentsMatchAt(glob, g + 1, path, k)) return true;
    return false;
  }
  return p < path.length && segmentPattern(glob[g]!).test(path[p]!) && segmentsMatchAt(glob, g + 1, path, p + 1);
}

// 1.0.9: any `[` a later `]` closes is a bracket expression (`[]s]`, `[!]x]`)
// 1.0.18 (S10): one forward scan, not `/[*?]|\[.*\]/`, which backtracks by the square of a run of `[` with no `]` (131,072 of them
// took the server's one thread about 15 s). Same answer: `*` or `?` anywhere, or a `[` with a `]` after it on the same line
// (`.` does not cross a line break: newline, carriage return, the line separator or the paragraph separator).
function hasGlobChars(text: string): boolean {
  let bracket = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x2a || c === 0x3f) return true;
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) { bracket = false; continue; }
    if (c === 0x5b) bracket = true;
    else if (c === 0x5d && bracket) return true;
  }
  return false;
}

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
  // 1.0.18 (S10): each tail by its index (a slice per tail cost the square of a long glob, outside the budget)
  if (!homeSample && sample[0] !== "") {
    for (let k = 0; k < glob.length; k++) if (segmentsMatchAt(glob, k, sample, 0)) return true;
    return false;
  }
  // a relative glob may be read from any folder: it is the sample's tail
  if (!anchored) {
    for (let k = 1; k < sample.length; k++) if (segmentsMatchAt(glob, 0, sample, k)) return true;
  }
  return false;
}

/** The sensitive row a glob in this command text could read, by its rule's
 * source (the name the verdict logs), or null. On Windows each token is read
 * in its Win32 canonical spelling (shared/in-project.ts win32Canonical), so
 * `\\?\C:\Users\me\.aw?\credentials` is the home glob it names. */
export function globKeyRead(text: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!text || !hasGlobChars(text)) return null;
  if (globWorkLeft !== Infinity) return globKeyReadWithin(text, platform);
  globWorkLeft = GLOB_WORK_PER_CHAR * text.length + GLOB_WORK_BASE;
  try {
    return globKeyReadWithin(text, platform);
  } catch (error) {
    if (!(error instanceof GlobBudgetSpent || error instanceof RangeError)) throw error;
    globFailClosed.count++;
    console.error(`sensitive-globs: ${error instanceof GlobBudgetSpent ? `work budget spent (${GLOB_WORK_PER_CHAR} per character)` : `RangeError: ${(error as Error).message}`} on a ${text.length}-character text; it is held as a key read`);
    return GLOB_BUDGET_REASON;
  } finally {
    globWorkLeft = Infinity;
  }
}

function globKeyReadWithin(text: string, platform: NodeJS.Platform): string | null {
  let globsRead = 0;
  for (const raw of new Set(text.split(/[\s;|&()<>,"'`‘-„]+/))) {
    // The prefix strip and canonical form never add glob syntax or length. Cap raw first: every canonical token then fits too.
    if (!hasGlobChars(raw)) continue;
    if (raw.length > MAX_GLOB_CHARS) return "a glob longer than Murage reads could name a key file";
    const token = win32Canonical(raw.replace(/^--?[\w-]+[:=]/, ""), platform);
    if (!hasGlobChars(token)) continue;
    // 1.0.18 (S10): this runs on the server's one thread and the text chooses how many there are. Past the budget it asks.
    if (++globsRead > MAX_GLOBS_READ) return "more globs than Murage reads could name a key file";
    const glob = homeForm(token).replace(/^(\.\/)+/, "").split("/").filter((segment, k) => segment !== "." || k === 0);
    // leading `..` steps reach a folder the reader cannot name: drop them, so the glob is read relative
    while (glob[0] === "..") glob.shift();
    // `**/**` is one `**`; past MAX_GLOBSTARS the glob could name anything
    for (let k = glob.length - 1; k > 0; k--) if (glob[k] === "**" && glob[k - 1] === "**") glob.splice(k, 1);
    if (glob.filter((segment) => segment === "**").length > MAX_GLOBSTARS) return "a glob too deep to read could name a key file";
    if (!glob.length) continue;
    const last = glob[glob.length - 1]!;
    // only `*` runs with an optional literal extension are generic (1.0.9,
    // section 5: decided on the raw segment, so a bracket-spelled name such
    // as `[c][r][e][d]…[s].json` is compared whole, as 1.0.8 did)
    const extensionOnly = /^\*+(\.[^*?[\]/]+)?$/.test(last);
    // 1.0.18: a run of wildcards in a key folder reads what `folder/*` reads, however many `?` it has (`~/.ssh/??????`
    // is `id_rsa`). Only against a sample whose `x` stands for any file; a named file is compared as written.
    const folderRun = glob.length > 1 && /^[*?]+$/.test(last) ? [...glob.slice(0, -1), "*"] : null;
    const namesFolder = (segments: readonly string[]): boolean => {
      const folders = new Set(segments.slice(0, -1).filter((segment) => segment !== "~" && segment !== "").map((segment) => segment.toLowerCase()));
      return glob.slice(0, -1).some((segment) => folders.has(segment.toLowerCase()));
    };
    for (const sample of KEY_SAMPLES) {
      if (folderRun && sample.segments[sample.segments.length - 1] === "x" && globCouldMatch(folderRun, sample.segments) && namesFolder(sample.segments)) return sample.re.source;
      if (!globCouldMatch(glob, sample.segments)) continue;
      // `*.json`, `*`: only in a folder that names a key folder (`~/.ssh/*.pem`)
      if (extensionOnly && !namesFolder(sample.segments)) continue;
      return sample.re.source;
    }
  }
  return null;
}
