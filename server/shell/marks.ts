// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Unreadable } from "./lex.ts";

export type DoubtReason = "tokenizer" | "value-path" | "file-fed-args" | "unavailable-exec" | "scan-gate" | "command";
/** A closed-list failure is never eligible for the could-not-read waiver. */
export class Doubt extends Unreadable {
  readonly doubt: DoubtReason;
  constructor(doubt: DoubtReason) { super("opaque", `Doubt(${doubt})`); this.doubt = doubt; }
}
/** Findings whose force does not depend on the reader mode. */
export class HardFinding extends Unreadable {
  readonly classification: "deny" | "ask";
  readonly rule: "protected-path" | "unknown-target" | "unreadable";
  readonly findingReason: string;
  // Explicit fields, not parameter properties: node strip-types (the kimi sign-in probe child) cannot load parameter properties.
  constructor(classification: "deny" | "ask", rule: "protected-path" | "unknown-target" | "unreadable", findingReason: string) {
    super("opaque", findingReason);
    this.classification = classification; this.rule = rule; this.findingReason = findingReason;
  }
}
export function denyTarget(reason = "unresolved-target"): never {
  throw new HardFinding("deny", "unknown-target", reason);
}
export function ambiguousInterpreter(): never {
  throw new HardFinding("ask", "unreadable", "ambiguous-interpreter");
}
let quiet = 0;
/** MARKS R1 (MurageMain 11-08): the typed denies, the read-position protected-path reading and the other stricter MARKS reads belong to the
 * owner's own clean No limits turn only (auto-approve `ask` sets it). Every other level and origin reads as at NLH0. */
let ownerReads = 0;
export function ownerMarks<T>(read: () => T): T {
  ownerReads++;
  try { return read(); } finally { ownerReads--; }
}
export function ownerDeny(): boolean { return ownerReads > 0; }
/** MARKS r7: read the text again with every closed-list doubt off, only to learn whether a named catastrophe is in it. */
export function withoutDoubts<T>(read: () => T): T {
  quiet++;
  try { return read(); } finally { quiet--; }
}
/** True while MARKS reads strictly (owner No limits). Every other level reads as before MARKS (r1.5 :24). */
export function strictMarks(): boolean { return quiet === 0; }
/** A closed-list doubt: it holds the call, except inside `withoutDoubts`, where the read goes on. */
export function doubt(reason: DoubtReason): void {
  if (quiet === 0) throw new Doubt(reason);
  return;
}
export const COMMAND_GATE_CHARS = 131_072;
export const SCAN_GATE_CHARS = 131_072;
export const COMPILERS: ReadonlySet<string> = new Set(["gcc", "g++", "cc", "c++", "clang", "clang++", "ld", "lld", "rustc"]);

/** Options without a complete model hold, including options that load code.
 * A colon means the short option consumes one value, attached or separate. */
const OPTIONS: Readonly<Record<string, string>> = {
  echo: "n", printf: "", pwd: "LP", true: "", false: "", ":": "",
  cat: "AbEenstTuv", head: "n:c:qv", tail: "n:c:qv", wc: "clmwL",
  ls: "aAlhRtdrSFf1", stat: "", cut: "b:c:d:f:s", tr: "cds", uniq: "cdu",
  sort: "bdfginrMuco:t:k:S:", diff: "uqr", cmp: "sl", tee: "ai",
  cp: "aRfiprvTt:", mv: "fint:v", ln: "sfinvt:", install: "dpm:t:",
  touch: "acm", mkdir: "pv", rmdir: "pv", rm: "rfidv", dd: "",
  chmod: "Rfv", chown: "Rfhv", chgrp: "Rfhv", sleep: "", date: "u",
  uname: "asnrvmpio", whoami: "", id: "ugGnrz", readlink: "fen", realpath: "e",
  sha1sum: "bc", sha256sum: "bc", sha512sum: "bc", md5sum: "bc", cksum: "",
};
export function checkCommandOptions(name: string, args: readonly string[]): void {
  const spec = OPTIONS[name];
  if (spec === undefined) { doubt("tokenizer"); if (ownerDeny()) return; } // M-FIX2-model
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (name === "dd" && !/^(?:(?:if|of)=.+|(?:bs|ibs|obs|count|skip|seek)=\d+[kMGTPEZY]?|status=(?:none|noxfer|progress))$/.test(arg)) doubt("tokenizer"); // M-FIX2-dd
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    // Only this long option has a modeled output operand.
    if (name === "sort" && (arg === "--output" || arg.startsWith("--output="))) {
      if (arg === "--output" && args[++i] === undefined) doubt("tokenizer"); // M-FIX2-long-value
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const at = spec.indexOf(arg[j]!);
      if (at < 0 || arg[j] === ":") doubt("tokenizer"); // M-FIX2-option
      if (spec[at + 1] === ":") {
        if (!arg.slice(j + 1) && args[++i] === undefined) doubt("tokenizer"); // M-FIX2-option-value
        break;
      }
    }
  }
}

/** Membership checks always use the complete option model. */
export function modeledOptions(name: string, args: readonly string[]): boolean {
  if (!Object.hasOwn(OPTIONS, name)) return false;
  const saved = quiet;
  quiet = 0;
  try { checkCommandOptions(name, args); return true; }
  catch (error) { if (error instanceof Doubt) return false; throw error; }
  finally { quiet = saved; }
}

