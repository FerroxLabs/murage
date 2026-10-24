// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The few commands Murage always asks about, at every access level.
//
// Ask, Auto, Full access and No limits decide how much a bot does without a
// card. None of them was ever meant to cover wiping the computer: deleting
// the whole drive, the home folder or a folder the system runs from, erasing
// a disk, or a fork bomb. Under No limits those used to go through unasked.
// They now raise an ordinary approval card, every time. They are not
// blocked: the owner can still allow one, and only that once (no "always
// allow" is offered or honoured for them).
//
// The list is short and literal on purpose. It parses the command as a shell
// would (server/shell/), visits every place a command can run, and calls a
// command ordinary only when every construct in it is one the reader models
// in full. Everything else asks: a word it cannot quote, a wrapper option it
// does not know, a command whose name is a value, a script fed to a shell
// from somewhere it cannot see, a value or folder that differs by branch.
// Quoted text is literal by construction, so the same words inside
// `echo "..."` or a commit message do not count, while `sh -c "..."`,
// `sudo`, `$( )` and heredocs read by a shell are looked through. It is a
// backstop for the obvious catastrophes, not a sandbox: real containment is
// the bot's own computer.
//
// A risky command (a delete, a move, a copy over a file, `chmod` or
// `chown`, an in-place edit, a disk write, `tee`, an output redirect) is
// read through its operands' candidates (server/shell/walk.ts): the values
// this text bound put in. When a candidate names a catastrophe, that is the
// card. A device path asks wherever it is spelled, unless a device reader
// reads it. Otherwise it asks when an operand is a value the text does not
// fix, a glob is anchored at a catastrophic folder, the program's own name
// came from a value, or it sits in a trap body. A folder the text does not
// fix makes a later relative delete ask.
//
// A mirror that deletes (`rsync --delete`, `rclone sync`, `robocopy /MIR`,
// `unison`, a cloud CLI's delete-sync) removes from its destination whatever
// the source lacks: the destination is read as `rm -rf` reads its paths.

import { isPlain, lex, literalText, renderWord, Unreadable, type Part, type Quote, type Word } from "./shell/lex.ts";
import { looksLikePowerShell, nestedProgram, POWERSHELLS, walkCmd, walkNestedInput, walkPwsh } from "./shell/pwsh.ts";
import {
  candidatesOf, deviceInWord, deviceReadPosition, fork, HOME, HOME_PARENT, homeSpelled, interpreterKey, isAnchored, isDeviceWrite, newContext, normalizePath, REMOTE_ELEVATED, resolveFrom,
  UNKNOWN_MARK, unmarked, walkScript, type Candidate, type SimpleCommand, type Visitor, type WalkContext,
} from "./shell/walk.ts";
import { posix as posixPath } from "node:path";
import { parse, type Redirect } from "./shell/parse.ts";

export type AlwaysAskRule = "delete-root" | "delete-home" | "delete-system-folder" | "disk-erase" | "fork-bomb" | "unreadable" | "unknown-target" | "protected-path";

/** What a protected path is (`protectedClass`). */
export type ProtectedClass = "root" | "home" | "system" | "volume";

export interface AlwaysAskHit {
  rule: AlwaysAskRule;
  /** Plain words for the card: what this would do. */
  what: string;
  /** `protected-path` only: the class of the path, and the program pointed at it */
  protectedClass?: ProtectedClass;
  program?: string;
  /** `unreadable` only (1.0.5): the one thing the reader could not see is a
   * script file on disk, named by a literal path this text did not write
   * (`source venv/bin/activate`, `bash build.sh`, `python manage.py`), and
   * the rest of the text was read whole. It asks at Ask and Auto; Full access
   * and No limits, on a turn they cover, run it (server/auto-approve.ts). */
  unseenScript?: true;
}

const WHAT: Record<AlwaysAskRule, string> = {
  "delete-root": "This would delete everything on this computer's main drive.",
  "delete-home": "This would delete your whole home folder.",
  "delete-system-folder": "This would delete a folder your computer needs to run.",
  "disk-erase": "This would erase or overwrite a whole disk.",
  "fork-bomb": "This would start copies of itself until the computer stops responding.",
  "unreadable": "Murage could not read this command well enough to tell what it would touch, so it asks you first.",
  "unknown-target": "This would delete whatever folder a value names when it runs, and Murage cannot see that value in advance.",
  "protected-path": "This points a program Murage does not know as read-only at a folder it protects.",
};

/** The card for the protected-path rule, by class. */
const PROTECTED_WHAT: Record<ProtectedClass, string> = {
  root: "This points a program Murage does not know as read-only at this computer's main drive.",
  home: "This points a program Murage does not know as read-only at your whole home folder.",
  system: "This points a program Murage does not know as read-only at a folder your computer needs to run.",
  volume: "This points a program Murage does not know as read-only at a whole disk or volume.",
};

/** The sentence a held card shows: what it would do, and why it asks. */
export function alwaysAskNote(hit: AlwaysAskHit): string {
  return `${hit.what} Murage always asks before a command like this, at every access level.`;
}

const hit = (rule: AlwaysAskRule): AlwaysAskHit => ({ rule, what: WHAT[rule] });

/** The card for text downloaded from the internet and run elevated
 * (UPSEC 10.5): it asks as an unreadable command does, in its own words. */
const REMOTE_ELEVATED_WHAT = "This runs text downloaded from the internet with administrator rights, and Murage cannot see that text in advance.";

/** The hit for a command the reader was not given whole (a cut card). */
export function unreadableHit(): AlwaysAskHit {
  return hit("unreadable");
}

/** Top-level folders the system runs from (macOS, Linux). A delete of one of
 * these, or of everything inside one, always asks. */
const SYSTEM_FOLDERS = new Set([
  "/applications", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/library",
  "/opt", "/private", "/proc", "/root", "/sbin", "/srv", "/sys", "/system", "/users", "/usr", "/var",
]);
/** Windows system folders, matched after the drive root. */
const WINDOWS_SYSTEM_FOLDERS = new Set(["windows", "program files", "program files (x86)", "programdata", "users"]);
/** What a path argument names, once `~`, `$HOME` and a trailing `/`, `/*`
 * or `/.` are taken away. */
