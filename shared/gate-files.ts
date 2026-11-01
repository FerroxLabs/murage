// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT section 1: the files that shape what a later turn runs or how it is judged. At No limits on a
// turn the owner started, a key rule no longer asks, but a call whose text or paths name one of these still does.
// The list is closed and built from the row ids in sensitive-paths.ts, so an edit to a row flows through. It is a
// plain-text guard: it reads what the call names, and a script that writes one of these files is not seen.

import { SENSITIVE_PATHS, SENSITIVE_TEXT } from "./sensitive-paths.ts";

export interface GateRow { id: string; re: RegExp }

/** The mkdtemp suffix is mixed case, which the key row's hex-only pattern misses. */
const MURAGE_EXEC = /murage-exec(-[0-9A-Za-z]+)?([\\/]|$|["'\s])/i;

const GATE_PATH_IDS = [
  "murage-exec", "murage-engine-hooks", "agy-workspace-hooks", "fuigo-engine-config", "project-tooling", "project-git",
  "gitconfig", "envrc", "shell-rc", "shell-startup", "system-startup", "ssh", "harness-keys", "keys-and-cluster-configs",
] as const;
const GATE_TEXT_IDS = ["cmd-autorun"] as const;

function rowById(rows: ReadonlyArray<{ id: string; re: RegExp }>, id: string): GateRow {
  const row = rows.find((one) => one.id === id);
  if (!row) throw new Error(`gate row ${id} is not in the sensitive list`);
  return { id, re: id === "murage-exec" ? MURAGE_EXEC : row.re };
}

export const GATE_ROWS: readonly GateRow[] = [
  ...GATE_PATH_IDS.map((id) => rowById(SENSITIVE_PATHS, id)),
  ...GATE_TEXT_IDS.map((id) => rowById(SENSITIVE_TEXT, id)),
];

/** Running a local tool changes nothing, so this one spelling leaves `project-tooling`. */
const LOCAL_TOOLS = /node_modules[\\/]\.bin(?=[\\/]|$|[\s"'])/gi;

/** A copy with `./`, empty and `seg/../` segments collapsed, for either separator. A segment starts only after a
 * separator, a space or a quote, so the walk over a long word stays linear. */
function collapsedPaths(text: string): string {
  let copy = text.replace(/[\\/]\.(?=[\\/])/g, "").replace(/([\\/])[\\/]+/g, "$1");
  for (let pass = 0; pass < 16; pass++) {
    const next = copy.replace(/(?<![^\\/\s"'])(?!\.\.?[\\/])[^\\/\s"']+[\\/]\.\.[\\/]/g, "");
    if (next === copy) break;
    copy = next;
  }
  return copy;
}

function rowIn(text: string): GateRow | undefined {
  return GATE_ROWS.find((row) => row.re.test(row.id === "project-tooling" ? text.replace(LOCAL_TOOLS, " ") : text));
}

/** The rule of the first gate row these texts name, as written or with their paths collapsed. */
export function gateHit(texts: readonly string[]): string | null {
  for (const text of texts) {
    const row = rowIn(text) ?? rowIn(collapsedPaths(text));
    if (row) return row.re.source;
  }
  return null;
}

const RULE_IDS: ReadonlyMap<string, string> = new Map([
  ...[...SENSITIVE_PATHS, ...SENSITIVE_TEXT].map((row) => [row.re.source, row.id] as const),
  ...GATE_ROWS.map((row) => [row.re.source, row.id] as const),
]);

/** The row id for a rule the verdict holds, which is a regex source: the value-free name a log line may carry. */
export function ruleRowId(rule: string | undefined): string | undefined {
  return rule === undefined ? undefined : RULE_IDS.get(rule);
}
