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
/** Disjoint from the compiler response-file rule. */
export function compilerResponse(name: string, args: readonly string[]): boolean {
  return COMPILERS.has(name) && args.some(arg => /(?:^|,)@/.test(arg)); // M-PR-6a
}
export function genericResponse(name: string, args: readonly string[], reader: boolean): boolean {
  return !COMPILERS.has(name) && !reader && args.some(arg => arg.startsWith("@")); // M-PR-6b
}