function classifyPath(raw: string): AlwaysAskRule | null {
  let p = homeSpelled(raw);
  if (!p) return null;
  // `~/..` is the folder that holds every home folder
  if (/^~\/(.*\/)?\.\.(\/|$)/.test(p)) p = `${HOME || "/home/user"}${p.slice(1)}`;
  if (isAnchored(p)) p = normalizePath(p);
  // a Windows drive root: C:, C:/, C:/*
  const drive = /^[a-z]:(\/.*)?$/i.exec(p);
  if (drive) {
    const rest = (drive[1] ?? "").replace(/(\/\*|\/\.)+$/, "").replace(/\/+$/, "").replace(/^\//, "").toLowerCase();
    if (!rest) return "delete-root";
    if (WINDOWS_SYSTEM_FOLDERS.has(rest)) return "delete-system-folder";
    if (/^users\/[^/]+$/.test(rest)) return "delete-home";
    return null;
  }
  // collapse repeated slashes, then strip what means "everything in it"
  p = p.replace(/\/{2,}/g, "/");
  for (;;) {
    const next = p.replace(/\/\*$/, "").replace(/\/\.$/, "").replace(/(.)\/$/, "$1");
    if (next === p) break;
    p = next;
  }
  if (p === "/" || p === "/*" || p === "") return "delete-root";
  if (p === "~" || /^~[A-Za-z0-9._-]+$/.test(p)) return "delete-home";
  const lower = p.toLowerCase();
  if (/^\/(users|home)\/[^/]+$/.test(lower) || (HOME && HOME !== "/" && lower === HOME)) return "delete-home";
  if (SYSTEM_FOLDERS.has(lower) || (HOME_PARENT && HOME_PARENT !== "/" && lower === HOME_PARENT)) return "delete-system-folder";
  return null;
}

const RANK: Record<AlwaysAskRule, number> = {
  "delete-root": 3, "delete-home": 2, "delete-system-folder": 2, "disk-erase": 2, "fork-bomb": 2, "unreadable": 2, "unknown-target": 1, "protected-path": 2,
};

/** Folders that hold the mounted volumes, and other top-level system folders
 * the delete rules do not list. */
const MOUNT_PARENTS = new Set(["/volumes", "/mnt", "/media", "/run/media"]);
const MORE_SYSTEM = new Set(["/nix", "/snap", "/cores"]);

/** The protected class a path names, or null: the drive root, a home folder
 * (`~`, `/Users/x`, `/home/x`, `/var/root`), a folder the system runs from
 * (macOS `/private/etc` is `/etc`), or one whole mounted volume
 * (`/Volumes/x`, `/mnt/x`, `/media/u/x`). Anything deeper is ordinary. */
export function protectedClass(raw: string): ProtectedClass | null {
  switch (classifyPath(raw)) {
    case "delete-root": return "root";
    case "delete-home": return "home";
    case "delete-system-folder": return "system";
  }
  const spelled = homeSpelled(raw);
  if (!spelled.startsWith("/")) return null;
  let p = normalizePath(spelled);
  for (;;) {
    const next = p.replace(/\/\*$/, "").replace(/\/\.$/, "").replace(/(.)\/$/, "$1");
    if (next === p) break;
    p = next;
  }
  p = p.toLowerCase();
  if (p.startsWith("/private/")) {
    const inner = p.slice("/private".length);
    if (classifyPath(inner) === "delete-system-folder" || MORE_SYSTEM.has(inner) || MOUNT_PARENTS.has(inner)) return "system";
  }
  if (p === "/var/root") return "home";
  if (MORE_SYSTEM.has(p) || MOUNT_PARENTS.has(p)) return "system";
  if (/^\/(volumes|mnt|media)\/[^/]+$/.test(p) || /^\/(media|run\/media)\/[^/]+\/[^/]+$/.test(p) || /^\/run\/media\/[^/]+$/.test(p)) return "volume";
  return null;
}


/** A glob anchored at one of these reaches into every top-level, home or
 * device folder: the drive root, the folders that hold the home folders,
 * `/dev`. */
function catastrophicAnchor(anchor: string): boolean {
  if (/^~\/(.*\/)?\.\.$/.test(anchor)) return true;
  const a = normalizePath(homeSpelled(anchor)).toLowerCase();
  return a === "/" || a === "/users" || a === "/home" || a === "/dev" || (HOME_PARENT !== "" && HOME_PARENT !== "/" && a === HOME_PARENT);
}

/** What one candidate of a path operand names. A value the text cannot see
 * asks only when what follows it is nothing but `/`, `/*` or `/.` (the
 * empty-variable footgun, `rm -rf $DIR/`), or when an empty value in the
 * middle would land on a catastrophe (`rm -rf ~/$x`); a glob anchored at a
 * catastrophic folder (`/us?`, `/Users/*`) asks the same way. */
function classifyCandidate(candidate: Candidate, ctx: WalkContext): AlwaysAskRule | null {
  // a relative path from a folder the text does not fix (it differs by
  // branch, or came from a value): the reader cannot tell which folder
  if (ctx.cwdConflict && !isAnchored(homeSpelled(unmarked(candidate.path)))) return valueTarget("folder", "the folder this runs from is not fixed by the text", FOLDER_TARGET);
  const cwd = ctx.cwd;
  switch (candidate.kind) {
    case "literal": return classifyPath(resolveFrom(cwd, candidate.path));
    case "glob": return classifyPath(resolveFrom(cwd, candidate.path)) ?? (catastrophicAnchor(candidate.anchor) ? "unknown-target" : null);
    // an item of a list file on disk: the same trust as a script on disk
    case "fromFile": return null;
    case "value": {
      if (candidate.lead) {
        const rest = candidate.path.slice(1).replace(/\\/g, "/");
        return rest !== "" && /^(\/(\*|\.)?)+$/.test(rest) ? "unknown-target" : null;
      }
      return classifyPath(resolveFrom(cwd, candidate.path.replaceAll(UNKNOWN_MARK, ""))) ? "unknown-target" : null;
    }
  }
}

/** The worst thing any candidate of these operands names. */
function worstOf(lists: Candidate[][], ctx: WalkContext): AlwaysAskRule | null {
  let found: AlwaysAskRule | null = null;
  for (const list of lists) {
    for (const candidate of list) {
      const rule = classifyCandidate(candidate, ctx);
      if (rule === "delete-root") return rule;
      if (rule && (!found || RANK[rule] > RANK[found])) found = rule;
    }
  }
  return found;
}

/** An operand's text when it stands for exactly one literal, else undefined. */
function flagText(list: Candidate[] | undefined): string | undefined {
  const only = list && list.length === 1 ? list[0]! : undefined;
  return only?.kind === "literal" ? only.text : undefined;
}

/** A delete that is not recursive as written, but has an argument the text
 * does not fix (`rm $FLAGS /`): that value may be the recursive flag, so
 * when a path it names would have asked, the reader asks. */
function optionFromValue(recursive: boolean, unknown: boolean, paths: Candidate[][], ctx: WalkContext): AlwaysAskRule | null {
  if (recursive) return worstOf(paths, ctx);
  // the target here is a literal that asks; only the option is a value, so
  // the routine carve-out never covers it
  if (unknown && worstOf(paths, ctx)) throw new Unreadable("expansion", "a delete option from a value");
  return null;
}

/** `rm` with a recursive flag, on a path that always asks. */
function rmHit(cmd: SimpleCommand, ctx: WalkContext): AlwaysAskRule | null {
  // a `find -exec` action runs on every file under the roots: recursive in effect
  let recursive = !!ctx.findAction;
  let unknown = false;
  const paths: Candidate[][] = [];
  let flagsDone = false;
  for (const list of cmd.operands) {
    const text = flagText(list);
    if (text === undefined && !flagsDone) unknown = true;
    if (!flagsDone && text === "--") { flagsDone = true; continue; }
    if (!flagsDone && text !== undefined && /^--/.test(text)) {
      if (text === "--recursive") recursive = true;
      continue;
    }
    if (!flagsDone && text !== undefined && /^-[a-zA-Z]+$/.test(text)) {
      if (/[rR]/.test(text)) recursive = true;
      continue;
    }
    paths.push(list);
  }
  return optionFromValue(recursive, unknown, paths, ctx);
}

/** Remove-Item's parameters with their aliases, for PowerShell's own
 * resolution: an exact name or alias, else the one parameter the text is a
 * prefix of. Anything else (`-f` is Filter or Force) PowerShell refuses,
 * and the reader asks. */
const REMOVE_ITEM_PARAMETERS: Array<{ name: string; aliases: string[]; value: boolean }> = [
  { name: "path", aliases: [], value: true },
  { name: "literalpath", aliases: ["pspath", "lp"], value: true },
  { name: "filter", aliases: [], value: true },
  { name: "include", aliases: [], value: true },
  { name: "exclude", aliases: [], value: true },
  { name: "recurse", aliases: [], value: false },
  { name: "force", aliases: [], value: false },
  { name: "credential", aliases: [], value: true },
  { name: "stream", aliases: [], value: true },
  { name: "whatif", aliases: ["wi"], value: false },
  { name: "confirm", aliases: ["cf"], value: false },
  { name: "usetransaction", aliases: ["usetx"], value: false },
  { name: "verbose", aliases: ["vb"], value: false },
  { name: "debug", aliases: ["db"], value: false },
  { name: "erroraction", aliases: ["ea"], value: true },
  { name: "warningaction", aliases: ["wa"], value: true },
  { name: "informationaction", aliases: ["infa"], value: true },
  { name: "progressaction", aliases: ["proga"], value: true },
  { name: "errorvariable", aliases: ["ev"], value: true },
  { name: "warningvariable", aliases: ["wv"], value: true },
  { name: "informationvariable", aliases: ["iv"], value: true },
  { name: "outvariable", aliases: ["ov"], value: true },
  { name: "outbuffer", aliases: ["ob"], value: true },
  { name: "pipelinevariable", aliases: ["pv"], value: true },
];

function removeItemParameter(given: string): { name: string; value: boolean } {
  const text = given.toLowerCase();
  const exact = REMOVE_ITEM_PARAMETERS.find((p) => p.name === text || p.aliases.includes(text));
  if (exact) return exact;
  const matches = REMOVE_ITEM_PARAMETERS.filter((p) => p.name.startsWith(text) || p.aliases.some((alias) => alias.startsWith(text)));
  if (matches.length !== 1) throw new Unreadable("pwsh", matches.length ? `-${given} is ambiguous` : `-${given} is not a Remove-Item parameter`);
  return matches[0]!;
}

/** Windows `rd /s`, `rmdir /s`, `del /s`, and PowerShell `Remove-Item`
 * under any of its names (server/shell/pwsh.ts resolves the aliases),
 * with its parameters resolved as PowerShell resolves them. */
function windowsDeleteHit(cmd: SimpleCommand, ctx: WalkContext): AlwaysAskRule | null {
  const { name, operands } = cmd;
  const texts = operands.map(flagText);
  if (name === "rd" || name === "rmdir" || name === "del" || name === "erase") {
    if (!texts.some((a) => a !== undefined && /^\/s$/i.test(a))) return null;
    return worstOf(operands.filter((_, i) => !(texts[i] !== undefined && /^\/[a-z]$/i.test(texts[i]!))), ctx);
  }
  if (name === "remove-item" || name === "ri") {
    let recursive = false;
    let unknown = false;
    const paths: Candidate[][] = [];
    for (let i = 0; i < operands.length; i++) {
      const text = texts[i];
      if (text === undefined) { unknown = true; paths.push(operands[i]!); continue; }
      if (text === "--%") throw new Unreadable("pwsh", "--% stops parsing");
      if (text === "--") { paths.push(...operands.slice(i + 1)); break; }
      const parameter = /^-([A-Za-z]+)(:.*)?$/.exec(text);
      if (!parameter) { paths.push(operands[i]!); continue; }
      if (parameter[2] !== undefined) throw new Unreadable("pwsh", `${text}: a parameter with a glued value`);
      const resolved = removeItemParameter(parameter[1]!);
      if (resolved.value) {
        const value = operands[i + 1];
        if (!value) throw new Unreadable("pwsh", `${text} without a value`);
        if (resolved.name === "path" || resolved.name === "literalpath") paths.push(value);
        i++;
        continue;
      }
      if (resolved.name === "recurse") recursive = true;
    }
    return optionFromValue(recursive, unknown, paths, ctx);
  }
  return null;
}

/** `find <path> -delete`: its roots. A `find -exec` action is a command of
 * its own, walked with `{}` standing for the roots and `ctx.findAction` set:
 * whatever program the walker resolves it to, a delete there reaches every
 * file under the roots (`rmHit`). */
function findHit(cmd: SimpleCommand, ctx: WalkContext): AlwaysAskRule | null {
  const texts = cmd.operands.map(flagText);
  if (!texts.includes("-delete")) return null;
  const roots: Candidate[][] = [];
  for (const [i, list] of cmd.operands.entries()) {
    const text = texts[i];
    if (text !== undefined && (text.startsWith("-") || text === "!" || text === "(")) break;
    roots.push(list);
  }
  // `find -delete` with no folder starts from the current one
  return worstOf(roots.length ? roots : [[{ kind: "literal", text: ".", path: "." }]], ctx);
}

/** How a mirroring tool's options take values: short letters that take one
 * (separate or glued), `--long` names that take the next word, and
 * single-dash names (unison's `-path x`). An option's value is no operand. */
interface MirrorArgs { short?: string; long?: readonly string[]; dash?: readonly string[] }

/** The operand indexes from `from` on, options and their values left out. */
function mirrorOperands(texts: Array<string | undefined>, spec: MirrorArgs, from = 0, to = texts.length): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const text = texts[i];
    if (text === undefined || text === "-" || !text.startsWith("-")) { out.push(i); continue; }
    if (text === "--") { for (let j = i + 1; j < to; j++) out.push(j); break; }
    if (spec.dash) { if (!text.includes("=") && spec.dash.includes(text.toLowerCase())) i++; continue; }
    if (text.startsWith("--")) { if (!text.includes("=") && spec.long?.includes(text)) i++; continue; }
    for (let k = 1; k < text.length; k++) if ((spec.short ?? "").includes(text[k]!)) { if (k === text.length - 1) i++; break; }
  }
  return out;
}