/** Options that make a program run another program or load code. They hold on every level (MurageMain X1 ruling). */
export function execCapableOption(name: string, args: readonly string[]): boolean {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  const LONG = /^--(?:compress-program|use-compress-program|rsh|rsync-path|checkpoint-action|to-command|info-script|new-volume-script|rmt-command|rsh-command|exec-path|upload-pack|receive-pack|config-env|ssh-command|editor|pager|paginate|plugin|wrapper|specs)(?:=|$)/i;
  const KEY = /(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass|external|helper|textconv|gitproxy|proxycommand|localcommand|knownhostscommand|insteadof)/i;
  if (args.some(a => LONG.test(a))) return true; // M-X1-exec
  if (base === "git") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith("-")) break;
      let value: string | undefined;
      if (a === "-c") value = args[++i];
      else if (a === "-C") { i++; continue; }
      else if (/^-c./.test(a)) value = a.slice(2);
      if (value !== undefined && (KEY.test(value.split("=")[0]!) || /=\s*!/.test(value))) return true; // M-X1-exec
    }
    return false;
  }
  if (base === "tar" || base === "bsdtar" || base === "gtar") return args.some(a => /^-[A-Za-z]*[IF](?![-\w])/.test(a) || /^-[A-Za-z]*I./.test(a) || /^-[A-Za-z]*F./.test(a)) || args.some(a => /^--(?:checkpoint-action|to-command)/.test(a)); // M-X1-exec
  if (base === "rsync") return args.some(a => /^-[A-Za-z]*e/.test(a) && !a.startsWith("--")); // M-X1-exec
  if (["ssh", "scp", "sftp", "ssh-add", "sshpass"].includes(base)) {
    return args.some((a, i) => /^-F/.test(a) || /^-o/.test(a) && /(?:command|proxyjump|include|match|identityagent|pkcs11|securitykeyprovider)/i.test(a.length > 2 ? a : (args[i + 1] ?? "")) || /^-J/.test(a) || /^-S/.test(a)); // M-X1-exec
  }
  if (COMPILERS.has(base) || base === "cpp" || base === "as") return args.some(a => /^-(?:specs|wrapper|fplugin|plugin|B(?!static|dynamic|symbolic))/.test(a)); // M-X1-exec
  return false;
}

const STARTUP_ENV = /^(?:LD_\w*|DYLD_\w*|BASH_ENV|ENV|PATH|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|ZDOTDIR|HOME|CDPATH|GLOBIGNORE|BASH_FUNC_\S*|NODE_OPTIONS|NODE_PATH|PYTHON\w*|PERL5\w*|PERLLIB|PERLIO\w*|RUBYOPT|RUBYLIB|GIT_\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|EDITOR|VISUAL|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|SSH_\w*|XDG_\w*|NPM_CONFIG_\w*|CARGO_\w*|RUSTC\w*|RUSTFLAGS|CC|CXX|MAKEFLAGS|SHELL|TMPDIR|SUDO_\w*)$/i;
/** Environment values can select executables, configs, or startup code. */
export function checkEnvironment(name: string): void {
  if (STARTUP_ENV.test(name)) doubt("tokenizer"); // M-FIX2-env
}
/** A sed program with no write, read or execute command. Anything this cannot strip stays and, if it holds a
 * w, W, r, R or e letter, holds the command (fail closed). */
export function sedProgramReadable(text: string): boolean {
  let flagged = false;
  const rest = text
    .replace(/s([^\\\n])((?:\\.|(?!\1)[^\\\n])*)\1((?:\\.|(?!\1)[^\\\n])*)\1([a-zA-Z0-9]*)/g, (_m, _d, _a, _b, flags: string) => { if (/[we]/.test(flags)) flagged = true; return ";"; })
    .replace(/y([^\\\n])((?:\\.|(?!\1)[^\\\n])*)\1((?:\\.|(?!\1)[^\\\n])*)\1/g, ";")
    .replace(/\/(?:\\.|[^/\\\n])*\//g, ";");
  return !flagged && !/[wWrRe]/.test(rest);
}
/** Every option and program is consumed; in-place and unknown options hold. */
export function checkSed(args: readonly string[], read: (path: string) => string | undefined): void {
  let programs = 0;
  let options = true;
  const program = (text: string | undefined) => {
    if (text === undefined || !sedProgramReadable(text)) doubt("tokenizer"); // M-R1-sed
    programs++;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("--")) {
      if (["--quiet", "--silent", "--regexp-extended", "--posix", "--separate", "--unbuffered", "--null-data", "--sandbox", "--debug"].includes(arg)) continue;
      const match = /^--(expression|file)(?:=(.*))?$/.exec(arg);
      if (!match) { doubt("tokenizer"); continue; }
      const value = match[2] ?? args[++i];
      program(match[1] === "file" ? value === undefined ? undefined : read(value) : value);
    } else if (options && arg.startsWith("-")) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        if (flag === "n" || flag === "E" || flag === "r" || flag === "s" || flag === "u" || flag === "z") continue;
        if (flag !== "e" && flag !== "f") doubt("tokenizer"); // M-R1-option
        const value = arg.slice(j + 1) || args[++i];
        program(flag === "f" ? value === undefined ? undefined : read(value) : value);
        break;
      }
      if (arg === "-") doubt("tokenizer");
    } else if (!programs) program(arg);
  }
  if (!programs) doubt("tokenizer");
}

/** These markers cannot occur in the plain literal grammar. */
export function interpolated(text: string): boolean {
  return /[`$@]|#\{|\beval\b|\bexec\s*\(/.test(text); // M-R1-literal
}
/** Disjoint from the compiler response-file rule. */
export function compilerResponse(name: string, args: readonly string[]): boolean {
  return COMPILERS.has(name) && args.some(arg => /(?:^|,)@/.test(arg)); // M-PR-6a
}
export function genericResponse(name: string, args: readonly string[], reader: boolean): boolean {
  return !COMPILERS.has(name) && !reader && args.some(arg => arg.startsWith("@")); // M-PR-6b
}
