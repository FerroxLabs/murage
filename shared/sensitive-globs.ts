// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DATA_CREDENTIAL_ENTRIES } from "./data-credential-paths.ts";
import { win32Canonical } from "./in-project.ts";
import { SENSITIVE_PATHS } from "./sensitive-paths.ts";

// 1.0.4 (09-1 Low): a glob that could match a key file is a read of it.
//
// `cat ~/.aw?/credentials` and `Get-Content ~\.aws\cred*` name no key file
// in so many letters, so the rows above never see them. Every path row's
// Read spellings are intersected with the command glob, retaining their
// wildcards. Both literal and glob checks therefore read SENSITIVE_PATHS.
// Relative globs can match a home rule's tail; unanchored rules can match
// the command glob's tail.
//
// Limits, on purpose: a glob of wildcards only (`*`, `*.*`) or a wildcard
// and an extension (`*.json`, `*.pem`) in a folder that names no key folder
// is not read as a key read, or every `prettier "**/*.json"` would hold. A
// hard link to a key file under an ordinary name cannot be told from any
// other file by its path at all: the key guard reads names and where
// symbolic links land (server/auto-approve.ts realKeyPaths), never inodes.

/** Legacy bracket-regression fixtures only; never used for the decision. */
export const KEY_SAMPLES: ReadonlyArray<{ re: RegExp; segments: string[] }> = SENSITIVE_PATHS.flatMap((row) =>
  row.read.map((rule) => {
    const sample = rule.replace(/^\*\*\//, "").replace(/\/\*\*$/, "/x").replace(/\*/g, "x");
    return { re: row.re, segments: sample.split("/") };
  }),
);

/** Internal glob spelling: NUL quotes a literal metacharacter (and itself).
 * Decode literal segments before filesystem calls; actual names cannot contain NUL. */
export function literalGlobPattern(text: string, brackets = true): string {
  return text.replace(brackets ? /[\0*?[\]]/g : /[\0*?]/g, char => "\0" + char);
}
export function globPatternText(pattern: string): string {
  return pattern.replace(/\0([\s\S])/g, "$1");
}

/** Where the bracket expression opened at `open` closes, as the shells read
 * it, or -1 when it does not (then the `[` is literal). */
function bracketEnd(segment: string, open: number): number {
  let at = open + 1;
  if (segment[at] === "!" || segment[at] === "^") at++;
  if (segment[at] === "]") at++;
  for (; at < segment.length; at++) {
    if (segment[at] === "\0") { at++; continue; }
    if (segment[at] === "]") return at;
  }
  return -1;
}

/** A closed bracket body that compiles exactly: only literal characters and
 * `a-z` ranges, with no leading `!` or `^`, no `]` member, no backslash and
 * no nested `[` (1.0.9, NOLIMITS-NODE-109-CUT section 5). The class it
 * spells, or null when it is not simple or JavaScript refuses it (`z-a`). */
function simpleClass(body: string): string | null {
  if (body.includes("\0") || body === "" || /^[!^]/.test(body) || /[\]\\[]/.test(body)) return null;
  const esc = (c: string): string => (/[\\\]^\-[]/.test(c) ? `\\${c}` : c);
  let out = "";
  for (let k = 0; k < body.length; k++) {
    if (body[k + 1] === "-" && k + 2 < body.length) { out += `${esc(body[k]!)}-${esc(body[k + 2]!)}`; k += 2; }
    else out += esc(body[k]!);
  }
  try { new RegExp(`[${out}]`); } catch { return null; }
  return `[${out}]`;
}

/** A bracket body with any non-ASCII member is read as matching ANY
 * character (fail closed, MAIN 2026-11-17T08:33Z): the readers below compare
 * classes over ASCII, so `[é]` would otherwise match nothing and skip
 * `/work/é/credentials.json`. */
function nonAsciiClass(body: string): boolean {
  return /[^\x00-\x7f]/.test(body);
}

/** More `**` than this in one glob is read as could-match: the matcher's
 * work grows with each one (Astra r4: `**\/` 20,000 times). */
const MAX_GLOBSTARS = 8;

// 1.0.9: any `[` a later `]` closes is a bracket expression (`[]s]`, `[!]x]`)
const GLOB_CHARS = /[*?]|\[.*\]/;

/** A path token with its home spelled `~` and its separators `/`. */
export function homeForm(token: string, platform: NodeJS.Platform = process.platform, home?: string): string {
  if (home && (token === home || token.startsWith(home.replace(/\/$/, "") + "/"))) token = "~" + token.slice(home.replace(/\/$/, "").length);
  return token
    .replace(/^\$(?:\{(GROK_HOME|KIMI_CODE_HOME|HERMES_HOME|OPENCODE_CONFIG_DIR|XDG_CONFIG_HOME)\}|(GROK_HOME|KIMI_CODE_HOME|HERMES_HOME|OPENCODE_CONFIG_DIR|XDG_CONFIG_HOME))(?=[\\/]|$)/, (_all, braced: string, plain: string) => ({ GROK_HOME: "~/.grok", KIMI_CODE_HOME: "~/.kimi-code", HERMES_HOME: "~/.hermes", OPENCODE_CONFIG_DIR: "~/.config/opencode", XDG_CONFIG_HOME: "~/.config" }[braced || plain] ?? _all))
    .replace(/\\/g, "/")
    .replace(/^(\$\{(?:env:)?HOME\}|\$HOME|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=\/|$)/i, "~")
    .replace(/^(?:[a-z]:|\/\/[^/]+)\/.*?users\/[^/]+(?=\/|$)/i, "~")
    .replace(/^~[^/]+(?=\/)/, "~")
    .replace(platform === "darwin" ? /^\/var\/root(?=\/|$)/ : /$^/, "~")
    .replace(/^\/(users|home)\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/root(?=\/|$)/, "~");
}

/** A tail segment of stars, or stars with one literal extension (`*.pem`), names no file by itself: a relative glob is not read as the tail of a row through it. */
const GENERIC_TAIL = /^\*+(\.[^*?[\]/]+)?$/;

/** Pin a row's leading name-prefix wildcard; extension and whole-star globs retain their meaning. */
function rowReadSegment(segment: string): string {
  return /^\*[a-z]/i.test(segment) ? "x" + segment.slice(1) : segment;
}

/** Intersect a command glob with a read spelling, retaining tail semantics. */
function globCouldMatch(glob: string[], pattern: string[], match = pathGlobsIntersect): boolean {
  const homeGlob = glob[0] === "~";
  const homePattern = pattern[0] === "~";
  const anchored = glob[0] === "" || homeGlob;
  if (anchored && (homePattern || pattern[0] === "")) return match(glob, pattern);
  // the pattern may sit anywhere: the glob's tail is the pattern
  if (!homePattern && pattern[0] !== "") {
    if (!anchored && !pattern.some(segment => !GENERIC_TAIL.test(segment))) return false;
    for (let k = 0; k < glob.length; k++) if (match(glob.slice(k), pattern)) return true;
    return false;
  }
  // a relative glob may be read from any folder: it is the pattern's tail
  if (!anchored) {
    for (let k = 1; k < pattern.length; k++) {
      const tail = pattern.slice(k);
      if (tail.some(segment => !GENERIC_TAIL.test(segment)) && match(glob, tail)) return true;
    }
  }
  return false;
}

/** Additional cd reads never replace the original command judgement. */
export function cdOperands(text: string): string[] {
  const operands: string[] = [];
  // Retain the old command scan (including commands inside shell payloads),
  // but read complete, dequoted words after each folder-changing construct.
  const commands = /(?:^|[\s;&|()])(?:(?:builtin\s+|command\s+)?(?:cd|pushd|Push-Location|Set-Location|sl|chdir)\s+|env\s+-C\s+|sudo\s+-D\s+|(?:--chdir|-WorkingDirectory)(?:=|\s+))/gi;
  const option = /^(?:-P|-L|-e|--|-n|\/d|-Path|-LiteralPath|-PSPath)$/i;
  for (const match of text.matchAll(commands)) {
    const rest = text.slice(match.index! + match[0].length);
    const words = rest.match(/^(?:(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()"'])+\s*)+/)?.[0]
      .match(/(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()"'])+/g) ?? [];
    for (const raw of words) {
      // Strip quotes only; retain substitution markers for the union's unknown rule.
      const word = raw.replace(/"([^"\n]*)"|'([^'\n]*)'/g,
        (_quoted, double: string | undefined, single: string | undefined) => double ?? single ?? "");
      if (option.test(word)) continue;
      if (word) operands.push(word);
      break;
    }
  }
  return operands;
}

export function placedGlobs(text: string, cwd: string, platform: NodeJS.Platform = process.platform, home?: string): string[] {
  return text.split(/[\s;|&()<>,"'`‘-„]+/).filter(token => GLOB_CHARS.test(token) && !/^(?:[\\/]|~|\$|%|[a-z]:)/i.test(token))
    .map(token => homeForm(cwd, platform, home).replace(/[\\/]$/, "") + "/" + token);
}

/** Bounded possible shell folders, retained only for the lifetime of a thread.
 * X3 r5 section 5 with rev 3.2 sections 2-3: at most 32 resolved places
 * (`targets`), at most 32 pending ABSENT lexical places of at most 4,096
 * bytes each (`pending`), and the flags `unknown`, `capped` (an overflow
 * episode), `kShown` (that episode's one K card was shown) and `dotglob`. */
export interface ShellCwdState { targets: Map<string, string>; unknown?: string; pending?: string[]; capped?: boolean; kShown?: boolean; dotglob?: boolean;
  /** On a P1 replacement only: its last cd was absolute (or `~/` with the handed HOME), so committing it installs an exact cwd (S-b). */
  install?: boolean }
export const SHELL_MAX_PLACES = 32;
export const SHELL_OVERFLOW_REASON = "this session has used more than 32 folders";
/** S3': any overflow (a 33rd place or a 33rd pending entry) makes the record
 * unknown and capped and empties both lists. No folder check decides
 * admission. A new episode (not already capped) gets a fresh K card. */
export function shellOverflow(state: ShellCwdState): void {
  if (!state.capped) state.kShown = false;
  state.capped = true;
  state.unknown = SHELL_OVERFLOW_REASON;
  state.targets.clear();
  state.pending = [];
}
/** S-a: places only grow, as a union; only an overflow empties them. */
export function admitShellPlace(state: ShellCwdState, path: string, reason: string): void {
  if (state.targets.has(path)) return;
  if (state.targets.size >= SHELL_MAX_PLACES) { shellOverflow(state); return; }
  state.targets.set(path, reason);
}
export const SHELL_MAX_PENDING = 32, SHELL_MAX_PENDING_BYTES = 4096;
/** P2: an ABSENT target is a pending lexical place, not a place and not unknown. */
export function admitShellPending(state: ShellCwdState, path: string, reason: string): void {
  if (Buffer.byteLength(path) > SHELL_MAX_PENDING_BYTES) { state.unknown ??= reason; return; }
  const pending = state.pending ??= [];
  if (pending.includes(path)) return;
  if (pending.length >= SHELL_MAX_PENDING) { shellOverflow(state); return; }
  pending.push(path);
}
/** S-a/S-b: `record` with `add`'s effects UNIONED in. Places and pending only
 * grow (an overflow on either side empties them and sets unknown and capped);
 * `unknown` is kept if either side has it (a union never clears it; only an
 * installing P1 commit does, in the registry). */
export function unionShellState(record: ShellCwdState, add: ShellCwdState): ShellCwdState {
  const next = copyShellCwdState(record);
  delete next.install;
  if (add.capped && !next.capped) shellOverflow(next);
  if (add.capped && add.kShown && next.capped) next.kShown = true;
  for (const [path, reason] of add.targets) admitShellPlace(next, path, reason);
  for (const path of add.pending ?? []) admitShellPending(next, path, `shell folder ${path.slice(0, 256)} cannot be proven`);
  if (add.unknown) next.unknown ??= add.unknown;
  if (add.dotglob) next.dotglob = true;
  return next;
}
/** A detached copy: no caller ever shares a record's live containers. */
export function copyShellCwdState(state: ShellCwdState): ShellCwdState {
  return {
    targets: new Map(state.targets),
    ...(state.unknown ? { unknown: state.unknown } : {}),
    ...(state.pending?.length ? { pending: [...state.pending] } : {}),
    ...(state.capped ? { capped: true } : {}),
    ...(state.kShown ? { kShown: true } : {}),
    ...(state.dotglob ? { dotglob: true } : {}),
    ...(state.install ? { install: true } : {}),
  };
}
export type ShellCwdByThread = Map<string, ShellCwdState>;

export function rememberShellCwds(states: ShellCwdByThread, threadId: string, text: string, cwd?: string, platform: NodeJS.Platform = process.platform, home?: string): void {
  const effects = shellDirectoryEffects(text).filter(effect => effect.scope === "parent");
  if (!effects.length) return;
  let state = states.get(threadId);
  if (!state) { state = { targets: new Map() }; states.set(threadId, state); }
  for (const effect of effects) {
    const operand = effect.operand ?? effect.command;
    const reason = `earlier cd/pushd/Set-Location/sl/chdir ${operand.slice(0, 256)}`;
    if (effect.kind !== "filesystem" || effect.flags.includes("-P") || unresolvedShellParent(operand) || /[$`]|%[^%]+%|^~-|^-$/.test(operand) || GLOB_CHARS.test(operand)) {
      state.unknown ??= reason;
      continue;
    }
    let target = win32Canonical(operand, platform).replace(/\\/g, "/");
    if (!/^(?:\/|~|[a-z]:)/i.test(target)) {
      if (!cwd) { state.unknown ??= reason; continue; }
      target = cwd.replace(/\\/g, "/").replace(/\/$/, "") + "/" + target;
    }
    // Resolve dot steps before home normalization, including a relative cd .. .
    const parts: string[] = [];
    for (const part of target.split("/")) {
      if (part === ".") continue;
      if (part === ".." && parts.length > 1) parts.pop();
      else if (part !== "..") parts.push(part);
    }
    target = homeForm(parts.join("/"), platform, home);
    if (state.targets.has(target)) continue;
    if (state.targets.size >= 32) { state.unknown ??= reason; continue; }
    state.targets.set(target, reason);
  }
}

/** Unknown shell folders add only anchored rows with a file-bearing last segment. */
export function unknownShellGlobRead(text: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const joined of placedGlobs(text, "~", platform)) {
    const last = win32Canonical(joined, platform).replace(/\\/g, "/").split("/").at(-1)!;
    if (!last) continue;
    for (const row of SENSITIVE_PATHS) for (const read of row.read) {
      if (!/^(?:~\/|\/|[a-z]:\/)/i.test(read)) continue;
      const tail = read.split("/").at(-1)!;
      if (pathGlobsIntersect([last], [tail])) return row.re.source;
    }
  }
  return null;
}

/** The sensitive row a glob in this command text could read, by its rule's
 * source (the name the verdict logs), or null. On Windows each token is read
 * in its Win32 canonical spelling (shared/in-project.ts win32Canonical), so
 * `\\?\C:\Users\me\.aw?\credentials` is the home glob it names. */
export function globKeyRead(text: string, platform: NodeJS.Platform = process.platform, includeTextFallback = true): string | null {
  if (shellDirectoryEffects(text).some(effect => effect.flags.includes("-P"))) {
    const unknown = unknownShellGlobRead(text, platform);
    if (unknown) return unknown;
  }
  const original = globKeyReadCandidate(text, platform, includeTextFallback);
  if (original) return original;
  for (const operand of cdOperands(text)) {
    const folder = cdFolderGlobRead(operand, platform);
    if (folder) return folder;
    if (!GLOB_CHARS.test(operand)) for (const joined of placedGlobs(text, operand, platform)) {
      const hit = globKeyReadCandidate(joined, platform);
      if (hit) return hit;
    }
  }
  return null;
}

/** A directory operand also reads its children, including a glob-named directory. */
function cdFolderGlobRead(operand: string, platform: NodeJS.Platform): string | null {
  const direct = globKeyReadCandidate(operand.replace(/[\\/]$/, "") + "/*", platform, true, false);
  if (direct || !GLOB_CHARS.test(operand)) return direct;
  const glob = homeForm(win32Canonical(operand, platform), platform).replace(/[\\/]$/, "").split("/");
  glob.push("*");
  for (const row of SENSITIVE_PATHS) for (const read of row.read) {
    const pattern = read.replace(/^\*\*\//, "").split("/").map(rowReadSegment);
    if (pattern.at(-1) === "**") pattern.splice(-1, 1, "*", "**");
    if (globCouldMatch(glob, pattern)) return row.re.source;
  }
  return null;
}

function globKeyReadCandidate(text: string, platform: NodeJS.Platform, includeTextFallback = true, anchoredFolderExemption = true): string | null {
  if (!text || !GLOB_CHARS.test(text)) return null;
  for (const raw of text.split(/[\s;|&()<>,"'`‘-„]+/)) {
    const token = win32Canonical(raw.replace(/^--?[\w-]+[:=]/, ""), platform);
    if (!GLOB_CHARS.test(token)) continue;
    const glob = homeForm(token, platform).replace(/^(\.\/)+/, "").split("/").filter((segment, k) => segment !== "." || k === 0);
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
    for (const row of SENSITIVE_PATHS) for (const read of row.read) {
      const pattern = { re: row.re, segments: read.replace(/^\*\*\//, "").split("/").map(rowReadSegment) };
      // Entries denote files: a terminal globstar needs at least one child.
      if (pattern.segments.at(-1) === "**") pattern.segments.splice(-1, 1, "*", "**");
      const anchored = anchoredFolderExemption && (glob[0] === "~" || glob[0] === "") && (pattern.segments[0] === "~" || pattern.segments[0] === "");
      if (!globCouldMatch(glob, pattern.segments, (a, b) => alignedPathIntersection(a, b, 0, extensionOnly && (!anchored || /^\*+$/.test(last))))) continue;
      return pattern.re.source;
    }
    if (!includeTextFallback) continue;
    // Add-only second pass: the original pinned-row verdict always wins.
    for (const row of SENSITIVE_PATHS) for (const read of row.read) {
      const segments = read.replace(/^\*\*\//, "").split("/");
      const pinned = segments.filter(segment => rowReadSegment(segment) !== segment);
      if (!pinned.length) continue;
      if (segments.at(-1) === "**") segments.splice(-1, 1, "*", "**");
      const anchored = anchoredFolderExemption && (glob[0] === "~" || glob[0] === "") && (segments[0] === "~" || segments[0] === "");
      if (!globCouldMatch(glob, segments, (a, b) => alignedPathIntersection(a, b, 4, extensionOnly && (!anchored || /^\*+$/.test(last))))) continue;
      return row.re.source;
    }
  }
  return null;
}

/** Character alphabets at each position of a credential family segment. */
export type FamilySegment = readonly string[];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const DIGITS = "0123456789";
const literal = (value: string): FamilySegment => [...value];
const repeated = (alphabet: string, count: number): string[] => Array.from({ length: count }, () => alphabet);
const randomFolder = (prefix: string): FamilySegment => [...literal(prefix), ...repeated(ALNUM, 6)];
const hashFile = (length: number, suffix: string): FamilySegment => [...repeated(HEX, length), ...literal(suffix)];

/** A bounded dynamic program, independent of any particular random sample. */
export function segmentsIntersect(glob: string, family: FamilySegment): boolean {
  if (glob.length > 4096 || family.length > 4096) return true;
  // a root spelled with non-ASCII (`/home/josé`) under a wildcard: read it in every locale
  if (hasWildcard(glob) && family.some(alphabet => [...alphabet].length === 1 && /[^\x00-\x7f]/.test(alphabet))) {
    const spelled = family.map(alphabet => [...alphabet].length === 1 ? literalGlobPattern(alphabet) : /^[A-Za-z0-9]+$/.test(alphabet) ? `[${alphabet}]` : "?").join("");
    return patternIntersection(glob, spelled);
  }
  type Token = "*" | { test: (char: string) => boolean };
  const tokens: Token[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") { tokens.push("*"); continue; }
    if (c === "?") { tokens.push({ test: () => true }); continue; }
    if (c === "[" && bracketEnd(glob, i) > i) {
      const end = bracketEnd(glob, i), body = glob.slice(i + 1, end);
      if (body.includes("[")) { tokens.push("*"); break; }
      const pattern = nonAsciiClass(body) ? null : simpleClass(body);
      const re = pattern ? new RegExp("^" + pattern + "$", "i") : undefined;
      tokens.push({ test: char => re ? re.test(char) : true });
      i = end;
    } else tokens.push({ test: char => char.toLowerCase() === c.toLowerCase() });
  }
  let reachable = new Uint8Array(family.length + 1); reachable[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(family.length + 1);
    for (let j = 0; j <= family.length; j++) {
      if (token === "*") next[j] = reachable[j]! || (j > 0 ? next[j - 1]! : 0);
      else if (j > 0 && reachable[j - 1] && [...family[j - 1]!].some(token.test)) next[j] = 1;
    }
    reachable = next;
  }
  return Boolean(reachable[family.length]);
}

type FamilyPath = readonly (FamilySegment | "**")[];
export interface CredentialFamily { id: string; root: "temp" | "data" | "backup" | "cloud"; segments: FamilyPath }
const uuid: FamilySegment = [..."xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"].map(c => c === "x" ? HEX : c);
const atomic = (base: FamilySegment): FamilySegment[] => Array.from({ length: 10 }, (_, i) => [...base, ".", ...repeated(DIGITS, i + 1), ".", ...uuid, ...literal(".tmp")]);
const files = (id: string, root: CredentialFamily["root"], parent: FamilyPath, leaves: FamilySegment[]): CredentialFamily[] => leaves.map(leaf => ({ id, root, segments: [...parent, leaf] }));

export const CREDENTIAL_FAMILIES: readonly CredentialFamily[] = [
  ...files("murage-cred", "temp", [randomFolder("murage-cred-")], [hashFile(32, ".json"), hashFile(32, ".json.tmp")]),
  ...files("murage-mcp", "temp", [randomFolder("murage-mcp-")], [literal("mcp.json")]),
  ...files("murage-pi-mcp", "temp", [randomFolder("murage-pi-mcp-")], [literal("mcp.json")]),
  ...files("murage-copilot-mcp", "temp", [randomFolder("murage-copilot-mcp-")], [hashFile(64, ".json"), ...atomic(hashFile(64, ".json"))]),
  ...files("murage-claude-private", "data", [literal("claude-private")], [hashFile(32, ".json"), ...Array.from({ length: 10 }, (_, i) => [...hashFile(32, ".json.new-"), ...repeated(DIGITS, i + 1)])]),
  ...files("murage-flux-hermes", "data", [literal("flux-hermes-home")], [literal("config.yaml"), ...atomic(literal("config.yaml"))]),
  ...files("murage-flux-hermes", "cloud", [literal("flux-hermes-home")], [literal("config.yaml"), ...atomic(literal("config.yaml"))]),
  ...files("murage-hook-env", "data", [literal("native"), "**", literal("hook-env")], Array.from({ length: 10 }, (_, i) => [...repeated(DIGITS, i + 1), "-", ...hashFile(16, ".env")])),
  ...files("murage-exec", "temp", [randomFolder("murage-exec-"), literal("env")], [hashFile(24, ""), ...Array.from({ length: 10 }, (_, i) => [...hashFile(24, "."), ...repeated(DIGITS, i + 1), ".", ...repeated(HEX, 8)])]),
  ...files("murage-exec", "temp", [randomFolder("murage-exec-")], [[...literal("murage-exec-"), ...repeated(HEX, 16)]]),
  ...files("murage-render", "temp", [[...literal("murage-render-"), ...repeated(HEX, 16)]], [literal("mcp.json")]),
  ...files("murage-engine-signin", "temp", [randomFolder("murage-engine-signin-")], [literal("Sign in.command")]),
  ...files("murage-provider-turn", "data", [literal("native"), literal("provider-turns"), randomFolder("hermesAgent-")], [literal("config.yaml")]),
  ...files("murage-backup-ssh", "backup", [randomFolder("ssh-")], [literal("key")]),
];

function familyMatch(glob: readonly string[], path: FamilyPath): boolean {
  const seen = new Set<string>();
  const visit = (g: number, p: number): boolean => {
    const key = g + ":" + p;
    if (seen.has(key)) return false;
    seen.add(key);
    if (g === glob.length && p === path.length) return true;
    if (glob[g] === "**") {
      if (visit(g + 1, p)) return true;
      if (p < path.length && visit(g, p + 1)) return true;
    }
    if (path[p] === "**") {
      if (visit(g, p + 1)) return true;
      if (g < glob.length && glob[g] !== "" && visit(g + 1, p)) return true;
    }
    return g < glob.length && p < path.length && path[p] !== "**" && glob[g] !== "**"
      && segmentsIntersect(glob[g]!, path[p] as FamilySegment) && visit(g + 1, p + 1);
  };
  return visit(0, 0);
}

export interface CredentialRoots { temp: readonly string[]; data?: readonly string[]; backup?: readonly string[]; cloud?: readonly string[]; home?: string }
export interface CredentialGlobOptions { runtime?: readonly { root: string; entries: readonly string[] }[]; platform?: NodeJS.Platform; roots: CredentialRoots }
export function credentialFamilyRule(id: string): string { return SENSITIVE_PATHS.find(row => row.id === id)?.re.source ?? "credential-family:" + id; }

/** Input words retain quoted spaces. No whitespace split is performed here. */
export function credentialGlobHit(words: readonly string[], options: CredentialGlobOptions): string | null {
  const platform = options.platform ?? process.platform;
  const roots = options.roots;
  for (const raw of words) {
    if (!GLOB_CHARS.test(raw)) continue;
    if (raw === "\u0001credential-glob-overflow*") return credentialFamilyRule("murage-cred");
    let word = raw.replace(/\\/g, "/")
      .replace(/^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP)|%(?:TEMP|TMP)%)(?=\/|$)/i, roots.temp[0] ?? "/tmp")
      .replace(/^(?:\$\{MURAGE_DATA_DIR\}|\$MURAGE_DATA_DIR)(?=\/|$)/, roots.data?.[0] ?? "~/.murage")
      .replace(/^(?:~|\$\{(?:env:)?(?:HOME|USERPROFILE)\}|\$(?:env:)?(?:HOME|USERPROFILE)|%USERPROFILE%)(?=\/|$)/i, roots.home ?? "~");
    if (platform === "win32") word = word.replace(/^\/([a-z])\//i, "$1:/");
    word = win32Canonical(word, platform).replace(/\\/g, "/");
    const normalized = word.replace(/\/\.(?=\/)/g, "").replace(/\/{2,}/g, "/");
    const variants = [normalized];
    if (normalized.includes("/../")) {
      let collapsed = normalized;
      for (let i = 0; i < 16; i++) { const next = collapsed.replace(/[^/]+\/\.\.\//g, ""); if (next === collapsed) break; collapsed = next; }
      variants.push(collapsed, normalized.replace(/[^/]+\/\.\.\//g, "*/"));
    }
    for (const token of variants) {
      if (/^\/\*{1,2}\/?$/.test(token)) continue;
      const anchored = /^(?:\/|[a-z]:\/|~\/)/i.test(token);
      const glob = token.split("/");
      if (!anchored && !glob[0]?.includes("murage-")) continue;
      if (glob.filter(segment => segment === "**").length > MAX_GLOBSTARS) return credentialFamilyRule("murage-cred");
      if (anchored && glob.at(-1) !== "") for (const root of roots.data ?? []) {
        const prefix = root.replace(/\\/g, "/").replace(/\/$/, "").split("/");
        for (const entry of DATA_CREDENTIAL_ENTRIES) {
          if (entry === "native/**") {
            const relative = glob.slice(prefix.length);
            if (relative[0] === "native" && (relative[1] === "fuigo-turn-logs" || (relative.length === 2 && relative[1]?.endsWith(".ndjson")))) continue;
          }
          // Entries denote files: a terminal globstar needs at least one child.
          const segments = entry.split("/");
          if (segments.at(-1) === "**") segments.splice(-1, 1, "*", "**");
          if (pathGlobsIntersect(glob, [...prefix, ...segments])) return "murage-data-credentials:" + entry;
        }
      }
      if (anchored && glob.at(-1) !== "") for (const { root, entries } of options.runtime ?? []) {
        const prefix = root.replace(/\\/g, "/").replace(/\/$/, "").split("/");
        for (const entry of entries) {
          // Entries denote files: a terminal globstar needs at least one child.
          const segments = entry.split("/");
          if (segments.at(-1) === "**") segments.splice(-1, 1, "*", "**");
          if (pathGlobsIntersect(glob, [...prefix, ...segments])) return "murage-data-credentials:" + entry;
        }
      }
      for (const family of CREDENTIAL_FAMILIES) {
        for (const root of roots[family.root] ?? []) {
          const parent = root.replace(/\\/g, "/").replace(/\/$/, "").split("/").map(literal);
          if (family.root === "temp" && glob.at(-1)?.includes("murage-") && GLOB_CHARS.test(glob.at(-1)!)) {
            if ((!anchored && glob.length === 1) || (anchored && familyMatch(glob.slice(0, -1), parent))) return credentialFamilyRule(family.id);
          }
          if (familyMatch(glob, anchored ? [...parent, ...family.segments] : family.segments)) return credentialFamilyRule(family.id);
        }
      }
    }
  }
  return null;
}

/** PowerShell expands wildcards in quoted arguments too. */
export function powershellGlobWords(text: string): string[] {
  const words: string[] = []; let word = "", quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c.charCodeAt(0) === 96 && i + 1 < text.length) { word += text[++i]; continue; }
    if (quote) { if (c === quote) { if (text[i + 1] === quote) { word += c; i++; } else quote = ""; } else word += c; }
    else if (c === "'" || c === '"') quote = c;
    else if (/[\s;|&()<>]/.test(c)) { if (word) words.push(word); word = ""; }
    else word += c;
  }
  if (word) words.push(word);
  return words;
}

/** A `*`, `?` or closed bracket expression the shells would expand (a
 * NUL-quoted metacharacter is literal). */
function hasWildcard(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "\0") { i++; continue; }
    if (c === "*" || c === "?" || (c === "[" && bracketEnd(segment, i) > i)) return true;
  }
  return false;
}

/** The fewest and most bytes a decoded name character stood for. A U+FFFD
 * (or a lone surrogate) is what a lossy decode left of 1..3 unknown bytes. */
function charBytes(c: string): [number, number] {
  const code = c.codePointAt(0)!;
  if (code === 0xfffd || (code >= 0xd800 && code <= 0xdfff)) return [1, 3];
  return code < 0x80 ? [1, 1] : code < 0x800 ? [2, 2] : code < 0x10000 ? [3, 3] : [4, 4];
}

/** The most bytes one character takes in any charset the shells decode
 * names in (UTF-8 as glibc once allowed it; GB18030 and EUC-TW take 4). */
const MAX_CHAR_BYTES = 6;

/** `na`: one unknown non-ASCII character. `optional`: the token may be absent. */
type PatternToken = { star: boolean; alphabet: string | null; na?: boolean; optional?: boolean };
/** The same conservative bracket read, for the variable-length data list.
 * With `runs`, each run of non-ASCII literal characters is read in every
 * locale at once (arev-salv-x3restore-n4 High): how many characters its B
 * bytes hold depends on the reader's charset (LC_ALL=C reads one per byte,
 * UTF-8 one per code point), so the run is any count from
 * ceil(B / MAX_CHAR_BYTES) to B unknown non-ASCII characters. The caller sets
 * it when the other side holds a wildcard that could count those bytes.
 * An ASCII character straight after a run that holds a lossy character may
 * be the tail byte of a multibyte character (Shift_JIS reads bytes 81 41 as
 * one character; a listing shows U+FFFD then "A"), so it is read as itself
 * or as swallowed by the run (arev-salv-x3restore-par-n2 High). A run that
 * follows a swallowed character may be the rest of that same character
 * (GB18030 reads 81 30 81 30 as one), so it has no fewest count. */
function patternTokens(segment: string, runs = false): PatternToken[] {
  const result: PatternToken[] = [];
  // one token per character (code point): `?` and a literal astral name are one character to the shells
  const charAt = (at: number): string => String.fromCodePoint(segment.codePointAt(at)!);
  let fewest = 0, most = 0, lossy = false, tail = false, joined = false;
  const flush = (): void => {
    const least = joined ? 0 : Math.ceil(fewest / MAX_CHAR_BYTES);
    for (let k = 0; k < most; k++) result.push({ star: false, alphabet: null, na: true, optional: k >= least });
    tail = lossy;
    fewest = most = 0; lossy = joined = false;
  };
  /** A literal ASCII character: optional when a lossy run may have swallowed it. */
  const ascii = (literal: string): void => {
    const swallowed = tail && literal.length === 1 && literal.charCodeAt(0) < 0x80;
    result.push({ star: false, alphabet: literal.toLowerCase() + literal.toUpperCase(), ...(swallowed ? { optional: true } : {}) });
    joined = swallowed;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = charAt(i);
    const quoted = c === "\0" && i + 1 < segment.length;
    const literal = quoted ? charAt(i + 1) : c;
    if (runs && /[^\x00-\x7f]/.test(literal) && (quoted || c !== "[" )) {
      const [low, high] = charBytes(literal);
      fewest += low; most += high;
      if (low !== high) lossy = true;
      tail = false;
      i += (quoted ? 1 : 0) + literal.length - 1;
      continue;
    }
    if (most) flush(); else joined = false;
    if (quoted) {
      i += 1 + literal.length - 1;
      ascii(literal);
      tail = false;
      continue;
    }
    const swallow = tail;
    tail = false;
    if (c === "*" || c === "?") { result.push({ star: c === "*", alphabet: null }); continue; }
    if (c === "[" && bracketEnd(segment, i) > i) {
      const end = bracketEnd(segment, i), body = segment.slice(i + 1, end), exact = nonAsciiClass(body) ? null : simpleClass(body);
      if (body.includes("[")) { result.push({ star: true, alphabet: null }); break; }
      const re = exact ? new RegExp(exact, "i") : null;
      result.push({ star: false, alphabet: re ? Array.from({ length: 128 }, (_, n) => String.fromCharCode(n)).filter(c => re.test(c)).join("") : null });
      i = end;
    } else {
      i += c.length - 1;
      tail = swallow;
      ascii(c);
      tail = false;
    }
  }
  if (most) flush();
  return result;
}
/** Could one character meet both tokens? An unknown non-ASCII character
 * meets any character, an unknown one, or a class holding non-ASCII. */
function tokensMeet(x: PatternToken, y: PatternToken): boolean {
  if (x.na || y.na) {
    const other = x.na ? y : x;
    return Boolean(other.na) || other.alphabet === null || /[^\x00-\x7f]/.test(other.alphabet);
  }
  return x.alphabet === null || y.alphabet === null || [...x.alphabet].some(c => y.alphabet!.includes(c));
}
function patternIntersection(left: string, right: string, check: () => void = () => {}): boolean {
  const a = patternTokens(left, hasWildcard(right)), b = patternTokens(right, hasWildcard(left));
  const pending = [[0, 0]], seen = new Set<string>();
  while (pending.length) {
    check();
    const [i, j] = pending.pop()!;
    const key = i + ":" + j;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === a.length && j === b.length) return true;
    const x = a[i!], y = b[j!];
    if (x?.star || x?.optional) pending.push([i! + 1, j!]);
    if (y?.star || y?.optional) pending.push([i!, j! + 1]);
    if (x && y && tokensMeet(x, y)) {
      pending.push([i! + (x.star ? 0 : 1), j! + (y.star ? 0 : 1)]);
    }
  }
  return false;
}
export function pathGlobsIntersect(left: readonly string[], right: readonly string[], check: () => void = () => {}): boolean {
  const seen = new Set<string>(), pending = [[0, 0]];
  while (pending.length) {
    check();
    const [i, j] = pending.pop()!;
    const key = i + ":" + j;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === left.length && j === right.length) return true;
    const a = left[i!], b = right[j!];
    if (a === "**") pending.push([i! + 1, j!]);
    if (b === "**") pending.push([i!, j! + 1]);
    if (a !== undefined && b !== undefined && patternIntersection(a === "**" ? "*" : a, b === "**" ? "*" : b, check)) {
      pending.push([i! + (a === "**" ? 0 : 1), j! + (b === "**" ? 0 : 1)]);
    }
  }
  return false;
}

/** Maximum distinct row core positions on one accepting alignment. Stars
 * consume no evidence. A row position can be met only once on an alignment. */
export function alignedCorePositions(left: string, right: string, check: () => void = () => {}): number {
  if (left.length > 4096 || right.length > 4096) return Infinity;
  const a = patternTokens(left), b = patternTokens(right);
  const pending: number[][] = [[0, 0, 0]], seen = new Map<string, number>();
  let accepted = -1;
  while (pending.length) {
    check();
    const [i, j, count] = pending.pop()! as [number, number, number];
    const key = `${i}:${j}`;
    if ((seen.get(key) ?? -1) >= count) continue;
    if (seen.size >= 16384) return Infinity;
    seen.set(key, count);
    if (i === a.length && j === b.length) { accepted = Math.max(accepted, count); continue; }
    const x = a[i], y = b[j];
    if (x?.star) pending.push([i + 1, j, count]);
    if (y?.star) pending.push([i, j + 1, count]);
    if (x && y && (x.alphabet === null || y.alphabet === null || [...x.alphabet].some(c => y.alphabet!.includes(c)))) {
      pending.push([i + (x.star ? 0 : 1), j + (y.star ? 0 : 1), count + (!x.star && !y.star ? 1 : 0)]);
    }
  }
  return accepted;
}

/** Evidence and intersection travel along the same path alignment. */
function alignedPathIntersection(left: readonly string[], right: readonly string[], minimum: number, requireFolder: boolean): boolean {
  const pending: [number, number, boolean][] = [[0, 0, false]], seen = new Set<string>();
  while (pending.length) {
    const [i, j, folder] = pending.pop()!;
    const key = `${i}:${j}:${folder}`;
    if (seen.has(key)) continue;
    if (seen.size >= 16384) return true;
    seen.add(key);
    if (i === left.length && j === right.length) { if (!requireFolder || folder) return true; continue; }
    const a = left[i], b = right[j];
    if (a === "**") pending.push([i + 1, j, folder]);
    if (b === "**") pending.push([i, j + 1, folder]);
    if (a === undefined || b === undefined) continue;
    const count = alignedCorePositions(a === "**" ? "*" : a, b === "**" ? "*" : b);
    if (count < 0 || (rowReadSegment(b) !== b && (a === "**" || count < minimum))) continue;
    const keyFolder = i < left.length - 1 && j < right.length - 1 && !/^[*~]*$/.test(a) && !/^[*~]*$/.test(b);
    pending.push([i + (a === "**" ? 0 : 1), j + (b === "**" ? 0 : 1), folder || keyFolder]);
  }
  return false;
}

/** Known anchors with unavailable expansion use the original row spellings.
 * One core position on an accepting alignment is enough; stars add none. */
export function unavailableAnchoredGlobRead(token: string, platform: NodeJS.Platform = process.platform, home?: string, check: () => void = () => {}): string | null {
  const glob = homeForm(token, platform, home).split("/");
  for (const row of SENSITIVE_PATHS) for (const read of row.read) {
    const pattern = read.split("/");
    if (pattern.at(-1) === "**") pattern.splice(-1, 1, "*", "**");
    const pending: [number, number, boolean][] = [[0, 0, false]], seen = new Set<string>();
    while (pending.length) {
      check();
      const [i, j, core] = pending.pop()!;
      const key = `${i}:${j}:${core}`;
      if (seen.has(key)) continue;
      if (seen.size >= 16384) return row.re.source;
      seen.add(key);
      if (i === glob.length && j === pattern.length && core) return row.re.source;
      const a = glob[i], b = pattern[j];
      if (a === "**") pending.push([i + 1, j, core]);
      if (b === "**") pending.push([i, j + 1, core]);
      if (a === undefined || b === undefined) continue;
      const count = alignedCorePositions(a === "**" ? "*" : a, b === "**" ? "*" : b, check);
      if (count < 0) continue;
      pending.push([i + (a === "**" ? 0 : 1), j + (b === "**" ? 0 : 1), core || (a !== "**" && b !== "**" && b !== "~" && count >= 1)]);
    }
  }
  return null;
}

/** H1's unavailable relative expansion rule, separate from other guards. */
export function credentialTextFallback(token: string): string | null {
  const glob = token.split("/");
  for (const row of SENSITIVE_PATHS) for (const read of row.read) {
    const segments = read.replace(/^\*\*\//, "").split("/");
    if (!segments.some(segment => rowReadSegment(segment) !== segment)) continue;
    if (segments.at(-1) === "**") segments.splice(-1, 1, "*", "**");
    if (globCouldMatch(glob, segments, (a, b) => alignedPathIntersection(a, b, 4, false))) return row.re.source;
  }
  return null;
}

export interface ShellDirectoryEffect {
  operand?: string;
  flags: string[];
  scope: "parent" | "child";
  kind: "filesystem" | "stack" | "home" | "oldpwd" | "unknown";
  command: string;
}
/** Quote and operator aware discovery. Child payloads contribute reads, but
 * their directory changes never become parent-shell history. */
export function shellDirectoryEffects(text: string, child = false, depth = 0, payloads?: string[], shell?: "pwsh"): ShellDirectoryEffect[] {
  if (depth > 8 || text.length > 262144) return [{ command: "unreadable shell", flags: [], scope: child ? "child" : "parent", kind: "unknown" }];
  const words = text.match(/(?:`[^`]*`|\$\([^)]*\)|\\.|"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()"'\\])+|&&|\|\||[;&|()]/g) ?? [];
  const effects: ShellDirectoryEffect[] = [];
  let quote = "", escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (shell !== "pwsh" && char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "'" || char === '"') quote = char;
  }
  // Redirections and argument substitutions do not move the parent shell.
  // Malformed directory operands are handled at the directory command below.
  let nesting = child ? 1 : 0, pipeline = false;
  for (let i = 0; i < words.length;) {
    const boundary = words[i]!;
    if (boundary === "(") { nesting++; i++; continue; }
    if (boundary === ")") { nesting = Math.max(child ? 1 : 0, nesting - 1); i++; continue; }
    if (/^[;&|]+$/.test(boundary)) { pipeline = boundary === "|"; i++; continue; }
    const command: string[] = [];
    while (i < words.length && !/^[;&|()]+$/.test(words[i]!)) command.push(words[i++]!);
    const dequote = (word: string): string => {
      let result = "", quote = "";
      for (let at = 0; at < word.length; at++) {
        const char = word[at]!;
        if (shell !== "pwsh" && char === "\\" && quote !== "'" && at + 1 < word.length && (!quote || /[$`"\\\n]/.test(word[at + 1]!))) {
          const next = word[++at]!;
          if (next !== "\n") result += next;
        } else if (quote) { if (char === quote) quote = ""; else result += char; }
        else if (char === "'" || char === '"') quote = char;
        else result += char;
      }
      return result;
    };
    const args = command.map(dequote);
    while (/^(?:if|then|else|elif|do|while|until|!)$/.test(args[0] ?? "")) args.shift();
    const scope = nesting || pipeline || words[i] === "|" || words[i] === "&" ? "child" : "parent";
    let at = /^(?:builtin|command)$/.test(args[0] ?? "") ? 1 : 0;
    const commandIndex = at;
    const name = (args[at++] ?? "").toLowerCase();
    if (/^(?:cd|pushd|popd|push-location|set-location|sl|chdir)$/.test(name)) {
      const flags: string[] = [];
      while (/^(?:-P|-L|-e|--|-n|\/d|-Path|-LiteralPath|-PSPath)$/i.test(args[at] ?? "")) { const flag = args[at++]!; flags.push(flag); if (flag === "--") break; }
      const operand = args[at];
      const kind = name === "popd" || ((name === "pushd" || name === "push-location") && (!operand || /^[+-]\d+$/.test(operand))) ? "stack"
        : operand === "-" ? "oldpwd" : operand === undefined ? "home" : "filesystem";
      effects.push({ command: name, flags, operand, kind: quote || escaped ? "unknown" : kind, scope });
    }
    for (let k = 0; k < args.length; k++) {
      if ((name === "env" && args[k] === "-C") || args[k] === "--chdir" || args[k] === "-WorkingDirectory" || (name === "sudo" && args[k] === "-D")) {
        effects.push({ command: name, operand: args[k + 1], flags: [], kind: args[k + 1] ? "filesystem" : "unknown", scope: "child" });
      } else if (args[k]?.startsWith("--chdir=")) effects.push({ command: name, operand: args[k]!.slice(8), flags: [], kind: "filesystem", scope: "child" });
      if ((k === commandIndex || name === "env" || name === "sudo") && /^(?:sh|bash|zsh|dash|ksh)$/.test(args[k] ?? "") && args[k + 1] === "-c" && args[k + 2] !== undefined) {
        payloads?.push(args[k + 2]!);
        effects.push(...shellDirectoryEffects(args[k + 2]!, true, depth + 1, payloads));
      }
    }
    if (/^(?:eval|source|\.)$/.test(name)) effects.push({ command: name, flags: [], kind: "unknown", scope });
  }
  return effects;
}

const SHELL_WORDS = /(?:`[^`]*`|\$\([^)]*\)|\\.|"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()"'\\])+|&&|\|\||[;&|()]/g;
/** r5:80 (P1): the whole top-level command is one `&&` list: no `||`, `;`,
 * `&`, `|`, newline or subshell at top level. Anything else is not a list a
 * single exit status can prove. */
export function shellAndList(text: string): boolean {
  if (/[\r\n]/.test(text) || text.length > 262144) return false;
  let quote = "", escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "'" || char === '"') quote = char;
  }
  if (quote || escaped) return false;
  const words = text.match(SHELL_WORDS) ?? [];
  return words.every(word => !/^[;&|()]+$/.test(word) || word === "&&");
}
/** X3 1.0.19 ruling H1 (positive knowledge only): is `text` a flat list of top-level simple commands joined only by
 * `;`, a newline or `&&`, in which every directory change is a plain `cd DIR` or `cd -- DIR` with exactly one literal
 * operand? Comments (an unquoted `#` at the start of a word, to the end of the line) are removed first. Anything this
 * tokenizer does not fully understand (an unclosed quote, a substitution, a redirect, a heredoc, a negation, `||`, `|`,
 * `&`, a subshell, a group, a function, a loop, an `if`, `builtin cd`, any other directory command) answers false, and
 * a false answer means the call can never clear `unknown`. */
export function provenCdList(text: string): number {
  if (text.length > 262144 || text.includes("\0")) return -1;
  interface W { text: string; quoted: boolean }
  const commands: W[][] = [];
  let words: W[] = [];
  let word = "", inWord = false, quoted = false;
  const endWord = () => { if (inWord) words.push({ text: word, quoted }); word = ""; inWord = false; quoted = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return -1;
      if (next === "\n") { i++; continue; }
      word += next; inWord = true; quoted = true; i++; continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return -1;
      word += text.slice(i + 1, end); inWord = true; quoted = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1, body = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j]!;
        if (d === "$" || d === "`") return -1;
        if (d === "\\") { const n = text[j + 1]; if (n === undefined) return -1; if (/["\\\n]/.test(n)) { if (n !== "\n") body += n; j++; continue; } }
        body += d;
      }
      if (j >= text.length) return -1;
      word += body; inWord = true; quoted = true; i = j; continue;
    }
    if (c === "$" || c === "`" || c === "<" || c === ">" || c === "(" || c === ")" || c === "|") return -1;
    if (c === "!" && !inWord) return -1;
    if (c === "&") { if (text[i + 1] === "&") { endCommand(); i++; continue; } return -1; }
    if (c === ";") { if (text[i + 1] === ";") return -1; endCommand(); continue; }
    if (c === "\n" || c === "\r") { endCommand(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    if (c === "#" && !inWord) { while (i < text.length && text[i] !== "\n") i++; i--; continue; }
    word += c; inWord = true;
  }
  endCommand();
  const KEYWORDS = /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|time|coproc|\{|\}|\[\[)$/;
  const DIRS = /^(?:cd|pushd|popd|chdir|push-location|set-location|sl)$/i;
  let cds = 0;
  for (const command of commands) {
    const head = command[0]!;
    if (!head.quoted && KEYWORDS.test(head.text)) return -1;
    if (/^(?:builtin|command|eval|source|\.|exec|env|sudo|nohup|xargs)$/.test(head.text) && command.some(w => DIRS.test(w.text))) return -1;
    if (DIRS.test(head.text)) {
      if (head.quoted || head.text !== "cd") return -1;
      const operands = command.slice(1);
      if (operands[0]?.text === "--" && !operands[0].quoted) operands.shift();
      if (operands.length !== 1) return -1;
      const operand = operands[0]!.text;
      cds++;
      if (operand === "" || operand.startsWith("-") || /[*?[\]{}~]/.test(operand.replace(/^~\//, ""))) return -1;
    }
  }
  return cds;
}

/** r5:33: the command text turns on dot matching for later globs. */
export function setsDotglob(text: string): boolean {
  return /\bshopt\s+-s\s+(?:\S+\s+)*dotglob\b|\bsetopt\s+(?:\S+\s+)*(?:globdots|glob_dots|GLOB_DOTS)\b|(?:^|[\s;&|(])GLOBIGNORE=/.test(text);
}
/** r5:108 (P6): the literal operands of a link, copy or mount in the same
 * call. Each gets the cd folder check, so `ln -s ~/.ssh k && cd k && cat *`
 * is read as a read of the linked folder. */
export function linkCopyOperands(text: string): string[] {
  const operands: string[] = [];
  const words = (text.length > 262144 ? "" : text).match(SHELL_WORDS) ?? [];
  const dequote = (word: string) => word.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g, (_all, double: string | undefined, single: string | undefined, escaped: string | undefined) => double ?? single ?? escaped ?? "");
  for (let i = 0; i < words.length;) {
    if (/^[;&|()]+$/.test(words[i]!)) { i++; continue; }
    const args: string[] = [];
    while (i < words.length && !/^[;&|()]+$/.test(words[i]!)) args.push(words[i++]!);
    let at = 0;
    while (/^(?:sudo|command|builtin|nohup|time|nice|rtk)$/.test(args[at] ?? "")) at++;
    const name = (args[at] ?? "").replace(/^.*\//, "");
    if (!/^(?:ln|cp|rsync|mount|bindfs)$/.test(name)) continue;
    const rest = args.slice(at + 1);
    if (name === "cp" && !rest.some(arg => /^-[a-zA-Z]*[rRa]/.test(arg) || arg === "--recursive" || arg === "--archive")) continue;
    for (const raw of rest) {
      if (raw.startsWith("-") || /[$`]/.test(raw)) continue;
      const word = dequote(raw);
      if (word) operands.push(word);
    }
  }
  return operands;
}

export function unresolvedShellParent(operand: string): boolean {
  let unresolved = false;
  for (const part of operand.split("/")) {
    if (part === "..") { if (unresolved) return true; }
    else if (part !== "" && part !== ".") unresolved = true;
  }
  return false;
}