const RSYNC_ARGS: MirrorArgs = {
  short: "BefTM@",
  long: ["--block-size", "--rsh", "--rsync-path", "--filter", "--exclude", "--exclude-from", "--include", "--include-from", "--files-from", "--temp-dir",
    "--compare-dest", "--copy-dest", "--link-dest", "--backup-dir", "--suffix", "--chmod", "--chown", "--usermap", "--groupmap", "--max-delete", "--max-size",
    "--min-size", "--max-alloc", "--partial-dir", "--timeout", "--contimeout", "--port", "--sockopts", "--log-file", "--log-file-format", "--out-format",
    "--password-file", "--bwlimit", "--stop-after", "--stop-at", "--write-batch", "--only-write-batch", "--read-batch", "--protocol", "--iconv",
    "--checksum-choice", "--cc", "--compress-choice", "--zc", "--compress-level", "--zl", "--skip-compress", "--info", "--debug", "--remote-option",
    "--modify-window", "--outbuf", "--address", "--checksum-seed", "--copy-as", "--early-input"],
};
const RCLONE_ARGS: MirrorArgs = {
  long: ["--config", "--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--filter-from", "--files-from", "--files-from-raw", "--transfers",
    "--checkers", "--log-file", "--log-level", "--backup-dir", "--suffix", "--max-age", "--min-age", "--max-size", "--min-size", "--bwlimit", "--stats",
    "--retries", "--timeout", "--contimeout", "--max-delete", "--max-transfer", "--order-by", "--compare-dest", "--copy-dest", "--user-agent", "--tpslimit",
    "--exclude-if-present", "--low-level-retries", "--buffer-size", "--multi-thread-streams", "--max-depth", "--cache-dir", "--password-command",
    "--conflict-resolve", "--conflict-loser", "--conflict-suffix", "--workdir", "--backup-dir1", "--backup-dir2", "--track-renames-strategy"],
};
const UNISON_ARGS: MirrorArgs = {
  dash: ["-path", "-ignore", "-ignorenot", "-prefer", "-force", "-logfile", "-backup", "-backupdir", "-backuploc", "-backupprefix", "-backupsuffix", "-nodeletion",
    "-noupdate", "-nocreation", "-servercmd", "-sshcmd", "-sshargs", "-label", "-merge", "-ui", "-repeat", "-retry", "-maxthreads", "-copyprog", "-copyprogrest",
    "-follow", "-rootalias", "-maxbackups", "-diff", "-root"],
};
const CLOUD_ARGS: MirrorArgs = {
  long: ["--exclude", "--include", "--profile", "--region", "--endpoint-url", "--acl", "--storage-class", "--sse", "--sse-kms-key-id", "--cache-control",
    "--content-type", "--metadata", "--metadata-directive", "--grants", "--expires", "--output", "--query", "--page-size", "--ca-bundle", "--color",
    "--request-payer", "--source-region", "--project", "--delete-destination", "--exclude-path", "--include-pattern", "--exclude-pattern", "--log-level",
    "--older-than", "--newer-than", "--encrypt-key"],
};
/** rclone's commands: the first operand that is one of these is the command (a global option's value before it is not). */
const RCLONE_COMMANDS = new Set(["sync", "bisync", "copy", "copyto", "move", "moveto", "purge", "delete", "deletefile", "rmdir", "rmdirs", "ls", "lsd", "lsl",
  "lsf", "lsjson", "check", "checksum", "mkdir", "cat", "config", "mount", "serve", "size", "about", "dedupe", "cleanup", "touch", "tree", "ncdu", "hashsum",
  "md5sum", "sha1sum", "link", "version", "listremotes", "rcat", "copyurl", "cryptcheck", "obscure", "settier", "backend", "selfupdate", "test", "help", "rc", "rcd"]);

/** Mirroring and sync tools that delete (`rsync --delete`, `rclone sync`,
 * `robocopy /MIR`, `unison`, the cloud CLIs' delete-sync): the operands they
 * delete from, or undefined when the command, as written, deletes nothing.
 * The destination of a deleting mirror is a recursive delete of whatever it
 * holds that the source does not, so it is read as `rm -rf` reads its
 * paths. A tool's first operand is its source; every later operand counts
 * as a destination, so an option value the reader takes for an operand can
 * only add a path, never hide the real destination. */
function mirrorTargets(cmd: SimpleCommand): Candidate[][] | undefined {
  const name = cmd.name.toLowerCase().replace(/\.(exe|cmd)$/, "");
  const texts = cmd.operands.map(flagText);
  const lists = (indexes: number[]) => indexes.map((i) => cmd.operands[i]!.map(localPath));
  // the operands after `verb` (the first operand spelled `verb`, options before it skipped)
  const after = (spec: MirrorArgs, ...verbs: string[]) => {
    const all = mirrorOperands(texts, spec);
    for (let at = 0; at + verbs.length <= all.length; at++) {
      if (verbs.every((verb, k) => texts[all[at + k]!]?.toLowerCase() === verb)) return all.slice(at + verbs.length);
    }
    return undefined;
  };
  const rimraf = rimrafTargets(cmd, name, texts);
  if (rimraf) return rimraf;
  switch (name) {
    case "rsync": {
      const operands = mirrorOperands(texts, RSYNC_ARGS);
      const targets: number[] = [];
      if (texts.some((text) => text !== undefined && /^--del(e(t(e.*)?)?)?$/.test(text))) targets.push(...operands.slice(1));
      if (texts.some((text) => text === "--remove-source-files" || text === "--remove-sent-files")) targets.push(...operands.slice(0, -1));
      return targets.length ? lists(targets) : undefined;
    }
    case "rclone": {
      const operands = mirrorOperands(texts, RCLONE_ARGS);
      const at = operands.findIndex((i) => RCLONE_COMMANDS.has(texts[i]?.toLowerCase() ?? ""));
      if (at < 0) return undefined;
      const verb = texts[operands[at]!]!.toLowerCase();
      const rest = operands.slice(at + 1);
      if (verb === "sync") return lists(rest.slice(1));
      if (verb === "bisync" || verb === "purge" || verb === "delete") return lists(rest);
      return undefined;
    }
    case "robocopy": {
      if (!texts.some((text) => text !== undefined && /^\/\/?(mir|purge)$/i.test(text))) return undefined;
      // `/MIR` and the other switches name no folder robocopy deletes from;
      // every word after the source is read, which they never match
      const source = texts.findIndex((text) => text === undefined || !/^\/\/?[a-z]+(:.*)?$/i.test(text) || classifyPath(text) !== null);
      return source < 0 ? undefined : cmd.operands.slice(source + 1);
    }
    // a sync propagates deletes into both roots: every root is a target
    case "unison": {
      const roots = mirrorOperands(texts, UNISON_ARGS);
      texts.forEach((text, i) => { if (text?.toLowerCase() === "-root" && i + 1 < texts.length) roots.push(i + 1); });
      return lists(roots);
    }
    case "aws": {
      if (!texts.includes("--delete")) return undefined;
      const rest = after(CLOUD_ARGS, "s3", "sync");
      return rest ? lists(rest.slice(1)) : undefined;
    }
    case "gsutil": {
      const rest = after({ short: "ohu", long: [] }, "rsync");
      if (!rest) return undefined;
      const start = cmd.operands.findIndex((_, i) => texts[i] === "rsync");
      let deletes = false;
      for (const text of texts.slice(start + 1)) {
        if (text === undefined || !/^-[A-Za-z]+$/.test(text)) continue;
        for (const letter of text.slice(1)) { if (letter === "d") deletes = true; if ("xyaj".includes(letter)) break; }
      }
      return deletes ? lists(mirrorOperands(texts, { short: "xyaj" }, start + 1).slice(1)) : undefined;
    }
    case "gcloud": {
      if (!texts.some((text) => text?.startsWith("--delete-unmatched-destination-objects"))) return undefined;
      const rest = after(CLOUD_ARGS, "storage", "rsync");
      return rest ? lists(rest.slice(1)) : undefined;
    }
    case "azcopy": {
      const flag = texts.findIndex((text) => text?.startsWith("--delete-destination"));
      if (flag < 0) return undefined;
      const value = texts[flag]!.includes("=") ? texts[flag]!.slice(texts[flag]!.indexOf("=") + 1) : texts[flag + 1];
      if (value !== undefined && value.toLowerCase() === "false") return undefined;
      const rest = after(CLOUD_ARGS, "sync");
      return rest ? lists(rest.slice(1)) : undefined;
    }
    case "mc": {
      if (texts.includes("--remove")) {
        const rest = after(CLOUD_ARGS, "mirror");
        if (rest) return lists(rest.slice(1));
      }
      const rest = after(CLOUD_ARGS, "rm");
      if (rest && texts.some((text) => text === "--recursive" || text === "-r")) return lists(rest);
      return undefined;
    }
  }
  return undefined;
}

/** A path a tool names through its local backend (`rclone`'s `:local:` or
 * `:local,opt=x:`, `file://` for the cloud CLIs) is that local path. */
function localPath(candidate: Candidate): Candidate {
  if (candidate.kind === "fromFile") return candidate;
  const prefix = /^(:local(,[^:]*)?:|file:\/\/(?=\/|[a-z]:)|file:\/\/localhost(?=\/))/i.exec(candidate.path)?.[0];
  if (!prefix) return candidate;
  const path = candidate.path.slice(prefix.length) || ".";
  return candidate.kind === "literal" ? { ...candidate, text: path, path } : { ...candidate, path };
}

