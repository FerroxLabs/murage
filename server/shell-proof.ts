// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 r5 rev 3.2 section 1 (designs X3-GLOB-REDESIGN-r5-rev32.md, X3-A-DESIGN-1018.md sections 1-5, X3-A-SIMPLE-1018-r2.md
// section 4): which per-call proof, if any, a shell call carries. Exactly three exist: P-CLAUDE (the murage-exec wrapper
// at PROVEN=1), P-FUIGO (the bound `cwd` field from a Fuigo at or above its contract version) and Codex's per-call
// `params.cwd`. P-SPAWN is not one: a recorded spawn folder only starts the session record. Everything else is the
// floor (the record). Each function here is value-free in what it reports: folder values stay in the start set only.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

/** The driver families proof selection tells apart. "other" is every persistent-shell driver without a proof. */
export type ShellDriver = "claude" | "fuigo" | "codex" | "other";

/** The first Fuigo version whose execute permission carries a bound `cwd` and `dotglob` (A:57-61, compare-then-start,
 *  R20). No shipped Fuigo states that contract yet, so this sits above every released build: every Fuigo call stays
 *  on the floor until the Fuigo build that cites the field and the compare-then-start file:line raises it. */
export const FUIGO_CWD_CONTRACT = "1.1.0";

/** What the judge reads from one Claude thread's murage-exec env file (the wrapper's own input, X3 A SIMPLE r2
 *  section 2) and its flag file. Values other than the folder are reduced to booleans here. */
export interface ClaudeExecProof {
  /** MURAGE_EXEC_CWD: the folder the wrapper cds to before `eval`; E for this turn. */
  cwd: string | null;
  /** MURAGE_EXEC_SHELL's basename. */
  shell: string | null;
  /** MURAGE_EXEC_PROVEN=1. */
  proven: boolean;
  /** The wrapper wrote a refusal to the thread's flag file. */
  refused: boolean;
  /** GLOBIGNORE in the map: bash dot-matches (S8). */
  globignore: boolean;
  /** BASH_FUNC_*, SHELLOPTS or BASHOPTS in the map (C2): floor. */
  shellFunctions: boolean;
}

/** Parse an env file's text (NUL-separated NAME=value pairs) and its flag file's text, or null when there is none. */
export function claudeExecProof(envText: string, flagText: string | null): ClaudeExecProof {
  const proof: ClaudeExecProof = { cwd: null, shell: null, proven: false, refused: Boolean(flagText && /\S/.test(flagText)), globignore: false, shellFunctions: false };
  for (const pair of envText.split("\0")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at), value = pair.slice(at + 1);
    if (name === "MURAGE_EXEC_CWD") proof.cwd = value || null;
    else if (name === "MURAGE_EXEC_SHELL") proof.shell = value.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, "") || null;
    else if (name === "MURAGE_EXEC_PROVEN") proof.proven = value === "1";
    else if (name === "GLOBIGNORE") proof.globignore = true;
    else if (name.startsWith("BASH_FUNC_") || name === "SHELLOPTS" || name === "BASHOPTS") proof.shellFunctions = true;
  }
  return proof;
}

/** The refusal flag is append-only, so a read is one fixed window from its head, never the whole file. */
export const FLAG_HEAD_BYTES = 4096;
export type FlagHead = { text: string; more: boolean };
/** The first FLAG_HEAD_BYTES of a flag file and whether bytes remain past them; null when the file cannot be read. */
export function readFlagHead(path: string): FlagHead | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, FLAG_HEAD_BYTES));
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString("utf8", 0, bytes), more: size > FLAG_HEAD_BYTES };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Read one thread's env file and flag file (`<env file>.flag`). An unreadable env file is no proof (null). */
export function readClaudeExecProof(envFile: string): ClaudeExecProof | null {
  let envText: string;
  try { envText = readFileSync(envFile, "utf8"); } catch { return null; }
  const head = readFlagHead(`${envFile}.flag`);
  // A flag longer than the window with a blank head is still a refusal (fail closed).
  return claudeExecProof(envText, head && (head.more && !/\S/.test(head.text) ? "refused" : head.text));
}

