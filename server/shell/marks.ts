// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Unreadable } from "./lex.ts";

export type DoubtReason = "tokenizer" | "value-path" | "file-fed-args" | "unavailable-exec" | "scan-gate" | "command";
/** A closed-list failure is never eligible for the could-not-read waiver. */
export class Doubt extends Unreadable {
  constructor(readonly doubt: DoubtReason) { super("opaque", `Doubt(${doubt})`); }
}
export const COMMAND_GATE_CHARS = 131_072;
export const SCAN_GATE_CHARS = 131_072;
export const COMPILERS: ReadonlySet<string> = new Set(["gcc", "g++", "cc", "c++", "clang", "clang++", "ld", "lld", "rustc"]);

/** Options without a complete model hold, including options that load code.
 * A colon means the short option consumes one value, attached or separate. */
const OPTIONS: Readonly<Record<string, string>> = {
  echo: "n", printf: "", pwd: "LP", true: "", false: "", ":": "",
  cat: "AbEenstTuv", head: "n:c:qv", tail: "n:c:qv", wc: "clmwL",
  ls: "aAlhRtdrSF1", stat: "", cut: "b:c:d:f:s", tr: "cds", uniq: "cdu",
  sort: "bdfginrMuco:t:k:S:", diff: "uqr", cmp: "sl", tee: "ai",
  cp: "aRfiprvTt:", mv: "fint:v", ln: "sfinvt:", install: "dpm:t:",
  touch: "acm", mkdir: "pv", rmdir: "pv", rm: "rfidv", dd: "",
  chmod: "Rfv", chown: "Rfhv", chgrp: "Rfhv", sleep: "", date: "u",
  uname: "asnrvmpio", whoami: "", id: "ugGnrz", readlink: "fen", realpath: "e",
  sha1sum: "bc", sha256sum: "bc", sha512sum: "bc", md5sum: "bc", cksum: "",
};
export function checkCommandOptions(name: string, args: readonly string[]): void {
  const spec = OPTIONS[name];
  if (spec === undefined) throw new Doubt("tokenizer"); // M-FIX2-model
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (name === "dd" && !/^(?:(?:if|of)=.+|(?:bs|ibs|obs|count|skip|seek)=\d+[kMGTPEZY]?|status=(?:none|noxfer|progress))$/.test(arg)) throw new Doubt("tokenizer"); // M-FIX2-dd
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    // Only this long option has a modeled output operand.
    if (name === "sort" && (arg === "--output" || arg.startsWith("--output="))) {
      if (arg === "--output" && args[++i] === undefined) throw new Doubt("tokenizer"); // M-FIX2-long-value
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const at = spec.indexOf(arg[j]!);
      if (at < 0 || arg[j] === ":") throw new Doubt("tokenizer"); // M-FIX2-option
      if (spec[at + 1] === ":") {
        if (!arg.slice(j + 1) && args[++i] === undefined) throw new Doubt("tokenizer"); // M-FIX2-option-value
        break;
      }
    }
  }
}

/** Environment values can select executables, configs, or startup code. */
export function checkEnvironment(name: string): void {
  if (!/^(?:LANG|LC_[A-Z_]+|TZ|TERM|NO_COLOR)$/.test(name)) throw new Doubt("tokenizer"); // M-FIX2-env
}
/** Only numeric print programs are modeled. Every option and program is consumed. */
export function checkSed(args: readonly string[], read: (path: string) => string | undefined): void {
  let programs = 0;
  let options = true;
  const program = (text: string | undefined) => {
    if (text === undefined || !/^(?:\d+(?:,\d+)?)?p\s*$/.test(text)) throw new Doubt("tokenizer"); // M-R1-sed
    programs++;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("--")) {
      if (arg === "--quiet" || arg === "--silent") continue;
      const match = /^--(expression|file)(?:=(.*))?$/.exec(arg);
      if (!match) throw new Doubt("tokenizer");
      const value = match[2] ?? args[++i];
      program(match[1] === "file" ? value === undefined ? undefined : read(value) : value);
    } else if (options && arg.startsWith("-")) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        if (flag === "n") continue;
        if (flag !== "e" && flag !== "f") throw new Doubt("tokenizer"); // M-R1-option
        const value = arg.slice(j + 1) || args[++i];
        program(flag === "f" ? value === undefined ? undefined : read(value) : value);
        break;
      }
      if (arg === "-") throw new Doubt("tokenizer");
    } else if (!programs) program(arg);
  }
  if (!programs) throw new Doubt("tokenizer");
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