/** `rimraf` and its runners (`npx rimraf`, `pnpm dlx rimraf`, `bunx rimraf`):
 * a recursive delete of every path it is given. */
const RIMRAF_RUNNERS = new Set(["npx", "pnpx", "bunx", "pnpm", "yarn", "npm", "bun"]);
function rimrafTargets(cmd: SimpleCommand, name: string, texts: Array<string | undefined>): Candidate[][] | undefined {
  const at = name === "rimraf" ? -1 : RIMRAF_RUNNERS.has(name) ? texts.findIndex((text) => text !== undefined && /^rimraf(@\S*)?$/i.test(text)) : -2;
  if (at === -2 || (at < 0 && name !== "rimraf")) return undefined;
  return cmd.operands.filter((_, i) => i > at && (texts[i] === undefined || !texts[i]!.startsWith("-")));
}

/** A deleting mirror whose destination always asks, read as `rm -rf` reads it. */
function mirrorHit(cmd: SimpleCommand, ctx: WalkContext): AlwaysAskRule | null {
  const targets = mirrorTargets(cmd);
  return targets ? worstOf(targets, ctx) : null;
}

/** Commands that erase a disk whatever their operands say. */
const DISK_WRITERS = new Set(["mke2fs", "newfs", "wipefs", "diskutil", "format", "format.com", "format-volume", "clear-disk", "initialize-disk", "mknod"]);
/** Commands that delete, move, overwrite or change who may use a file: the
 * Unix ones and PowerShell's (cmd's `rd`, `del` and `move` too). */
const RISKY = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "ln", "install", "rsync", "truncate", "chmod", "chown", "chgrp", "chflags", "setfacl", "tee", "dd", "shred",
  "rd", "del", "erase", "move", "copy", "xcopy", "robocopy", "icacls", "takeown", "attrib", "ren",
  "remove-item", "ri", "move-item", "mi", "copy-item", "cpi", "rename-item", "rni", "set-content", "sc", "add-content", "ac", "clear-content", "clc", "out-file", "set-acl",
]);

/** A command the reader treats as destructive: a delete, a move, an
 * overwrite, a change of owner or mode, a disk write, an in-place edit. */
function isRisky(name: string, texts: Array<string | undefined>): boolean {
  if (RISKY.has(name) || DISK_WRITERS.has(name) || name.startsWith("mkfs")) return true;
  if (name === "find") return texts.includes("-delete");
  // `sed -i`, `perl -pi -e`: the file is rewritten where it stands
  if (name === "sed" || name === "perl") return texts.some((text) => /^-[A-Za-z]*i|^--in-place/.test(text ?? ""));
  return false;
}

/** Disk verbs that erase whatever operand they are given. */
function diskHit(name: string, texts: Array<string | undefined>): boolean {
  if (name === "mkfs" || name.startsWith("mkfs.") || name === "mke2fs" || name === "newfs" || name === "wipefs" || name === "mknod") return true;
  if (name === "diskutil") {
    const verb = (texts.find((a) => a && !a.startsWith("-")) ?? "").toLowerCase();
    return ["erasedisk", "erasevolume", "zerodisk", "randomdisk", "secureerase", "partitiondisk", "reformat"].includes(verb);
  }
  if (name === "format" || name === "format.com") return texts.some((a) => /^[a-z]:$/i.test(a ?? ""));
  // `Remove-Partition` drops a partition and its data; `diskpart` runs a
  // script (`/s`) or input of disk verbs (`clean`) the reader does not read
  return name === "format-volume" || name === "clear-disk" || name === "initialize-disk" || name === "remove-partition" || name === "diskpart";
}

/** Devices ask wherever they are spelled: a device path in any candidate of
 * any operand, unless the command is a device reader and the operand sits
 * where it reads. */
function deviceHit(cmd: SimpleCommand): boolean {
  const texts = cmd.operands.map(flagText);
  for (const [index, list] of cmd.operands.entries()) {
    for (const candidate of list) {
      if (candidate.kind === "fromFile" || deviceInWord(candidate.path) === undefined) continue;
      if (!deviceReadPosition(cmd.name, texts, index)) return true;
    }
  }
  return false;
}

/** Where output goes (policy A): a device is a disk write, a stream under
 * `/dev/` is not a file, and a value asks. */
function outputTarget(target: Word, candidates: Candidate[], ctx: WalkContext): AlwaysAskHit | null {
  if (candidates.some((candidate) => candidate.kind !== "fromFile" && isDeviceWrite(candidate.path))) return hit("disk-erase");
  if (candidates.every((candidate) => candidate.kind === "literal" && candidate.text.startsWith("/dev/"))) return null;
  if (candidates.some((candidate) => candidate.kind === "value")) valueTargetIn(true, "expansion", "where output goes has a value", REDIRECT_TOOL, targetExpression(target));
  if (ctx.indirect === "trap") throw new Unreadable("indirect", "output written in a trap body");
  return null;
}

/** Deletes of one file at a time: as a `find -exec` action, of every file under the roots. */
const FIND_FILE_DELETES = new Set(["unlink", "shred"]);
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "<>", "&>", "&>>"]);
const CD = new Set(["cd", "pushd", "set-location", "sl", "chdir"]);

/** The tiny read-only allow list of the protected-path rule (A+): a program
 * here may name any path. Matched exactly: case and all for a POSIX name,
 * any case for a PowerShell or cmd name, never with a suffix or a folder. */
const READ_ONLY = new Set(["pwd", "ls", "du", "df", "stat", "wc", "cat", "head", "tail", "cd", "echo", "printf"]);
/** Searches: read-only by name (output sent to a file is the redirect check
 * below), except `rg --pre` and `--pre-glob`, which run a program. */
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg"]);
const RG_RUNNERS = /^--pre(-glob)?(=|$)/;
/** `find` is read-only until an action that deletes, runs a program or
 * writes a file appears among its arguments, in any position. sed and awk
 * stay off the list: their scripts have write and exec modes. */
const FIND_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** Shell builtins that bind names and hand nothing to a program: what they
 * bind is the walker's business, as before. */
const BINDINGS = new Set(["export", "local", "declare", "typeset", "readonly", ":"]);
/** Output that goes nowhere a file lives. */
const QUIET_OUTPUT = /^(\/dev\/(null|stdout|stderr|fd\/[12])|&?[0-9-])$/;
/** Options whose value is a command line of its own (`lftp -c`). */
const COMMAND_OPTIONS = new Set(["-c", "-e", "--command", "--execute", "--eval"]);
/** Programs that mount a host folder, and how: `short` the letter of the
 * mount option (`-v`), `values` the other short letters that take a value
 * (a cluster stops at one), `long` the long mount options. */
interface MountSpec { short: string; values: string; long: readonly string[]; csv?: string }
const CONTAINER_MOUNTS: MountSpec = { short: "v", values: "acehlmpuwH", long: ["--volume", "--mount"], csv: "--mount" };
const MOUNT_TOOLS: Record<string, MountSpec> = {
  docker: CONTAINER_MOUNTS,
  podman: CONTAINER_MOUNTS,
  nerdctl: CONTAINER_MOUNTS,
  "systemd-nspawn": { short: "", values: "", long: ["--bind", "--bind-ro"] },
};

/** Text tools whose option values are separators, field lists, sizes or
 * code, never files (`cut -d/`, `sort -t/`): `values` the short
 * letters that take such a value, `paths` the short letters whose value is a
 * file (read as before), `long` and `longPaths` the same for long options.
 * An option not listed here is read as before. `tr` names no file at all:
 * its arguments are character sets, and where its output goes is the
 * redirect check's. */
interface TextToolSpec { values: string; paths: string; long: readonly string[]; longPaths: readonly string[]; files?: false }
const TEXT_TOOLS: Record<string, TextToolSpec> = {
  cut: { values: "dfbc", paths: "", long: ["--delimiter", "--fields", "--bytes", "--characters", "--output-delimiter"], longPaths: [] },
  sort: { values: "tkS", paths: "oT", long: ["--field-separator", "--key", "--buffer-size", "--parallel", "--batch-size", "--sort"], longPaths: ["--output", "--temporary-directory", "--files0-from", "--random-source", "--compress-program"] },
  column: {
    values: "csoNlRHOEWTripnC",
    paths: "",
    long: ["--separator", "--output-separator", "--output-width", "--table-columns", "--table-columns-limit", "--table-right", "--table-hide", "--table-order", "--table-noextreme", "--table-wrap", "--table-truncate", "--tree", "--tree-id", "--tree-parent", "--table-name", "--table-column"],
    longPaths: [],
  },
  paste: { values: "d", paths: "", long: ["--delimiters"], longPaths: [] },
  join: { values: "aejotv12", paths: "", long: [], longPaths: [] },
  tr: { values: "", paths: "", long: [], longPaths: [], files: false },
};

/** The operands of a text tool that are an option's text value, or the
 * option word carrying one glued: they are not paths. Options are read up
 * to `--`, in any position, as getopt permutes them; a long option may be
 * cut short to any unique prefix, as getopt_long accepts. */
function textToolValues(texts: Array<string | undefined>, spec: TextToolSpec): Set<number> {
  const skip = new Set<number>();
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    if (text === undefined || text === "-" || !text.startsWith("-")) continue;
    if (text === "--") break;
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const name = eq > 0 ? text.slice(0, eq) : text;
      const all = [...spec.long, ...spec.longPaths];
      const prefixed = all.filter((option) => option.startsWith(name));
      const option = all.includes(name) ? name : prefixed.length === 1 ? prefixed[0] : undefined;
      if (option === undefined || !spec.long.includes(option)) continue;
      skip.add(index);
      if (eq < 0) skip.add(++index);
      continue;
    }
    for (let k = 1; k < text.length; k++) {
      const letter = text[k]!;
      // a file's option: its value, glued or the next word, is read as before
      if (spec.paths.includes(letter)) { if (k + 1 === text.length) index++; break; }
      if (spec.values.includes(letter)) {
        skip.add(index);
        if (k + 1 === text.length) skip.add(++index);
        break;
      }
      if (!/[A-Za-z0-9]/.test(letter)) break;
    }
  }
  return skip;
}