/** Dotted numeric versions, compared part by part; a pre-release or build tail is ignored. Unparseable: false. */
export function versionAtLeast(version: string | null | undefined, floor: string): boolean {
  const parse = (value: string) => /^v?(\d+(?:\.\d+)*)/.exec(value.trim())?.[1]?.split(".").map(Number);
  const have = version ? parse(version) : undefined, need = parse(floor)!;
  if (!have) return false;
  for (let k = 0; k < Math.max(have.length, need.length); k++) {
    const a = have[k] ?? 0, b = need[k] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The per-call proof facts one call carries, as the call site read them. `namedCwd` is the extractor's value
 *  (shared/exact-command.ts commandCwdFromToolInput): a usable absolute folder, null when claimed but unusable,
 *  undefined when absent. */
export interface ShellProofFacts {
  driver?: ShellDriver;
  namedCwd?: string | null;
  /** Claude only: the turn's recorded shell mode (claude.ts claudeShellMode) and the env file the judge read. */
  claude?: { mode: string; exec: ClaudeExecProof | null };
  /** Fuigo only: the driver's version probe and the permission's `dotglob` field as sent. */
  fuigo?: { version: string | null; dotglob?: unknown };
}

/** The proof kinds a start set can come from. */
export type ShellProofSource = "claude" | "fuigo" | "codex-cwd";
/** Why a call stayed on the floor (A section 5 A2 causes), value-free. */
export type ShellFloorCause =
  | "unproven-driver" | "claude-mode" | "claude-no-env" | "claude-not-proven" | "claude-refused" | "claude-zsh" | "claude-map"
  | "claude-no-cwd" | "fuigo-old" | "fuigo-no-cwd" | "codex-no-cwd" | "codex-invalid-cwd";

export type ShellProofVerdict =
  | { source: ShellProofSource; cwd: string; dotglob: boolean }
  | { floor: ShellFloorCause };

const absolute = (path: string | null | undefined): path is string => typeof path === "string" && (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path));

/** Rev 3.2 section 1, exactly. `dotglob` is the proven call's dot state: true means dot matching ON. */
export function shellProof(facts: ShellProofFacts): ShellProofVerdict {
  if (facts.driver === "claude") {
    // M22: a P-CLAUDE call is proven only when the turn's recorded shell mode is murage-exec.
    if (facts.claude?.mode !== "murage-exec") return { floor: "claude-mode" };
    const exec = facts.claude.exec;
    if (!exec) return { floor: "claude-no-env" };
    if (exec.refused) return { floor: "claude-refused" };
    if (!exec.proven) return { floor: "claude-not-proven" };
    if (exec.shell !== "bash") return { floor: "claude-zsh" };
    if (exec.shellFunctions) return { floor: "claude-map" };
    if (!absolute(exec.cwd)) return { floor: "claude-no-cwd" };
    // Owner ruling (8 Nov), superseding S8 / A SIMPLE r2:20: dot matching is ON for every Claude Code call. Claude
    // Code sources the user's shell snapshot (headless-text-only.ts `shell-snapshots`), and a `shopt -s dotglob` there
    // never shows in the env map, so a map without GLOBIGNORE does not prove dot matching off. GLOBIGNORE is a reason,
    // not a gate.
    return { source: "claude", cwd: exec.cwd, dotglob: true };
  }
  if (facts.driver === "fuigo") {
    if (!versionAtLeast(facts.fuigo?.version, FUIGO_CWD_CONTRACT)) return { floor: "fuigo-old" };
    if (!absolute(facts.namedCwd)) return { floor: "fuigo-no-cwd" };
    // A:60: a missing `dotglob` field means dot matching ON (M26).
    return { source: "fuigo", cwd: facts.namedCwd, dotglob: facts.fuigo?.dotglob !== false };
  }
  if (facts.driver === "codex") {
    if (facts.namedCwd === null) return { floor: "codex-invalid-cwd" };
    // Rev 3.2 section 1 makes a spawn-bound Codex call (no `params.cwd`) a per-call start only with a Codex file:line
    // showing such a call spawns at the recorded folder. None is cited (Codex also keeps persistent exec sessions),
    // so Codex without `params.cwd` follows the persistent-shell rule: the record (T-SP3 reads CARDS).
    if (!absolute(facts.namedCwd)) return { floor: "codex-no-cwd" };
    return { source: "codex-cwd", cwd: facts.namedCwd, dotglob: true };
  }
  return { floor: "unproven-driver" };
}

const counts = new Map<string, number>();
/** A2 (A section 5): calls on each proof and on the floor by cause, per driver. Value-free keys only. */
export function countShellStart(driver: ShellDriver | undefined, outcome: ShellProofSource | ShellFloorCause | "named" | "record"): void {
  const key = `${driver ?? "unnamed"}:${outcome}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
export function shellStartCounts(): ReadonlyMap<string, number> { return new Map(counts); }

/** X3 A SIMPLE r2 section 4 (r2:32): the two judgments the replay runs for one glob-bearing command. The floor side is
 *  the record replayed with dot matching ON; the proof side starts at THAT command's E (the env file's cwd for its
 *  turn), never at the thread's spawn folder, with the proven call's dot state. A command with no E has no proof side. */
export function replayEndpoints(command: { execCwd?: string | null; globignore?: boolean; /** never an endpoint (MS9b) */ spawnCwd?: string }): { floor: { dotglob: true }; proof?: { cwd: string; dotglob: boolean } } {
  return absolute(command.execCwd)
    ? { floor: { dotglob: true }, proof: { cwd: command.execCwd, dotglob: true } }
    : { floor: { dotglob: true } };
}

/** The A2 union (rev 3.2 R1, A:74): a command counts when any of its proof, floor or K outcomes is a new card versus
 *  b18. Returns the union count and both one-sided counts. */
export function replayUnion(rows: readonly { proofNew?: boolean; floorNew: boolean; kNew?: boolean }[]): { union: number; proof: number; floor: number; k: number } {
  let union = 0, proof = 0, floor = 0, k = 0;
  for (const row of rows) {
    if (row.proofNew) proof++;
    if (row.floorNew) floor++;
    if (row.kNew) k++;
    if (row.proofNew || row.floorNew || row.kNew) union++;
  }
  return { union, proof, floor, k };
}
