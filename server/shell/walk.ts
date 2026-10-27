// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The walker behind the always-ask reader: it visits every place a command
// can run in a parsed script, and it is an allowlist. A command is ordinary
// only when every node it is made of is one the walker models in full:
//
//   words      lit, tilde, glob, brace (nothing runs); var (its operand word
//              is walked; every operand is read through `candidatesOf`, with
//              the values this text bound put in); subst, procsub (walked
//              as a nested script); arith (its substitutions are walked)
//   commands   simple (assignments, wrappers from the table, the program,
//              its arguments, its redirects); if, loops, for, case (every
//              branch walked in a fork and merged); subshell (a fork);
//              group; function (its body walked, its shape recorded);
//              (( )) and [[ ]] (their substitutions)
//   re-entry   `sh -c`, a shell reading a heredoc, here-string or literal
//              echo, `eval`, `trap`, `su -c`, `env -S`, `find -exec`, `xargs`,
//              PowerShell and cmd through server/shell/pwsh.ts; every word
//              in one of these positions has to be fixed by the text, so a
//              value, substitution, glob or brace there asks
//
//   functions  a definition runs nothing; every call walks the body again
//              with the call's words bound to `$1`…, `$@`, `$*`, `$#`, and
//              the state the body ends in is merged back as a branch: a name
//              it bound, a folder it moved to or a function it defined is
//              unknown from there on. A body that assigns, moves or defines
//              makes those unknown from the definition on as well
//
//   values     the rules read operands through `candidatesOf` (`operandsOf`):
//              literal, a glob with its anchor, or a value. Stdin is
//              `Provenance`, computed and never assumed (emitters, identity,
//              listers). Files written and links made here are tracked. Every
//              uncertain path makes a name unknown: an assignment before a
//              command (`D=x cmd`), `+=`, a binder with options, a pipeline
//              or `&` (a branch), an `&&`/`||` chain past its first command
//              (a branch), `source`, `let`, `printf -v`, arithmetic that
//              assigns, a trap body, a function body. `eval` runs in place.
//              A trap body is walked at registration, marked so a risky
//              command in it asks; a function later defined under a name
//              the trap calls asks (the trap could run it)
//
// Anything else asks: a program the text does not fix, `shift` or `set --`,
// an alias, a function defined in one branch, a positional parameter in a
// script a shell runs with arguments, a printf directive or an escape on the
// way into a shell, a wrapper option outside the table, a value with spaces
// in command position, more nesting or recursion than the depth cap. The
// parts and command kinds are enumerated in exhaustive switches, so a new
// node kind fails the typecheck until it is placed.

import { homedir } from "node:os";
import { powershellRunner } from "./pwsh.ts";

import { isPlain, lex, lexQuotedBody, literalText, renderWord, Unreadable, type Part, type Word } from "./lex.ts";
import { parse, type AndOr, type Command, type Pipeline, type Redirect, type Script } from "./parse.ts";
import { checkUnplacedWrite, isLoaderName, loadsCodeFirst, namesStartupFile, writtenStartupFile, markLoaderRunner, markLoaderVariable, mentionsLoaderVariable, pythonModuleLoads, rReadsProfile, type LoaderMarks } from "./loaders.ts";


/** Nested scripts (`sh -c`, `eval`, a substitution) deeper than this ask. */
export const MAX_DEPTH = 8;
const MAX_CANDIDATES = 512;
const MAX_NAMES = 16;

/** What a function body does to the state around it, read off the body
 * once at the definition: it is applied to the caller's state at the
 * definition and after every call, so the names it assigns, the folder it
 * moves to and the functions it defines are unknown from there on. */
export interface BodyEffects {
  /** names the body assigns (`X=`, `local`, `export`, `read`, `for X`, `${X:=}`) */
  assigns: Set<string>;
  /** the body runs something that can assign any name (`eval`, `source`,
   * `let`, arithmetic, `printf -v`, a program the text does not fix) */
  opaque: boolean;
  /** the body moves to another folder (`cd`, `pushd`, `popd`) */
  movesCwd: boolean;
  /** functions the body defines */
  defines: Array<{ name: string; body: Command }>;
}

export interface FunctionShape {
  /** calls itself twice, once in the background or beside itself in a pipe */
  forkBomb: boolean;
  /** the body, walked again at every call with the call's words bound to
   * `$1`…, `$@`, `$*` and `$#` */
  body: Command;
  /** the body as text, so two definitions can be compared */
  key: string;
  /** defined in one branch and not another, or defined differently by
   * branch, or defined inside another function's body: a call asks */
  conflict: boolean;
  effects: BodyEffects;
}

/** Where the text a command reads on stdin (or a file holds) comes from, as
 * far as the text says: written out here, a file named here, the paths a
 * lister prints from these roots, or a value the reader cannot see. */
export type Provenance =
  | { kind: "literal"; text: string; words: Word[] }
  | { kind: "file"; path: string }
  | { kind: "roots"; roots: Word[] }
  | { kind: "value"; why: string }
  /** text a downloader fetched from a literal https address this text names
   * (`DOWNLOADERS`): a source like a file path, out of reach as a file on
   * disk is, and read by `runsRemote` */
  | { kind: "remote"; url: string };

/** One thing an operand can stand for once the values this text binds are
 * put in (`operandsOf`). `path` is the text the path rules read: a literal
 * leading `~` or `$` carries LITERAL_MARK, each part the text does not fix
 * carries UNKNOWN_MARK. A glob keeps its anchor: the literal folder before
 * its first glob character, resolved from the folder the command runs in. */
export type Candidate =
  | { kind: "literal"; text: string; path: string }
  | { kind: "glob"; anchor: string; path: string }
  | { kind: "value"; why: string; path: string; lead: boolean }
  /** one of the items an executor reads from a list file on disk this text
   * did not write (`xargs rm < list.txt`): the same trust as a script on
   * disk, ordinary in every rule. `path` is the list file */
  | { kind: "fromFile"; path: string };

export interface WalkContext {
  /** Server-authorized literal Bash payloads from a Windows command. Shared across forks. */
  windowsBash?: string[];
  /** the folder the next command runs from, when the text says */
  cwd?: string;
  /** branches moved to different folders: a relative delete from here asks */
  cwdConflict: boolean;
  /** names assigned in this text: their candidates, or null when the value
   * cannot be known (`read` of unknown input, a value that differs by
   * branch). Every operand is read through these (`candidatesOf`) */
  bound: Map<string, Word[] | null>;
  /** names bound to arrays: every candidate is one element */
  arrays: Set<string>;
  /** names made read-only: a later assignment fails, so the value the
   * reader would put in is not the one the shell keeps. Unknown for good */
  readonly: Set<string>;
  /** functions defined so far in this text, by their shape */
  functions: Map<string, FunctionShape>;
  /** something ran that can assign any name (a function body with `eval`
   * in it): a name with no later binding is unknown, and asks where a
   * literal would have been trusted */
  opaque: boolean;
  /** what a command in the enclosing compound reads on stdin, when the text says */
  stdin?: Provenance;
  /** the commands here run later or from text the shell builds: a trap
   * body, text eval runs. A risky command in a trap body asks */
  indirect?: "trap" | "eval";
  /** every program a trap body in this text calls: a function by one of
   * these names defined from here on could be what the trap runs, so
   * that definition asks */
  trapCalls?: Set<string>;
  /** the script being walked runs behind an elevation prefix (set by
   * `unwrap` for the script an elevated command hands to a shell) */
  elevated?: boolean;
  /** files this text wrote, by resolved path, with what was written */
  written: Map<string, Provenance>;
  /** symbolic links this text made (`ln -s A B`): B's resolved path to A */
  links: Map<string, string>;
  /** hard links this text made (`ln A B`): every name of one file, by
   * resolved path, to the one identity they share (`INODE_MARK` and a
   * number). `written` keys a linked file by that identity, so a write
   * through either name is what both names hold from then on */
  inodes: Map<string, string>;
  /** the commands here are a `find -exec` action: run on every file under
   * find's roots, so a delete of a root reaches all of it, as a recursive
   * one does */
  findAction?: boolean;
  /** 1.0.5 r8: a loader variable set and an interpreter or shell run,
   * shared by every fork of one read (server/shell/loaders.ts) */
  loaders: LoaderMarks;
  depth: number;
}

/** A simple command as the rules see it: its program name resolved and the
 * wrappers taken off; its arguments as written, and per argument every
 * candidate it stands for (`operands`, index-aligned with `args`; operands
 * an executor appends, like xargs input, are appended to both). */
export interface SimpleCommand {
  name: string;
  args: Word[];
  operands: Candidate[][];
  redirects: Redirect[];
  /** behind sudo, doas, run0, pkexec or `su -c` */
  elevated: boolean;
  /** the program's name came from a value (`$R -rf x`, `"$@"`): the
   * reader followed the name, and a risky command found this way asks */
  derived?: true;
  /** what the command reads on stdin, when the text says (a nested
   * PowerShell or cmd reads its commands from it) */
  stdin?: Provenance;
  /** the program word as written, when it is literal, and the reader that
   * found it: POSIX names are exact case and all, Windows names any case */
  program?: { text: string; dialect: "posix" | "windows" };
}

export interface Visitor<H> {
  /** Every simple command, in order. May move `ctx.cwd`. A hit stops the walk. */
  command(cmd: SimpleCommand, ctx: WalkContext): H | null;
  /** Every redirect with a target, on simple and compound commands alike,
   * with the target as written and every candidate it stands for. */
  redirect(redirect: Redirect, target: Word, candidates: Candidate[], ctx: WalkContext): H | null;
  /** A redirect in PowerShell or cmd text, with its candidates. */
  pwshRedirect?(target: Word, candidates: Candidate[], ctx: WalkContext): H | null;
  /** Does this string, quoted inside code the reader does not model
   * (`python -c`, `node -e`), name a catastrophe on its own? */
  catastrophic?(text: string): boolean;
  /** A call of a function shaped like a fork bomb. */
  forkBomb(): H;
  /** The wrappers' own arguments (`env -C DIR`, `flock FILE`, `xargs -a
   * FILE`), each glued option value as a word of its own: read before the
   * wrappers are taken off, whatever they run (a shell, a script, a
   * function), from the folder the text runs in. */
  wrapperArgs?(words: Word[], ctx: WalkContext): H | null;
  /** May `find`'s arguments hold a value here (the always-ask routine
   * carve-out)? True only when the visitor takes that on itself; otherwise
   * a value anywhere in them is unreadable. */
  findValues?(words: Word[]): boolean;
  /** A script file on disk that a shell runs, an interpreter runs or
   * `source` reads, named by a literal path this text did not write: its
   * contents are not in the text. True when the visitor takes that on
   * itself (always-ask's, which still asks below Full access) and the walk
   * goes on to the rest of the text; otherwise it is unreadable, as before.
   * Never offered elevated, nor for a file this text wrote or a value names. */
  unseenScript?(path: string, ctx: WalkContext): boolean;
}

/** 1.0.5: a literal script file on disk this text did not write. The visitor
 * may take it on and read on; otherwise it is unreadable, as 1.0.4 U17 made it. */
function unseenScript<H>(visitor: Visitor<H>, path: string, ctx: WalkContext, elevated: boolean, detail: string): void {
  if (!elevated && visitor.unseenScript?.(path, ctx)) return;
  throw new Unreadable("opaque", detail);
}

/** 1.0.5 r8: an interpreter or a shell runs: a loader variable this read set
 * reaches it, and a startup file this read wrote or linked is read first. */
function runnerStarts(ctx: WalkContext, name: string): void {
  markLoaderRunner(ctx.loaders, name);
  checkUnplacedWrite(ctx.loaders, name);
  const startup = writtenStartupFile([...ctx.written.keys(), ...ctx.links.keys()]);
  if (startup) throw new Unreadable("opaque", `${name} reads a startup file this text wrote (${startup})`);
}

export function newContext(cwd?: string): WalkContext {
  return { cwd, cwdConflict: false, bound: new Map(), arrays: new Set(), readonly: new Set(), functions: new Map(), opaque: false, written: new Map(), links: new Map(), inodes: new Map(), loaders: {}, depth: 0 };
}

/** A copy for a subshell, a branch or a nested script: what it binds or
 * moves to does not leak back out unless `merge` is asked to. */
export function fork(ctx: WalkContext, deeper = false): WalkContext {
  const next: WalkContext = {
    windowsBash: ctx.windowsBash,
    cwd: ctx.cwd,
    cwdConflict: ctx.cwdConflict,
    bound: new Map(ctx.bound),
    arrays: new Set(ctx.arrays),
    readonly: new Set(ctx.readonly),
    functions: new Map(ctx.functions),
    opaque: ctx.opaque,
    written: new Map(ctx.written),
    links: new Map(ctx.links),
    inodes: new Map(ctx.inodes),
    loaders: ctx.loaders,
    depth: ctx.depth + (deeper ? 1 : 0),
  };
  if (ctx.stdin) next.stdin = ctx.stdin;
  if (ctx.indirect) next.indirect = ctx.indirect;
  if (ctx.elevated) next.elevated = true;
  if (ctx.findAction) next.findAction = true;
  if (ctx.trapCalls) next.trapCalls = new Set(ctx.trapCalls);
  return next;
}

/** A word's brace alternatives multiplied out (`{a,b}` is `a` and `b`);
 * every other part stays as written. */
export function braceCandidates(word: Word): Word[] {
  let candidates: Part[][] = [[]];
  for (const part of word.parts) {
    const options: Part[][] = part.kind === "brace" ? part.alts.map((alt) => alt.parts) : [[part]];
    const next: Part[][] = [];
    for (const head of candidates) for (const option of options) next.push([...head, ...option]);
    if (next.length > MAX_CANDIDATES) throw new Unreadable("expansion", "too many values");
    candidates = next;
  }
  return candidates.map((parts) => ({ parts }));
}


/** Every name a binding made unknown: a value the text does not fix. */
function unknownName(name: string, ctx: WalkContext): void {
  ctx.bound.set(name, null);
  ctx.arrays.delete(name);
}

/** Is this a value the reader will trust as it stands: every candidate
 * made of literal parts only? */
function fixed(value: Word[] | null | undefined): value is Word[] {
  return !!value && value.every((word) => word.parts.every((part) => part.kind === "lit" || part.kind === "tilde" || part.kind === "glob" || part.kind === "brace"));
}
/** Marks literal text that starts with `~` or `$`: it names a file called
 * that, not the home folder. */
export const LITERAL_MARK = "\u0000";
/** Marks a part of a path the text does not fix (`$DIR`, `$(…)`). */
export const UNKNOWN_MARK = "\u0001";
/** The text without its marks. */
export const unmarked = (text: string): string => text.replaceAll(LITERAL_MARK, "").replaceAll(UNKNOWN_MARK, "");

/** Variables that name the home folder, in the shells and on Windows. */
const HOME_VARS = new Set(["HOME", "USERPROFILE", "ENV:USERPROFILE", "ENV:HOME"]);

/** `$HOME` names the home folder unless this text binds HOME (then it is a
 * value like any other), or ran something that can bind any name. */
export function homeVar(name: string, ctx: WalkContext): boolean {
  return HOME_VARS.has(name.toUpperCase()) && !ctx.bound.has(name) && !ctx.bound.has(name.toUpperCase()) && !ctx.bound.has(name.toLowerCase()) && !ctx.opaque;
}

/** `$HOME`, `${HOME}` and the Windows spellings of the home folder, as `~`. */
export function homeSpelled(raw: string): string {
  return raw.trim().replace(/^\$\{HOME\}|^\$HOME|^%USERPROFILE%|^\$env:USERPROFILE|^\$env:HOME/i, "~").replace(/[\\]/g, "/");
}

/** Does this path stand on its own, or does it depend on the folder the
 * command runs in? */
export function isAnchored(path: string): boolean {
  return /^(\/|~|[a-z]:)/i.test(path);
}

/** `.` and `..` worked out, so `rm -rf ..` from a top-level folder is read as
 * the drive it lands on. */
export function normalizePath(path: string): string {
  const drive = /^[a-z]:/i.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  const lead = rest.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length && parts[parts.length - 1] !== "..") parts.pop(); else if (!lead && !drive) parts.push(part); continue; }
    parts.push(part);
  }
  return `${drive}${lead}${parts.join("/")}` || (drive ? `${drive}/` : lead || ".");
}

/** A path argument as the command would reach it: relative paths are taken
 * from the folder the command runs in, when that folder is known. */
export function resolveFrom(cwd: string | undefined, raw: string): string {
  const path = homeSpelled(raw);
  if (!path || isAnchored(path)) return path;
  // a relative path from a folder the text does not fix: `./x` and `x` are one file
  const relative = () => {
    if (!path.startsWith("./")) return path;
    const short = normalizePath(path);
    // `./~` is a file called `~`, never the home folder
    return isAnchored(short) ? path : short;
  };
  if (!cwd) return relative();
  const base = homeSpelled(cwd);
  if (!isAnchored(base)) return relative();
  return normalizePath(`${base}/${path}`);
}

/** The one chokepoint for a file this text may have written (UPSEC 10.4 b):
 * the path resolved from the folder the command runs in, then every link
 * this text made followed to a fixed point. Every `ctx.written` lookup reads
 * through it, so a script reached by a symbolic link runs what the text
 * wrote to its target. */
export function resolveWritten(ctx: WalkContext, text: string): string {
  if (text.startsWith(INODE_MARK)) return text;
  return writtenKey(ctx, resolveFrom(ctx.cwd, text));
}

/** The file a path names: resolved from the folder the command runs in,
 * every symbolic link followed. A path, never a hard-link identity; its
 * record is read through `resolveWritten`. */
export function resolvePath(ctx: WalkContext, text: string): string {
  return followLinks(ctx, resolveFrom(ctx.cwd, text));
}

/** The `written` key of a path already resolved from the folder the command
 * runs in: every symbolic link followed, then the hard-link identity the
 * name shares with its other names, so one record serves them all. */
export function writtenKey(ctx: WalkContext, resolved: string): string {
  const path = followLinks(ctx, resolved);
  return ctx.inodes.get(path) ?? path;
}

function followLinks(ctx: WalkContext, resolved: string): string {
  let path = resolved;
  for (let hops = 0; hops <= MAX_DEPTH; hops++) {
    const next = ctx.links.get(path);
    if (next === undefined || next === path) return path;
    path = next;
  }
  throw new Unreadable("depth", "links that point at each other");
}

/** What marks a `written` key as a hard-link identity, never a path. */
export const INODE_MARK = "\u0002inode:";
let inodeCount = 0;

/** Record what a write put in a file: through every symbolic link to the
 * file itself, and into the identity its hard links share. */
function setWritten(ctx: WalkContext, resolved: string, content: Provenance): void {
  ctx.written.set(writtenKey(ctx, resolved), content);
}

/** `ln A B` without `-s` (UPSEC 10.4 b, live): B becomes a second name of
 * A's file. Both names resolve to one identity, and the record lives under
 * that identity, never copied, so a later write through either name is what
 * both hold. A name `ln -f` replaces leaves the identity it had. */
function hardLink(ctx: WalkContext, source: string, link: string): void {
  const target = followLinks(ctx, source);
  let id = ctx.inodes.get(target);
  if (id === undefined) {
    id = `${INODE_MARK}${++inodeCount}`;
    ctx.inodes.set(target, id);
    const held = ctx.written.get(target);
    if (held !== undefined) { ctx.written.delete(target); ctx.written.set(id, held); }
  }
  ctx.written.delete(link);
  ctx.links.delete(link);
  ctx.inodes.set(link, id);
}

/** Every path name `written` holds a record for: plain keys, and each name
 * of a hard-linked file whose identity holds one. */
function writtenNames(ctx: WalkContext): string[] {
  const names = [...ctx.written.keys()].filter((key) => !key.startsWith(INODE_MARK));
  for (const [path, id] of ctx.inodes) if (ctx.written.has(id)) names.push(path);
  return names;
}

/** This computer's home folder, for a cwd or path spelled out in full. */
export const HOME = (() => {
  try { return homedir().replace(/[\\]/g, "/").replace(/\/+$/, "").toLowerCase(); } catch { return ""; }
})();
/** The folder that holds the home folder: `/Users`, `/home`. */
export const HOME_PARENT = HOME && HOME !== "/" ? normalizePath(`${HOME}/..`) : "";

/** `\\.\PhysicalDrive0` and `\\?\PhysicalDrive0`, in any case. */
export const PHYSICAL_DRIVE = /[\\/]{2}[.?][\\/]physicaldrive\d+/i;
/** `\\.\C:`: a whole Windows volume. */
const WINDOWS_VOLUME = /^[\\/]{2}[.?][\\/][A-Za-z]:$/;
/** `DEVICE_STREAMS`: the families of `/dev/` names that hold no filesystem,
 * by kind, each a pattern on the name after `/dev/`. Pseudo files; standard
 * streams; terminals and serial lines; shared memory and queues; bash's
 * network pseudo files; the syslog socket; input, sound, video and graphics;
 * virtualization and buses; cpu and power. Every other name under `/dev/` is
 * the device class, whatever its naming scheme (a volume-group folder, a
 * zvol, a BSD disk name): a storage node needs no row. A family's own
 * folder (`/dev/shm`, `/dev/pts`) is in the family. `fd<digits>` without a
 * slash is a floppy, not a stream. */
const DEVICE_STREAMS = new RegExp("^(?:" + [
  "null", "zero", "full", "random", "urandom",
  "", "stdin", "stdout", "stderr", "fd", String.raw`fd/\d+`, "kmsg", "termination-log", "hwrng", String.raw`bpf\d*`, "autofs",
  "tty.*", "pts(?:/.*)?", "ptmx", "console", String.raw`cu\..+`,
  "shm(?:/.*)?", "mqueue(?:/.*)?",
  "tcp/.+", "udp/.+",
  "log",
  "input(?:/.*)?", "snd(?:/.*)?", String.raw`video\d+`, "dri(?:/.*)?", String.raw`hidraw\d+`, "uinput",
  "kvm", "net(?:/.*)?", "fuse", "vfio(?:/.*)?", "bus(?:/.*)?", "usb(?:/.*)?", String.raw`i2c-\d+`, "spidev.*",
  "cpu(?:/.*)?", String.raw`rtc\d+`, String.raw`watchdog\d+`, "rfkill",
].join("|") + ")$");

/** Is this path a device a write could erase: a Windows physical drive, a
 * whole Windows volume, or any name under `/dev/` outside `DEVICE_STREAMS`. */
export function isDeviceWrite(path: string): boolean {
  const text = unmarked(path);
  if (PHYSICAL_DRIVE.test(text) || WINDOWS_VOLUME.test(text)) return true;
  if (!text.startsWith("/dev/")) return false;
  const normal = normalizePath(text);
  if (!normal.startsWith("/dev/")) return false;
  return !DEVICE_STREAMS.test(normal.slice("/dev/".length));
}

/** A device path spelled anywhere in this text: every substring starting at
 * `/dev/`, `\\.\` or `\\?\`, up to the end, a blank, `,` or `;`, tested by
 * `isDeviceWrite`. Catches `-o/dev/sda`, `--log-file=/dev/sda`,
 * `of=/dev/sda`, `-Path:\\.\PhysicalDrive0`, `file:///dev/sda`. */
export function deviceInWord(text: string): string | undefined {
  const plain = unmarked(text);
  for (let i = 0; i < plain.length; i++) {
    if (!plain.startsWith("/dev/", i) && !/^[\\/]{2}[.?][\\/]/.test(plain.slice(i, i + 4))) continue;
    // a device name starts a word, follows `=`, a quote, a bracket or a
    // blank, ends a glued short option (`-o/dev/sda`) or a URL scheme
    // (`file:///dev/sda`); `~/dev/x` and `/home/me/dev/x` are folders
    if (i > 0 && /[A-Za-z0-9_.~$}\-\/\\]/.test(plain[i - 1]!) && !/^-[A-Za-z]+$/.test(plain.slice(0, i)) && !plain.slice(0, i).endsWith("://")) continue;
    let end = i;
    // a `/dev/` name is made of name characters: it ends at a quote, a
    // bracket, `#` or anything else around it (`open('/dev/null')`,
    // `s#x#/dev/null#`); a Windows device name ends at a blank, `,` or `;`
    const posix = plain.startsWith("/dev/", i);
    while (end < plain.length && (posix ? /[A-Za-z0-9_.+\-/:@%~]/ : /[^\s,;]/).test(plain[end]!)) end++;
    // a name ends in a name character: `/dev/null.` and `/dev/null:` end a sentence or a list
    const sub = posix ? plain.slice(i, end).replace(/[.:@%~+\-]+$/, "") : plain.slice(i, end);
    if (isDeviceWrite(sub)) return sub;
  }
  return undefined;
}

/** Commands that read devices, and which operands they read (`DEVICE_READERS`).
 * A reader is exempt only in a mode it is known to read in: `PURE_READERS`
 * have no writing mode in any option; every other reader has a row of the
 * options it is known to read with (`READER_MODES`), and any other option,
 * a writing one (`xxd -r`, `pv -o`) or one the row does not know, makes the
 * command a writer. */