/** jq's filter (`jq .`, `jq '.items[]'`) is code that reads JSON, not a
 * path: jq runs nothing and writes no file. The first operand that is not an
 * option or an option's value is the filter, unless `-f`/`--from-file` names
 * a file for it. Every other operand and option value is read as before. */
function jqFilter(texts: Array<string | undefined>): Set<number> {
  const skip = new Set<number>();
  const twoWords = ["--arg", "--argjson", "--slurpfile", "--rawfile"];
  const oneWord = ["--indent", "-L"];
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    if (text === undefined) return skip;
    if (text === "--") { if (index + 1 < texts.length) skip.add(index + 1); return skip; }
    if (text.startsWith("--from") || (/^-[A-Za-z]+$/.test(text) && text.includes("f"))) return skip;
    if (twoWords.includes(text)) { index += 2; continue; }
    if (oneWord.includes(text)) { index += 1; continue; }
    if (text.startsWith("-") && text !== "-") continue;
    skip.add(index);
    return skip;
  }
  return skip;
}

function readOnlyListed(cmd: SimpleCommand): boolean {
  const program = cmd.program;
  if (!program || /[\\/]/.test(program.text)) return false;
  const name = program.dialect === "posix" ? program.text : program.text.toLowerCase();
  const searcher = SEARCHERS.has(name);
  if (!READ_ONLY.has(name) && !searcher && name !== "find") return false;
  if (name === "find" || name === "rg") {
    // a word that opens with a value could be any of the options: it asks
    for (const word of cmd.args) {
      let text = "";
      for (const part of word.parts) {
        if (part.kind === "lit") text += part.text;
        else if (part.kind === "tilde" || part.kind === "glob") break;
        else return false;
      }
      if (name === "find" ? FIND_ACTIONS.has(text) : RG_RUNNERS.test(text)) return false;
    }
  }
  // none of the twelve has a flag that runs, writes or edits a file: only
  // output sent somewhere other than the terminal takes one off the list
  for (const redirect of cmd.redirects) {
    if (!OUTPUT_REDIRECTS.has(redirect.op) && redirect.op !== ">&") continue;
    const target = redirect.target ? literalText(redirect.target) : undefined;
    if (target === undefined || !QUIET_OUTPUT.test(target)) return false;
  }
  return true;
}

/** The protected class one literal names, whole or after a leading
 * `--name=`, `-name=` or `NAME=`, from the folder the text fixes. A
 * relative path from a folder the text does not fix is not this rule's. */
function protectedLiteral(path: string, ctx: WalkContext, assignments = true): ProtectedClass | null {
  const plain = unmarked(path);
  const prefix = (assignments ? /^(--?[A-Za-z0-9][\w.-]*=|[A-Za-z_][A-Za-z0-9_]*=)/ : /^--?[A-Za-z0-9][\w.-]*=/).exec(plain)?.[0];
  // `env PATH=/bin cmd`: an environment setting for the child, not an argument
  if (!assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain)) return null;
  for (const one of prefix ? [path, path.slice(path.indexOf("=") + 1)] : [path]) {
    if (one === "") continue;
    if (!isAnchored(homeSpelled(unmarked(one))) && (ctx.cwdConflict || !ctx.cwd)) continue;
    const found = protectedClass(resolveFrom(ctx.cwd, one));
    if (found) return found;
  }
  return null;
}

/** The worst protected class among an operand's literal and glob candidates;
 * a value is today's business, not this rule's. */
function protectedCandidates(candidates: Candidate[], ctx: WalkContext, assignments = true): ProtectedClass | null {
  for (const candidate of candidates) {
    if (candidate.kind !== "literal" && candidate.kind !== "glob") continue;
    const found = protectedLiteral(candidate.path, ctx, assignments);
    if (found) return found;
  }
  return null;
}

/** A command line given as an option's value, tokenised as the reader
 * lexes a script (whitespace when it cannot). */
function protectedInLine(text: string, ctx: WalkContext): ProtectedClass | null {
  let words: Word[] | undefined;
  try {
    words = lex(text).flatMap((token) => (token.kind === "word" ? [token.word] : []));
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
  }
  if (words) {
    for (const word of words) {
      let candidates: Candidate[];
      try { candidates = candidatesOf(word, ctx); } catch (error) { if (error instanceof Unreadable) continue; throw error; }
      const found = protectedCandidates(candidates, ctx);
      if (found) return found;
    }
    return null;
  }
  for (const token of text.split(/\s+/)) {
    const found = token ? protectedLiteral(token, ctx) : null;
    if (found) return found;
  }
  return null;
}

/** A mount's host side: `-v SRC:DST[:opts]`, `--bind SRC[:DST]`,
 * `--mount type=bind,source=SRC,…`. */
function mountSource(text: string, csv: boolean): string | undefined {
  if (csv) return text.split(",").map((piece) => /^(source|src)=(.*)$/i.exec(piece)?.[2]).find((source) => source !== undefined);
  const from = /^[A-Za-z]:[\\/]/.test(text) ? 2 : 0;
  const colon = text.indexOf(":", from);
  return colon < 0 ? text : text.slice(0, colon);
}

/** A path glued to a short option or a cluster of them, as getopt and pflag
 * take it: `-C/`, `-o~/x`, `-xo=/usr`, `-dC:\Users\x`. */
function attachedPath(text: string): string | undefined {
  if (text.startsWith("--") || !/^-[A-Za-z0-9]/.test(text)) return undefined;
  const anchored = /^(\/|~|[A-Za-z]:[\\/])/;
  for (let k = 2; k < text.length; k++) {
    const rest = text.slice(k);
    if (anchored.test(rest)) return rest;
    if (rest.startsWith("=")) return anchored.test(rest.slice(1)) ? rest.slice(1) : undefined;
    if (!/[A-Za-z0-9]/.test(text[k]!)) return undefined;
  }
  return undefined;
}

/** The command line an option gives (`lftp -c LINE`): `--command LINE`,
 * `--command=LINE`, `-cLINE`, `-c=LINE`, or a short cluster ending in the
 * letter (`-dc LINE`). */
function commandLine(texts: Array<string | undefined>, index: number): string | undefined {
  const text = texts[index]!;
  if (text.startsWith("--")) {
    const eq = text.indexOf("=");
    if (!COMMAND_OPTIONS.has(eq > 0 ? text.slice(0, eq) : text)) return undefined;
    return eq > 0 ? text.slice(eq + 1) : texts[index + 1];
  }
  const short = /^-([A-Za-z0-9]{0,2}?)([ce])(.*)$/s.exec(text);
  if (!short) return undefined;
  return short[3] ? short[3].replace(/^=/, "") : texts[index + 1];
}

/** A mount option's value, in every spelling pflag takes: `--volume SRC`,
 * `--volume=SRC`, `-v SRC`, `-vSRC`, `-v=SRC`, and `-itv SRC` or `-itvSRC`
 * (the cluster read up to the first letter that takes a value). */
function mountValue(texts: Array<string | undefined>, index: number, spec: MountSpec): { value: string | undefined; csv: boolean } | undefined {
  const text = texts[index]!;
  if (text.startsWith("--")) {
    const eq = text.indexOf("=");
    const option = eq > 0 ? text.slice(0, eq) : text;
    if (!spec.long.includes(option)) return undefined;
    return { value: eq > 0 ? text.slice(eq + 1) : texts[index + 1], csv: option === spec.csv };
  }
  if (!spec.short || !text.startsWith("-")) return undefined;
  for (let k = 1; k < text.length; k++) {
    const letter = text[k]!;
    if (letter === spec.short) {
      const glued = text.slice(k + 1).replace(/^=/, "");
      return { value: glued || texts[index + 1], csv: false };
    }
    if (spec.values.includes(letter) || !/[A-Za-z0-9]/.test(letter)) return undefined;
  }
  return undefined;
}

/** Option A+: a program that is not exactly on the read-only list, whose
 * literal arguments name a protected path, asks. A value glued to its
 * option counts as the separate form does, a command line given to `-c` and
 * a mount's host side are read too (the wrappers' own arguments are the
 * `wrapperArgs` hook's). Values, substitutions and an unknown folder are
 * left as they were. */
function protectedPathOf(cmd: SimpleCommand, ctx: WalkContext): ProtectedClass | null {
  if (BINDINGS.has(cmd.name) || readOnlyListed(cmd)) return null;
  const texts = cmd.operands.map(flagText);
  const interpreter = interpreterKey(cmd.name) !== undefined;
  const mounts = MOUNT_TOOLS[cmd.name];
  // `cut -d/`, `sort -t/`: a text tool's separator is not a path
  const textTool = Object.hasOwn(TEXT_TOOLS, cmd.name) ? TEXT_TOOLS[cmd.name]! : undefined;
  if (textTool?.files === false) return null;
  const textValues = textTool ? textToolValues(texts, textTool) : cmd.name === "jq" ? jqFilter(texts) : undefined;
  for (const [index, list] of cmd.operands.entries()) {
    if (textValues?.has(index)) continue;
    const found = protectedCandidates(list, ctx);
    if (found) return found;
    const text = texts[index];
    if (text === undefined) continue;
    const attached = attachedPath(text);
    const glued = attached !== undefined ? protectedLiteral(attached, ctx) : null;
    if (glued) return glued;
    // `lftp -c 'local mirror --delete x ~'`: the line is read word by word
    // (an interpreter's code is the opaque scanner's)
    if (!interpreter) {
      const line = commandLine(texts, index);
      const inLine = line !== undefined ? protectedInLine(line, ctx) : null;
      if (inLine) return inLine;
    }
    const mount = mounts ? mountValue(texts, index, mounts) : undefined;
    const source = mount?.value === undefined ? undefined : mountSource(mount.value, mount.csv);
    const mounted = source ? protectedLiteral(source, ctx) : null;
    if (mounted) return mounted;
  }
  return null;
}

