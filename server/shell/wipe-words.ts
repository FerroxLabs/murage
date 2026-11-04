// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-WIPE-WORD (designs/NOLIMITS-MEANS-IT.md R3, R10, R11): one plain check over every byte of a text the
// reader could not follow. It finds a word from the reader's own delete, disk and mirror vocabulary (wipe-vocab.ts),
// a disk the reader's deviceInWord names, or a fork-bomb shape, wherever it sits. hiding.ts runs first (1.0.16). It reads, it never runs anything.
// The only caller is autoVerdictOf, on an owner-started No limits turn, on a hit marked readerFailed.

import { functionCallsFunction } from "./hiding.ts";
import { CMDS, POWERSHELLS } from "./pwsh.ts";
import { deviceInWord, PHYSICAL_DRIVE } from "./walk.ts";
import { CHECK_ONLY, CHECK_ONLY_WINDOWS, DELETE_FLAGS, DELETE_VERBS, DISK_DROP_VERBS, DISK_PREFIX, DISK_VERBS, MIRROR_WORDS, PROGRAM_SUFFIX, TOOL_FLAGS, WINDOWS_DELETE_ALIASES, WINDOWS_DISK_VERBS } from "./wipe-vocab.ts";

const EVERY = new Set<string>([...DELETE_VERBS, ...DISK_VERBS, ...DISK_DROP_VERBS, ...MIRROR_WORDS, ...CHECK_ONLY]);
const WINDOWS = new Set<string>([...WINDOWS_DELETE_ALIASES, ...WINDOWS_DISK_VERBS, ...CHECK_ONLY_WINDOWS]);
const FLAGS = new Set<string>(DELETE_FLAGS);
/** A drive standing alone or starting a path: `E:`, `C:\x`, `c:/x`. */
const DRIVE = /(?:^|[\s"'=(])[a-z]:(?:[\\/]|\s|$)|%[a-z_]+%/;
const SPAN = /\$'((?:[^'\\]|\\[\s\S])*)(?:'|$)/g;
const QUOTES = /\$?["\u201c\u201d]|['\u2018\u2019]/g;

const cp = (n: number): string => (n <= 0x10ffff ? String.fromCodePoint(n) : " ");
function numeric(t: string): string {
  return t
    .replace(/\\u\{([0-9a-f]{1,6})\}|`u\{([0-9a-f]{1,6})\}/gi, (_, a, b) => cp(parseInt(a ?? b, 16)))
    .replace(/\\U([0-9a-f]{1,8})/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{1,4})/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{1,2})/gi, (_, h) => cp(parseInt(h, 16)))
    // bash reads `\NNN` as one byte: `\562` is 0x72, `r` (Astra r1 H4)
    .replace(/\\([0-7]{1,3})/g, (_, o) => cp(parseInt(o, 8) & 0xff));
}
/** What bash makes of the inside of `$'…'`: every escape decoded, and the word ends at a NUL. */
function ansiC(body: string): string {
  const controls = body.replace(/\\c([\s\S])/g, (_, c: string) => cp(c.charCodeAt(0) & 0x1f));
  return numeric(controls).replace(/\\[abeEfnrtv]/g, " ").replace(/\\([\\'"?])/g, "$1").split("\0")[0]!;
}
/** Every reading of the text: a NUL dropped, a NUL as a break, a `$'…'` cut at its NUL; each escape character dropped or a space. */
export function variants(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, "").replace(/`(?:\r\n|\r|\n)/g, "");
  const decoded = numeric(joined);
  const bases = new Set([decoded.replace(/\0/g, ""), decoded.replace(/\0/g, " "), numeric(joined.replace(SPAN, (_, b: string) => ansiC(b))).replace(/\0/g, "")]);
  const out = new Set<string>();
  for (const base of bases) for (const bs of ["", " "]) for (const bt of ["", " "]) for (const ct of ["", " "]) for (const qt of ["", " "]) {
    out.add(base.replace(/\\/g, bs).replace(/`/g, bt).replace(/\^/g, ct).replace(/[\r\n]/g, " ").replace(QUOTES, qt).normalize("NFKC"));
  }
  return [...out];
}
/** The reader's own `deviceInWord`, on each piece a shell would split, as written and with a value after `/dev/` read as a device. */
/** A path glob whose leading folder could expand to `/dev` (`/de[v]/sda`, `/d?v/sda`, a star in place of dev) (Astra r2 H1). */
function globDevice(piece: string): boolean {
  const m = /^(?:[\w-]*=)?\/+(?:\.\/+)*([^/]*[[?*][^/]*)\/./.exec(piece);
  if (!m) return false;
  let glob = "", asBefore = "";
  // `!` and `^` both negate a bracket class (`/[^x]ev/sda`); outside a class `^` is a plain character (Astra r2 H1)
  let inClass = false;
  for (const ch of m[1]!) {
    const wasClass = inClass;
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    glob += ch === "*" ? ".*" : ch === "?" ? "." : ch === "!" || (ch === "^" && wasClass) ? "^" : ch === "[" || ch === "]" || /[\w-]/.test(ch) ? ch : "\\" + ch;
    asBefore += ch === "*" ? ".*" : ch === "?" ? "." : ch === "!" ? "^" : ch === "[" || ch === "]" || /[\w-]/.test(ch) ? ch : "\\" + ch;
  }
  // MurageMain re-scope (no regression): a folder the 1.0.15 reading took for a disk still counts as one
  try { return new RegExp("^" + glob + "$").test("dev") || new RegExp("^" + asBefore + "$").test("dev"); } catch { return true; }
}
function deviceIn(v: string): boolean {
  for (const piece of v.split(/[\s;|&(){}<>,]+|:[-=+?]/)) {
    if (globDevice(piece)) return true;
    if (!piece.includes("/dev/") && !/physicaldrive|[\\/]{2}[.?][\\/]/i.test(piece)) continue;
    // a variable before `/dev/` may be empty (`$D/dev/sda`): read it as gone (design NOLIMITS-UNREADABLE R3 DISK)
    if (deviceInWord(piece.replace(/\$\{?\w+\}?(?=\/dev\/)/g, "").replace(/\/dev\/[$%\x60].*$/, "/dev/x")) !== undefined) return true;
  }
  return false;
}
/** `:|:`, `$0` piped or sent to the background, or a function that calls a function defined in this text (itself or
 * another) with a pipe or a lone `&` in its body: every fork-bomb shape forkBombShape (walk.ts) holds, self and mutual
 * recursion, read over the whole text with no length cap (GrokBuild r1 H2, Astra r1 H3). */
function forkIn(v: string): boolean {
  const flat = v.replace(/\s+/g, "");
  if (flat.includes(":|:") || /\$0[|&]/.test(flat)) return true;
  return /\||(?<!&)&(?!&)/.test(v) && functionCallsFunction(v);
}
export interface WipeWord { word: string; kind: "delete" | "disk" | "mirror" | "fork" }
const kindOf = (w: string): WipeWord["kind"] => (w.startsWith(DISK_PREFIX) || (DISK_VERBS as readonly string[]).includes(w) || (DISK_DROP_VERBS as readonly string[]).includes(w) || w === "format" ? "disk"
  : w === "-delete" ? "delete" : w.startsWith("-") || (MIRROR_WORDS as readonly string[]).includes(w) || w === "robocopy" || w === "rsync" || w === "mc" ? "mirror" : "delete");
export function wipeWordIn(text: string, dialect?: "pwsh"): WipeWord | null {
  const vs = variants(text);
  const lower = vs.map((v) => v.toLowerCase());
  const tokens = lower.map((v) => v.split(/[^a-z0-9._-]+/).filter(Boolean));
  const windows = dialect === "pwsh" || tokens.some((ts) => ts.some((t) => POWERSHELLS.has(t) || CMDS.has(t))) || lower.some((v) => DRIVE.test(v));
  for (const [i, ts] of tokens.entries()) {
    for (const t of ts) {
      const base = t.replace(PROGRAM_SUFFIX, "");
      if (EVERY.has(base) || FLAGS.has(t) || base.startsWith(DISK_PREFIX)) return { word: base, kind: kindOf(base) };
      if (WINDOWS.has(base) && (windows || base !== t)) return { word: base, kind: kindOf(base) };
      if (/physicaldrive\d/.test(t)) return { word: "a disk", kind: "disk" };
    }
    for (const [tool, flag] of TOOL_FLAGS) if (ts.some((t) => t.replace(PROGRAM_SUFFIX, "") === tool) && ts.some((t) => flag.test(t))) return { word: tool, kind: "mirror" };
    if (deviceIn(vs[i]!)) return { word: "a disk", kind: "disk" };
    if (forkIn(lower[i]!)) return { word: "fork", kind: "fork" };
  }
  const written = text.replace(/["'\u201c\u201d\u2018\u2019]/g, "");
  if (deviceIn(written) || PHYSICAL_DRIVE.test(written)) return { word: "a disk", kind: "disk" };
  return null;
}