const PURE_READERS = new Set([
  "grep", "egrep", "fgrep", "zgrep", "rg", "cat", "head", "tail", "more", "hexdump", "od", "strings", "stat", "ls", "lsblk",
  "sha1sum", "sha256sum", "sha512sum", "md5sum", "cksum", "cmp", "wc", "df", "mount", "findmnt", "lsof", "fuser", "readlink", "realpath", "test", "[",
  "get-item", "get-content", "get-disk", "get-partition", "get-volume", "get-physicaldisk", "gi", "gc",
]);
/** A reader's known read-only options: `letters` are short flags that take
 * no value (they may be clustered), `values` short options that take one
 * (separate or glued), `long` and `longValues` the same for `--name` forms,
 * `exact` whole words for tools with single-dash long options (`xxd -ps`).
 * `operand` says which operands it reads: every one, or only the first. */
interface ReaderMode { letters: string; values: string; long?: string[]; longValues?: string[]; exact?: string[]; exactValues?: string[]; glued?: RegExp; operand: "any" | "first"; noPlus?: true }
const READER_MODES: Record<string, ReaderMode> = {
  // `xxd in [out]`: the second operand is written; `-r` writes the first's bytes back
  xxd: { letters: "", values: "", exact: ["-a", "-autoskip", "-b", "-bits", "-C", "-capitalize", "-E", "-EBCDIC", "-e", "-h", "-help", "-i", "-include", "-p", "-ps", "-postscript", "-plain", "-u", "-uppercase", "-d", "-decimal", "-v", "-version"], exactValues: ["-c", "-cols", "-g", "-groupsize", "-l", "-len", "-n", "-name", "-o", "-offset", "-s", "-seek", "-R"], glued: /^-[cglos][-+0-9]/, operand: "first" },
  // `-o` (output), `-U` (store-and-forward) and `-P` (pid file) write
  pv: { letters: "ptIerab8kTnqcWglfxvCEYKX0ShV", values: "AFDsimwHNLBZdR", long: ["--progress", "--timer", "--eta", "--fineta", "--rate", "--average-rate", "--bytes", "--bits", "--numeric", "--quiet", "--wait", "--line-mode", "--null", "--force", "--no-splice", "--skip-errors", "--stop-at-size", "--direct-io", "--discard", "--sync", "--help", "--version"], longValues: ["--size", "--name", "--interval", "--width", "--height", "--rate-limit", "--buffer-size", "--format", "--delay-start"], operand: "any" },
  // identify, geometry, timings, power mode, temperature: every setter and erase is out
  hdparm: { letters: "IigtTCHvh", values: "", long: ["--direct", "--help"], operand: "any" },
  // health and logs; `-t` (test), `-s`/`-o`/`-S` (settings), `-X` and `--set` are out
  smartctl: { letters: "aAixcHjgVh", values: "ldnqfTrvF", long: ["--all", "--info", "--health", "--xall", "--capabilities", "--attributes", "--json", "--scan", "--scan-open", "--identify", "--help", "--usage", "--version", "--copyright", "--license"], longValues: ["--log", "--device", "--nocheck", "--format", "--quietmode", "--tolerance", "--report", "--vendorattribute", "--firmwarebug", "--get", "--json", "--identify"], operand: "any" },
  // the device read is an operand; one given to `-c`/`-w` is a cache file written
  blkid: { letters: "dlpikgvVh", values: "ostnuOScwLU", long: ["--no-encoding", "--garbage-collect", "--list-filesystems", "--info", "--probe", "--list-one", "--no-part-details", "--help", "--version"], longValues: ["--cache-file", "--output", "--label", "--uuid", "--match-tag", "--match-token", "--offset", "--size", "--usages"], operand: "any" },
  // `-w` writes patterns, `-n` rewrites in place, `-o` writes the list to a file
  badblocks: { letters: "sfvBX", values: "bcdeiopt", operand: "first" },
  // `ddrescue in out [map]`: the first operand is read, the others are written
  ddrescue: { letters: "dDfnNqvMRSu", values: "abcrsioeKTm", long: ["--help", "--version", "--verbose", "--quiet", "--idirect", "--no-scrape", "--no-trim", "--reverse"], longValues: ["--size", "--input-position", "--sector-size", "--cluster-size"], operand: "first" },
  // `-C` compiles a magic file and writes it
  // a pager that only shows what it reads: no `+` start command (`+v` opens
  // the editor), no log file (`-o`, `-O`, `--log-file`), no key file
  // (`-k`, `--lesskey-*`, which can set the input preprocessor); every
  // option listed here only changes how the text is shown
  less: { letters: "aABcCdeEfFgGiIJKLmMnNqQrRsSuUVwWX~", values: "bhjxyz#pP", long: ["--quit-at-eof", "--QUIT-AT-EOF", "--quit-if-one-screen", "--ignore-case", "--IGNORE-CASE", "--line-numbers", "--LINE-NUMBERS", "--chop-long-lines", "--raw-control-chars", "--RAW-CONTROL-CHARS", "--no-init", "--force", "--squeeze-blank-lines", "--quiet", "--silent", "--QUIET", "--SILENT", "--long-prompt", "--LONG-PROMPT", "--status-column", "--hilite-search", "--HILITE-SEARCH", "--hilite-unread", "--HILITE-UNREAD", "--no-lessopen", "--use-color", "--wordwrap", "--follow-name", "--incsearch", "--no-keypad", "--tilde", "--help", "--version"], longValues: ["--tabs", "--shift", "--window", "--max-back-scroll", "--max-forw-scroll", "--pattern", "--prompt", "--header"], operand: "any", noPlus: true },
  file: { letters: "bcdEhiklLnNprsSvzZ0", values: "eFfmP", long: ["--brief", "--mime", "--mime-type", "--mime-encoding", "--apple", "--extension", "--dereference", "--no-dereference", "--keep-going", "--special-files", "--uncompress", "--uncompress-noreport", "--raw", "--no-pad", "--print0", "--preserve-date", "--no-sandbox", "--help", "--version"], longValues: ["--exclude", "--files-from", "--magic-file", "--separator", "--parameter"], operand: "any" },
};

/** The operand indexes of a reader in a known read-only mode, or undefined
 * when any word is an option outside its row (a writing one, or one the row
 * does not know). An option's value is no operand. */
function readerOperands(row: ReaderMode, texts: string[]): number[] | undefined {
  const operands: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    if (text === "--") { for (let j = i + 1; j < texts.length; j++) operands.push(j); break; }
    // a `+` start command runs a pager command (`less +v` edits)
    if (row.noPlus && text.startsWith("+")) return undefined;
    if (!text.startsWith("-") || text === "-") { operands.push(i); continue; }
    if (row.exact?.includes(text)) continue;
    if (row.exactValues?.includes(text)) { i++; continue; }
    if (row.glued?.test(text)) continue;
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const option = eq > 0 ? text.slice(0, eq) : text;
      if (eq < 0 && row.long?.includes(option)) continue;
      if (row.longValues?.includes(option)) { if (eq < 0) i++; continue; }
      return undefined;
    }
    if (row.exact) return undefined;
    // a cluster of flags, which may end in an option that takes a value
    for (let k = 1; k < text.length; k++) {
      const letter = text[k]!;
      if (row.values.includes(letter)) { if (k === text.length - 1) i++; break; }
      if (!row.letters.includes(letter)) return undefined;
    }
  }
  return operands;
}

/** `cp`, `install`: the options that take a value, and the one naming the destination folder. */
const COPY_VALUES: Record<string, string> = { cp: "tS", install: "tSmog" };
/** `rsync` read-only flags: a source device is read only with these, and the last operand is the destination. */
const RSYNC_MODE: ReaderMode = { letters: "avzrlptgoDhPnqcHAXxSWuiIEm", values: "", long: ["--archive", "--verbose", "--compress", "--recursive", "--progress", "--copy-devices", "--sparse", "--checksum", "--stats", "--human-readable", "--partial", "--dry-run", "--itemize-changes", "--times", "--perms", "--links", "--hard-links"], longValues: ["--info"], operand: "any" };
const DISKUTIL_READS = new Set(["info", "list", "listplist", "verifyvolume", "verifydisk", "mount", "unmount", "unmountdisk", "eject"]);
const PARTITION_TOOLS = new Set(["fdisk", "sfdisk", "gdisk", "parted"]);
/** Options of a partition tool that change only how a listing looks. */
const PARTITION_QUIET: Record<string, Set<string>> = {
  parted: new Set(["-s", "--script", "-m", "--machine"]),
};

/** Does `name` read a device at argument `index` (`texts` are the literal
 * argument texts)? A device anywhere else is a write the reader cannot rule out. */
export function deviceReadPosition(name: string, texts: Array<string | undefined>, index: number): boolean {
  if (PURE_READERS.has(name)) return true;
  const row = READER_MODES[name];
  if (row) {
    if (texts.some((text) => text === undefined)) return false;
    const operands = readerOperands(row, texts as string[]);
    if (!operands?.includes(index)) return false;
    return row.operand === "any" || operands[0] === index;
  }
  if (name === "dd") return (texts[index] ?? "").startsWith("if=");
  if (name === "cp" || name === "rsync" || name === "install") {
    // every source operand: an option, an option's value and the destination
    // (the last operand, or the folder `-t` names) are no source
    if (texts.some((text) => text === undefined)) return false;
    const words = texts as string[];
    if (name === "rsync") {
      const operands = readerOperands(RSYNC_MODE, words);
      return !!operands?.includes(index) && index !== operands[operands.length - 1];
    }
    const values = COPY_VALUES[name]!;
    const operands: number[] = [];
    let target: number | undefined;
    for (let i = 0; i < words.length; i++) {
      const text = words[i]!;
      if (text === "--") { for (let j = i + 1; j < words.length; j++) operands.push(j); break; }
      if (!text.startsWith("-") || text === "-") { operands.push(i); continue; }
      if (text.startsWith("--")) {
        if (text.startsWith("--target-directory")) { target = text.includes("=") ? i : i + 1; if (!text.includes("=")) i++; continue; }
        if (text === "--suffix") i++;
        continue;
      }
      for (let k = 1; k < text.length; k++) {
        const letter = text[k]!;
        if (!values.includes(letter)) continue;
        const glued = k < text.length - 1;
        if (letter === "t") target = glued ? i : i + 1;
        if (!glued) i++;
        break;
      }
    }
    const destination = target ?? operands[operands.length - 1];
    return operands.includes(index) && index !== destination;
  }
  if (name === "diskutil") {
    const verbs = texts.filter((text) => text !== undefined && !text.startsWith("-")).map((text) => text!.toLowerCase());
    // `diskutil apfs list…` reads; any other apfs verb can erase
    if (verbs[0] === "apfs") return (verbs[1] ?? "").startsWith("list");
    return DISKUTIL_READS.has(verbs[0] ?? "");
  }
  if (PARTITION_TOOLS.has(name)) {
    // a listing and nothing else: every word is a device, a list option or
    // (parted) the one `print` verb; any other option or action word, or a
    // word the text does not fix, may change the table
    if (texts.some((text) => text === undefined)) return false;
    const others = (texts as string[]).filter((text) => deviceInWord(text) === undefined && !(PARTITION_QUIET[name] ?? new Set()).has(text));
    if (name === "parted") {
      const listing = others.filter((text) => text === "-l" || text === "--list" || text === "print");
      return others.length === listing.length && listing.length >= 1;
    }
    return others.length >= 1 && others.every((text) => text === "-l" || text === "--list");
  }
  return diagnosticRead(name, texts, index);
}

/** Read-only verbs of the disk diagnostics, by tool (`DEVICE_READERS`). */
const DIAGNOSTIC_VERBS: Record<string, Set<string>> = {
  udevadm: new Set(["info", "monitor"]),
  udisksctl: new Set(["info", "status", "dump"]),
  nvme: new Set(["list", "id-ctrl", "id-ns", "smart-log", "error-log", "fw-log"]),
  zpool: new Set(["status", "list", "get"]),
  zfs: new Set(["status", "list", "get"]),
};

const PARTX_SHOW = new Set(["-s", "--show", "-o", "--output", "-b", "--bytes", "-g", "--noheadings", "-n", "--nr", "-P", "--pairs", "-r", "--raw", "-v", "--verbose", "-S", "--sector-size", "--list-types"]);

/** The diagnostic rows of `DEVICE_READERS`: a disk path a read-only verb or
 * option reads stays ordinary. Any writing verb or option anywhere in the
 * command, or a word the text does not fix, makes it no reader. */
function diagnosticRead(name: string, texts: Array<string | undefined>, index: number): boolean {
  if (texts.some((text) => text === undefined)) return false;
  const words = texts as string[];
  const options = words.filter((text) => text.startsWith("-") && text.length > 1);
  const verbs = words.filter((text) => !(text.startsWith("-") && text.length > 1));
  const verbRow = DIAGNOSTIC_VERBS[name];
  if (verbRow) return verbs.length > 0 && verbRow.has(verbs[0]!.toLowerCase()) && words[index] !== verbs[0];
  if (name === "blockdev") return options.some((text) => text.startsWith("--get") || text === "--report") && options.every((text) => text.startsWith("--get") || text === "--report" || text === "-q" || text === "-v");
  // `--show` and the options that only shape its listing; `-a`, `-d`, `-u` change the table
  if (name === "partx") return options.some((text) => text === "-s" || text === "--show") && options.every((text) => PARTX_SHOW.has(text.replace(/=.*$/, "")) || /^-o.+/.test(text));
  // `fsck -n`: the check that writes nothing; `-f` and `-v` change nothing else
  if (name.startsWith("fsck")) {
    const letters = options.filter((text) => !text.startsWith("--")).map((text) => text.slice(1)).join("");
    return options.every((text) => !text.startsWith("--")) && letters.includes("n") && /^[nfv]+$/.test(letters);
  }
  return false;
}


/** The value of a name as one string, so two states can be compared. A
 * name never bound, bound to something the text does not fix, or bound to
 * a value with an expansion in it are all "?" to the reader: nothing it
 * would trust as a path on its own. */
function valueKey(ctx: WalkContext, name: string): string {
  const value = ctx.bound.get(name);
  return fixed(value) ? JSON.stringify(value.map(renderWord)) : "?";
}

/** Branches that may or may not have run, folded back into the state they
 * started from. A name bound the same way everywhere keeps its value; a name
 * that differs (a literal in one branch, something else in another) is
 * marked, and wherever its value would have been trusted later, the reader
 * asks instead. The folder is marked the same way. */
/** Branches that may or may not have run, folded back into the state they
 * started from. A name bound the same way everywhere keeps its value; a name
 * that differs (a literal in one branch, something else in another) is
 * marked, and wherever its value would have been trusted later, the reader
 * asks instead. The folder is marked the same way. A file written in a
 * branch may have been written; written differently by branch, its content
 * is a value. */
function merge(ctx: WalkContext, forks: WalkContext[]): void {
  const names = new Set<string>(ctx.bound.keys());
  for (const branch of forks) for (const name of branch.bound.keys()) names.add(name);
  for (const name of names) {
    const entry = valueKey(ctx, name);
    if (forks.some((branch) => valueKey(branch, name) !== entry)) {
      ctx.bound.set(name, null);
    } else if (entry === "?") {
      // every state has a value the reader does not trust on its own, but
      // the parts it knows (`$HOME/x`) still count: keep all of them
      const union: Word[] = [];
      const seen = new Set<string>();
      for (const state of [ctx, ...forks]) for (const word of state.bound.get(name) ?? []) { const key = JSON.stringify(word); if (!seen.has(key)) { seen.add(key); union.push(word); } }
      if (union.length > MAX_CANDIDATES) throw new Unreadable("expansion", "too many values");
      ctx.bound.set(name, union.length ? union : null);
    }
  }
  for (const branch of forks) {
    for (const name of branch.arrays) ctx.arrays.add(name);
    for (const name of branch.readonly) { ctx.readonly.add(name); unknownName(name, ctx); }
    if (branch.opaque) ctx.opaque = true;
    // a function defined only in a branch, or defined differently by
    // branch, is one the reader cannot name the body of: a call asks
    for (const [name, shape] of branch.functions) {
      const known = ctx.functions.get(name);
      if (!known || known.key !== shape.key || shape.conflict) ctx.functions.set(name, { ...(known ?? shape), forkBomb: (known?.forkBomb ?? false) || shape.forkBomb, conflict: true });
    }
    for (const [path, provenance] of branch.written) {
      const known = ctx.written.get(path);
      if (!known) ctx.written.set(path, provenance);
      else if (JSON.stringify(known) !== JSON.stringify(provenance)) ctx.written.set(path, { kind: "value", why: "a file written differently by branch" });
    }
    for (const [path, target] of branch.links) ctx.links.set(path, target);
    // a name linked differently by branch: one identity is kept, and what it
    // holds is a value when either side held anything
    for (const [path, id] of branch.inodes) {
      const known = ctx.inodes.get(path);
      if (known === id) continue;
      const held = ctx.written.has(known ?? path) || branch.written.has(id);
      ctx.inodes.set(path, id);
      if (held) ctx.written.set(id, { kind: "value", why: "a file linked differently by branch" });
    }
    if (branch.cwdConflict || branch.cwd !== ctx.cwd) ctx.cwdConflict = true;
    if (branch.trapCalls) ctx.trapCalls = new Set([...(ctx.trapCalls ?? []), ...branch.trapCalls]);
  }
  if (ctx.cwdConflict) ctx.cwd = undefined;
}


/** Run each branch in its own fork of `ctx`, then merge them all back. */
function branches<H>(ctx: WalkContext, runs: Array<(branch: WalkContext) => H | null>): H | null {
  const forks: WalkContext[] = [];
  for (const run of runs) {
    const branch = fork(ctx);
    const hit = run(branch);
    if (hit) return hit;
    forks.push(branch);
  }
  merge(ctx, forks);
  return null;
}

interface WrapperSpec {
  /** options that stand alone (`--opt=value` is also accepted for these) */
  flags: Set<string>;
  /** options that take the next word (or the rest of the cluster) as a value */
  values: Set<string>;
  /** options whose value is a script the wrapper runs (`env -S`, `su -c`) */
  scripts?: Set<string>;
  /** positional words before the command (timeout's duration, su's user) */
  positional?: number;
  /** `NAME=value` words before the command are the wrapper's (env, sudo) */
  assignments?: boolean;
  /** `-5` style numbers are options (nice) */
  numeric?: boolean;
  /** the command's arguments come from stdin (xargs) */
  xargs?: boolean;
  /** every word from the wrapper to the end of the command has to be fixed
   * by the text (env, xargs): a value anywhere in it asks */
  plainWords?: boolean;
  /** options whose value is the folder the command runs from (`env -C`) */
  cwd?: Set<string>;
  /** options that run the command as a login, from the target's home folder (`sudo -i`) */
  login?: Set<string>;
  /** options whose value names the target user (`sudo -u`) */
  user?: Set<string>;
  /** the first positional word names the target user (`su bob`) */
  userPositional?: boolean;
  /** the command runs from the target's home folder unless this option is given (`pkexec`) */
  homeUnless?: string;
  /** the first positional word is the new root, and the command runs from it unless this option is given (`chroot`) */
  rootUnless?: string;
}

const spec = (flags: string, values: string, extra: Partial<WrapperSpec> = {}): WrapperSpec => ({
  flags: new Set(flags.split(/\s+/).filter(Boolean)),
  values: new Set(values.split(/\s+/).filter(Boolean)),
  ...extra,
});

/** Programs that run the rest of the line as a command of their own, with
 * every option they take. An option outside this table asks: the table
 * only has to be correct, never complete. */
const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: spec(
    "-A -b -E -H -i -K -k -l -n -P -S -s -V -v --askpass --background --preserve-env --set-home --login --remove-timestamp --reset-timestamp --list --non-interactive --preserve-groups --stdin --shell --version --validate --help",
    "-u -g -h -p -C -D -r -t -T -U -R --user --group --host --prompt --close-from --chdir --role --type --command-timeout --other-user --chroot",
    { assignments: true, cwd: new Set(["-D", "--chdir"]), login: new Set(["-i", "--login"]), user: new Set(["-u", "--user"]) },
  ),
  doas: spec("-L -n -s", "-u -C"),
  run0: spec(
    "--no-ask-password --slice-inherit --no-pager --help --version -h",
    "-u -g -D -E -M --unit --property --description --slice --user --group --nice --chdir --setenv --background --machine",
    { cwd: new Set(["-D", "--chdir"]) },
  ),
  pkexec: spec("--version --disable-internal-agent --help --keep-cwd", "--user", { user: new Set(["--user"]), homeUnless: "--keep-cwd" }),
  env: spec(
    "-i -0 -v --ignore-environment --null --debug --help --version",
    "-u -C --unset --chdir --block-signal --default-signal --ignore-signal --list-signal-handling",
    { scripts: new Set(["-S", "--split-string"]), assignments: true, plainWords: true, cwd: new Set(["-C", "--chdir"]) },
  ),
  nice: spec("--help --version", "-n --adjustment", { numeric: true }),
  timeout: spec("--preserve-status --foreground -v --verbose --help --version", "-k -s --kill-after --signal", { positional: 1 }),
  xargs: spec(
    "-0 -r -t -p -x -o --null --no-run-if-empty --verbose --interactive --exit --open-tty --help --version --show-limits",
    "-a -E -e -I -i -L -l -n -P -s -d --arg-file --eof --replace --max-lines --max-args --max-procs --max-chars --delimiter --process-slot-var",
    { xargs: true, plainWords: true },
  ),
  nohup: spec("--help --version", ""),
  command: spec("-p -v -V", ""),
  exec: spec("-c -l", "-a"),
  builtin: spec("", ""),
  time: spec("-p -a -v -q --append --verbose --quiet --portability --help --version", "-f -o --format --output"),
  caffeinate: spec("-d -i -m -s -u", "-t -w"),
  su: spec(
    "- -l -m -p -P -f --login --preserve-environment --pty --fast --help --version",
    "-s -g -G --shell --group --supp-group",
    { scripts: new Set(["-c", "--command"]), positional: 1, login: new Set(["-", "-l", "--login"]), userPositional: true },
  ),
  script: spec(
    "-a -e -f -k -q -r -V -h -B --append --return --flush --quiet --version --help",
    "-F -t -T -o -m -E -I -O --log-in --log-out --log-io --log-timing --output-limit --echo",
    { scripts: new Set(["-c", "--command"]), positional: 1 },
  ),
  setsid: spec("-c -f -w --ctty --fork --wait --help --version", ""),
  stdbuf: spec("--help --version", "-i -o -e --input --output --error"),
  ionice: spec("-t --ignore --help --version", "-c -n -p -P -u --class --classdata --pid --pgid --uid"),
  unbuffer: spec("-p", ""),
  chronic: spec("-e -v", ""),
  parallel: spec("--will-cite -k --keep-order -0 --null -q --quote", "-j --jobs -n -N -a --arg-file -I -S --sshlogin --colsep -d --delim", { xargs: true, plainWords: true }),
  watch: spec("-b -c -d -e -g -n -p -t -x --beep --color --differences --errexit --chgexit --interval --precise --no-title --exec", "-n --interval"),
  chroot: spec("--help --version --skip-chdir", "--userspec --groups", { positional: 1, rootUnless: "--skip-chdir" }),
  unshare: spec("-r -m -u -i -n -p -U -C -T -f --fork --map-root-user --mount --uts --ipc --net --pid --user --cgroup --time", "-w --wd -S -G --setuid --setgid --kill-child --mount-proc", { cwd: new Set(["-w", "--wd"]) }),
  nsenter: spec("-a --all -m -u -i -n -p -U -C -T --preserve-credentials", "-t --target -r --root -w --wd -S -G", { cwd: new Set(["-w", "--wd"]) }),
  flock: spec("-s -x -u -n -o -c -E --shared --exclusive --unlock --nonblock --close --conflict-exit-code", "-w --timeout -E", { scripts: new Set(["-c", "--command"]), positional: 1 }),
  taskset: spec("-a --all-tasks -p --pid", "-c --cpu-list", { positional: 1 }),
  chrt: spec("-f -r -b -o -i -d -a -p -R --fifo --rr --batch --other --idle --deadline --all-tasks --pid --reset-on-fork", "-T -P -D", { positional: 1 }),
  "systemd-run": spec("--scope --user --system --pty -P --pipe -p --wait --collect --no-block -q --quiet -G", "--unit --description --slice --property --uid --gid --nice --setenv --working-directory -E -p", { cwd: new Set(["--working-directory"]) }),
  strace: spec("-f -ff -v -x -xx -c -C -i -q -qq -r -t -tt -ttt -T -y -yy -z -Z", "-e -o -p -s -P -u -E -b -a -O -S -X", { positional: 0 }),
  ltrace: spec("-f -i -r -t -tt -ttt -T -S -C -w", "-e -o -p -s -u -A -n -x -l"),
};