/** A wrapper's own arguments (`env -C /`, `flock ~`, `xargs -a /etc`), glued
 * values included: whatever the wrapper runs, a protected one asks. */
function protectedWrapperArgs(words: Word[], ctx: WalkContext): ProtectedClass | null {
  for (const word of words) {
    let candidates: Candidate[];
    try { candidates = candidatesOf(word, ctx); } catch (error) { if (error instanceof Unreadable) continue; throw error; }
    const found = protectedCandidates(candidates, ctx, false);
    if (found) return found;
    const text = literalText(word);
    const attached = text !== undefined ? attachedPath(text) : undefined;
    const glued = attached !== undefined ? protectedLiteral(attached, ctx, false) : null;
    if (glued) return glued;
  }
  return null;
}

/** The first protected-path hit of the read in progress (`read`). */
let deferred: AlwaysAskHit | null = null;
/** The read in progress (`read`): its text, and every script file on disk it
 * runs unseen (1.0.5). Read after every other rule: any of them wins. */
let unseen: { text: string; paths: string[] } | null = null;

/** One write or delete the routine carve-out passed over, as the run's
 * history records it: the tool (`rm`, a redirect, `find -delete`, a
 * mirror's name) and the target expression the carve-out matched, as
 * written (`"$OUT"`). Never the command's other arguments. */
export interface CarvedTarget {
  tool: string;
  target: string;
}

/** The tool name a redirect's target is recorded under. */
export const REDIRECT_TOOL = "a redirect";
/** A relative target from a folder a value set (`cd "$D" && rm -rf build`):
 * the value is the cd's, so no operand of the delete is recorded. */
export const FOLDER_TARGET = "a path in a folder set by a value";

/** Routine carve-out (owner decision, 1.0.3): on a scheduled or manual
 * routine run, a write or delete whose target is held in a value (rm, an
 * output redirect, find -delete, a deleting mirror) is recorded here instead
 * of thrown, and the read goes on, so every other rule still reads the whole
 * text. `null` = not carving; otherwise every such target, once each. */
let carved: CarvedTarget[] | null = null;
/** The tool whose targets a delete rule of rm, find or a mirror is
 * classifying, while it does; null otherwise. */
let carveScope: string | null = null;

function inCarveScope<T>(tool: string, run: () => T): T {
  const outer = carveScope;
  carveScope = tool;
  try { return run(); } finally { carveScope = outer; }
}

/** A value-held target inside a carve scope: recorded when carving, thrown otherwise. */
function valueTarget(reason: "expansion" | "folder", detail: string, target: string): null {
  valueTargetIn(carveScope !== null, reason, detail, carveScope ?? "", target);
  return null;
}

function valueTargetIn(covered: boolean, reason: "expansion" | "folder", detail: string, tool: string, target: string): void {
  if (carved === null || !covered) throw new Unreadable(reason, detail);
  if (!carved.some((entry) => entry.tool === tool && entry.target === target)) carved.push({ tool, target });
}

/** The tool a command's carved targets are recorded under. */
function carveTool(name: string): string {
  return name === "find" ? "find -delete" : name;
}

const QUOTE_MARK: Record<Quote, string> = { none: "", single: "'", double: '"' };

/** A target word in the shape it was written, quotes and all (`"$OUT"`,
 * `"$D/..."`): its variable names only. Literal text, a substitution's
 * command, an operator's word and a `~user` are each written `...`, so no
 * string the command spells (a password passed to `$(lookup ...)`) is
 * recorded. Only ever the target itself, never another argument. */
function targetExpression(word: Word | undefined): string {
  if (!word) return "a value";
  let out = "";
  let open: Quote = "none";
  for (const part of word.parts) {
    const quote: Quote = "quote" in part ? part.quote : "none";
    if (quote !== open) { out += QUOTE_MARK[open] + QUOTE_MARK[quote]; open = quote; }
    const text = partExpression(part);
    if (!(text === MASK && out.endsWith(MASK))) out += text;
  }
  return out + QUOTE_MARK[open];
}

const MASK = "...";
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function partExpression(part: Part): string {
  switch (part.kind) {
    // a folder step is kept, so `"$D/x"` reads as a path under `$D`
    case "lit": return part.text === "" ? "" : part.text.startsWith("/") ? `/${MASK}` : MASK;
    // only a plain name is kept: cmd keeps `%D:x=word%` whole as its name,
    // so a name that is not an identifier is written `...` too
    case "var": {
      const name = VAR_NAME.test(part.name) ? part.name : MASK;
      return part.op === undefined ? `$${name}` : part.op === "#" ? `\${#${name}}` : `\${${name}${part.op}${MASK}}`;
    }
    case "subst": return `$(${MASK})`;
    case "arith": return `$((${MASK}))`;
    case "procsub": return `${part.dir}(${MASK})`;
    case "tilde": return part.user === "" ? "~" : `~${MASK}`;
    case "glob": return part.text;
    case "brace": return `{${MASK}}`;
  }
}

/** The rules, run on every simple command the walker finds. */
const visitor: Visitor<AlwaysAskHit> = {
  command(cmd: SimpleCommand, ctx: WalkContext): AlwaysAskHit | null {
    const { name, args, operands } = cmd;
    const texts = operands.map(flagText);
    // `cd / && rm -rf *`: later commands run from the folder it moved to.
    // A folder from a value, or `cd -`, is one the text does not fix: a
    // relative delete from there asks
    if (CD.has(name)) {
      const index = texts.findIndex((text) => text === undefined || text === "-" || !text.startsWith("-"));
      if (index < 0) { ctx.cwd = resolveFrom(ctx.cwd, "~"); ctx.cwdConflict = false; return null; }
      const list = operands[index]!;
      const only = list.length === 1 ? list[0]! : undefined;
      if (!only || only.kind !== "literal" || only.text === "-") { ctx.cwd = undefined; ctx.cwdConflict = true; return null; }
      if (ctx.cwdConflict && !isAnchored(homeSpelled(only.path))) { ctx.cwd = undefined; return null; }
      const next = resolveFrom(ctx.cwd, only.path);
      ctx.cwd = isAnchored(next) ? next : undefined;
      ctx.cwdConflict = false;
      return null;
    }
    // `popd` goes back to a folder the reader did not keep
    if (name === "popd") { ctx.cwd = undefined; ctx.cwdConflict = true; return null; }
    // `powershell -Command <text>` or `cmd /c <text>` inside a shell script:
    // the text is read by the PowerShell or cmd reader, when the text fixes it
    if (POWERSHELLS.has(name) || name === "cmd" || name === "cmd.exe") {
      const pwsh = POWERSHELLS.has(name);
      const run = nestedProgram(name, args);
      // `-Command -`, `-File`, or nothing to run: it reads its commands from
      // what is piped in, or runs its script (UPSEC 10.6)
      if (run.kind !== "text") return walkNestedInput(pwsh, run, cmd.stdin, ctx, visitor);
      const rest = run.words;
      for (const arg of rest) if (!isPlain(arg)) throw new Unreadable("expansion", `a value in text ${name} runs`);
      const text = rest.map(renderWord).join(" ");
      const nested = fork(ctx, true);
      if (cmd.stdin) nested.stdin = cmd.stdin; else delete nested.stdin;
      return pwsh ? walkPwsh(text, nested, visitor) : walkCmd(text, nested, visitor);
    }
    // a device spelled anywhere outside a reader's read position
    if (deviceHit(cmd)) return hit("disk-erase");
    if (diskHit(name, texts)) return hit("disk-erase");
    // the operands name a catastrophe: that is the card
    // the routine carve-out covers the targets of rm, find -delete and the
    // deleting mirrors only: every other value throws as before
    const carvable = carvableTargets(cmd, ctx);
    const tool = carveTool(name);
    const rule = name === "rm" || (ctx.findAction && FIND_FILE_DELETES.has(name)) ? inCarveScope(tool, () => rmHit(cmd, ctx)) : name === "find" ? inCarveScope(tool, () => findHit(cmd, ctx)) : windowsDeleteHit(cmd, ctx) ?? inCarveScope(tool, () => mirrorHit(cmd, ctx));
    if (rule) return hit(rule);
    // otherwise a risky command has to be fixed by the text, whole: its
    // operands, its name, and the place it runs from
    // a deleting mirror (`rclone sync`, `unison`, `aws s3 sync --delete`)
    // is risky as `rm` is: a value in its operands asks
    if (isRisky(name, texts) || mirrorTargets(cmd) !== undefined) {
      for (const [index, list] of operands.entries()) {
        for (const candidate of list) {
          // `fromFile` (a list on disk) is ordinary here, as a script on disk is
          if (candidate.kind === "value") valueTargetIn(carvable === "all" || carvable?.has(candidate) === true, "expansion", `a value in ${name}'s arguments`, tool, targetExpression(args[index]));
          if (candidate.kind === "glob" && catastrophicAnchor(candidate.anchor)) return hit("unknown-target");
        }
      }
      if (cmd.derived) throw new Unreadable("dynamic-name", `a value names ${name}`);
      if (ctx.indirect === "trap") throw new Unreadable("indirect", `${name} in a trap body`);
    }
    // A+: a protected literal under a program off the allow list. It is
    // kept, not returned: the walk goes on, so every rule above keeps its
    // own verdict on the whole text, and this card stands only where the
    // text would otherwise have been ordinary
    const found = deferred ? null : protectedPathOf(cmd, ctx);
    if (found) deferred = { rule: "protected-path", what: PROTECTED_WHAT[found], protectedClass: found, program: name };
    return null;
  },
  redirect(redirect: Redirect, target, candidates, ctx): AlwaysAskHit | null {
    // `>&word` with a word that is not a descriptor number writes to that file, as `&>` does
    const dup = redirect.op === ">&" && /^\d+$|^-$/.test(literalText(target) ?? "");
    if (!OUTPUT_REDIRECTS.has(redirect.op) && (redirect.op !== ">&" || dup)) return null;
    return outputTarget(target, candidates, ctx);
  },
  /** A redirect inside PowerShell or cmd text: the same rule. */
  pwshRedirect(target, candidates, ctx): AlwaysAskHit | null {
    return outputTarget(target, candidates, ctx);
  },
  catastrophic(text: string): boolean {
    return protectedClass(text) !== null;
  },
  wrapperArgs(words: Word[], ctx: WalkContext): AlwaysAskHit | null {
    // kept, as a command's own hit is: every later rule keeps its verdict
    const found = deferred ? null : protectedWrapperArgs(words, ctx);
    if (found) deferred = { rule: "protected-path", what: PROTECTED_WHAT[found], protectedClass: found, program: "wrapper" };
    return null;
  },
  forkBomb(): AlwaysAskHit {
    return hit("fork-bomb");
  },
  /** 1.0.5: a marker only. Whether the run may go ahead unseen is the
   * shape of the whole text (`unseenShapeAdmits`), read after the walk. */
  unseenScript(path: string): boolean {
    if (unseen === null) return false;
    unseen.paths.push(path);
    return true;
  },
  findValues(words: Word[]): boolean {
    if (carved === null) return false;
    const at = findValuesPassable(words);
    if (at < 0) return false;
    valueTargetIn(true, "expansion", "a value in find's arguments", carveTool("find"), targetExpression(words[at]));
    return true;
  },
};