const ELEVATORS = new Set(["sudo", "doas", "run0", "pkexec"]);
/** Interpreters of languages the reader does not model: their inline code
 * (`INLINE_CODE`), a heredoc or literal stdin into them, or a file this text
 * wrote is scanned (`scanOpaque`). */
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "luajit", "osascript", "tclsh", "rscript"]);
/** Capability commands, emitters and listers: a function or alias by one of
 * these names (or a wrapper's, a shell's, an interpreter's, or a builtin the
 * reader relies on) changes what the rules read, and asks. */
const CAPABILITY_NAMES = new Set([
  "rm", "unlink", "rmdir", "rd", "del", "erase", "remove-item", "ri", "find",
  "dd", "mke2fs", "newfs", "wipefs", "shred", "diskutil", "format", "mknod",
  "cp", "mv", "ln", "install", "rsync", "truncate", "chmod", "chown", "chgrp", "chflags", "setfacl", "tee", "sed", "perl",
  "copy", "xcopy", "robocopy", "move", "ren", "icacls", "takeown", "attrib",
  "set-content", "sc", "add-content", "ac", "out-file", "copy-item", "cpi", "move-item", "mi", "rename-item", "rni", "clear-content", "clc", "set-acl",
  "echo", "printf", "cat", "fd", "fdfind", "ls", "git", "grep", "rg", "egrep", "fgrep", "cd", "pushd", "popd",
  "command", "builtin", "exec", "eval", "trap", "read", "set", "shift", "unset", "source", ".",
]);
function isShadowed(name: string): boolean {
  return CAPABILITY_NAMES.has(name) || name.startsWith("mkfs") || name in WRAPPERS || ELEVATORS.has(name) || SHELLS.has(name) || interpreterKey(name) !== undefined;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);