/** `find … -delete` whose only values are whole double-quoted names among
 * its roots (`find "$t" -delete`): each stays one word before the first
 * test. Every test and action after it is literal, with no action that runs
 * a command and no `;` or `+` anywhere, so a value spelling `-exec` has no
 * terminator and find runs nothing. No substitution, no `${…}` operator.
 * The value's index among the words, or -1. */
function findValuesPassable(words: Word[]): number {
  const texts = words.map(literalText);
  if (!texts.includes("-delete")) return -1;
  if (texts.some((text) => text !== undefined && (FIND_RUNS.has(text) || text === ";" || text === "+"))) return -1;
  // exactly one value, and it is the last root: the word after it is find's
  // first test, so the value cannot open an action over literal words
  const values = words.flatMap((word, i) => (isPlain(word) ? [] : [i]));
  if (values.length !== 1) return -1;
  const at = values[0]!;
  const next = texts[at + 1];
  if (next === undefined || !(next.startsWith("-") || next === "!" || next === "(")) return -1;
  if (texts.slice(0, at).some((text) => text !== undefined && (text.startsWith("-") || text === "!" || text === "("))) return -1;
  const only = words[at]!.parts.length === 1 ? words[at]!.parts[0]! : undefined;
  return only?.kind === "var" && only.quote === "double" && only.op === undefined ? at : -1;
}

/** The operand candidates the routine carve-out may pass over when they
 * are values: every operand of rm (and of a file delete find runs), the
 * roots of find -delete, the destinations of a deleting mirror written
 * after a literal `--` (never its source or an option value such as
 * `rsync -e`). Null: none. */
function carvableTargets(cmd: SimpleCommand, ctx: WalkContext): "all" | Set<Candidate> | null {
  if (carved === null) return null;
  if (cmd.name === "rm" || (ctx.findAction && FIND_FILE_DELETES.has(cmd.name))) return "all";
  if (cmd.name === "find") {
    const texts = cmd.operands.map(flagText);
    const roots = new Set<Candidate>();
    for (const [i, list] of cmd.operands.entries()) {
      const text = texts[i];
      if (text !== undefined && (text.startsWith("-") || text === "!" || text === "(")) break;
      for (const candidate of list) roots.add(candidate);
    }
    return texts.includes("-delete") ? roots : null;
  }
  // a mirror only after a literal `--`: before it, a value can spell an
  // option that runs a command (`rsync -e`, `--rsh=`, `--rsync-path=`)
  const targets = mirrorTargets(cmd);
  const end = cmd.operands.findIndex((list) => flagText(list) === "--");
  if (!targets || end < 0) return null;
  const afterEnd = new Set(cmd.operands.slice(end + 1).flat());
  return new Set(targets.flat().filter((candidate) => afterEnd.has(candidate)));
}
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Does this command always ask, whatever the bot's access level? Null when
 * it is an ordinary command. `cwd` is the folder it runs in, when the engine
 * reported one: `rm -rf *` there is a delete of that folder.
 *
 * `mode: "command"` is strict: text the reader cannot parse asks
 * (`unreadable`). `mode: "text"` is for the summary of a tool that runs no
 * command, where a stray apostrophe in a file name must not ask.
 *
 * `shell: "pwsh"` is for an engine's PowerShell tool: its text is
 * PowerShell's whatever it starts with, so it is read by the PowerShell
 * reader only. */
export function alwaysAskCommand(text: string | undefined, cwd?: string, mode: "command" | "text" = "command", shell?: "pwsh"): AlwaysAskHit | null {
  if (!text) return null;
  try {
    return readWhole(text, cwd, shell);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    if (mode !== "command") return null;
    return error.message.endsWith(REMOTE_ELEVATED) ? { rule: "unreadable", what: REMOTE_ELEVATED_WHAT } : hit("unreadable");
  }
}

/** Text the cmd reader must see too: cmd given text to run (`/c`, `/k`,
 * `/r`), or a line that goes on past `cmd` the way only cmd reads it (`&`,
 * a pipe, `%x%`, `!x!`). */
const CMD_RUNS_TEXT = /\s\/[ckr](?=[\s"]|$)|[&%!]|(?<!>)\|/i;

function read(text: string, cwd: string | undefined, shell?: "pwsh"): AlwaysAskHit | null {
  deferred = null;
  unseen = { text, paths: [] };
  try {
    return (shell === "pwsh" ? walkPwsh(text, newContext(cwd || undefined), visitor) : readRules(text, cwd)) ?? deferred;
  } finally {
    deferred = null;
  }
}

/** The always-ask read for a scheduled or manual routine run (the owner's
 * routine carve-out). It is `alwaysAskCommand` in command mode, except that
 * a write or delete target held in a value (rm, an output redirect,
 * find -delete, a deleting mirror) does not make the command unreadable:
 * the read goes on, and when nothing else asks, `valueTarget` names each
 * tool and target expression passed over so the run can record them. Every other rule, a literal
 * catastrophe, a protected path, and every other unreadable text still ask. */
export function alwaysAskRoutineCommand(text: string | undefined, cwd?: string, shell?: "pwsh"): { hit: AlwaysAskHit | null; valueTarget?: CarvedTarget[] } {
  if (!text) return { hit: null };
  carved = [];
  carveScope = null;
  try {
    const found = readWhole(text, cwd, shell);
    if (found) return { hit: found };
    return carved.length > 0 ? { hit: null, valueTarget: carved } : { hit: null };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { hit: error.message.endsWith(REMOTE_ELEVATED) ? { rule: "unreadable", what: REMOTE_ELEVATED_WHAT } : hit("unreadable") };
  } finally {
    carved = null;
    carveScope = null;
  }
}

/** `read`, then the unseen script files when nothing else asked: they may go
 * ahead at Full access and No limits only in a text of the allowed shape
 * (`unseenShapeAdmits`); any other text with one asks at every level. */
function readWhole(text: string, cwd: string | undefined, shell?: "pwsh"): AlwaysAskHit | null {
  try {
    const found = read(text, cwd, shell);
    if (found || !unseen || unseen.paths.length === 0) return found;
    return unseenShapeAdmits(text, unseen.paths, cwd, shell) ? { ...hit("unreadable"), unseenScript: true } : hit("unreadable");
  } finally {
    unseen = null;
  }
}

/** 1.0.5: the commands a text that runs an unseen script file may hold, so
 * that nothing in it can have made or changed that file and nothing runs
 * besides it: a script run by a shell or an interpreter with no option
 * before it, a sourced file, `cd`, and a few commands that only print. */
const SHAPE_SHELLS = new Set(["bash", "sh"]);
const SHAPE_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "php", "perl"]);
const SHAPE_SOURCES = new Set(["source", "."]);
const SHAPE_PRINTS = new Set(["pwd", "ls", "true", "deactivate", "which", "echo"]);
/** A literal path with no option shape. */
const SHAPE_PATH = /^(?!-)[A-Za-z0-9_./@+-]+$/;
const baseName = (path: string): string => path.split("/").pop() ?? path;
/** The device or process folder, or a file in it, however it is spelled
 * (`/dev`, `/dev/`, `//dev/stdin`, `/./proc/self/fd/0`, `/tmp/../dev`). */
const deviceOrProcess = (path: string): boolean => /^\/(?:dev|proc)(?:\/|$)/.test(posixPath.normalize(path.replace(/\/+/g, "/")));
/** A literal path of the allowed shape that is not the device or process folder. */
const shapePath = (path: string | undefined): path is string => path !== undefined && SHAPE_PATH.test(path) && !deviceOrProcess(path);
/** An absolute path, POSIX or with a drive. */
const anchored = (path: string): boolean => /^(?:\/|[A-Za-z]:\/)/.test(path);

/** 1.0.5 r8: every folder each command of the shape may run from, given the
 * command's own folder and that any `cd` may fail (`cd /no/such; bash
 * proc/self/fd/0` runs from where it started), and every script path from
 * each of them: absolute, and never the device or process folder. With no
 * folder for the command, a relative script path is not placed and asks. */
function everyFolderPlaces(commands: string[][], cwd: string | undefined): boolean {
  const start = cwd?.replace(/\\/g, "/");
  // with no folder for the command, the folder it started in stays one the
  // text may still be in: a `cd` that fails does not leave it
  const unknown = start === undefined || !anchored(start);
  let folders: string[] = unknown || start === undefined ? [] : [start];
  const from = (folder: string, path: string): string => (anchored(path) ? path : posixPath.join(folder, path));
  for (const words of commands) {
    const [name, path] = words as [string, string | undefined];
    if (name === "cd" && path !== undefined) {
      folders = [...new Set([...folders, ...(anchored(path) ? [path] : folders.map((folder) => from(folder, path)))])];
      continue;
    }
    const script = shapeScript(words);
    if (!script) continue;
    if (anchored(script)) { if (deviceOrProcess(script)) return false; continue; }
    if (unknown || folders.map((folder) => from(folder, script)).some(deviceOrProcess)) return false;
  }
  return true;
}

/** The text as a flat list of simple commands' literal words, or null when
 * it holds anything else: a background job, a pipe, a negation, a compound
 * command, an assignment, a redirect other than to /dev/null or `2>&1`, a
 * word that is not one fixed string, or an unquoted glob or brace. */
function shapeCommands(text: string): string[][] | null {
  let script;
  try { script = parse(text); } catch (error) { if (error instanceof Unreadable) return null; throw error; }
  const out: string[][] = [];
  for (const item of script.items) {
    if (item.background) return null;
    for (const pipeline of item.andOr.pipelines) {
      if (pipeline.negated || pipeline.commands.length !== 1) return null;
      const command = pipeline.commands[0]!;
      if (command.kind !== "simple" || command.assigns.length > 0 || command.words.length === 0) return null;
      if (!command.redirects.every(quietRedirect)) return null;
      const words: string[] = [];
      for (const word of command.words) {
        const literal = literalText(word);
        if (literal === undefined) return null;
        if (word.parts.some((part) => part.kind === "lit" && part.quote === "none" && /[*?[\]{}]/.test(part.text))) return null;
        words.push(literal);
      }
      out.push(words);
    }
  }
  return out;
}

/** `>/dev/null`, `1>/dev/null`, `2>/dev/null`, `2>&1`. */
function quietRedirect(redirect: Redirect): boolean {
  if (redirect.heredoc || !redirect.target) return false;
  const target = literalText(redirect.target);
  if (redirect.op === ">") return (redirect.fd === undefined || redirect.fd === 1 || redirect.fd === 2) && target === "/dev/null";
  return redirect.op === ">&" && redirect.fd === 2 && target === "1";
}

/** The script path a command of the allowed shape runs, "" for a command
 * that runs none, or null for a command outside the shape. */
function shapeScript(words: string[]): string | null {
  const [name, path] = words as [string, string | undefined];
  if (name === "cd") return words.length === 2 && shapePath(path) ? "" : null;
  if (SHAPE_PRINTS.has(name)) return "";
  if (!SHAPE_SOURCES.has(name) && !SHAPE_SHELLS.has(name) && !SHAPE_INTERPRETERS.has(name)) return null;
  if (!shapePath(path)) return null;
  // php reads its own options after the script too (`php app.php -r code`,
  // `-d auto_prepend_file=x`): any option-shaped word there is outside the shape
  if (name === "php" && words.slice(2).some((word) => word.startsWith("-"))) return null;
  return path;
}

/** Each script path is spelled once (no other word shares its file name),
 * and every unseen file the walk found is one of them. */
function spelledOnce(commands: string[][], scripts: string[], paths: string[]): boolean {
  const names = commands.flat().map(baseName);
  if (scripts.some((script) => names.filter((name) => name === baseName(script)).length !== 1)) return false;
  return paths.every((path) => scripts.some((script) => baseName(script) === baseName(path)));
}

/** 1.0.5: may the unseen script file in this text run at Full access and
 * No limits? Only when the whole text is of the allowed shape, so the file
 * was on disk before it ran and nothing else runs unread. A POSIX text
 * only: PowerShell and cmd keep asking. */
function unseenShapeAdmits(text: string, paths: string[], cwd: string | undefined, shell?: "pwsh"): boolean {
  if (shell === "pwsh" || looksLikePowerShell(text) !== null || /^\s*robocopy(\.exe)?(?=\s|$)/i.test(text)) return false;
  // never a device or process file as the walk resolved it (`//dev/stdin`)
  if (paths.some(deviceOrProcess)) return false;
  const commands = shapeCommands(text);
  if (!commands || commands.length === 0) return false;
  // every script placed from every folder the text may be in (`cd / && bash
  // proc/self/fd/0`, a `cd` that failed); a relative one with no folder asks
  if (!everyFolderPlaces(commands, cwd)) return false;
  // a `cd` with a `||` in the text: which folder a script runs from turns on
  // what failed (`cd /no/such || cd /work && bash build.sh`), so it asks
  if (commands.some((words) => words[0] === "cd") && parse(text).items.some((item) => item.andOr.ops.includes("||"))) return false;
  return coreShape(commands, paths) || venvShape(commands, paths);
}

/** One script file run by a shell, an interpreter or `source`, beside `cd`
 * and the commands that only print. */
function coreShape(commands: string[][], paths: string[]): boolean {
  const scripts = commands.map(shapeScript);
  if (!scripts.every((script) => script !== null)) return false;
  // one script file only: one unseen script may write another
  // (`bash stage.sh && bash run.sh`), which the reader never sees
  const runs = scripts.filter((script): script is string => script !== "");
  return runs.length === 1 && spelledOnce(commands, runs, paths);
}

/** 1.0.5 r6: a virtual environment switched on, then the Python tools that
 * work in it (`source venv/bin/activate && pip install -r requirements.txt`,
 * `cd app && . .venv/bin/activate && python -m pytest`). Zero or more `cd`,
 * then the one activate script with nothing run before it (so the text
 * cannot have written it), then only `cd`, the printing commands, `pip`,
 * `pytest` and `python -m pip|pytest|unittest`: none of them runs a script file of its
 * own, takes code inline or loads code first. The activate is the only
 * unseen file. Every word was read by the reader, which found nothing. */
function venvShape(commands: string[][], paths: string[]): boolean {
  let at = 0;
  while (at < commands.length && commands[at]![0] === "cd") {
    if (shapeScript(commands[at]!) !== "") return false;
    at++;
  }
  const source = commands[at];
  if (!source || source.length !== 2 || !SHAPE_SOURCES.has(source[0]!)) return false;
  const activate = source[1]!;
  if (!shapePath(activate) || !(activate === "bin/activate" || activate.endsWith("/bin/activate"))) return false;
  if (!commands.slice(at + 1).every(venvTool)) return false;
  return paths.length === 1 && spelledOnce(commands, [activate], paths);
}

const VENV_TOOLS = new Set(["pip", "pip3", "pytest"]);
const VENV_PYTHONS = new Set(["python", "python3"]);
/** The modules `python -m` may name there: none takes code in its
 * arguments (`timeit`, `cProfile -c`, `pdb -c`, `trace` and `runpy` would). */
const VENV_MODULES = new Set(["pip", "pytest", "unittest"]);
/** A command allowed after the activate. */
function venvTool(words: string[]): boolean {
  const [name, option, module] = words as [string, string | undefined, string | undefined];
  if (name === "cd" || SHAPE_PRINTS.has(name)) return shapeScript(words) === "";
  if (VENV_TOOLS.has(name)) return true;
  // `-m` first, so no option before it (`-c`, `-X`, `-W`, `-I`) changes what runs
  if (VENV_PYTHONS.has(name)) return option === "-m" && module !== undefined && VENV_MODULES.has(module);
  return false;
}

function readRules(text: string, cwd: string | undefined): AlwaysAskHit | null {
  const ctx = newContext(cwd || undefined);
  // `robocopy` is Windows' own: a line it opens is read as a POSIX shell,
  // PowerShell and cmd would each read it (`C:\Users\x` is a path to the
  // last two), and the first hit wins
  if (/^\s*robocopy(\.exe)?(?=\s|$)/i.test(text)) {
    return walkScript(text, fork(ctx), visitor) ?? walkPwsh(text, fork(ctx), visitor) ?? walkCmd(text, fork(ctx), visitor);
  }
  switch (looksLikePowerShell(text)) {
    case "pwsh": return walkPwsh(text, ctx, visitor);
    // `cmd /c …` typed into a POSIX shell or into cmd: read both ways. A
    // `cmd` that is given no text to run (`cmd 2>/dev/null`) is read by the
    // shell it was typed into only: cmd's reader would take `/dev/null` for
    // a device and `>|` for a redirect with no target
    case "cmd": {
      const cmdReads = CMD_RUNS_TEXT.test(text);
      let posix: AlwaysAskHit | null;
      try {
        posix = walkScript(text, fork(ctx), visitor);
      } catch (error) {
        // text a POSIX shell cannot read (`cmd /c "rd /s /q C:\"`, where `\"`
        // is no escape to cmd) still asks; the card names what cmd would do
        // when the cmd reader can tell
        if (!(error instanceof Unreadable) || !cmdReads) throw error;
        let viaCmd: AlwaysAskHit | null = null;
        try { viaCmd = walkCmd(text, fork(ctx), visitor); } catch (inner) { if (!(inner instanceof Unreadable)) throw inner; }
        if (viaCmd) return viaCmd;
        throw error;
      }
      return posix ?? (cmdReads ? walkCmd(text, fork(ctx), visitor) : null);
    }
    // a name both shells have (`rd`, `del`): read under both, first hit wins
    case "both": return walkPwsh(text, fork(ctx), visitor) ?? walkCmd(text, fork(ctx), visitor);
    default: return walkScript(text, ctx, visitor);
  }
}

/** For the history report only: why a command is unreadable (`reason: detail`), or null. */
export function alwaysAskUnreadableReason(text: string, cwd?: string): string | null {
  try {
    return readWhole(text, cwd)?.rule === "unreadable" ? "opaque: a script file the reader does not see" : null;
  } catch (error) {
    if (error instanceof Unreadable) return error.message;
    throw error;
  }
}