const BINDERS = new Set(["export", "local", "declare", "typeset", "readonly"]);
/** builtins that assign names the text does not spell out */
const OPAQUE = new Set(["eval", "source", ".", "let", "mapfile", "readarray", "getopts"]);
const MOVES_CWD = new Set(["cd", "pushd", "popd", "chdir"]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const POSITIONAL = /^(\d+|[@*#])$/;
/** `=`, `++` or `--` in arithmetic: a name may change */
const ASSIGNS_IN_ARITH = /=|\+\+|--/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
/** Something ran that can assign any name. */
const OPAQUE_EFFECTS: BodyEffects = { assigns: new Set(), opaque: true, movesCwd: false, defines: [] };
/** A sourced file: it can assign any name and move anywhere. */
const SOURCE_EFFECTS: BodyEffects = { assigns: new Set(), opaque: true, movesCwd: true, defines: [] };

/** Every word in these positions has to be fixed by the text. */
function plainWords(words: Word[], where: string): void {
  for (const word of words) if (!isPlain(word)) throw new Unreadable("expansion", `a value in ${where}`);
}

function unreachable(value: never): never {
  throw new Error(`unmodeled node ${JSON.stringify(value)}`);
}

/** `rm` for `/bin/rm`, `~/bin/rm`, `"rm"`, `r''m`; undefined when the name
 * is not fixed by the text (`$cmd`, `$BIN/$x`, `rm$IFS-rf`). Only the last
 * path segment has to be literal: `$(dirname "$0")/run.sh` runs `run.sh`. */
export function resolveName(word: Word): string | undefined {
  let text = "";
  let slashAt = 0;
  let dynamicAt = -1;
  for (const part of word.parts) {
    if (part.kind === "lit") {
      const slash = Math.max(part.text.lastIndexOf("/"), part.text.lastIndexOf("\\"));
      if (slash >= 0) slashAt = text.length + slash + 1;
      text += part.text;
    } else {
      text += part.kind === "tilde" ? `~${part.user}` : "\u0001";
      dynamicAt = text.length;
    }
  }
  // the last segment is fixed only when every value sits before a `/`
  if (dynamicAt > slashAt) return undefined;
  const base = text.slice(slashAt);
  return base === "" ? undefined : base.toLowerCase();
}

/** What a word can stand for once the names bound in this text are put in:
 * one word, or several for `${X:-y}`, a bound name with several values, or
 * `{a,b}`. A name whose value differs by branch comes out marked, and the
 * rules ask where they would otherwise have trusted it. */
export function expandWord(word: Word, ctx: WalkContext): Word[] {
  let candidates: Part[][] = [[]];
  const multiply = (options: Part[][]) => {
    const next: Part[][] = [];
    for (const head of candidates) for (const option of options) next.push([...head, ...option]);
    if (next.length > MAX_CANDIDATES) throw new Unreadable("expansion", "too many values");
    candidates = next;
  };
  for (const part of word.parts) {
    switch (part.kind) {
      case "var": {
        const bound = ctx.bound.get(part.name);
        const unknown: Part = { kind: "var", name: part.name, quote: part.quote };
        const own: Part[][] = bound ? bound.map((w) => w.parts) : [[unknown]];
        if (part.op === undefined) { multiply(own); break; }
        const fallback = part.word ? expandWord(part.word, ctx).map((w) => w.parts) : [[]];
        if (part.op === ":+" || part.op === "+") { multiply([...fallback, []]); break; }
        if (part.op === ":-" || part.op === "-" || part.op === ":=" || part.op === "=") {
          // with a colon an empty value takes the fallback too: a value bound
          // empty, or one that may come out empty, stands for both
          const colon = part.op.startsWith(":");
          const takesFallback = !bound || (colon && bound.some(mayBeEmpty));
          const kept = bound && colon ? own.filter((parts) => !isEmptyParts(parts)) : own;
          const values = takesFallback ? [...(bound ? kept : own), ...fallback] : own;
          if (part.op === ":=" || part.op === "=") { if (ctx.readonly.has(part.name)) unknownName(part.name, ctx); else ctx.bound.set(part.name, (bound && !takesFallback ? own : values).map((parts) => ({ parts }))); }
          multiply(values.length ? values : [[]]);
          break;
        }
        multiply([[unknown]]);
        break;
      }
      case "brace": multiply(part.alts.map((alt) => alt.parts)); break;
      case "lit": case "tilde": case "glob": case "subst": case "arith": case "procsub": multiply([[part]]); break;
      default: unreachable(part);
    }
  }
  return candidates.map((parts) => ({ parts }));
}

/** Parts that are empty for sure: no part, or only empty literals. */
function isEmptyParts(parts: Part[]): boolean {
  return parts.every((part) => part.kind === "lit" && part.text === "");
}

/** Can this value come out empty? Empty for sure, or made only of parts the
 * text does not fix (a name, a substitution) and empty literals. */
function mayBeEmpty(word: Word): boolean {
  return word.parts.every((part) => (part.kind === "lit" && part.text === "") || part.kind === "var" || part.kind === "subst" || part.kind === "arith" || part.kind === "brace");
}

/** Every candidate an operand stands for (`operandsOf` for one word): the
 * values this text bound put in (`${X:-y}` both ways), braces multiplied out,
 * links this text made followed. A part the text does not fix makes the
 * candidate a value; an unquoted value the shell would split or glob is a
 * value too. */
export function candidatesOf(word: Word, ctx: WalkContext): Candidate[] {
  const reshaped = word.parts.some((part) => part.kind === "var" && part.quote === "none" && (ctx.bound.get(part.name) ?? []).some((value) => value.parts.some((p) => p.kind === "glob" || (p.kind === "lit" && /[\s*?[]/.test(p.text)))));
  const out: Candidate[] = [];
  for (const expanded of expandWord(word, ctx)) {
    for (const one of braceCandidates(expanded)) {
      const candidate = candidateOf(one, ctx);
      out.push(reshaped && candidate.kind !== "value" ? { kind: "value", why: "a value the shell splits or globs", path: candidate.path, lead: false } : candidate);
      if (out.length > MAX_CANDIDATES) throw new Unreadable("expansion", "too many values");
    }
  }
  return out;
}

function candidateOf(word: Word, ctx: WalkContext): Candidate {
  // an item xargs reads from a list file on disk (`xargsItems`)
  for (const part of word.parts) if (part.kind === "var" && part.name.startsWith(FROM_FILE)) return { kind: "fromFile", path: part.name.slice(FROM_FILE.length) };
  let path = "";
  let text = "";
  let value: string | undefined;
  let lead = false;
  let globAt = -1;
  for (const [index, part] of word.parts.entries()) {
    switch (part.kind) {
      case "tilde": path += `~${part.user}`; text += `~${part.user}`; break;
      case "lit": {
        if (index === 0 && /^[~$]/.test(part.text)) path += LITERAL_MARK;
        if (part.quote === "none" && globAt < 0) {
          // `[u]sr` is a glob to the shell
          const open = part.text.indexOf("[");
          if (open >= 0 && part.text.indexOf("]", open + 1) > open) globAt = path.length + open;
        }
        path += part.text;
        text += part.text;
        break;
      }
      case "glob": if (globAt < 0) globAt = path.length; path += part.text; text += part.text; break;
      case "var":
        if (part.op === undefined && homeVar(part.name, ctx)) { path += "~"; text += "~"; break; }
        value ??= `$${part.name}`;
        if (index === 0) lead = true;
        path += UNKNOWN_MARK;
        break;
      case "subst": case "arith": case "procsub": case "brace":
        value ??= "a substitution";
        if (index === 0) lead = true;
        path += UNKNOWN_MARK;
        break;
      default: unreachable(part);
    }
  }
  if (value !== undefined) return { kind: "value", why: value, path, lead };
  if (globAt >= 0) {
    const prefix = unmarked(path.slice(0, globAt));
    const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const anchor = slash < 0 ? "." : slash === 0 ? "/" : prefix.slice(0, slash);
    return { kind: "glob", anchor: resolveFrom(ctx.cwd, anchor), path };
  }
  // a link this text made stands for what it points to
  const link = resolvePath(ctx, path);
  if (link !== resolveFrom(ctx.cwd, path)) return { kind: "literal", text: link, path: link };
  return { kind: "literal", text, path };
}

/** The simple command the rules see, its operands read through `candidatesOf`. */
export function simpleCommand(name: string, args: Word[], ctx: WalkContext, extra: { redirects?: Redirect[]; elevated?: boolean; derived?: boolean; operands?: Candidate[][]; stdin?: Provenance; program?: SimpleCommand["program"] } = {}): SimpleCommand {
  const operands = extra.operands ?? args.map((arg) => candidatesOf(arg, ctx));
  return {
    name, args, operands, redirects: extra.redirects ?? [], elevated: !!(extra.elevated || ctx.elevated), ...(extra.derived ? { derived: true as const } : {}), ...(extra.stdin ? { stdin: extra.stdin } : {}),
    ...(extra.program ? { program: extra.program } : {}),
  };
}

/** How xargs (or parallel) splits what it reads, from its own options. */
interface XargsOptions {
  nul: boolean;
  delimiter?: string;
  replace?: string;
}

function xargsOptions(words: Word[]): XargsOptions {
  const options: XargsOptions = { nul: false };
  const unescape = (d: string) => (d === "\\n" ? "\n" : d === "\\t" ? "\t" : d === "\\0" ? "\0" : d);
  for (let i = 0; i < words.length; i++) {
    const text = literalText(words[i]!) ?? "";
    const next = () => literalText(words[++i] ?? { parts: [] }) ?? "";
    if (text === "-0" || text === "--null") options.nul = true;
    else if (text === "-d" || text === "--delimiter" || text === "--delim") options.delimiter = unescape(next());
    else if (/^-d./.test(text)) options.delimiter = unescape(text.slice(2));
    else if (/^--delim(iter)?=/.test(text)) options.delimiter = unescape(text.slice(text.indexOf("=") + 1));
    else if (text === "-I") options.replace = next();
    else if (/^-I./.test(text)) options.replace = text.slice(2);
    else if (text === "-i" || text === "--replace") options.replace = "{}";
    else if (/^-i./.test(text)) options.replace = text.slice(2);
    else if (text.startsWith("--replace=")) options.replace = text.slice(10) || "{}";
  }
  return options;
}

/** What xargs reads, split the way xargs splits it: blanks and newlines
 * separate, quotes and backslashes group; `-0` splits on NUL, `-d` on its
 * delimiter, `-I` takes one line per item. */
function tokenizeXargs(text: string, options: XargsOptions): string[] {
  if (options.nul) return text.split("\0").filter((token) => token !== "");
  if (options.delimiter !== undefined) return text.split(options.delimiter).filter((token) => token !== "");
  if (options.replace !== undefined) return text.split("\n").map((line) => line.replace(/^[ \t]+/, "")).filter((line) => line !== "");
  const tokens: string[] = [];
  let current: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) { if (current !== undefined) tokens.push(current); current = undefined; continue; }
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Unreadable("quote", `${c} in what xargs reads`);
      current = (current ?? "") + text.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === "\\") { current = (current ?? "") + (text[i + 1] ?? ""); i++; continue; }
    current = (current ?? "") + c;
  }
  if (current !== undefined) tokens.push(current);
  return tokens;
}

/** A token another program hands over as an argument: literal, except that
 * a leading `~` may be the home folder an emitter's shell expanded. */
function tokenWord(token: string): Word {
  const tilde = /^~[A-Za-z0-9._-]*/.exec(token);
  if (!tilde) return { parts: [{ kind: "lit", text: token, quote: "single" }] };
  const rest = token.slice(tilde[0].length);
  return { parts: [{ kind: "tilde", user: tilde[0].slice(1) }, ...(rest ? [{ kind: "lit", text: rest, quote: "single" } as Part] : [])] };
}

/** `word` with every `match` in its literal text replaced by `replacement`'s parts. */
function spliceWord(word: Word, match: string, replacement: Word): Word {
  const parts: Part[] = [];
  for (const part of word.parts) {
    if (part.kind !== "lit" || !part.text.includes(match)) { parts.push(part); continue; }
    const pieces = part.text.split(match);
    pieces.forEach((piece, index) => {
      if (index > 0) parts.push(...replacement.parts);
      if (piece) parts.push({ kind: "lit", text: piece, quote: part.quote });
    });
  }
  return { parts };
}

/** `env -S "a b"`: the script split as env splits it, into words. */
function splitScript(text: string): Word[] {
  const words: Word[] = [];
  for (const token of lex(text)) {
    if (token.kind === "word") words.push(token.word);
    else if (token.kind !== "eof") throw new Unreadable("wrapper-option", "an operator in env -S");
  }
  return words;
}

interface Unwrapped {
  words: Word[];
  xargs?: XargsOptions;
  derived: boolean;
  elevated: boolean;
  /** a script a wrapper runs (`su -c`, `script -c`, `flock -c`), with the
   * words after it as its positional parameters */
  script?: Word;
  positionals?: Word[];
  alternatives?: Word[][];
  /** every wrapper's own arguments, as written, and each value glued to its
   * option (`-C/x`, `--chdir=/x`) as a word of its own */
  wrapperArgs: Word[];
  /** the folder a wrapper moved the command to (`env -C`, `sudo -D`, a
   * login); `path` undefined when the text does not fix it */
  cwd?: { path?: string };
}

/** A value glued to its option, as a word: `~` and `~user` at its start are
 * the home folder, as the conservative reading. */
function gluedWord(text: string): Word {
  const tilde = /^~([A-Za-z0-9._-]*)((?:\/.*)?)$/s.exec(text);
  if (tilde) return { parts: [{ kind: "tilde", user: tilde[1]! }, ...(tilde[2] ? [{ kind: "lit" as const, text: tilde[2], quote: "single" as const }] : [])] };
  return { parts: [{ kind: "lit", text, quote: "single" }] };
}

/** The command after its wrappers: `sudo -u root rm -rf /` is `rm -rf /`.
 * An elevator (or `su` with a script) marks the result elevated; `env -S`
 * splits its script into the command's words. */
function unwrap(words: Word[], ctx: WalkContext): Unwrapped {
  let rest = words;
  let xargs: XargsOptions | undefined;
  let derived = false;
  let elevated = false;
  const wrapperArgs: Word[] = [];
  let cwd: { path?: string } | undefined;
  const done = (extra: Partial<Unwrapped> = {}): Unwrapped => ({ words: rest, derived, elevated, wrapperArgs, ...(xargs ? { xargs } : {}), ...(cwd ? { cwd } : {}), ...extra });
  // `env -C DIR`: the folder the command runs from, read as `cd DIR` reads it
  const moveTo = (word: Word | undefined) => {
    const base = cwd ? cwd.path : ctx.cwd;
    const conflict = cwd ? cwd.path === undefined : ctx.cwdConflict;
    let list: Candidate[] = [];
    try { list = word ? candidatesOf(word, ctx) : []; } catch (error) { if (!(error instanceof Unreadable)) throw error; }
    const only = list.length === 1 ? list[0]! : undefined;
    if (!only || only.kind !== "literal" || (conflict && !isAnchored(homeSpelled(only.path)))) { cwd = {}; return; }
    const next = resolveFrom(base, only.path);
    cwd = isAnchored(next) ? { path: next } : {};
  };
  for (;;) {
    if (rest.length === 0) return done();
    const substituted = substituteLead(rest, ctx);
    derived ||= substituted.derived;
    const { lists } = substituted;
    // `command -v $c` with `for c in a b`: one wrapped command per program
    if (lists.length > 1) return done({ alternatives: lists });
    rest = lists[0]!;
    const name = resolveName(rest[0]!);
    const wrapper = name === undefined ? undefined : WRAPPERS[name];
    if (!wrapper) return done();
    if (wrapper.plainWords) plainWords(rest, `${name}'s command`);
    if (ELEVATORS.has(name!)) elevated = true;
    let i = 1;
    let positional = 0;
    let script: Word | undefined;
    let login = false;
    let user: Word | undefined;
    let root: Word | undefined;
    const seen = new Set<string>();
    // an option's value: the folder it moves to, the user it names
    const valueOf = (option: string, value: Word | undefined) => {
      if (wrapper.cwd?.has(option)) moveTo(value);
      if (wrapper.user?.has(option)) user = value;
    };
    while (i < rest.length && !script) {
      const word = rest[i]!;
      // 1.0.5 r8: `env "$n=x" node …`: a name a value gives may be a loader variable
      if (wrapper.assignments && literalText(word) === undefined && !assignmentOf(word)) markLoaderVariable(ctx.loaders, `${name} with a value in its arguments`);
      const setName = wrapper.assignments ? literalText(word)?.match(/^([^=]+)=/)?.[1] : undefined;
      if (setName !== undefined && isLoaderName(setName)) markLoaderVariable(ctx.loaders, setName);
      if (wrapper.assignments && assignmentOf(word)) {
        // `env HOME=$x cmd`: what the command sees is not in the text
        if (!isPlain(word)) throw new Unreadable("expansion", `a value in ${name}'s assignments`);
        i++;
        continue;
      }
      // `flock ~ cmd`: a home folder is a positional word like any other
      const text = literalText(word) ?? (isPlain(word) ? renderWord(word) : undefined);
      if (text === undefined) break;
      if (text === "--") { i++; break; }
      if (text.startsWith("--") && text.length > 2) {
        const eq = text.indexOf("=");
        const option = eq < 0 ? text : text.slice(0, eq);
        seen.add(option);
        if (wrapper.scripts?.has(option)) {
          script = eq < 0 ? rest[i + 1] : { parts: [{ kind: "lit", text: text.slice(eq + 1), quote: "single" }] };
          if (!script) throw new Unreadable("wrapper-option", text);
          i += eq < 0 ? 2 : 1;
        } else if (wrapper.values.has(option)) {
          const value = eq < 0 ? rest[i + 1] : gluedWord(text.slice(eq + 1));
          if (eq >= 0) wrapperArgs.push(value!);
          valueOf(option, value);
          i += eq < 0 ? 2 : 1;
        } else if (wrapper.flags.has(option) || wrapper.flags.has(text)) {
          if (wrapper.login?.has(option)) login = true;
          i++;
        } else {
          throw new Unreadable("wrapper-option", text);
        }
        continue;
      }
      if (text.startsWith("-") && text.length > 1 || (text === "-" && wrapper.flags.has("-"))) {
        if (text === "-") { if (wrapper.login?.has("-")) login = true; i++; continue; }
        if (wrapper.numeric && /^-\d+$/.test(text)) { i++; continue; }
        if (wrapper.flags.has(text) && text.length > 2) { if (wrapper.login?.has(text)) login = true; i++; continue; }
        let consumedNext = false;
        for (let j = 1; j < text.length; j++) {
          const option = `-${text[j]}`;
          // getopt's `-C/x`; pflag's `-C=/x` too, read both ways
          const glued = text.slice(j + 1);
          if (wrapper.scripts?.has(option)) {
            script = glued ? { parts: [{ kind: "lit", text: glued, quote: "single" }] } : rest[i + 1];
            if (!script) throw new Unreadable("wrapper-option", text);
            consumedNext = !glued;
            break;
          }
          if (wrapper.values.has(option)) {
            consumedNext = !glued;
            if (glued) {
              const value = gluedWord(glued.startsWith("=") && glued.length > 1 ? glued.slice(1) : glued);
              wrapperArgs.push(value);
              if (glued.startsWith("=") && glued.length > 1) wrapperArgs.push(gluedWord(glued));
              valueOf(option, value);
            } else {
              valueOf(option, rest[i + 1]);
            }
            break;
          }
          if (!wrapper.flags.has(option)) throw new Unreadable("wrapper-option", text);
          if (wrapper.login?.has(option)) login = true;
        }
        i += consumedNext ? 2 : 1;
        continue;
      }
      if (wrapper.assignments && ASSIGNMENT.test(text)) { i++; continue; }
      if ((wrapper.positional ?? 0) > positional) {
        if (positional === 0 && wrapper.userPositional) user = word;
        if (positional === 0 && wrapper.rootUnless) root = word;
        positional++;
        i++;
        continue;
      }
      break;
    }
    if (wrapper.xargs) xargs = xargsOptions(rest.slice(1, i));
    wrapperArgs.push(...rest.slice(1, i));
    // `chroot DIR cmd` runs cmd from DIR's top; `sudo -i`, `su -` and
    // `pkexec` from the target's home folder (`~user`, or `~root`)
    if (root && !seen.has(wrapper.rootUnless!)) moveTo(root);
    if (login || (wrapper.homeUnless && !seen.has(wrapper.homeUnless))) {
      const named = user ? literalText(user) : "root";
      cwd = { path: named !== undefined && /^[A-Za-z0-9._-]+$/.test(named) ? `~${named}` : "~" };
    }
    if (script) {
      // `su -c "$x"`, `env -S "ls $d"`: a script the text does not fix
      plainWords([script, ...rest.slice(i)], `${name}'s script`);
      if (name === "env") {
        // `env -S "rm -rf" /usr`: one command, the split script then the
        // rest. env reads the split words as its own arguments, so they go
        // back through env: `env -S 'X=1 rm -rf ~'` sets X and runs rm
        rest = [rest[0]!, ...splitScript(renderWord(script)), ...rest.slice(i)];
        continue;
      }
      if (name === "su") elevated = true;
      const positionals = rest.slice(i);
      rest = [];
      return done({ script, positionals });
    }
    rest = rest.slice(i);
  }
}

/** What a command's own redirects say it reads on stdin: a heredoc or
 * here-string (the last one wins, as in a shell), a file it names, a value
 * for a duplicated descriptor; undefined for no input redirect. */
function provenanceOfRedirects(redirects: Redirect[], ctx: WalkContext): Provenance | undefined {
  let result: Provenance | undefined;
  for (const redirect of redirects) {
    if (redirect.fd !== undefined && redirect.fd !== 0) continue;
    if (redirect.heredoc) {
      const { body, quoted } = redirect.heredoc;
      // an unquoted body expands `$`, backticks and backslashes before the
      // reader of the heredoc sees it
      result = quoted || !/[$`\\]/.test(body) ? { kind: "literal", text: body, words: [] } : { kind: "value", why: "a heredoc with an expansion or escape" };
    } else if (redirect.op === "<<<" && redirect.target) {
      const target = redirect.target;
      result = isPlain(target) ? { kind: "literal", text: renderWord(target), words: [target] } : { kind: "value", why: "a here-string with a value" };
    } else if (redirect.op === "<" && redirect.target) {
      const candidates = candidatesOf(redirect.target, ctx);
      const only = candidates.length === 1 ? candidates[0]! : undefined;
      result = only?.kind === "literal" ? { kind: "file", path: resolvePath(ctx, only.text) } : { kind: "value", why: "input from a file a value names" };
    } else if (redirect.op === "<&" || redirect.op === "<>") {
      result = { kind: "value", why: "input from a descriptor" };
    }
  }
  return result;
}

/** What a command reads on stdin: its own redirect, else what the command to
 * its left in the pipe writes, else what the enclosing compound was given. */
function stdinProvenance(command: Command, before: Command[], ctx: WalkContext): Provenance | undefined {
  const own = provenanceOfRedirects(command.redirects, ctx);
  if (own) return own;
  if (before.length) return outputOf(before[before.length - 1]!, before.slice(0, -1), ctx);
  return ctx.stdin;
}

/** What a command writes on stdout, computed and never assumed: an emitter
 * with literal words (`echo` without escapes, `printf` without directives),
 * an identity (`cat` with no operand, `tee` to literal files) passing its
 * own input through, `cat` of one literal file, a lister's paths. Every
 * other command's output is a value, whatever its flags. */
function outputOf(command: Command, before: Command[], ctx: WalkContext): Provenance {
  if (command.kind !== "simple" || command.words.length === 0) return { kind: "value", why: "the output of a compound command" };
  const name = resolveName(command.words[0]!);
  const args = command.words.slice(1);
  if (name === "echo") {
    let words = args;
    let escapes = false;
    if (/^-[neE]+$/.test(literalText(words[0] ?? { parts: [] }) ?? "")) {
      escapes = /e/.test(literalText(words[0]!)!);
      words = words.slice(1);
    }
    const joined = words.map(renderWord).join(" ");
    if (escapes || joined.includes("\\") || !words.every(isPlain)) return { kind: "value", why: "echo with an escape or a value" };
    return { kind: "literal", text: joined, words };
  }
  if (name === "printf") {
    const words = args.filter((word, index) => !(index === 0 && literalText(word) === "--"));
    const joined = words.map(renderWord).join(" ");
    const format = words[0] ? renderWord(words[0]) : "";
    if (/[%\\]/.test(format) || joined.includes("\\") || !words.every(isPlain)) return { kind: "value", why: "printf with a directive, an escape or a value" };
    return { kind: "literal", text: joined, words: [] };
  }
  if (name === "cat") {
    if (args.every((word) => literalText(word) === "-")) return stdinProvenance(command, before, ctx) ?? { kind: "value", why: "cat of input the text does not show" };
    const only = args.length === 1 ? literalText(args[0]!) : undefined;
    if (only !== undefined && !only.startsWith("-")) return { kind: "file", path: resolvePath(ctx, only) };
    return { kind: "value", why: "cat of several files or a value" };
  }
  if (name === "tee" && args.every((word) => literalText(word) !== undefined && !literalText(word)!.startsWith("-"))) {
    return stdinProvenance(command, before, ctx) ?? { kind: "value", why: "tee of input the text does not show" };
  }
  const roots = name === undefined ? undefined : listerRoots(name, args, ctx);
  if (roots) return { kind: "roots", roots };
  const download = name === undefined ? undefined : downloader(name, args);
  if (download && download.output === undefined) return { kind: "remote", url: download.url };
  // a line filter keeps some of a lister's lines, whole and unchanged: its
  // output is paths under the same roots. A line filter or a carriage-return
  // strip (`crStrip`) adds nothing to a file this text did not write, or to
  // a download: what comes out is still that file's or that address's, out
  // of reach as they are (`cat install.sh | tr -d '\r' | sh`). Any other
  // transformer's output is a value
  if (name !== undefined && (lineFilter(name, args) || crStrip(name, args))) {
    const input = stdinProvenance(command, before, ctx);
    if (input?.kind === "roots" && lineFilter(name, args)) return input;
    if (input?.kind === "file" && !ctx.written.has(resolveWritten(ctx, input.path))) return input;
    if (input?.kind === "remote") return input;
  }
  return { kind: "value", why: `the output of ${name ?? "a value"}` };
}

const lit = (text: string): Word => ({ parts: [{ kind: "lit", text, quote: "none" }] });
const optionSet = (text: string) => new Set(text.split(/\s+/).filter(Boolean));

/** Options of the line filters (`sort`, `uniq`, `head`, `tail`, `grep`): each
 * keeps whole input lines and changes none. No file operand, no output file,
 * nothing that cuts or numbers a line (`head -c`, `uniq -c`, `grep -o`). */
const LINE_FILTERS: Record<string, { flags: Set<string>; values: Set<string>; pattern?: true }> = {
  sort: { flags: optionSet("-r -u -n -V -h -f -z -s -b -d -R -g -M --reverse --unique --numeric-sort --version-sort --human-numeric-sort --ignore-case --zero-terminated --stable --random-sort"), values: optionSet("-k -t --key --field-separator") },
  uniq: { flags: optionSet("-u -d -i -z --unique --repeated --ignore-case --zero-terminated"), values: new Set() },
  head: { flags: optionSet("-z --zero-terminated"), values: optionSet("-n --lines") },
  tail: { flags: optionSet("-z --zero-terminated"), values: optionSet("-n --lines") },
  grep: { flags: optionSet("-v -i -E -F -G -w -x -z -s --invert-match --ignore-case --extended-regexp --fixed-strings --word-regexp --line-regexp --null-data"), values: optionSet("-e --regexp"), pattern: true },
};

/** `crStrip`: a filter that deletes carriage returns and nothing else:
 * `tr -d` whose one set is a carriage return, `dos2unix` reading stdin, and
 * `sed` whose one program deletes carriage returns. Taking out a carriage
 * return cannot uncomment a line or make a word. */
const CR_SET = new Set(["\r", "\\r", "\\015", "\\15", "\\x0d", "\\x0D"]);
const SED_CR = /^s(.)\\r\$?\1\1g?$/;
function crStrip(name: string, args: Word[]): boolean {
  const texts = args.map(literalText);
  if (texts.some((text) => text === undefined)) return false;
  if (name === "dos2unix") return texts.every((text) => text === "-q" || text === "--quiet");
  const options = texts.filter((text) => text!.startsWith("-") && text!.length > 1);
  const operands = texts.filter((text) => !(text!.startsWith("-") && text!.length > 1));
  if (name === "tr") return options.length >= 1 && options.every((text) => text === "-d" || text === "--delete") && operands.length === 1 && CR_SET.has(operands[0]!);
  if (name === "sed") {
    const programs = texts.filter((text, i) => !text!.startsWith("-") || texts[i - 1] === "-e");
    return options.every((text) => text === "-e") && programs.length === 1 && SED_CR.test(programs[0]!);
  }
  return false;
}

/** Downloader options that send a local file (`-d @f`, `-T f`, `-K f`, a
 * wget input list): the response may depend on what is on disk. */
const DOWNLOAD_READS_FILE = optionSet("-F --form -T --upload-file -K --config -i --input-file");
/** Downloader options that take the next word as a value. */
const DOWNLOAD_VALUES = optionSet("-H --header -A --user-agent -U -X --request -e --referer -u --user -m --max-time --connect-timeout --retry --retry-delay -t --tries --timeout -w --write-out --proto --proto-redir -d --data --data-raw --data-binary --data-urlencode");
/** `OUTPUT_OPTIONS`: the options by which a program writes a file it is
 * given. Additive only: a file in this position is marked written. */
const OUTPUT_OPTIONS = optionSet("-o -O --output --out --outfile --output-file --output-document --log-file --logfile");

/** The file an output option names, for the word at `i` (`-o f`, `-of`,
 * `--output=f`, `of=f`), with the index of the last word it used. */
function outputOption(texts: string[], i: number, name?: string): { file: string; last: number } | undefined {
  const text = texts[i]!;
  if (text.startsWith("of=")) return { file: text.slice(3), last: i };
  if (OUTPUT_OPTIONS.has(text)) return texts[i + 1] === undefined ? undefined : { file: texts[i + 1]!, last: i + 1 };
  const eq = text.indexOf("=");
  if (text.startsWith("--") && eq > 0 && OUTPUT_OPTIONS.has(text.slice(0, eq))) return { file: text.slice(eq + 1), last: i };
  // glued to its file, whatever the file's name (`-oapp`, `-oout.bin`,
  // `-Ofile`); `-O-` and `-qO-` write to stdout. A compiler's `-O2`, `-Os`,
  // `-Ofast` is an optimization level, not a file, for a build tool only
  if (/^-[A-Za-z]*[oO]-$/.test(text)) return { file: "-", last: i };
  const lower = /^-o(.+)$/.exec(text);
  if (lower) return { file: lower[1]!, last: i };
  const upper = /^-O(.+)$/.exec(text);
  if (upper && !(name !== undefined && isBuildTool(name) && /^(\d+|s|z|g|fast)$/.test(upper[1]!))) return { file: upper[1]!, last: i };
  // last in a cluster of short flags (`-sSLo f`, `-qO f`)
  if (/^-[A-Za-z]+$/.test(text) && OUTPUT_OPTIONS.has(`-${text[text.length - 1]}`) && text.length > 2) return texts[i + 1] === undefined ? undefined : { file: texts[i + 1]!, last: i + 1 };
  return undefined;
}

/** A word that reads as a file: it has a folder separator or an extension. */
export function pathShaped(text: string): boolean {
  return !text.startsWith("-") && (/[\\/]/.test(text) || /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(text));
}

/** `DOWNLOADERS`: `curl`, `wget` or `fetch` with exactly one literal operand
 * that is an https address, and no option that sends a local file. Its
 * output is `remote`; with an output option (other than `-` for stdout) it
 * writes that file instead (`output`). Undefined for anything else. */
function downloader(name: string, args: Word[]): { url: string; output?: string } | undefined {
  if (name !== "curl" && name !== "wget" && name !== "fetch") return undefined;
  const texts = args.map(literalText);
  if (texts.some((text) => text === undefined)) return undefined;
  const words = texts as string[];
  const operands: string[] = [];
  let output: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const text = words[i]!;
    if (text === "--") { operands.push(...words.slice(i + 1)); break; }
    if (!text.startsWith("-") || text === "-") { operands.push(text); continue; }
    if (DOWNLOAD_READS_FILE.has(text) || /^--(form|upload-file|config|input-file)=/.test(text)) return undefined;
    const out = outputOption(words, i);
    if (out) { if (out.file !== "-") output = out.file; i = out.last; continue; }
    const eq = text.indexOf("=");
    const option = text.startsWith("--") && eq > 0 ? text.slice(0, eq) : text;
    if (DOWNLOAD_VALUES.has(option)) {
      const value = option === text ? words[++i] : text.slice(eq + 1);
      if (value === undefined) return undefined;
      // `-d @file` sends a file
      if (/^-(d|-data)/.test(option) && value.startsWith("@")) return undefined;
      continue;
    }
    // `-T`, `-F`, `-K` or `-i` in a cluster of short flags
    if (!text.startsWith("--") && /[FTKi]/.test(text.slice(1))) return undefined;
  }
  if (operands.length !== 1 || !operands[0]!.startsWith("https://")) return undefined;
  return { url: operands[0]!, ...(output !== undefined ? { output } : {}) };
}

function lineFilter(name: string, args: Word[]): boolean {
  const row = LINE_FILTERS[name === "egrep" || name === "fgrep" ? "grep" : name];
  if (!row) return false;
  const texts = args.map(literalText);
  if (texts.some((text) => text === undefined)) return false;
  let pattern = !row.pattern;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    if (row.flags.has(text)) continue;
    if (row.values.has(text)) { if (++i >= texts.length) return false; if (text === "-e" || text === "--regexp") pattern = true; continue; }
    // `-n5`, `-5`, `--lines=5`, `-k2`: a value glued on
    if (/^-(n|k|t)./.test(text) && row.values.has(text.slice(0, 2))) continue;
    if (/^--(lines|key|field-separator)=/.test(text) && row.values.has(text.slice(0, text.indexOf("=")))) continue;
    if ((name === "head" || name === "tail") && /^-\d+$/.test(text)) continue;
    if (row.pattern && !pattern && !text.startsWith("-")) { pattern = true; continue; }
    return false;
  }
  return pattern;
}

/** `LISTERS`: commands whose output is paths under their roots, with every
 * option they may take. One option outside the row, or any value, and the
 * output is a value. */
const FIND_LISTER = optionSet("-name -iname -path -ipath -wholename -iwholename -regex -iregex -type -mtime -mmin -atime -amin -ctime -cmin -newer -newermt -size -empty -maxdepth -mindepth -user -group -perm -links -xdev -mount -depth -prune -print -print0 -not ! -a -and -o -or ( ) -L -H -P -follow -nowarn -regextype -daystart");
const FIND_LISTER_FLAGS = optionSet("-empty -xdev -mount -depth -prune -print -print0 -not ! -a -and -o -or ( ) -L -H -P -follow -nowarn -daystart");
const FD_LISTER_FLAGS = optionSet("-H --hidden -I --no-ignore -0 --print0 -a --absolute-path -g --glob -i -s -F --fixed-strings -p --full-path");
const FD_LISTER_VALUES = optionSet("-e --extension -t --type -d --max-depth -E --exclude");
const LS_LISTER = optionSet("-1 -a -A -d -t -r -S -U -f -p --color=never");
const GIT_LS_FILES_FLAGS = optionSet("-o --others -m --modified -c --cached -z --exclude-standard -i --ignored --directory --full-name");
const GREP_LISTER_FLAGS = optionSet("-r -R -i -E -F -G -P -w -x -s -q -z -n -H -h -a -l -L --files-with-matches --files-without-match");
const GREP_LISTER_VALUES = optionSet("-e --include --exclude --exclude-dir");
const GREPS = new Set(["grep", "rg", "egrep", "fgrep"]);

/** The roots a lister prints paths under, or undefined when it is not one. */
function listerRoots(name: string, args: Word[], ctx: WalkContext): Word[] | undefined {
  const texts = args.map(literalText);
  if (texts.some((text) => text === undefined)) return undefined;
  const t = texts as string[];
  const here = (): Word => lit(ctx.cwd ?? ".");
  if (name === "find") {
    const roots: Word[] = [];
    let i = 0;
    for (; i < t.length && !(t[i]!.startsWith("-") || t[i] === "!" || t[i] === "(" || t[i] === ")"); i++) roots.push(args[i]!);
    for (; i < t.length; i++) {
      if (!FIND_LISTER.has(t[i]!)) return undefined;
      if (!FIND_LISTER_FLAGS.has(t[i]!) && ++i >= t.length) return undefined;
    }
    return roots.length ? roots : [lit(".")];
  }
  if (name === "fd" || name === "fdfind") {
    const operands: Word[] = [];
    for (let i = 0; i < t.length; i++) {
      const option = t[i]!.includes("=") && t[i]!.startsWith("--") ? t[i]!.slice(0, t[i]!.indexOf("=")) : t[i]!;
      if (FD_LISTER_VALUES.has(option)) { if (option === t[i] && ++i >= t.length) return undefined; continue; }
      if (FD_LISTER_FLAGS.has(t[i]!)) continue;
      if (t[i]!.startsWith("-")) return undefined;
      operands.push(args[i]!);
    }
    const roots = operands.slice(1);
    return roots.length ? roots : [here()];
  }
  if (name === "ls") {
    const roots: Word[] = [here()];
    for (let i = 0; i < t.length; i++) {
      const text = t[i]!;
      if (text.startsWith("--")) { if (!LS_LISTER.has(text)) return undefined; continue; }
      if (text.startsWith("-") && text.length > 1) { for (const letter of text.slice(1)) if (!LS_LISTER.has(`-${letter}`)) return undefined; continue; }
      roots.push(args[i]!);
    }
    return roots;
  }
  if (name === "git") {
    if (t[0] !== "ls-files") return undefined;
    for (let i = 1; i < t.length; i++) {
      if (GIT_LS_FILES_FLAGS.has(t[i]!) || t[i]!.startsWith("--exclude=")) continue;
      if (t[i] === "--exclude") { if (++i >= t.length) return undefined; continue; }
      return undefined;
    }
    return [here()];
  }
  if (GREPS.has(name)) {
    let lists = false;
    let pattern = false;
    const operands: Word[] = [];
    for (let i = 0; i < t.length; i++) {
      const text = t[i]!;
      const option = text.startsWith("--") && text.includes("=") ? text.slice(0, text.indexOf("=")) : text;
      if (GREP_LISTER_VALUES.has(option)) { if (option === "-e") pattern = true; if (option === text && ++i >= t.length) return undefined; continue; }
      if (text.startsWith("--")) { if (!GREP_LISTER_FLAGS.has(text)) return undefined; if (/files-with/.test(text)) lists = true; continue; }
      if (text.startsWith("-") && text.length > 1) {
        for (const letter of text.slice(1)) {
          if (!GREP_LISTER_FLAGS.has(`-${letter}`)) return undefined;
          if (letter === "l" || letter === "L") lists = true;
        }
        continue;
      }
      operands.push(args[i]!);
    }
    if (!lists) return undefined;
    const roots = pattern ? operands : operands.slice(1);
    return roots.length ? roots : [here()];
  }
  return undefined;
}

/** UPSEC 10.4 remote provenance: text downloaded from a literal https
 * address this text names (`DOWNLOADERS`), run by a shell or an interpreter
 * without elevation, directly or saved with an output option and run. false:
 * ordinary, because the text names its source as a path to a script on disk
 * does (section 5). The one rule in the r4 delta Sean may decide
 * differently: set it to true and every such run asks. An elevated run asks
 * either way (`runsRemote`). */
export const ASK_UNELEVATED_REMOTE_RUN = false;

/** The detail of the ask for downloaded text run elevated; the card names it. */
export const REMOTE_ELEVATED = "runs downloaded text elevated";

/** Downloaded text is about to run: elevated it asks; unelevated it follows
 * `ASK_UNELEVATED_REMOTE_RUN`. */
export function runsRemote(elevated: boolean): void {
  if (elevated) throw new Unreadable("expansion", REMOTE_ELEVATED);
  if (ASK_UNELEVATED_REMOTE_RUN) throw new Unreadable("expansion", "runs downloaded text");
}

/** The program a shell runs: its `-c` word (with `$0` and the positional
 * parameters after it), a script file it names, or its stdin. Undefined for
 * an interactive shell with nothing the text shows. */
type ShellProgram =
  | { kind: "text"; texts: string[]; zero?: Word; positionals: Word[]; fromStdin?: true }
  | { kind: "file"; path: string; positionals: Word[]; fromStdin?: true };

/** The startup file `--rcfile`/`--init-file` names: a file this text wrote,
 * or nothing for the null device; anything else asks (1.0.4 U17 r2). */
function startupFile(word: Word | undefined, ctx: WalkContext, option: string): Provenance | undefined {
  if (!word) throw new Unreadable("syntax", `${option} without a file`);
  const candidates = candidatesOf(word, ctx);
  const only = candidates.length === 1 ? candidates[0]! : undefined;
  if (only?.kind !== "literal") throw new Unreadable("expansion", `a shell reads a startup file a value names (${option})`);
  if (isNullInput(only.text)) return undefined;
  const written = ctx.written.get(resolveWritten(ctx, only.text));
  if (!written) throw new Unreadable("opaque", `a shell reads a startup file the reader does not see (${option})`);
  return written;
}

/** Long options of the shells that take no value and run nothing (1.0.5 r3). */
const SHELL_LONG_OPTIONS = new Set(["--norc", "--noprofile", "--posix", "--noediting", "--restricted", "--verbose", "--login", "--interactive", "--version", "--help", "--no-rcs", "--no-globalrcs", "--no-config", "--no-execute", "--private"]);

function shellScript(args: Word[], stdin: Provenance | undefined, ctx: WalkContext, elevated: boolean, startup: Array<Provenance | undefined> = []): ShellProgram | undefined {
  let i = 0;
  let hasC = false;
  // `bash -s`: the script is stdin, and every operand is a positional (1.0.5 r2)
  let hasS = false;
  for (; i < args.length; i++) {
    const text = literalText(args[i]!);
    if (text === undefined) break;
    if (text === "--") { i++; break; }
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") { i++; continue; }
    // `bash --rcfile x -i`: an interactive shell runs its startup file first
    // (1.0.4 U17 r2). One this text wrote is read as it was written; one on
    // disk the reader does not see, or a value, asks
    if (text === "--rcfile" || text === "--init-file") { startup.push(startupFile(args[i + 1], ctx, text)); i++; continue; }
    // fish's `-C`/`--init-command` runs its value as code before anything
    // else (1.0.5 r3): code the reader is not shown in the shell's own words
    if (/^--init-command(=|$)/.test(text) || /^-[A-Za-z]*C/.test(text)) throw new Unreadable("opaque", `a shell runs an init command (${text.split("=")[0]})`);
    if (/^[-+][A-Za-z]+$/.test(text)) { if (text.startsWith("-") && text.includes("c")) hasC = true; if (text.startsWith("-") && text.includes("s")) hasS = true; continue; }
    // a long option the reader does not know may take a value or run code
    if (text.startsWith("--")) { if (SHELL_LONG_OPTIONS.has(text)) continue; throw new Unreadable("opaque", `a shell option the reader does not know (${text.split("=")[0]})`); }
    break;
  }
  if (hasC) {
    const word = args[i];
    if (!word) throw new Unreadable("syntax", "-c without a script");
    // the script and the arguments it reads as `$0`, `$1`… have to be fixed by the text
    plainWords(args, "a script a shell runs");
    const zero = args[i + 1];
    return { kind: "text", texts: [renderWord(word)], ...(zero ? { zero } : {}), positionals: args.slice(i + 2) };
  }
  const operand = args[i];
  const operandText = operand ? literalText(operand) : undefined;
  if (operand && !hasS && operandText !== "-s" && operandText !== "-") {
    // `bash script.sh`: a file; one this text wrote is read as it was written
    const candidates = candidatesOf(operand, ctx);
    const only = candidates.length === 1 ? candidates[0]! : undefined;
    if (only?.kind === "literal") return { kind: "file", path: resolvePath(ctx, only.text), positionals: args.slice(i + 1) };
    // 1.0.4 U17: a script a value names is one the reader cannot see
    throw new Unreadable("expansion", ctx.written.size ? "a shell runs a file a value names, after this text wrote files" : "a shell runs a file a value names");
  }
  const positionals = operand ? args.slice(hasS ? i : i + 1) : [];
  if (!stdin) return undefined;
  switch (stdin.kind) {
    case "literal": {
      // echo's words are also read one by one: `echo rm -rf ~` and
      // `echo 'rm' '-rf' '~'` reach the shell in whatever split the text gives
      const texts = [stdin.text, ...stdin.words.map(renderWord)];
      return { kind: "text", texts, positionals, fromStdin: true };
    }
    case "file": return { kind: "file", path: stdin.path, positionals, fromStdin: true };
    case "roots": throw new Unreadable("expansion", "a shell reads the paths a lister prints");
    case "value": throw new Unreadable("expansion", `a shell reads ${stdin.why}`);
    case "remote": runsRemote(elevated); return undefined;
    default: return unreachable(stdin);
  }
}

/** Inline-code options of the interpreters (`INTERPRETERS`). */
export const INLINE_CODE: Record<string, RegExp> = {
  python: /^-[A-Za-z]*c$/,
  node: /^(-e|--eval|-p|--print|-pe)$/,
  deno: /^(eval)$/,
  bun: /^(-e|--eval|-p|--print|-pe)$/,
  perl: /^-[A-Za-z0-9]*[eE]$/,
  ruby: /^-[A-Za-z]*e$/,
  php: /^-r$/,
  lua: /^-e$/,
  osascript: /^-e$/,
  rscript: /^-e$/,
  tclsh: /^$/,
};
/** Interpreter options that take the next word as a value. */
export const INTERPRETER_VALUES = new Set(["-W", "-X", "-r", "--require", "--import", "--loader", "-C", "--conditions", "-I", "-M", "-l", "-x"]);

/** Letters `INTERPRETER_VALUES` lists that are plain flags in a bundle for
 * this interpreter: perl's `-l` takes digits only, ruby's `-l` none, and
 * python's `-I` none. */
const BUNDLE_FLAGS: Record<string, string> = { perl: "l", ruby: "l", python: "I" };

/** Does this interpreter option take the next word as its value? Not the
 * `BUNDLE_FLAGS` letters: perl's `-l` takes only attached digits (`-l015`),
 * ruby's `-l` and python's `-I` nothing, so `perl -l -e <code>` reads its
 * code as `perl -e <code>` does. */
export function takesValue(key: string, text: string): boolean {
  if (!INTERPRETER_VALUES.has(text)) return false;
  return !(text.length === 2 && (BUNDLE_FLAGS[key] ?? "").includes(text[1]!));
}

/** Where the code starts in an inline-code option written with its code
 * attached (1.0.3 A-b1-1): `--eval=CODE` and `--print=CODE` (the option is
 * the part before `=`), `-eCODE`, `-pCODE`, `-rCODE`, and a short-option
 * bundle whose inline letter takes the rest (`-lneCODE`, `-IcCODE`). A letter
 * that takes a value (`INTERPRETER_VALUES`, python's `-m`) ends the bundle:
 * `-Wonce` and `-rjson` are not code. */
function attachedAt(key: string, text: string): number | undefined {
  const inline = INLINE_CODE[key];
  if (!inline || !text.startsWith("-") || text === "-") return undefined;
  if (text.startsWith("--")) {
    const eq = text.indexOf("=");
    return eq > 2 && inline.test(text.slice(0, eq)) ? eq + 1 : undefined;
  }
  for (let k = 2; k <= text.length; k++) {
    if (inline.test(text.slice(0, k))) return k;
    const letter = text[k - 1]!;
    if (key === "python" && letter === "m") return undefined;
    if (INTERPRETER_VALUES.has(`-${letter}`) && !(BUNDLE_FLAGS[key] ?? "").includes(letter)) return undefined;
  }
  return undefined;
}

/** The code of an inline-code option written with its code attached, as a
 * word of its own (its quoting and any expansion kept), or undefined when the
 * word is not one. Shared by the POSIX and PowerShell readers. */
export function attachedInlineCode(key: string, word: Word): Word | undefined {
  let head = "";
  for (const part of word.parts) {
    if (part.kind !== "lit") break;
    head += part.text;
  }
  const at = attachedAt(key, head);
  if (at === undefined) return undefined;
  const parts: Part[] = [];
  let skip = at;
  for (const part of word.parts) {
    if (skip > 0 && part.kind === "lit") {
      if (part.text.length <= skip) { skip -= part.text.length; continue; }
      parts.push({ ...part, text: part.text.slice(skip) });
      skip = 0;
      continue;
    }
    parts.push(part);
  }
  return parts.length ? { parts } : undefined;
}

export function interpreterKey(name: string): string | undefined {
  if (/^python[0-9.]*$/.test(name)) return "python";
  if (name === "node" || name === "nodejs") return "node";
  if (name === "luajit") return "lua";
  // `R -e` and `Rscript -e` run the same language
  if (name === "rscript" || name === "r") return "rscript";
  return INTERPRETERS.has(name) ? name : undefined;
}

/** The program an interpreter runs: inline code, a script file, its stdin. */
type InterpreterProgram = { kind: "code"; words: Word[]; rest: Word[] } | { kind: "file"; path: string } | { kind: "stdin" } | { kind: "none" };

function interpreterProgram(key: string, args: Word[], ctx: WalkContext): InterpreterProgram {
  const inline = INLINE_CODE[key]!;
  // R reads `.Rprofile` from the folder first (1.0.5 r8, server/shell/loaders.ts)
  if (key === "rscript" && rReadsProfile(args.map(literalText))) throw new Unreadable("opaque", "R reads a profile first");
  const code: Word[] = [];
  // the index of the last code word: the words after it are the code's own arguments
  let last = -1;
  // 1.0.5 r8: node and php read their own options after inline code too
  // (`node -e 1 -r ./x.js`): one there that loads code first asks
  const inlineCode = (): InterpreterProgram => {
    const rest = args.slice(last + 1);
    if (key === "node" || key === "php" || key === "bun" || key === "deno") {
      for (const [at, word] of rest.entries()) {
        const text = literalText(word);
        if (text === undefined) continue;
        const next = rest[at + 1] ? literalText(rest[at + 1]!) : undefined;
        if (loadsCodeFirst(key, text, next) || ((key === "bun" || key === "deno") && runnerOption(key, text) === "preload")) throw new Unreadable("opaque", `${key} loads code first (${text.split("=")[0]})`);
      }
    }
    return { kind: "code", words: code, rest };
  };
  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    // the option on its own (`-e`, `-pe`) takes the next word, below
    const attached = text !== undefined && inline.test(text) ? undefined : attachedInlineCode(key, args[i]!);
    if (attached) {
      code.push(attached);
      last = i;
      if (key === "python" || key === "node" || key === "php" || key === "deno") break;
      continue;
    }
    if (text === undefined) return code.length ? inlineCode() : interpreterFile(args[i]!, ctx);
    // `node -r ./x.js`, `ruby -I dir`, `perl -MX`, `php -d auto_prepend_file=x`:
    // code that runs before the program, an empty or an inline one too, and
    // after inline code for the interpreters that read options there
    // (1.0.5 r6, r8: server/shell/loaders.ts, shared with the PowerShell reader)
    if (loadsCodeFirst(key, text, literalText(args[i + 1] ?? { parts: [] }))) throw new Unreadable("opaque", `${key} loads code first (${text.split("=")[0]})`);
    if (text !== "" && inline.test(text)) {
      const word = args[i + 1];
      if (!word) throw new Unreadable("opaque", `${text} without code`);
      code.push(word);
      i++;
      last = i;
      // python, node and php stop at their code; perl, ruby, osascript take more
      if (key === "python" || key === "node" || key === "php" || key === "deno") break;
      continue;
    }
    if (code.length) { if (key === "perl" || key === "ruby" || key === "osascript" || key === "lua") continue; break; }
    // deno and bun take a subcommand (`bun install`, `deno test`); `run`
    // names a package script, or a file when it has a folder or an extension
    // (1.0.4 U17: read as the PowerShell reader reads them)
    if ((key === "deno" || key === "bun") && !text.startsWith("-")) {
      if (text !== "run") return runnerTarget(args[i]!, ctx);
      // `deno run -A x.ts`, `bun run --watch x.ts`: the options a run takes come
      // before its script; one the reader does not know may take the next word
      // (1.0.4 U17 r2), so where the script starts is unknown and it asks
      let at = i + 1;
      for (; at < args.length; at++) {
        const option = literalText(args[at]!);
        if (option === undefined || !option.startsWith("-")) break;
        if (option === "--") { at++; break; }
        const flags = RUNNER_FLAGS[key]!;
        const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
        // `--preload x.ts`, `-r x.ts`: code that runs before the script, a file
        // the run does not show the reader (1.0.4 U17 r3)
        if (runnerOption(key, option) === "preload") throw new Unreadable("opaque", `${key} run loads code first (${name})`);
        if (flags.valued.has(name)) { if (!option.includes("=")) at++; continue; }
        if (flags.bare.has(name) || flags.prefixes.some((prefix) => name.startsWith(prefix))) continue;
        throw new Unreadable("opaque", `${key} run with an option the reader does not know (${name})`);
      }
      const target = args[at];
      return target ? runnerTarget(target, ctx) : { kind: "none" };
    }
    if (text === "--" || text === "run") return args[i + 1] ? interpreterFile(args[i + 1]!, ctx) : { kind: "none" };
    if (text === "-") return { kind: "stdin" };
    // `python -m runpy x.py`, `-m pdb`, a module of the project's own: a file
    // the reader does not see (1.0.5 r8); pip, pytest, venv and their kin stay ordinary
    if (key === "python" && pythonModuleLoads(text, args[i + 1] ? literalText(args[i + 1]!) : undefined)) throw new Unreadable("opaque", "python -m runs a module the reader does not see");
    if (key === "python" && /^-[bBdEhiIOqsSuvV]*m/.test(text)) return { kind: "none" };
    // `bun -r ./x.ts ok.ts`, `bun --require ./x.ts run ok.ts`: code that runs
    // first, before or without a `run` (1.0.5 r4, reader-gaps r3)
    if ((key === "deno" || key === "bun") && runnerOption(key, text) === "preload") throw new Unreadable("opaque", `${key} loads code first (${text.split("=")[0]})`);
    if (text.startsWith("-")) { if (takesValue(key, text)) i++; continue; }
    // php reads its own options after the script too (`php x.php -r code`,
    // `php /dev/null -d auto_prepend_file=x`): any option there asks
    if (key === "php") {
      for (const later of args.slice(i + 1)) {
        const word = literalText(later);
        if (word === "--") break;
        if (word === undefined || word.startsWith("-")) throw new Unreadable("opaque", "php with an option after its script");
      }
    }
    return interpreterFile(args[i]!, ctx);
  }
  return code.length ? inlineCode() : { kind: "stdin" };
}

/** The options of `deno run` and `bun run` before the script (1.0.4 U17 r2):
 * flags, options that take the next word unless given with `=`, and option
 * families by prefix. Any other option asks. */
const RUNNER_FLAGS: Record<string, { bare: Set<string>; valued: Set<string>; prefixes: string[] }> = {
  deno: {
    bare: new Set(["-A", "--allow-all", "-q", "--quiet", "-r", "--reload", "--no-check", "--check", "--watch", "--watch-hmr", "--hmr", "--no-clear-screen",
      "--inspect", "--inspect-brk", "--inspect-wait", "--no-prompt", "--no-remote", "--no-npm", "--no-config", "--no-lock", "--lock", "--cached-only", "--frozen",
      "--node-modules-dir", "--no-code-cache", "--env", "--env-file", "--v8-flags", "-R", "-W", "-N", "-E", "-S", "-P", "--permission-set"]),
    valued: new Set(["--log-level", "-c", "--config", "--import-map", "--cert", "--location", "--seed", "--ext", "--preload", "--require", "--watch-exclude"]),
    prefixes: ["--allow-", "--deny-", "--unstable"],
  },
  bun: {
    bare: new Set(["--watch", "--hot", "--no-clear-screen", "--smol", "--bun", "-b", "--silent", "--if-present", "--no-install", "-i", "--prefer-offline", "--prefer-latest",
      "--inspect", "--inspect-wait", "--inspect-brk", "--no-deprecation", "--throw-deprecation", "--expose-gc", "--no-addons", "--zero-fill-buffers", "--no-env-file",
      "--no-macros", "--unhandled-rejections", "--revision", "--verbose", "--install"]),
    valued: new Set(["--cwd", "--env-file", "-r", "--preload", "--require", "--import", "-d", "--define", "--tsconfig-override", "--main-fields", "--extension-order",
      "--conditions", "--loader", "-l", "--shell", "--elide-lines", "-F", "--filter", "--config", "-c", "--port", "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime"]),
    prefixes: [],
  },
};

/** `deno run` and `bun run` options whose value is code that runs before
 * the script or package task: any of them asks (1.0.4 U17 r3). Deno's `-r`
 * is `--reload`, a flag. */
const RUNNER_PRELOADS = new Set(["-r", "--preload", "--require", "--import"]);

/** What a `deno`/`bun` option is: code loaded first (`--preload x`,
 * `--require=x`, bun's `-r x` or `-rx`; deno's `-r` is `--reload`), a flag the
 * run knows, one that takes the next word, or one the reader does not know. */
export function runnerOption(key: string, option: string): "preload" | "bare" | "valued" | "unknown" {
  const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
  if (RUNNER_PRELOADS.has(name) && !(key === "deno" && name === "-r")) return "preload";
  if (key === "bun" && /^-r./.test(name)) return "preload";
  const flags = RUNNER_FLAGS[key];
  if (!flags) return "unknown";
  if (flags.valued.has(name)) return option.includes("=") ? "bare" : "valued";
  if (flags.bare.has(name) || flags.prefixes.some((prefix) => name.startsWith(prefix))) return "bare";
  return "unknown";
}

/** The word after `deno`/`bun` or after their `run` options: a path or a
 * name with an extension is a script file; a bare name is a package script or
 * a task, unless this text wrote a file by that name, which is read as the
 * script it may be (1.0.4 U17 r2: as before this lane). */
function runnerTarget(word: Word, ctx: WalkContext): InterpreterProgram {
  const named = literalText(word);
  if (named === undefined || /[\\/.]/.test(named)) return interpreterFile(word, ctx);
  return ctx.written.has(resolveWritten(ctx, named)) ? interpreterFile(word, ctx) : { kind: "none" };
}

/** The script file an interpreter runs, read through `candidatesOf` as a
 * shell's script operand is: one literal candidate is that file (through
 * `resolveWritten`); a file a value names asks (1.0.4 U17: the reader cannot
 * see it, as the PowerShell reader asks for an interpreter given a value). */
function interpreterFile(word: Word, ctx: WalkContext): InterpreterProgram {
  const candidates = candidatesOf(word, ctx);
  const only = candidates.length === 1 ? candidates[0]! : undefined;
  if (only?.kind === "literal") return { kind: "file", path: resolvePath(ctx, only.text) };
  throw new Unreadable("expansion", ctx.written.size ? "an interpreter runs a file a value names, after this text wrote files" : "an interpreter runs a file a value names");
}

/** The scan of a file this text wrote and then runs (`strict`): any home
 * lookup, any call that deletes or runs, any quoted catastrophe asks. */
const STRICT_HOME = /\b(HOME|USERPROFILE|expanduser|homedir|GetFolderPath|SpecialFolder|UserProfile)\b/;
const STRICT_EXIT = /\b(os\.execute|execute|system|popen|subprocess|child_process|execSync|execFileSync|execFile|exec|spawnSync|spawn|Start-Process|Invoke-Expression|iex|os\.remove|os\.unlink|unlink|rmtree|rmSync|rimraf|unlinkSync|rmdirSync|Remove-Item)\b|`|%x/;

/** Literal inline code (`python -c`, `node -e`, a heredoc into `python3 -`)
 * is read by what it can do. Code that only prints, reads or computes is
 * ordinary whatever its strings say: text that is printed or searched is
 * data. Code that runs another program (`OPAQUE_RUNS`), deletes
 * (`OPAQUE_DELETES`) or writes (`OPAQUE_WRITES`) is read further. */
const OPAQUE_RUNS = /\b(os\.execute|system|popen|Popen|subprocess|child_process|check_output|check_call|getoutput|getstatusoutput|execSync|execFileSync|execFile|exec|execl|execlp|execle|execv|execvp|execve|execvpe|spawnSync|spawn|Start-Process|Invoke-Expression|iex|shell_exec|passthru|proc_open)\b|do shell script|%x[({[|!]/;
/** Backticks run shell text in these languages; in JavaScript they are a template string. */
const BACKTICK_RUNS = new Set(["perl", "ruby", "php"]);
const OPAQUE_DELETES = /\b(rm_rf|rm_r|rm_f|rmdir|rmtree|remove_tree|remove_dir|remove_entry|remove_entry_secure|unlink|unlinkSync|rmSync|rmdirSync|rimraf|removedirs|removeSync|emptyDir|emptyDirSync|shred|Remove-Item)\b|\bos\.remove\b/;
const OPAQUE_WRITES = /\b(open|fopen|write|writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|WriteAllBytes|Set-Content|Out-File|copy|copy2|copyfile|copyFile|syswrite)\b/;
/** `rm` as code (`fs.rm`, `FileUtils.rm`), or as a word a shell-out runs (`['rm', '-rf', p]`). */
const OPAQUE_RM = /\brm\b/;
const SHELL_DELETES = /\b(rm|rmdir|unlink|shred|rimraf|Remove-Item)\b/;
/** A lookup of the home folder. With a delete it may be the home folder itself. */
const OPAQUE_HOME = /\b(HOME|USERPROFILE|expanduser|homedir|GetFolderPath|SpecialFolder|UserProfile|expand_path|getpwuid)\b|\b(Path|Dir)\.home\b/;
/** A read of the environment: what runs or is deleted comes from a value. */
const OPAQUE_ENV = /\b(environ|getenv|ENV|Sys\.getenv)\b|\bprocess\.env\b|\$ENV\{/;
/** Comment syntax by interpreter, so a comment's words are not read as code. */
const HASH_COMMENTS = new Set(["python", "ruby", "perl", "php", "rscript", "osascript", "tclsh"]);
const SLASH_COMMENTS = new Set(["node", "deno", "bun", "php"]);
const DASH_COMMENTS = new Set(["lua", "osascript"]);
/** Reasons a quoted string read as shell text is not shell text at all. */
const NOT_SHELL = new Set(["syntax", "quote", "escape", "heredoc", "substitution", "operator", "nesting"]);

/** The code with its comments taken out, the same with its strings blanked
 * (`bare`), and its quoted strings, with the strings quoted inside those
 * (an f-string or a template string holds code with strings of its own). */
function opaqueParts(text: string, key: string | undefined, nested = true): { code: string; bare: string; strings: string[]; ranges: Array<[number, number]>; tops: number[] } {
  const hash = key !== undefined && HASH_COMMENTS.has(key);
  const slash = key !== undefined && SLASH_COMMENTS.has(key);
  const dash = key !== undefined && DASH_COMMENTS.has(key);
  let code = "";
  let bare = "";
  const strings: string[] = [];
  // where each quoted string stands in `code`, its quotes included
  const ranges: Array<[number, number]> = [];
  // the index in `strings` of the string each range holds
  const tops: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const wordStart = i === 0 || /\s/.test(text[i - 1]!);
    if (wordStart && ((hash && c === "#") || (slash && text.startsWith("//", i)) || (dash && text.startsWith("--", i)))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c !== "'" && c !== '"' && c !== "`") { code += c; bare += c; continue; }
    let s = "";
    let j = i + 1;
    for (; j < text.length && text[j] !== c; j++) {
      if (text[j] === "\\" && (text[j + 1] === "\\" || text[j + 1] === "'" || text[j + 1] === '"' || text[j + 1] === "`")) { s += text[j + 1]; j++; continue; }
      s += text[j];
    }
    tops.push(strings.length);
    strings.push(s);
    if (nested) strings.push(...opaqueParts(s, undefined, false).strings);
    // `code` keeps the string as written, escapes and all, so a quote-aware
    // scan of `code` (`closingOf`) finds the same strings again
    ranges.push([code.length, code.length + j - i]);
    code += text.slice(i, Math.min(j + 1, text.length));
    bare += c + c;
    i = j;
  }
  return { code, bare, strings, ranges, tops };
}

/** The members of Lua's `os` table code may name without asking: all but
 * `execute` read or compute, and `execute` is a run call the scan reads. */
const LUA_OS_MEMBERS = /^\s*\.\s*(?:execute|time|date|clock|getenv|difftime|remove|rename|exit|tmpname|setlocale)\b/;
/** Lua names that reach code or tables the scan does not follow: loaded
 * text, modules, the global and environment tables, raw and debug access. */
const LUA_UNSEEN = /\b(?:load|loadstring|loadfile|dofile|require|_G|_ENV|getfenv|setfenv|rawget|rawset|debug|package)\b/;

/** Lua code in the forms `scanOpaque` reads (1.0.4 U21 r2): a long string
 * (`[[…]]`, `[==[…]==]`) becomes a quoted string, a long comment and a line
 * comment go, `os . execute` and `os["execute"]` become `os.execute`, and a
 * string call (`os.execute"…"`) gets its parentheses. What it cannot read
 * asks: an unclosed long bracket, `os` reached any other way (`local o = os`,
 * `os[k]`), `execute` named outside `os.execute`, a table call, a name
 * that loads code or reaches the global tables, or a long string in code
 * that runs a program. */
function readLua(text: string): string {
  let out = "";
  let longString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const long = /^--\[(=*)\[/.exec(text.slice(i));
      if (long) {
        const close = text.indexOf(`]${long[1]}]`, i + long[0].length);
        if (close < 0) throw new Unreadable("opaque", "lua code with an unclosed long comment");
        out += " ";
        i = close + long[1]!.length + 1;
        continue;
      }
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    const long = c === "[" ? /^\[(=*)\[/.exec(text.slice(i)) : null;
    if (long) {
      const close = text.indexOf(`]${long[1]}]`, i + long[0].length);
      if (close < 0) throw new Unreadable("opaque", "lua code with an unclosed long string");
      const body = text.slice(i + long[0].length, close).replace(/^\r?\n/, "");
      out += `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      longString = true;
      i = close + long[1]!.length + 1;
      continue;
    }
    out += c;
  }
  out = out
    .replace(/\bos\s*\.\s*execute\b/g, "os.execute")
    .replace(/\bos\s*\[\s*(?:"execute"|'execute')\s*\]/g, "os.execute")
    .replace(/\bos\.execute\s*("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/g, "os.execute($1)");
  // the code with its strings blanked: names, not data
  const bare = out.replace(/"(?:[^"\\]|\\[\s\S])*"?|'(?:[^'\\]|\\[\s\S])*'?/g, '""');
  for (const match of bare.matchAll(/\bos\b/g)) {
    if (!LUA_OS_MEMBERS.test(bare.slice(match.index! + 2))) throw new Unreadable("opaque", "lua code reaches os in a way the reader does not follow");
  }
  if (LUA_UNSEEN.test(bare)) throw new Unreadable("opaque", "lua code loads code or reaches tables the reader does not follow");
  if (/\bos\.execute\s*\{/.test(bare)) throw new Unreadable("opaque", "lua runs a table call of os.execute");
  if (/\bexecute\b/.test(out.replace(/\bos\.execute\b/g, ""))) throw new Unreadable("opaque", "lua names execute outside os.execute");
  // a long string in code that runs a program asks, as it did before this
  // round: the reader does not judge what such a run is given
  if (longString && /\bos\.execute\b|\bpopen\b/.test(out)) throw new Unreadable("opaque", "lua runs a program in code with a long string");
  return out;
}

/** What a scan of opaque code is given besides the code: its interpreter,
 * the words after the code, what is piped in, and whether this text wrote
 * the file the code came from (`strict`). */
type OpaqueInput = { key?: string; rest?: Word[]; stdin?: Provenance; strict?: boolean };

/** Inspect literal inline argv identically in every outer shell. */
export function scanInterpreterInline<H>(name: string, args: Word[], ctx: WalkContext, visitor: Visitor<H>, stdin?: Provenance): void {
  const key = interpreterKey(name === "py" ? "python" : name);
  if (!key) throw new Unreadable("opaque", "unknown interpreter");
  const program = interpreterProgram(key, args, ctx);
  if (program.kind !== "code") throw new Unreadable("opaque", "inline code was not literal");
  if (!program.words.every(isPlain)) throw new Unreadable("opaque", "inline code from a value");
  scanOpaque(program.words.map(renderWord).join("\n"), !!ctx.elevated, visitor, ctx, { key, rest: program.rest, ...(stdin ? { stdin } : {}) });
}

/** Code in a language the reader does not model (`python -c`, `node -e`, a
 * heredoc into `perl`). Out of reach: a target the code computes, and a file
 * it did not get from this text. It asks when it runs elevated; when it runs,
 * deletes or writes and a string names a disk; when it runs or deletes and a
 * string names a catastrophe; when it deletes and looks up the home folder;
 * when it runs or deletes after this text wrote files, or with what the
 * environment or a value gives it; and when it runs a string, word or piped
 * text that, read as shell, is a catastrophe or not readable. */
function scanOpaque<H>(text: string, elevated: boolean, visitor: Visitor<H>, ctx: WalkContext, input: OpaqueInput = {}): void {
  // (1) elevated
  if (elevated) throw new Unreadable("opaque", "code the reader does not model, run elevated");
  // Lua's long strings, long comments and the other ways to reach
  // `os.execute` are read into the forms the scan knows (1.0.4 U21 r2)
  if (input.key === "lua") text = readLua(text);
  if (input.strict) return scanWritten(text, visitor);
  // (2) the code, its strings, its strings blanked
  const key = input.key;
  const { code, bare, strings, ranges, tops } = opaqueParts(text, key);
  const inString = (at: number) => ranges.some(([from, to]) => at > from && at < to);
  // (3) the families. `runs` and the exact delete names find call spans; the
  // stems only widen what the target scan reads
  const runs = OPAQUE_RUNS.test(code) || (BACKTICK_RUNS.has(key ?? "") && code.includes("`"));
  const runSpans = callSpans(code, OPAQUE_RUNS, key, () => true);
  if (BACKTICK_RUNS.has(key ?? "")) for (const [from, to] of ranges) if (code[from] === "`") runSpans.push(code.slice(from, to + 1));
  const runStrings = runSpans.flatMap((span) => opaqueParts(span, undefined).strings);
  const exactSpans = [...callSpans(code, OPAQUE_DELETES, key, () => true), ...callSpans(code, OPAQUE_RM, key, (at) => !inString(at))];
  // a printed `rm -rf` is data; `rm` in code, or in a string a run call receives, deletes
  const deletesExact = OPAQUE_DELETES.test(code) || OPAQUE_RM.test(bare) || (runs && runStrings.some((s) => SHELL_DELETES.test(s)));
  const stems = stemFamilies(bare, key);
  const deletes = deletesExact || stems.deletes.length > 0;
  const writes = OPAQUE_WRITES.test(code) || stems.writes;
  if (!runs && !deletes && !writes) return;
  // a delete API found by its stem gets the same checks as an exact name,
  // in its own call spans (UPSEC 10.4 c step 5): a stem is never an
  // exemption from them
  const stemSpans = stems.deletes.length ? callSpans(code, stemPattern(stems.deletes), key, (at) => !inString(at)) : [];
  const deleteSpans = [...exactSpans, ...stemSpans];
  const words: string[] = [];
  for (const word of input.rest ?? []) {
    const literal = literalText(word);
    if (literal !== undefined) words.push(literal);
    else if (runs || deletesExact) throw new Unreadable("opaque", "code given a value");
  }
  // (4) targets: a disk under any family, a catastrophe under run or delete
  // Tcl's targets are bare words (`file delete -force ~`): every word of a
  // run or delete call span is a name the scan reads
  if (key === "tclsh") for (const span of [...runSpans, ...deleteSpans]) for (const word of opaqueParts(span, undefined, false).bare.split(/[\s{}]+/)) if (word && !word.startsWith("-")) words.push(word);
  const named = [...strings, ...words];
  if (named.some((s) => deviceInWord(s) !== undefined)) throw new Unreadable("opaque", "names a disk");
  // a delete found only by its stem (a collection's `clear`, a string's
  // `format`) is judged by what its own call is given (UPSEC 10.3, the
  // stem families kept whole): a root, home or system literal, or a value,
  // ARGUMENT of that call asks; the same text beside it is data
  const stemOnly = !runs && !deletesExact;
  const judged = stemOnly ? spanNamed(stemSpans, key) : named;
  // a bare separator is no path only as the separator argument of its own
  // join or split (`'/'.join(p)`, `p.split('/')`): that one string, never
  // the same text elsewhere in the code. The words after the code are never one
  const separators = new Set<number>();
  ranges.forEach(([from, to], r) => { if (separatorArgument(code, from, to, strings[tops[r]!]!, key)) separators.add(tops[r]!); });
  if ((runs || deletes) && judged.some((s, i) => visitor.catastrophic?.(s) && (stemOnly || !separators.has(i)))) throw new Unreadable("opaque", "names a catastrophe");
  // (5) the rules for what a run or delete call is given, read in the call's
  // own span: code that reads the environment to print it and runs a
  // literal elsewhere is ordinary
  if (runs || deletes) {
    const found = [...runSpans, ...deleteSpans];
    // an exact run or delete name with no call span (a reference) is read
    // over the whole code; a stem with no call is a name, not a call
    const spans = found.length ? found : runs || deletesExact ? [code] : [];
    const spanCode = spans.join("\n");
    const unhomed = spanCode.replace(HOME_SUBPATH, "");
    if (deletes && OPAQUE_HOME.test(WALKS_UP.test(unhomed) ? spanCode : unhomed)) throw new Unreadable("opaque", "deletes and looks up the home folder");
    if (namesWritten(judged, ctx)) throw new Unreadable("opaque", "runs or deletes with a file this text wrote");
    if (OPAQUE_ENV.test(spanCode)) throw new Unreadable("opaque", "code given a value");
    if (spans.some((span) => spanHasValue(span, key, code))) throw new Unreadable("opaque", "code given a value");
    if (runs) {
      const shellTexts = [...(found.length ? runStrings : strings), ...words];
      if (input.stdin?.kind === "literal") shellTexts.push(input.stdin.text);
      else if (input.stdin && input.stdin.kind !== "file" && input.stdin.kind !== "remote") throw new Unreadable("opaque", "code given a value");
      for (const s of shellTexts) {
        if (!s.trim()) continue;
        let hit: H | null;
        try {
          hit = walkScript(s, fork(ctx, true), visitor);
        } catch (error) {
          if (!(error instanceof Unreadable)) throw error;
          // a string that is no shell text (`it's`) is data; one-word dialect names (`end`) too
          if (NOT_SHELL.has(error.reason) || (error.reason === "dialect" && !/\s/.test(s.trim()))) continue;
          throw new Unreadable("opaque", `runs shell text the reader cannot read (${error.reason})`);
        }
        if (hit) throw new Unreadable("opaque", "runs a catastrophe");
      }
    }
  }
  // (6) code that deletes or writes may have written any file it names: a
  // later run of that file asks
  if (deletes || writes) {
    ctx.loaders.unplacedWrite ??= "a file inline code may have written";
    for (const s of strings) {
      const path = s.trim();
      if (path && !/\s/.test(path) && pathShaped(path)) ctx.written.set(resolveWritten(ctx, path), { kind: "value", why: "a file inline code may have written" });
    }
  }
}

/** Is the string literal at `from`..`to` in `code` (its quotes included) a
 * bare separator given as the separator argument of its own call: the
 * receiver of a string join (`'/'.join(p)`), the first argument of a split
 * (`p.split('/')`, `explode('/', s)`), the one argument of an array join
 * (`parts.join('/')`), the first argument of perl's `join` or PHP's
 * `implode`, or the separator of Lua's `table.concat`? A path join
 * (`os.path.join('/', x)`, `File.join('/')`, `path.join('/')`) gives the
 * root itself and is no separator use. */
function separatorArgument(code: string, from: number, to: number, s: string, key: string | undefined): boolean {
  if (s !== "/" && s !== "\\") return false;
  const before = code.slice(0, from);
  const after = code.slice(to + 1);
  if (/^\s*\.\s*join\s*\(/.test(after)) return true;
  if (/\b(?:r?split|explode)\s*\(\s*$/.test(before)) return true;
  if (/\.\s*join\s*\(\s*$/.test(before) && /^\s*\)/.test(after)) return !/\b(?:path|Path|File|os|posixpath|ntpath|Pathname|PurePath|PurePosixPath|PureWindowsPath|Dir|FileUtils)\s*\.\s*join\s*\(\s*$/.test(before);
  if (/^\s*,/.test(after) && ((key === "perl" && /(?<![\w.$:>])join\s*\(?\s*$/.test(before)) || (key === "php" && /\bimplode\s*\(\s*$/.test(before)))) return true;
  return key === "lua" && /\btable\.concat\s*\([^()]*,\s*$/.test(before) && /^\s*\)/.test(after);
}

/** `OPAQUE_DELETE_STEMS` and `OPAQUE_WRITE_STEMS`: a delete or write API in
 * any modelled language, by the stem in its name. Matched case-insensitive
 * on whole identifiers (`.`, `::`, `$` and `-` inside one) in the code with
 * its strings blanked. They decide what the target scan reads, never on
 * their own that it asks. */
const OPAQUE_DELETE_STEMS = ["rm", "remove", "unlink", "delete", "del", "rmdir", "rmtree", "wipe", "erase", "format", "truncate", "empty", "clear", "purge", "destroy", "shred"];
const OPAQUE_WRITE_STEMS = ["write", "append", "open", "create", "copy", "cp", "move", "mv", "rename", "replace", "link", "extract", "unpack", "chmod", "chown"];
const IDENTIFIER = /[A-Za-z_$][\w$]*(?:(?:\.|::|-)[A-Za-z_$][\w$]*)*/g;

/** The stem families of the code with its strings blanked, exactly as
 * UPSEC 10.3 specifies: "an identifier containing" a stem, case-insensitive,
 * with `.`, `::`, `$` and `-` inside an identifier. Every identifier that
 * contains a delete stem anywhere (`platform`, `format` and `clear`
 * included) is a delete identifier; one that contains a write stem marks the
 * write family. What keeps harmless APIs ordinary is not a narrower family
 * but where a stem-only delete is judged: its own call's arguments
 * (`spanNamed`, `spanHasValue`). */
function stemFamilies(bare: string, _key: string | undefined): { deletes: string[]; writes: boolean } {
  const deletes = new Set<string>();
  let writes = false;
  for (const match of bare.matchAll(IDENTIFIER)) {
    const id = match[0];
    const lower = id.toLowerCase();
    if (OPAQUE_DELETE_STEMS.some((stem) => lower.includes(stem))) deletes.add(id);
    if (OPAQUE_WRITE_STEMS.some((stem) => lower.includes(stem))) writes = true;
  }
  return { deletes: [...deletes], writes };
}

/** What stem-only delete calls are given, as the target scan reads it: the
 * strings inside their spans and (Tcl) the bare words of a span. A name in a
 * span is a value (`spanHasValue`), so it asks on its own. */
function spanNamed(spans: string[], key: string | undefined): string[] {
  const named: string[] = [];
  for (const span of spans) {
    const parts = opaqueParts(span, undefined);
    named.push(...parts.strings);
    if (key === "tclsh") for (const word of parts.bare.split(/[\s{}]+/)) if (word && !word.startsWith("-")) named.push(word);
  }
  return named;
}

/** A pattern that finds each of these identifiers as a whole name, for `callSpans`. */
function stemPattern(ids: string[]): RegExp {
  const escaped = ids.sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(String.raw`(?<![\w$])(?:` + escaped.join("|") + String.raw`)(?![\w$])`);
}

/** Languages where a call needs no parentheses (`system "ls"`, `unlink $f`,
 * `exec rm x`): there a call's span runs to the end of its line. */
const BARE_CALLS = new Set(["perl", "ruby", "lua", "tclsh", "osascript"]);

/** The index of what closes the bracket or quote at `at` in `code`, quotes
 * inside skipped; the end of the code when nothing closes it. */
function closingOf(code: string, at: number): number {
  const open = code[at]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : open === "<" ? ">" : open;
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    const c = code[i]!;
    if (c === "\\") { i++; continue; }
    if (i > at && c === close && (open === close || depth === 1)) return i;
    if (open !== close && c === open) { depth++; continue; }
    if (open !== close && c === close) { depth--; continue; }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      i = j;
    }
  }
  return code.length;
}

/** The span of every call `pattern` finds in `code` (UPSEC 10.4 c step 5):
 * from its `(` to the matching `)`; to the end of its line where a call
 * takes no parentheses; the delimited text of `%x(…)`. A name with neither
 * (an import, a reference) has no span. `keep` filters match positions. */
function callSpans(code: string, pattern: RegExp, key: string | undefined, keep: (at: number) => boolean): string[] {
  const spans: string[] = [];
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const match of code.matchAll(global)) {
    const at = match.index!;
    if (!keep(at)) continue;
    const name = match[0];
    const lineEnd = (from: number) => { const nl = code.indexOf("\n", from); return nl < 0 ? code.length : nl; };
    if (name === "do shell script") { spans.push(code.slice(at + name.length, lineEnd(at))); continue; }
    if (name.startsWith("%x")) { const open = at + 2; spans.push(code.slice(open, closingOf(code, open) + 1)); continue; }
    let end = at + name.length;
    // the rest of a dotted name: `subprocess.run(`, `FileUtils.rm_rf `
    end += /^(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*/.exec(code.slice(end))![0].length;
    // a method's receiver is what it acts on (`Path.home().rmdir()`,
    // `Path(p).unlink()`): the span starts there, the call itself included
    const from = receiverStart(code, at);
    const head = code.slice(from, end);
    end += /^[ \t]*/.exec(code.slice(end))![0].length;
    if (code[end] === "(") { spans.push(head + code.slice(end, closingOf(code, end) + 1)); continue; }
    if (key === undefined || BARE_CALLS.has(key)) spans.push((from < at ? head + " " : "") + code.slice(end, lineEnd(end)));
  }
  return spans;
}

/** Where the receiver of a method call at `at` starts: back over each
 * `.`/`->` and the name, bracketed group or string before it. `at` itself
 * when the call has no receiver. */
function receiverStart(code: string, at: number): number {
  let i = at;
  for (;;) {
    const dot = code[i - 1] === "." ? i - 1 : code.slice(i - 2, i) === "->" ? i - 2 : -1;
    if (dot < 0) return i;
    let j = dot;
    while (j > 0 && (code[j - 1] === ")" || code[j - 1] === "]")) {
      const close = code[j - 1]!;
      const open = close === ")" ? "(" : "[";
      let depth = 0;
      let k = j - 1;
      for (; k >= 0; k--) {
        if (code[k] === close) depth++;
        else if (code[k] === open && --depth === 0) break;
      }
      if (k < 0) return i;
      j = k;
    }
    if (j > 0 && (code[j - 1] === "'" || code[j - 1] === '"' || code[j - 1] === "`")) {
      const quote = code[j - 1]!;
      const start = code.lastIndexOf(quote, j - 2);
      if (start < 0) return i;
      j = start;
    } else {
      while (j > 0 && /[\w$]/.test(code[j - 1]!)) j--;
    }
    if (j === dot) return i;
    i = j;
  }
}

/** Words of code that are no value: keywords and literals. */
const CODE_KEYWORDS = new Set("true false null none nil undefined self this new await async lambda function return and or not in is if else elif unless for of let const var typeof instanceof yield do end then def import from as with".split(" "));

/** Standard modules whose upper-case names are constants of the language,
 * not paths: flags, modes, signals, error numbers. */
const CONSTANT_MODULES = new Set(["os", "stat", "errno", "signal", "subprocess", "sys", "io", "fcntl", "constants", "Fcntl", "POSIX", "Errno", "File", "IO", "Process", "Signal", "Math", "Number"]);

/** The right side of every assignment to `name` in `code` (`name = …`,
 * `const name = …`, `name := …`, `name <- …`, `name += …`), each to the end
 * of its statement. An augmented or chained assignment gives its whole right
 * side, which is no literal. */
function assignmentsOf(code: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`(?<![\w$.])${escaped}\s*(?::\s*[\w\[\]., |]+?)?\s*([-+*/%|&^]|\*\*|//|\?\?|\|\||&&|<<|>>)?(=|:=|<-)(?![=>])([^;\n]*)`, "g");
  const sides: string[] = [];
  for (const match of code.matchAll(pattern)) sides.push(match[1] ? `${match[1]}${match[2]}${match[3]}` : match[3]!);
  return sides;
}

/** Does a call's span hold a value: a variable built elsewhere, whatever
 * its case (`p` in `rmtree(p)`, `$f` in perl, `TARGET` assigned a home
 * lookup on another line, `ROOT` imported), or an f-string that puts one in
 * (UPSEC 10.4 c step 5: "a span that contains a bare identifier (a variable
 * built elsewhere) is a value and asks")? A call, a keyword argument, an
 * object key, a keyword, and a standard module's constant (`stat.S_IWRITE`,
 * that module never assigned here) are no value. */
function spanHasValue(span: string, key: string | undefined, code: string = span): boolean {
  const { bare } = opaqueParts(span, undefined, false);
  if (key === "perl" || key === "php") return /[$@%][A-Za-z_{]/.test(bare);
  // Tcl words are literal text; a value is `$name` or a `[command]`
  if (key === "tclsh") return /\$[A-Za-z_{:]|\[/.test(bare);
  for (const match of bare.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?:(?:\.|::|->|\?\.)[A-Za-z_$][\w$]*)*/g)) {
    const id = match[0];
    if (CODE_KEYWORDS.has(id.toLowerCase())) continue;
    const after = /^[ \t]*(.?.?)/.exec(bare.slice(match.index! + id.length))![1]!;
    if (after.startsWith("(")) continue;
    // a string prefix (`f''`, `r""`, `b''`): the string is read below
    if (after[0] === "'" || after[0] === '"' || after[0] === "`") continue;
    if (after[0] === ":" && after[1] !== ":") continue;
    if (after[0] === "=" && after[1] !== "=" && after[1] !== ">") continue;
    const segments = id.split(/\.|::|->|\?\./);
    if (segments.length === 1) return true;
    // a standard library's constant (`os.O_RDONLY`, `stat.S_IWRITE`), its
    // module never assigned in this code; any other module's or object's
    // upper-case name (`cfg.ROOT`) is a value the text does not fix
    const root = segments[0]!;
    if (segments.length === 2 && /^[A-Z][A-Z0-9_]+$/.test(segments[1]!) && CONSTANT_MODULES.has(root) && assignmentsOf(code, root).length === 0) continue;
    return true;
  }
  return /(?<![\w$])[fF][rR]?(['"])[^'"\n]*\{\s*[A-Za-z_]/.test(span);
}

/** A home lookup with a fixed folder under it (`expanduser('~/.cache/x')`,
 * `Path.home() / 'x'`, `path.join(os.homedir(), 'x')`): not the home folder. */
const SUBPATH = String.raw`(?![^'"\s]*\.\.)(?=[^'"\s]*[^./'"\s])[^'"\s]+`;
const HOME_SUBPATH = new RegExp(String.raw`\bexpanduser\(\s*(['"])~\/${SUBPATH}\1\s*\)|\b(?:Path|Dir)\.home\(\)\s*\/\s*(['"])${SUBPATH}\2|\bjoin\(\s*(?:require\(\s*['"](?:node:)?os['"]\s*\)|os)\.homedir\(\)\s*,\s*(['"])${SUBPATH}\3`, "g");
/** Code that walks up from a path (`.parent`, `dirname`, `..`): a folder
 * under home may lead back to home itself. */
const WALKS_UP = /\.\.|\b(parent|parents|dirname|pardir|normpath|abspath|realpath|resolve|split|rsplit|rpartition|with_name|joinpath)\b/;

/** Does a string or word given to opaque code name a file this text wrote:
 * its path, its file name, or a glob over its file name? The code reads what
 * is in it, and that is something the scan did not see. */
function namesWritten(named: string[], ctx: WalkContext): boolean {
  if (!ctx.written.size) return false;
  const keys = writtenNames(ctx);
  const base = (path: string) => path.replace(/^.*[\\/]/, "");
  const bases = new Set(keys.map(base));
  for (const text of named) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (ctx.written.has(resolveWritten(ctx, trimmed)) || bases.has(base(trimmed))) return true;
    if (/[*?[]/.test(trimmed)) {
      const escaped = base(trimmed).replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      const pattern = new RegExp("^" + escaped + "$");
      if ([...bases].some((name) => pattern.test(name))) return true;
    }
  }
  return false;
}

/** The strict scan, for code this text wrote to a file and then runs. */
function scanWritten<H>(text: string, visitor: Visitor<H>): void {
  for (let i = 0; i < text.length; i++) {
    const quote = text[i]!;
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let s = "";
    let j = i + 1;
    for (; j < text.length && text[j] !== quote; j++) {
      if (text[j] === "\\" && (text[j + 1] === "\\" || text[j + 1] === "'" || text[j + 1] === '"')) { s += text[j + 1]; j++; continue; }
      s += text[j];
    }
    if (visitor.catastrophic?.(s) || deviceInWord(s) !== undefined) throw new Unreadable("opaque", "names a catastrophe");
    i = j;
  }
  if (STRICT_HOME.test(text)) throw new Unreadable("opaque", "looks up the home folder");
  if (STRICT_EXIT.test(text)) throw new Unreadable("opaque", "deletes or runs something the reader cannot see");
}

/** A script with a shebang naming a non-shell interpreter is scanned as code. */
function shebangInterpreter(text: string): string | undefined {
  const first = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  if (!first) return undefined;
  const program = (first[1]!.replace(/^.*\//, "") === "env" ? first[2] ?? "" : first[1]!).replace(/^.*\//, "").toLowerCase();
  return SHELLS.has(program) ? undefined : program;
}

/** `$0`, `$1`…, `$@`, `$*` and `$#` for a script or function body walked
 * with these words. A positional not given is empty, as in a shell. */
function bindPositionals(inner: WalkContext, values: Word[][], zero?: Word[]): void {
  const empty: Word[] = [{ parts: [{ kind: "lit", text: "", quote: "none" }] }];
  for (const name of [...inner.bound.keys(), ...inner.arrays]) if (POSITIONAL.test(name) && name !== "0") { inner.bound.delete(name); inner.arrays.delete(name); }
  if (zero) inner.bound.set("0", zero);
  for (let i = 1; i <= Math.max(9, values.length); i++) inner.bound.set(String(i), values[i - 1] ?? empty);
  for (const name of ["@", "*"]) { inner.bound.set(name, values.flat()); inner.arrays.add(name); }
  inner.bound.set("#", [{ parts: [{ kind: "lit", text: String(values.length), quote: "none" }] }]);
}


export function walkScript<H>(text: string, ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (ctx.depth > MAX_DEPTH) throw new Unreadable("depth");
  // 1.0.5 r8: a loader variable named anywhere in the text, with an
  // interpreter or a shell run anywhere in the read, asks
  const loader = mentionsLoaderVariable(text, "posix");
  if (loader) markLoaderVariable(ctx.loaders, loader);
  return walkList(parse(text), ctx, visitor);
}

/** `wsl` options that take a value, and those that manage WSL and run nothing. */
const WSL_VALUES = new Set(["-d", "--distribution", "-u", "--user", "--cd", "--shell-type", "--distribution-id"]);

/** A command PowerShell or cmd runs whose program executes other text: a
 * POSIX shell (`bash -c`), an interpreter (`python -c`, `node -e`), a
 * wrapper or an elevator (`env`, `sudo`), or `wsl`. It is walked as the POSIX
 * reader walks it, so nested scripts are read and inline code is scanned.
 * `program` is the name with `.exe` and its kin taken off; `stdin` is what
 * the Windows pipeline before it writes (UPSEC 10.6). Undefined when the
 * program is none of these: the caller hands it to the rules as it stands. */
export function walkForeignExecutor<H>(program: string, args: Word[], ctx: WalkContext, visitor: Visitor<H>, stdin?: Provenance): H | null | undefined {
  const name = program === "py" ? "python" : program;
  if (name === "wsl") return walkWsl(args, ctx, visitor, stdin);
  if (!(SHELLS.has(name) || interpreterKey(name) !== undefined || Object.hasOwn(WRAPPERS, name) || ELEVATORS.has(name))) return undefined;
  const words = [lit(name), ...args];
  const command: Extract<Command, { kind: "simple" }> = { kind: "simple", assigns: [], words, redirects: [] };
  return visitWords(words, command, stdin, ctx, visitor, undefined, false, []);
}

/** `wsl [options] [--] words`: the words joined and run by the Linux
 * shell; `wsl -e words` (`--exec`) runs them without a shell. Options that
 * manage WSL (`--list`, `--shutdown`) run nothing. */
function walkWsl<H>(args: Word[], ctx: WalkContext, visitor: Visitor<H>, stdin?: Provenance): H | null {
  // `wsl` with nothing to run starts the Linux shell, which reads its commands from stdin
  const shell = (): H | null => (stdin ? walkForeignExecutor("sh", [], ctx, visitor, stdin) ?? null : null);
  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    if (text === undefined) throw new Unreadable("expansion", "a value in what wsl runs");
    if (text === "-e" || text === "--exec") {
      const rest = args.slice(i + 1);
      if (!rest.length) return shell();
      return walkForeignExecutor(resolveName(rest[0]!) ?? "", rest.slice(1), ctx, visitor, stdin) ?? visitWords(rest, { kind: "simple", assigns: [], words: rest, redirects: [] }, stdin, ctx, visitor, undefined, false, []);
    }
    if (text === "--") return walkWslText(args.slice(i + 1), ctx, visitor, stdin) ?? shell();
    if (WSL_VALUES.has(text)) { i++; continue; }
    if (text.startsWith("-")) {
      // `--user=x`-style values; anything else manages WSL
      if (/^--(user|cd|distribution|shell-type)=/.test(text)) continue;
      return null;
    }
    return walkWslText(args.slice(i), ctx, visitor, stdin) ?? null;
  }
  return shell();
}

/** The words `wsl` joins and hands the Linux shell, which passes its stdin on. Undefined with no words. */
function walkWslText<H>(words: Word[], ctx: WalkContext, visitor: Visitor<H>, stdin?: Provenance): H | null | undefined {
  if (!words.length) return undefined;
  plainWords(words, "text wsl runs");
  const inner = fork(ctx, true);
  if (stdin) inner.stdin = stdin; else delete inner.stdin;
  return walkScript(words.map(renderWord).join(" "), inner, visitor);
}

function walkNested<H>(text: string, ctx: WalkContext, visitor: Visitor<H>): H | null {
  return walkScript(text, fork(ctx, true), visitor);
}

function walkList<H>(script: Script, ctx: WalkContext, visitor: Visitor<H>): H | null {
  for (const item of script.items) {
    // `cmd &` runs in a subshell of its own: what it binds or moves to may
    // or may not reach what follows (zsh and bash differ), so it is a branch
    const hit = item.background ? branches(ctx, [(branch) => walkAndOr(item.andOr, branch, visitor)]) : walkAndOr(item.andOr, ctx, visitor);
    if (hit) return hit;
  }
  return null;
}

/** `a && b && c`: each runs only after everything before it succeeded, so
 * inside the chain the state is exact (`cd / && rm -rf *` is read from
 * `/`). For what comes after the chain, `b` and `c` may or may not have run,
 * so the chain past its first pipeline is one branch, merged back at the
 * end. Once a `||` is in the chain, which later pipelines run depends on
 * what failed, so each one from there is a branch of its own. */
function walkAndOr<H>(andOr: AndOr, ctx: WalkContext, visitor: Visitor<H>): H | null {
  const [first, ...rest] = andOr.pipelines;
  let hit = walkPipeline(first!, ctx, visitor);
  if (hit) return hit;
  let chain: WalkContext | undefined;
  let exact = true;
  for (const [index, pipeline] of rest.entries()) {
    if (andOr.ops[index] === "||") exact = false;
    if (!chain || !exact) {
      if (chain) merge(ctx, [chain]);
      chain = fork(ctx);
    }
    hit = walkPipeline(pipeline, chain, visitor);
    if (hit) return hit;
  }
  if (chain) merge(ctx, [chain]);
  return null;
}

/** The commands of a pipeline each run in a subshell (the last one in the
 * current shell under zsh): what one binds or moves to may or may not reach
 * what follows the pipeline, so each is a branch. */
function walkPipeline<H>(pipeline: Pipeline, ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (pipeline.commands.length === 1) return walkCommand(pipeline.commands[0]!, ctx, visitor, []);
  const runs = pipeline.commands.map((command, index) => (branch: WalkContext) => walkCommand(command, branch, visitor, pipeline.commands.slice(0, index)));
  return branches(ctx, runs);
}

function walkParts<H>(word: Word, ctx: WalkContext, visitor: Visitor<H>): H | null {
  for (const part of word.parts) {
    let hit: H | null = null;
    switch (part.kind) {
      case "lit": case "tilde": case "glob": case "brace": break;
      case "var": if (part.word) hit = walkParts(part.word, ctx, visitor); break;
      case "subst": case "procsub": hit = walkNested(part.text, ctx, visitor); break;
      // nothing in arithmetic runs except its substitutions; an assignment
      // in it changes a name the reader does not follow
      case "arith":
        if (ASSIGNS_IN_ARITH.test(part.text)) applyEffects(OPAQUE_EFFECTS, ctx);
        hit = walkParts({ parts: lexQuotedBody(part.text) }, ctx, visitor);
        break;
      default: unreachable(part);
    }
    if (hit) return hit;
  }
  return null;
}

function walkRedirects<H>(redirects: Redirect[], ctx: WalkContext, visitor: Visitor<H>): H | null {
  for (const redirect of redirects) {
    if (redirect.target) {
      const hit = walkParts(redirect.target, ctx, visitor);
      if (hit) return hit;
    }
    if (redirect.heredoc && !redirect.heredoc.quoted) {
      const hit = walkParts({ parts: lexQuotedBody(redirect.heredoc.body) }, ctx, visitor);
      if (hit) return hit;
    }
    if (redirect.target) {
      const hit = visitor.redirect(redirect, redirect.target, candidatesOf(redirect.target, ctx), ctx);
      if (hit) return hit;
    }
  }
  return null;
}

function walkWords<H>(words: Word[], ctx: WalkContext, visitor: Visitor<H>): H | null {
  for (const word of words) {
    const hit = walkParts(word, ctx, visitor);
    if (hit) return hit;
  }
  return null;
}

/** Remember what a name stands for from here on: every candidate value,
 * with the parts the text cannot fix kept as they are (a `$HOME/x` value
 * still names a folder under home; a `$(…)` value is unknown). */
function bind(name: string, value: Word, ctx: WalkContext, elements?: Word[]): void {
  if (ctx.readonly.has(name)) { unknownName(name, ctx); return; }
  if (elements) {
    ctx.arrays.add(name);
    ctx.bound.set(name, elements.flatMap((element) => expandWord(element, ctx)));
    return;
  }
  ctx.arrays.delete(name);
  ctx.bound.set(name, expandWord(value, ctx));
}

/** `NAME=value` as one word: the name and the value's parts. */
export function assignmentOf(word: Word): { name: string; value: Word; append: boolean } | undefined {
  const first = word.parts[0];
  if (!first || first.kind !== "lit" || first.quote !== "none") return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.text);
  if (!match) return undefined;
  const rest = first.text.slice(match[0].length);
  const parts: Part[] = rest === "" ? word.parts.slice(1) : [{ kind: "lit", text: rest, quote: "none" }, ...word.parts.slice(1)];
  return { name: match[1]!, value: { parts }, append: match[2] === "+" };
}

/** The command words with a bound value put in for the first word: `$G -C x`
 * with `G=/usr/bin/git` is `/usr/bin/git -C x`, `"${K[@]}"` with
 * `K=(sudo rm -rf /)` is `sudo rm -rf /`, and `$c` with `for c in ls rm` is
 * both `ls` and `rm`, one list each. A value the text does not fix and a
 * value with spaces (the shell would split it) ask. */
function substituteLead(words: Word[], ctx: WalkContext): { lists: Word[][]; derived: boolean } {
  const word = words[0]!;
  if (resolveName(word) !== undefined) return { lists: [words], derived: false };
  const lead = word.parts[0];
  if (!lead || lead.kind !== "var" || lead.op !== undefined || !ctx.bound.get(lead.name)) throw new Unreadable("dynamic-name", renderWord(word));
  const candidates = expandWord(word, ctx);
  if (ctx.arrays.has(lead.name) && word.parts.length === 1) return { lists: [[...candidates, ...words.slice(1)]], derived: true };
  const byName = new Map<string, Word[]>();
  for (const candidate of candidates) {
    if (lead.quote === "none" && /\s/.test(literalText(candidate) ?? "")) throw new Unreadable("dynamic-name", "a value with spaces");
    const name = resolveName(candidate);
    if (name === undefined) throw new Unreadable("dynamic-name", renderWord(word));
    if (!byName.has(name)) byName.set(name, [candidate, ...words.slice(1)]);
  }
  if (byName.size > MAX_NAMES) throw new Unreadable("dynamic-name", "too many programs");
  return { lists: [...byName.values()], derived: true };
}

function walkCommand<H>(command: Command, ctx: WalkContext, visitor: Visitor<H>, before: Command[]): H | null {
  if (command.kind === "simple") return walkSimple(command, ctx, visitor, before);
  // redirects first: a heredoc on a compound is what the commands inside read
  let hit = walkRedirects(command.redirects, ctx, visitor);
  if (hit) return hit;
  const outerStdin = ctx.stdin;
  const stdin = stdinProvenance(command, before, ctx);
  if (stdin) ctx.stdin = stdin; else delete ctx.stdin;
  try {
    hit = walkCompound(command, ctx, visitor);
    if (hit) return hit;
    recordWrites(command, before, undefined, [], ctx);
    return null;
  } finally {
    if (outerStdin) ctx.stdin = outerStdin; else delete ctx.stdin;
  }
}

function walkCompound<H>(command: Exclude<Command, { kind: "simple" }>, ctx: WalkContext, visitor: Visitor<H>): H | null {
  let hit: H | null = null;
  {
    switch (command.kind) {
      case "if": {
        const [first, ...rest] = command.clauses;
        hit = walkList(first!.cond, ctx, visitor);
        if (hit) return hit;
        const runs: Array<(branch: WalkContext) => H | null> = [
          (branch) => walkList(first!.body, branch, visitor),
          ...rest.map((clause) => (branch: WalkContext) => walkList(clause.cond, branch, visitor) ?? walkList(clause.body, branch, visitor)),
        ];
        if (command.otherwise) { const otherwise = command.otherwise; runs.push((branch) => walkList(otherwise, branch, visitor)); }
        return branches(ctx, runs);
      }
      case "loop": {
        hit = walkList(command.cond, ctx, visitor);
        if (hit) return hit;
        const body = command.body;
        return branches(ctx, [(branch) => walkList(body, branch, visitor)]);
      }
      case "for": {
        const body = command.body;
        if (command.header) {
          hit = walkParts(command.header, ctx, visitor);
          if (hit) return hit;
        }
        if (command.words) {
          hit = walkWords(command.words, ctx, visitor);
          if (hit) return hit;
          const values = command.words.flatMap((word) => expandWord(word, ctx));
          const literal = values.every((word) => word.parts.every((part) => part.kind !== "var" && part.kind !== "subst" && part.kind !== "arith" && part.kind !== "procsub"));
          if (literal && !ctx.readonly.has(command.name)) ctx.bound.set(command.name, values); else unknownName(command.name, ctx);
        } else if (command.name) {
          unknownName(command.name, ctx);
        }
        return branches(ctx, [(branch) => walkList(body, branch, visitor)]);
      }
      case "case":
        hit = walkParts(command.word, ctx, visitor);
        if (hit) return hit;
        return branches(ctx, command.clauses.map((clause) => (branch: WalkContext) => walkWords(clause.patterns, branch, visitor) ?? walkList(clause.body, branch, visitor)));
      case "subshell":
        return walkList(command.body, fork(ctx), visitor);
      case "group":
        return walkList(command.body, ctx, visitor);
      case "function": {
        // a definition runs nothing; the body is walked at every call,
        // with that call's words bound. What the body would do to the
        // names, the folder and the functions around it is unknown from
        // here on: the reader does not know when it will be called
        const name = command.name.toLowerCase();
        // a function named like a wrapper, a shell or a capability command
        // changes what every later use of that name runs
        if (isShadowed(name)) throw new Unreadable("shadow", `function ${name}`);
        if (ctx.trapCalls?.has(name)) throw new Unreadable("dynamic-eval", `function ${name} defined after a trap that runs it`);
        const effects = bodyEffects(command.body, ctx);
        applyEffects(effects, ctx);
        ctx.functions.set(name, { forkBomb: forkBombShape(command.body, name, ctx), body: command.body, key: JSON.stringify(command.body), conflict: false, effects });
        return null;
      }
      case "arith":
        if (command.words.some((word) => word.parts.some((part) => part.kind === "lit" && ASSIGNS_IN_ARITH.test(part.text)))) applyEffects(OPAQUE_EFFECTS, ctx);
        return walkWords(command.words, ctx, visitor);
      case "cond":
        return walkWords(command.words, ctx, visitor);
      default:
        return unreachable(command);
    }
  }
}

/** The name a simple command calls, through its wrappers, when the text
 * fixes it; undefined otherwise. Never throws. */
function calleeName(command: Extract<Command, { kind: "simple" }>, ctx: WalkContext): string | undefined {
  try {
    const { words } = unwrap(command.words, ctx);
    return words[0] ? resolveName(words[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** `set -euo pipefail` sets options; `set -- a b` or `set a b` replaces
 * the positional parameters. */
function setsArguments(args: Word[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    if (text === undefined) return true;
    if (text === "--" || text === "-") return true;
    // `-o pipefail`, also at the end of a cluster: `-euo pipefail`
    if (/^[-+][A-Za-z]*o$/.test(text)) { i++; continue; }
    if (!text.startsWith("-") && !text.startsWith("+")) return true;
  }
  return false;
}

/** A call of a function defined in this text: its body walked again with
 * the call's words bound to `$1`…, `$@`, `$*` and `$#` (a positional the
 * call did not give is empty, as in a shell), one level deeper, so a
 * function that calls itself runs into the depth cap and asks. */
function callFunction<H>(called: string, shape: FunctionShape, args: Word[], ctx: WalkContext, visitor: Visitor<H>): H | null {
  if (shape.conflict) throw new Unreadable("branch", `function ${called} is not one definition`);
  const inner = fork(ctx, true);
  if (inner.depth > MAX_DEPTH) throw new Unreadable("depth");
  bindPositionals(inner, args.map((word) => expandWord(word, ctx)));
  const hit = walkCommand(shape.body, inner, visitor, []);
  if (hit) return hit;
  // the state the body ended in (through every function it called) is the
  // caller's state now, merged back as a branch: a name, folder or
  // function it changed is unknown from here on. Its positional parameters
  // were its own
  for (const name of [...inner.bound.keys(), ...inner.arrays]) {
    if (!POSITIONAL.test(name)) continue;
    inner.bound.delete(name); inner.arrays.delete(name);
    if (ctx.bound.has(name)) inner.bound.set(name, ctx.bound.get(name) ?? null);
    if (ctx.arrays.has(name)) inner.arrays.add(name);
  }
  merge(ctx, [inner]);
  return null;
}

/** What a function body would do to the state around it, read off the body
 * without running it. Over-approximate on purpose: every name an assignment
 * could reach counts, a program the text does not fix counts as anything,
 * and a function the body calls brings its own effects. */
function bodyEffects(body: Command, ctx: WalkContext): BodyEffects {
  const effects: BodyEffects = { assigns: new Set(), opaque: false, movesCwd: false, defines: [] };
  const word = (w: Word): void => {
    for (const part of w.parts) {
      if (part.kind === "var") {
        if (part.op === "=" || part.op === ":=") effects.assigns.add(part.name);
        if (part.word) word(part.word);
      } else if (part.kind === "arith" && /=|\+\+|--/.test(part.text)) effects.opaque = true;
    }
  };
  const words = (ws: Word[]): void => { for (const w of ws) word(w); };
  const list = (script: Script): void => {
    for (const item of script.items) for (const pipeline of item.andOr.pipelines) for (const c of pipeline.commands) command(c);
  };
  const command = (c: Command): void => {
    for (const redirect of c.redirects) if (redirect.target) word(redirect.target);
    switch (c.kind) {
      case "simple": {
        for (const assign of c.assigns) { effects.assigns.add(assign.name); word(assign.value); if (assign.elements) words(assign.elements); }
        words(c.words);
        // the program, past wrappers and their options
        let at = 0;
        let name: string | undefined;
        for (; at < c.words.length; at++) {
          const w = c.words[at]!;
          const n = resolveName(w);
          if (n === undefined) { effects.opaque = true; break; }
          if (WRAPPERS[n] || n.startsWith("-") || assignmentOf(w)) continue;
          name = n;
          break;
        }
        if (name === undefined) break;
        const args = c.words.slice(at + 1);
        const called = ctx.functions.get(name);
        if (called) {
          for (const n of called.effects.assigns) effects.assigns.add(n);
          if (called.effects.opaque) effects.opaque = true;
          if (called.effects.movesCwd) effects.movesCwd = true;
          effects.defines.push(...called.effects.defines);
        }
        if (MOVES_CWD.has(name)) effects.movesCwd = true;
        else if (OPAQUE.has(name) || (name === "printf" && args.some((w) => literalText(w) === "-v"))) effects.opaque = true;
        else if (BINDERS.has(name) || name === "read" || name === "unset") {
          let named = false;
          for (const w of args) {
            const text = literalText(w);
            if (text === undefined) { effects.opaque = true; continue; }
            if (text.startsWith("-")) continue;
            const match = NAME.exec(text);
            if (match) { effects.assigns.add(match[0]); named = true; }
          }
          if (name === "read" && !named) effects.assigns.add("REPLY");
        }
        break;
      }
      case "if": for (const clause of c.clauses) { list(clause.cond); list(clause.body); } if (c.otherwise) list(c.otherwise); break;
      case "loop": list(c.cond); list(c.body); break;
      case "for": effects.assigns.add(c.name); if (c.words) words(c.words); if (c.header) word(c.header); list(c.body); break;
      case "case": word(c.word); for (const clause of c.clauses) { words(clause.patterns); list(clause.body); } break;
      case "subshell": case "group": list(c.body); break;
      case "function": effects.defines.push({ name: c.name.toLowerCase(), body: c.body }); command(c.body); break;
      case "arith": effects.opaque = true; words(c.words); break;
      case "cond": words(c.words); break;
      default: unreachable(c);
    }
  };
  command(body);
  return effects;
}

/** Make everything a body could change unknown from here on. */
function applyEffects(effects: BodyEffects, ctx: WalkContext): void {
  for (const name of effects.assigns) unknownName(name, ctx);
  if (effects.opaque) {
    ctx.opaque = true;
    for (const name of [...ctx.bound.keys()]) unknownName(name, ctx);
  }
  if (effects.movesCwd) { ctx.cwd = undefined; ctx.cwdConflict = true; }
  for (const { name, body } of effects.defines) {
    ctx.functions.set(name, { forkBomb: false, body, key: JSON.stringify(body), conflict: true, effects: { assigns: new Set(), opaque: false, movesCwd: false, defines: [] } });
  }
}

/** Does this function body call its own name at least twice, at least once
 * in the background or beside another self-call in a pipeline? Every shape
 * of `:(){ :|:& };:`, `bomb(){ bomb & bomb; }` and `f(){ f & f & }`. */
function forkBombShape(body: Command, name: string, ctx: WalkContext): boolean {
  let calls = 0;
  let shape = false;
  const visitList = (script: Script) => {
    for (const item of script.items) {
      for (const pipeline of item.andOr.pipelines) {
        let own = 0;
        for (const command of pipeline.commands) {
          if (command.kind === "simple") { if (calleeName(command, ctx) === name) own++; }
          else visitCommand(command);
        }
        calls += own;
        if (own >= 2 || (own >= 1 && item.background)) shape = true;
      }
    }
  };
  const visitCommand = (command: Command) => {
    switch (command.kind) {
      case "simple": if (calleeName(command, ctx) === name) calls++; break;
      case "if": for (const clause of command.clauses) { visitList(clause.cond); visitList(clause.body); } if (command.otherwise) visitList(command.otherwise); break;
      case "loop": visitList(command.cond); visitList(command.body); break;
      case "for": visitList(command.body); break;
      case "case": for (const clause of command.clauses) visitList(clause.body); break;
      case "subshell": case "group": visitList(command.body); break;
      case "function": case "arith": case "cond": break;
      default: unreachable(command);
    }
  };
  visitCommand(body);
  return calls >= 2 && shape;
}
const OUTPUT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

/** `BUILD_TOOLS`: compilers, assemblers and linkers, for one thing only:
 * their `-O2`, `-Os`, `-Ofast` is an optimization level, not an output file
 * (`outputOption`). Their output file is marked by the written-files rule
 * like any other program's; no build tool is exempt from it. */
const BUILD_TOOLS = new Set(["cc", "c++", "gcc", "g++", "clang", "clang++", "gfortran", "tcc", "nvcc", "rustc", "swiftc", "zig", "ghc", "go", "ld", "ld.lld", "lld", "as", "nasm", "javac", "kotlinc", "esbuild", "tsc"]);

/** Is `name` a `BUILD_TOOLS` program (`gcc-13`, `clang.exe` included)? */
function buildTool(name: string): string | undefined {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  const tool = /^(gcc|g\+\+|clang|clang\+\+)-\d+$/.test(base) ? base.replace(/-\d+$/, "") : base;
  return BUILD_TOOLS.has(tool) ? tool : undefined;
}
const isBuildTool = (name: string) => buildTool(name) !== undefined;

/** Where `cp`, `mv`, `install` and `ln` put things: the source operands, the
 * destination, and whether the destination is known to be a folder (`-t`,
 * a trailing `/`) or known not to be one (`-T`). Options that take a value
 * are skipped with it. Undefined with fewer than a source and a destination. */
function placements(name: string, args: Word[], texts: Array<string | undefined>): { sources: Word[]; destination: Word; intoFolder: boolean; noFolder: boolean } | undefined {
  const values = name === "install" ? "tSmog" : "tS";
  const operands: Word[] = [];
  let folder: Word | undefined;
  let noFolder = false;
  for (let i = 0; i < args.length; i++) {
    const text = texts[i];
    if (text === "--") { operands.push(...args.slice(i + 1)); break; }
    if (text === undefined || !text.startsWith("-") || text === "-") { operands.push(args[i]!); continue; }
    if (text.startsWith("--")) {
      if (text === "--no-target-directory") noFolder = true;
      if (text.startsWith("--target-directory=")) folder = { parts: [{ kind: "lit", text: text.slice("--target-directory=".length), quote: "none" }] };
      else if (text === "--target-directory" && args[i + 1]) folder = args[++i];
      else if (text === "--suffix" || text === "--mode" || text === "--owner" || text === "--group") i++;
      continue;
    }
    for (let k = 1; k < text.length; k++) {
      const letter = text[k]!;
      if (letter === "T") noFolder = true;
      if (!values.includes(letter)) continue;
      const glued = k < text.length - 1;
      const value: Word | undefined = glued ? { parts: [{ kind: "lit", text: text.slice(k + 1), quote: "none" }] } : args[i + 1];
      if (!glued) i++;
      if (letter === "t" && value) folder = value;
      break;
    }
  }
  if (folder) return operands.length ? { sources: operands, destination: folder, intoFolder: true, noFolder: false } : undefined;
  if (operands.length < 2) return undefined;
  const destination = operands[operands.length - 1]!;
  const trailing = (literalText(destination) ?? "").endsWith("/");
  return { sources: operands.slice(0, -1), destination, intoFolder: trailing, noFolder };
}

/** After a command ran: the files it wrote, with what it wrote, and the links
 * it made. A literal output redirect records the command's output (`>>`,
 * stderr and an unknown program's output are values); `tee` records its
 * input; `cp`, `mv` and `install` record what the source held. */
function recordWrites(command: Command, before: Command[], name: string | undefined, args: Word[], ctx: WalkContext, catastrophic?: (text: string) => boolean): void {
  const literalTargets = (word: Word): string[] | undefined => {
    const candidates = candidatesOf(word, ctx);
    return candidates.every((c) => c.kind === "literal") ? candidates.map((c) => resolveFrom(ctx.cwd, (c as { text: string }).text)) : undefined;
  };
  for (const redirect of command.redirects) {
    if (!redirect.target) continue;
    const dup = redirect.op === ">&" && /^\d+$|^-$/.test(literalText(redirect.target) ?? "");
    if (!OUTPUT_OPS.has(redirect.op) && (redirect.op !== ">&" || dup)) continue;
    const stdout = redirect.fd === undefined || redirect.fd === 1;
    const content: Provenance = command.kind === "simple" && stdout && redirect.op !== ">>" && redirect.op !== "&>>" && redirect.op !== "<>" ? outputOf(command, before, ctx) : { kind: "value", why: "output the reader does not compute" };
    const targets = literalTargets(redirect.target);
    if (!targets) ctx.loaders.unplacedWrite ??= "a redirect to a value";
    for (const path of targets ?? []) setWritten(ctx, path, content);
  }
  if (command.kind !== "simple" || name === undefined) return;
  const texts = args.map(literalText);
  if (name === "tee") {
    const content: Provenance = texts.some((text) => text === "-a" || text === "--append") ? { kind: "value", why: "appended" } : stdinProvenance(command, before, ctx) ?? { kind: "value", why: "tee of unknown input" };
    for (const [index, arg] of args.entries()) if (!(texts[index] ?? "-").startsWith("-")) { const targets = literalTargets(arg); if (!targets) ctx.loaders.unplacedWrite ??= "tee to a value"; for (const path of targets ?? []) setWritten(ctx, path, content); }
    return;
  }
  if (name === "cp" || name === "mv" || name === "install" || name === "ln") {
    const placed = placements(name, args, texts);
    if (!placed) return;
    const symbolic = (name === "ln" && texts.some((text) => text !== undefined && (/^-[A-Za-z]*s/.test(text) || text === "--symbolic")))
      || (name === "cp" && texts.some((text) => text !== undefined && (/^-[A-Za-z]*s/.test(text) || text === "--symbolic-link")));
    // `cp -l` makes hard links, as `ln` does
    const hard = name === "ln" || (name === "cp" && texts.some((text) => text !== undefined && (/^-[A-Za-z]*l/.test(text) || text === "--link")));
    const resolvedSources = placed.sources.map((word) => literalTargets(word));
    const destinations = literalTargets(placed.destination) ?? [];
    if (!literalTargets(placed.destination)) ctx.loaders.unplacedWrite ??= `${name} to a value`;
    const several = placed.sources.length > 1;
    for (const sources of resolvedSources) {
      const source = sources?.length === 1 ? sources[0]! : undefined;
      // where the source lands: inside the destination folder, under its own
      // name, and (one source, no `-T`, no `-t`) the destination itself, as
      // the text does not say whether the destination is a folder
      const lands = destinations.flatMap((path) => {
        const child = source !== undefined ? `${path.replace(/\/+$/, "")}/${source.replace(/^.*\//, "")}` : undefined;
        if (placed.intoFolder || several) return child !== undefined ? [child] : [];
        if (placed.noFolder || child === undefined) return [path];
        return [path, child];
      });
      if (symbolic) {
        if (source !== undefined) for (const link of lands) { ctx.inodes.delete(link); ctx.links.set(link, source); }
        continue;
      }
      // a hard link is the same file under a second name: one identity, live
      if (hard) {
        if (source !== undefined) for (const link of lands) hardLink(ctx, source, link);
        else for (const link of lands) { ctx.inodes.delete(link); ctx.links.delete(link); ctx.written.set(link, { kind: "value", why: `${name} from a source the text does not fix` }); }
        continue;
      }
      // `mv` renames: the destination name takes the source's file, its
      // identity and its link included
      if (name === "mv" && source !== undefined) {
        const id = ctx.inodes.get(source);
        const link = ctx.links.get(source);
        const held = id === undefined ? ctx.written.get(source) : undefined;
        for (const path of lands) {
          ctx.inodes.delete(path); ctx.links.delete(path); ctx.written.delete(path);
          if (id !== undefined) ctx.inodes.set(path, id);
          else if (link !== undefined) ctx.links.set(path, link);
          else ctx.written.set(path, held ?? { kind: "file", path: source });
        }
        ctx.inodes.delete(source); ctx.links.delete(source); ctx.written.delete(source);
        continue;
      }
      // a copy holds what the source held when copied; it is written into
      // the destination's file, so every name of that file holds it
      const content: Provenance = source === undefined ? { kind: "value", why: `${name} from a source the text does not fix` } : ctx.written.get(resolveWritten(ctx, source)) ?? { kind: "file", path: source };
      for (const path of lands) setWritten(ctx, path, content);
    }
    return;
  }
  // every other program marks a file written only where it says it writes
  // one (UPSEC 10.4): (i) a file in an output-option position holds what the
  // command read, a download, or a value; (ii) a command given literal text
  // (on stdin, or an argument naming a catastrophe or a disk) may have put
  // that text in any path-shaped operand. Content from disk or the network
  // is out of reach as a script on disk is, so nothing else is marked. The
  // script a shell or an interpreter runs is read, not written
  const script = SHELLS.has(name) || interpreterKey(name) !== undefined ? texts.findIndex((text) => text === undefined || !text.startsWith("-")) : -1;
  const stdin = stdinProvenance(command, before, ctx);
  const download = downloader(name, args);
  const plain = texts.map((text) => text ?? "");
  for (let i = 0; i < plain.length; i++) {
    if (texts[i] === undefined) continue;
    const out = outputOption(plain, i, name);
    if (!out) continue;
    i = out.last;
    if (out.file === "-" || texts[out.last] === undefined) continue;
    // UPSEC 10.4, written files (i), the governing rule: "the operand sits
    // in an OUTPUT_OPTIONS position, with provenance = the command's stdin
    // provenance when that is remote or file, else value". With 10.4 remote
    // provenance ("a downloader with an output option -> written.set(path,
    // remote)") that is all: nothing else makes an output file hold what
    // disk held, so a compiler or linker given no `remote` or `file` stdin
    // writes a value like any other tool
    const content: Provenance = download?.output !== undefined ? { kind: "remote", url: download.url }
      : stdin?.kind === "remote" || stdin?.kind === "file" ? stdin
      : { kind: "value", why: `a file ${name} wrote` };
    setWritten(ctx, resolveFrom(ctx.cwd, out.file), content);
  }
  const literalSource = stdin?.kind === "literal" || plain.some((text, index) => texts[index] !== undefined && index !== script
    && (text.split(/\s+/).some((word) => word !== "" && (catastrophic?.(word) || deviceInWord(word) !== undefined)) || catastrophic?.(text)));
  if (!literalSource) return;
  for (const [index, text] of texts.entries()) {
    if (index === script || text === undefined || !pathShaped(text)) continue;
    setWritten(ctx, resolveFrom(ctx.cwd, text), { kind: "value", why: `a file ${name} may have written from this text` });
  }
}

function walkSimple<H>(command: Extract<Command, { kind: "simple" }>, ctx: WalkContext, visitor: Visitor<H>, before: Command[]): H | null {
  // 1.0.5 r8 lanereview: a startup file named by any word, its quoting taken
  // out (`~/.zshe"nv"`, `$HOME/.bash_pro\file`), with a shell or an interpreter run
  for (const word of [...command.words, ...command.redirects.flatMap((redirect) => redirect.target ? [redirect.target] : []), ...command.assigns.map((assign) => assign.value)]) {
    const named = namesStartupFile(word.parts.map((part) => (part.kind === "lit" ? part.text : "\u0000")).join(""));
    if (named) markLoaderVariable(ctx.loaders, named);
  }
  for (const assign of command.assigns) {
    // 1.0.5 r8: `HOME=./x zsh -c …`, `NODE_OPTIONS=… node …`
    if (isLoaderName(assign.name)) markLoaderVariable(ctx.loaders, assign.name);
    const hit = walkParts(assign.value, ctx, visitor);
    if (hit) return hit;
  }
  let hit = walkWords(command.words, ctx, visitor) ?? walkRedirects(command.redirects, ctx, visitor);
  if (hit) return hit;
  for (const assign of command.assigns) {
    if (assign.elements) {
      hit = walkWords(assign.elements, ctx, visitor);
      if (hit) return hit;
    }
    // `D=x cmd` binds for that command only (and for the shell too, after
    // some builtins); `D+=x` joins to a value: either way unknown from here
    if (command.words.length > 0 || assign.append) unknownName(assign.name, ctx);
    else bind(assign.name, assign.value, ctx, assign.elements);
  }
  if (command.words.length === 0) { recordWrites(command, before, undefined, [], ctx); return null; }
  const stdin = stdinProvenance(command, before, ctx);
  const { lists, derived } = substituteLead(command.words, ctx);
  for (const list of lists) {
    hit = visitWords(list, command, stdin, ctx, visitor, undefined, derived, before);
    if (hit) return hit;
  }
  return null;
}


/** Text that runs in this shell (`eval`): walked in place, one level
 * deeper, marked so a risky command in it asks. */
function walkInPlace<H>(text: string, ctx: WalkContext, visitor: Visitor<H>, how: "eval"): H | null {
  const outer = ctx.indirect;
  ctx.indirect = outer ?? how;
  ctx.depth++;
  try {
    return walkScript(text, ctx, visitor);
  } finally {
    ctx.depth--;
    if (outer) ctx.indirect = outer; else delete ctx.indirect;
  }
}

/** A script walked as its own shell would run it: one level deeper, with
 * `$0` and the positional parameters bound, elevated when its runner was. */
function walkWithPositionals<H>(text: string, zero: Word | undefined, positionals: Word[], ctx: WalkContext, visitor: Visitor<H>, elevated: boolean, stdin?: Provenance): H | null {
  const inner = fork(ctx, true);
  if (elevated) inner.elevated = true;
  // what the script's commands read: the stdin its shell was given (UPSEC
  // 10.6), carried into every nested shell however deep the chain
  if (stdin) inner.stdin = stdin; else delete inner.stdin;
  bindPositionals(inner, positionals.map((word) => expandWord(word, ctx)), zero ? expandWord(zero, ctx) : undefined);
  return walkScript(text, inner, visitor);
}

/** Input that holds nothing to run: the null device. */
function isNullInput(path: string): boolean {
  return path === "/dev/null" || /^nul$/i.test(path);
}

/** A file this text wrote, run by a shell or directly: literal content is
 * walked (or scanned, under a non-shell shebang); content from a value asks. */
function runWritten<H>(written: Provenance, positionals: Word[], ctx: WalkContext, visitor: Visitor<H>, elevated: boolean, direct: boolean, hops = 0, stdin?: Provenance): H | null {
  if (hops > MAX_DEPTH) throw new Unreadable("depth");
  switch (written.kind) {
    case "literal":
      if (direct && shebangInterpreter(written.text)) { const key = interpreterKey(shebangInterpreter(written.text)!); scanOpaque(written.text, elevated, visitor, ctx, { strict: true, ...(key ? { key } : {}) }); return null; }
      return walkWithPositionals(written.text, undefined, positionals, ctx, visitor, elevated, stdin);
    case "file": {
      const again = ctx.written.get(resolveWritten(ctx, written.path));
      if (again) return runWritten(again, positionals, ctx, visitor, elevated, direct, hops + 1, stdin);
      // 1.0.4 U17: a shell given a copy of a script on disk runs what the
      // reader does not see; a program run directly is read as any program on disk is
      if (direct || isNullInput(written.path)) return null;
      throw new Unreadable("opaque", "a shell runs a copy of a script file the reader does not see");
    }
    case "roots": case "value": throw new Unreadable("expansion", "a script this text wrote from a value");
    case "remote": runsRemote(elevated); return null;
    default: return unreachable(written);
  }
}

/** Program text an interpreter reads, by where it came from: literal text is
 * scanned, a file this text wrote is scanned as written, a file it did not
 * write is out of reach, anything else asks. */
function scanProvenance<H>(program: Provenance, ctx: WalkContext, visitor: Visitor<H>, elevated: boolean, key: string, hops = 0): void {
  if (hops > MAX_DEPTH) throw new Unreadable("depth");
  switch (program.kind) {
    // piped or heredoc text is read as inline code; a file this text wrote, strictly
    case "literal": scanOpaque(program.text, elevated, visitor, ctx, { key, strict: hops > 0 }); return;
    case "file": {
      const written = ctx.written.get(resolveWritten(ctx, program.path));
      if (written) { scanProvenance(written, ctx, visitor, elevated, key, hops + 1); return; }
      // 1.0.4 U17: code from a file on disk this text did not write asks
      if (isNullInput(program.path)) return;
      throw new Unreadable("opaque", "an interpreter reads code from a file the reader does not see");
    }
    case "roots": case "value": throw new Unreadable("opaque", "code from a value");
    case "remote": runsRemote(elevated); return;
    default: unreachable(program);
  }
}

/** What xargs appends: the tokens of literal input, a lister's roots, the
 * items of a list file (UPSEC 10.4: a list this text wrote is read as it was
 * written; one on disk is `fromFile`, the same trust as a script on disk),
 * or undefined for input the text does not show. A list from the network
 * is a value: a delete list fetched from an address is no developer idiom. */
function xargsItems(stdin: Provenance | undefined, options: XargsOptions, ctx: WalkContext, hops = 0): Word[] | undefined {
  if (hops > MAX_DEPTH) throw new Unreadable("depth");
  if (stdin?.kind === "literal") {
    const items = tokenizeXargs(stdin.text, options).map(tokenWord);
    if (items.length > MAX_CANDIDATES) throw new Unreadable("expansion", "too many values");
    return items;
  }
  if (stdin?.kind === "roots") return stdin.roots;
  if (stdin?.kind === "file") {
    const written = ctx.written.get(resolveWritten(ctx, stdin.path));
    if (written) return xargsItems(written, options, ctx, hops + 1);
    return [fromFileWord(stdin.path)];
  }
  return undefined;
}
/** Marks the item word `xargsItems` makes for a list file on disk. */
const FROM_FILE = "-xargs-file:";
/** The operand word that stands for the items of a list file on disk (`fromFile`). */
export function fromFileWord(path: string): Word {
  return { parts: [{ kind: "var", name: `${FROM_FILE}${path}`, quote: "none" }] };
}
/** An operand an executor appends that the text does not show. */
const APPENDED_VALUE: Word = { parts: [{ kind: "var", name: "-xargs-input", quote: "none" }] };

/** `find`'s roots: the operands before its first option, `.` when none. */
function findRoots(args: Word[]): Word[] {
  const roots: Word[] = [];
  for (const arg of args) {
    const text = literalText(arg);
    if (text !== undefined && (text.startsWith("-") || text === "!" || text === "(")) break;
    roots.push(arg);
  }
  return roots.length ? roots : [lit(".")];
}

/** `read` from literal input binds its names to the input's first line, split
 * on blanks (the last name takes the rest); from anything else, unknown. */
function bindRead(args: Word[], stdin: Provenance | undefined, ctx: WalkContext): void {
  const names: string[] = [];
  let plain = true;
  for (const word of args) {
    const text = literalText(word);
    if (text === undefined) { plain = false; continue; }
    if (text.startsWith("-")) { if (text !== "-r") plain = false; continue; }
    names.push(text);
  }
  if (!names.length) names.push("REPLY");
  const line = stdin?.kind === "literal" ? stdin.text.split("\n")[0]! : undefined;
  if (!plain || line === undefined) { for (const name of names) unknownName(name, ctx); return; }
  const tokens = line.trim().split(/[ \t]+/).filter(Boolean);
  names.forEach((name, index) => {
    if (ctx.readonly.has(name)) { unknownName(name, ctx); return; }
    const value = index === names.length - 1 ? tokens.slice(index).join(" ") : tokens[index] ?? "";
    ctx.arrays.delete(name);
    ctx.bound.set(name, [tokenWord(value)]);
  });
}

/** One simple command, its first word already fixed to one program. */
function visitWords<H>(list: Word[], command: Extract<Command, { kind: "simple" }>, given: Provenance | undefined, ctx: WalkContext, visitor: Visitor<H>, viaXargs: XargsOptions | undefined, viaDerived: boolean, before: Command[], viaElevated = false): H | null {
  const unwrapped = unwrap(list, ctx);
  // the wrappers' own arguments, before anything they run is read
  if (visitor.wrapperArgs && unwrapped.wrapperArgs.length) {
    const hit = visitor.wrapperArgs(unwrapped.wrapperArgs, ctx);
    if (hit) return hit;
  }
  if (!unwrapped.cwd) return visitUnwrapped(unwrapped, command, given, ctx, visitor, viaXargs, viaDerived, before, viaElevated);
  // `env -C DIR cmd`: cmd runs from DIR (a folder the text does not fix when
  // a value names it); this shell stays where it was
  const { cwd, cwdConflict } = ctx;
  ctx.cwd = unwrapped.cwd.path;
  ctx.cwdConflict = unwrapped.cwd.path === undefined;
  try {
    return visitUnwrapped(unwrapped, command, given, ctx, visitor, viaXargs, viaDerived, before, viaElevated);
  } finally {
    ctx.cwd = cwd;
    ctx.cwdConflict = cwdConflict;
  }
}

/** One simple command after its wrappers. */
function visitUnwrapped<H>(unwrapped: Unwrapped, command: Extract<Command, { kind: "simple" }>, given: Provenance | undefined, ctx: WalkContext, visitor: Visitor<H>, viaXargs: XargsOptions | undefined, viaDerived: boolean, before: Command[], viaElevated: boolean): H | null {
  let hit: H | null = null;
  let stdin = given;
  const xargs = unwrapped.xargs ?? viaXargs;
  const derived = unwrapped.derived || viaDerived;
  const elevated = unwrapped.elevated || viaElevated || !!ctx.elevated;
  if (unwrapped.alternatives) {
    for (const alternative of unwrapped.alternatives) {
      hit = visitWords(alternative, command, stdin, ctx, visitor, xargs, derived, before, elevated);
      if (hit) return hit;
    }
    return null;
  }
  if (unwrapped.script) {
    // `su -c`, `script -c`, `flock -c`: the words after the script are its `$0`, `$1`…
    const [zero, ...positionals] = unwrapped.positionals ?? [];
    return walkWithPositionals(renderWord(unwrapped.script), zero, positionals, ctx, visitor, elevated, stdin);
  }
  let words = unwrapped.words;
  if (words.length === 0) return null;
  if (xargs) {
    // what xargs reads becomes the command's arguments
    const items = xargsItems(stdin, xargs, ctx);
    stdin = undefined;
    if (xargs.replace !== undefined) {
      const replace = xargs.replace;
      if (!items) {
        words = words.map((word) => spliceWord(word, replace, APPENDED_VALUE));
      } else {
        // one command per item, the item put in where the replace string stands
        for (const item of items) {
          hit = visitWords(words.map((word) => spliceWord(word, replace, item)), command, undefined, ctx, visitor, undefined, derived, before, elevated);
          if (hit) return hit;
        }
        return null;
      }
    } else {
      words = [...words, ...(items ?? [APPENDED_VALUE])];
    }
  }
  const name = resolveName(words[0]!);
  if (name === undefined) throw new Unreadable("dynamic-name", renderWord(words[0]!));
  const windowsRunner = ctx.windowsBash ? powershellRunner(name) : undefined;
  if (ctx.windowsBash && (windowsRunner === "interpreter" || windowsRunner === "launcher" && name !== "bash" || /^(cmd|wsl|start-process|set-content|powershell|pwsh)(\.exe)?$/i.test(name) || /\.(ps1|psm1|psd1|py|sh)$/i.test(name))) throw new Unreadable("pwsh", "the nested executor needs approval");
  if (ctx.indirect === "trap") (ctx.trapCalls ??= new Set()).add(name);
  const shape = ctx.functions.get(name);
  if (shape?.forkBomb) return visitor.forkBomb();
  if (shape) return callFunction(name, shape, words.slice(1), ctx, visitor);
  const args = words.slice(1);
  // the positional parameters moved or replaced: what `$1` names from here
  // on is not something the reader follows
  if (name === "shift" || (name === "set" && setsArguments(args))) throw new Unreadable("dynamic-eval", `${name} moves the arguments`);
  // `./x`, `/tmp/x`: a program this text wrote, run directly
  const direct = literalText(words[0]!);
  if (direct !== undefined && /[\\/]/.test(direct)) {
    const written = ctx.written.get(resolveWritten(ctx, direct));
    if (written) { runnerStarts(ctx, direct); return runWritten(written, args, ctx, visitor, elevated, true, 0, stdin); }
  }
  if (name === "wsl" || name === "wsl.exe") return walkWsl(args, ctx, visitor, stdin);
  if (SHELLS.has(name)) {
    runnerStarts(ctx, name);
    const startup: Array<Provenance | undefined> = [];
    const program = shellScript(args, stdin, ctx, elevated, startup);
    // a startup file this text wrote runs before the shell's own program
    for (const written of startup) {
      if (!written) continue;
      if (name === "fish") throw new Unreadable("dialect", "a fish script");
      hit = runWritten(written, [], ctx, visitor, elevated, false, 0);
      if (hit) return hit;
    }
    if (!program) return null;
    if (program.kind === "file") {
      const written = ctx.written.get(resolveWritten(ctx, program.path));
      // 1.0.4 U17 (fail closed, as the PowerShell reader does): a script on
      // disk this text did not write is one the reader does not see. An
      // empty input (`/dev/null`) runs nothing
      if (!written) {
        if (isNullInput(program.path)) return null;
        // 1.0.5 r2: bytes piped or redirected into a shell (`bash < x.sh`,
        // `cat x.sh | sh`, through a line filter) are piped code: they ask
        // at every level. Only a script operand a shell names is unseen
        if (program.fromStdin) throw new Unreadable("opaque", `${name} reads a script the reader does not see from its input`);
        unseenScript(visitor, program.path, ctx, elevated, `${name} runs a script file the reader does not see`);
        return null;
      }
      if (name === "fish") throw new Unreadable("dialect", "a fish script");
      // a script read from stdin leaves its commands nothing on stdin; a file or `-c` passes it on
      return runWritten(written, program.positionals, ctx, visitor, elevated, false, 0, stdin?.kind === "file" && stdin.path === program.path ? undefined : stdin);
    }
    if (name === "fish") throw new Unreadable("dialect", "a fish script");
    for (const text of program.texts) {
      hit = walkWithPositionals(text, program.zero, program.positionals, ctx, visitor, elevated, program.fromStdin ? undefined : stdin);
      if (hit) return hit;
    }
    return null;
  }
  const interpreter = interpreterKey(name);
  if (interpreter) {
    runnerStarts(ctx, name);
    const program = interpreterProgram(interpreter, args, ctx);
    if (program.kind === "code") {
      if (!program.words.every(isPlain)) throw new Unreadable("opaque", "inline code from a value");
      scanOpaque(program.words.map(renderWord).join("\n"), elevated, visitor, ctx, { key: interpreter, rest: program.rest, ...(stdin ? { stdin } : {}) });
    } else if (program.kind === "file") {
      const written = ctx.written.get(resolveWritten(ctx, program.path));
      // 1.0.4 U17: a script on disk this text did not write asks
      if (!written) { if (!isNullInput(program.path)) unseenScript(visitor, program.path, ctx, elevated, `${name} runs a script file the reader does not see`); }
      else scanProvenance(written, ctx, visitor, elevated, interpreter, 1);
    } else if (program.kind === "stdin" && stdin) {
      scanProvenance(stdin, ctx, visitor, elevated, interpreter);
    }
  }
  if (name === "eval") {
    // the text runs in this shell: what it binds, moves to or defines stays
    if (!args.every(isPlain)) {
      const values = args.flatMap(word => expandWord(word, ctx));
      if (values.every(isPlain)) {
        // Preserve a known catastrophic payload before the residual value
        // hold, without widening Ask/Auto for ordinary eval-from-a-value.
        hit = walkInPlace(values.map(renderWord).join(" "), fork(ctx, true), visitor, "eval");
        if (hit) return hit;
      }
    }
    plainWords(args, "text eval runs");
    const text = args.map(renderWord).join(" ");
    if (text.trim()) {
      hit = walkInPlace(text, ctx, visitor, "eval");
      if (hit) return hit;
    }
    return null;
  }
  if (name === "trap") {
    // `trap 'action' SIG…`: the action is a script that runs later, at a
    // time the reader does not see. It is read now, marked so a risky
    // command in it asks, and whatever it changes is unknown from here on
    const action = args.find((word) => !(literalText(word) ?? "").startsWith("-") || literalText(word) === "-");
    if (action) {
      const text = literalText(action);
      if (text === undefined) throw new Unreadable("dynamic-eval", "trap");
      if (text.trim() && text !== "-") {
        const inner = fork(ctx, true);
        inner.indirect = ctx.indirect ?? "trap";
        hit = walkScript(text, inner, visitor);
        if (hit) return hit;
        merge(ctx, [inner]);
      }
    }
  }
  if (name === "source" || name === ".") {
    // a sourced file this text wrote runs here, as written: it is walked
    // (or, written from a value, asks); a file a value names after this text
    // wrote files may be one of them
    const at = literalText(args[0] ?? { parts: [] }) === "--" ? 1 : 0;
    const file = args[at];
    if (file) {
      const candidates = candidatesOf(file, ctx);
      const only = candidates.length === 1 ? candidates[0]! : undefined;
      if (only?.kind === "literal") {
        const written = ctx.written.get(resolveWritten(ctx, only.text));
        if (written) {
          hit = runWritten(written, args.slice(at + 1), ctx, visitor, elevated, false, 0, stdin);
          if (hit) return hit;
        } else if (!isNullInput(only.text)) {
          // 1.0.4 U17 r2 (fail closed, as `bash x.sh` is): a file on disk this
          // text did not write runs here unseen
          unseenScript(visitor, resolvePath(ctx, only.text), ctx, elevated, `${name} runs a script file the reader does not see`);
        }
      } else {
        // 1.0.4 U17 r2: a file a value names is one the reader cannot see
        throw new Unreadable("expansion", ctx.written.size ? `${name} reads a file a value names, after this text wrote files` : `${name} reads a file a value names`);
      }
    }
  }
  if ((name === "printf" && args.some((word) => literalText(word) === "-v")) || name === "getopts") {
    // 1.0.5 r8: `printf -v "$n" …`: a name a value gives may be a loader variable
    if (args.some((word) => { const text = literalText(word); return text === undefined || isLoaderName(text); })) markLoaderVariable(ctx.loaders, `${name} of a loader variable or a name a value gives`);
  }
  if (OPAQUE.has(name) || (name === "printf" && args.some((word) => literalText(word) === "-v"))) {
    // `source x`, `let`, `printf -v`: names the text does not spell out are
    // assigned, and a sourced file can define anything a trap would run
    if (ctx.trapCalls?.size && (name === "source" || name === ".")) throw new Unreadable("dynamic-eval", `${name} after a trap is registered`);
    applyEffects(name === "source" || name === "." ? SOURCE_EFFECTS : OPAQUE_EFFECTS, ctx);
    for (const [fname, shape] of ctx.functions) ctx.functions.set(fname, { ...shape, conflict: true });
  }
  if (name === "alias") {
    for (const word of args) {
      const text = literalText(word) ?? "=";
      if (!text.includes("=")) continue;
      if (isShadowed(text.slice(0, text.indexOf("=")).toLowerCase())) throw new Unreadable("shadow", `alias ${text.slice(0, text.indexOf("="))}`);
      throw new Unreadable("dynamic-eval", "alias");
    }
  }
  if (name === "find") {
    // `find … -exec cmd {} ;`: the action is a command of its own, run with
    // `{}` standing for what find finds, under its roots; any value among
    // the arguments could be an action or part of one
    if (visitor.findValues?.(args) !== true) plainWords(args, "find's arguments");
    const roots = findRoots(args);
    for (let i = 0; i < args.length; i++) {
      if (!FIND_ACTIONS.has(literalText(args[i]!) ?? "")) continue;
      const action: Word[] = [];
      let j = i + 1;
      for (; j < args.length; j++) {
        const text = literalText(args[j]!);
        if (text === ";" || text === "+") break;
        action.push(args[j]!);
      }
      if (j >= args.length) throw new Unreadable("syntax", "find -exec without ;");
      if (action.length) {
        const outer = ctx.findAction;
        ctx.findAction = true;
        try {
          for (const root of roots) {
            hit = visitWords(action.map((word) => spliceWord(word, "{}", root)), command, undefined, ctx, visitor, undefined, derived, [], elevated);
            if (hit) return hit;
          }
        } finally {
          if (outer) ctx.findAction = true; else delete ctx.findAction;
        }
      }
      i = j;
    }
  }
  if (BINDERS.has(name)) {
    // `declare -n R=S` is a reference, `-i` an integer, `-a` an array:
    // with any option the value is not what is written. A `readonly` name
    // keeps its value through every later assignment, which fails
    const options = args.some((word) => (literalText(word) ?? "").startsWith("-"));
    for (const word of args) {
      const assignment = assignmentOf(word);
      const text = literalText(word);
      // 1.0.5 r8: `export "$n=x"`: a name a value gives may be a loader
      // variable; `export $'NODE_OPT\x49ONS'=x` is one, decoded
      if (!assignment && text === undefined) markLoaderVariable(ctx.loaders, `${name} of a name a value gives`);
      const setName = assignment?.name ?? text?.split("=")[0];
      if (setName !== undefined && isLoaderName(setName)) markLoaderVariable(ctx.loaders, setName);
      const readonly = name === "readonly" || (name !== "export" && options && args.some((w) => /^-[A-Za-z]*r/.test(literalText(w) ?? "")));
      if (!assignment) {
        if (readonly && text !== undefined && !text.startsWith("-")) { ctx.readonly.add(text); unknownName(text, ctx); }
        continue;
      }
      if (readonly) ctx.readonly.add(assignment.name);
      if (options || assignment.append || readonly) unknownName(assignment.name, ctx);
      else bind(assignment.name, assignment.value, ctx);
    }
  } else if (name === "read") {
    if (args.some((word) => { const text = literalText(word); return text === undefined || isLoaderName(text); })) markLoaderVariable(ctx.loaders, "read of a loader variable or a name a value gives");
    bindRead(args, stdin, ctx);
  } else if (name === "unset") {
    // an `unset` name is unknown from here on
    for (const word of args) {
      const text = literalText(word);
      if (text !== undefined && !text.startsWith("-")) unknownName(text, ctx);
    }
  }
  hit = visitor.command(simpleCommand(name, args, ctx, {
    redirects: command.redirects, elevated, derived, ...(stdin ? { stdin } : {}),
    ...(direct !== undefined ? { program: { text: direct, dialect: "posix" as const } } : {}),
  }), ctx);
  if (hit) return hit;
  recordWrites(command, before, name, args, ctx, visitor.catastrophic);
  return null;
}
