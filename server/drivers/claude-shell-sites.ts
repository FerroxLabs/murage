// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 A SIMPLE r4.5 B6 (r3 B6 sites): the every-release engine check extracts EVERY occurrence of
// CLAUDE_CODE_SHELL_PREFIX in the gate CLI and classes it by its code pattern:
//   (i) Bash tool wrap, (ii) command hooks wrap, (iii) MCP stdio wrap, (iv) cloud-device hook reads and checks,
//   (v) carriers (no spawn), (vi) text only.
// The rule set is CLOSED: an occurrence that no rule matches (a new spawn site, a new wrap pattern, a renamed minified
// helper) is unclassed, and one unclassed occurrence fails the check. Between releases a new site has no `mcp:` marker,
// so B2 and W5 refuse it at PROVEN=1 anyway; the check makes the release notice it.

import { readFileSync } from "node:fs";

export const SHELL_PREFIX_NAME = "CLAUDE_CODE_SHELL_PREFIX";
export type ShellSiteClass = "i" | "ii" | "iii" | "iv" | "v" | "vi";
type Rule = { cls: ShellSiteClass; before: RegExp; after: RegExp; note: string };

/** Each rule: the text right before the name (anchored at its end) and right after it (anchored at its start). Read from
 * Claude Code 2.1.309 install, 26 occurrences. */
export const SHELL_SITE_RULES: readonly Rule[] = [
  { cls: "i", before: /bt=i\.$/, after: /^;if\(bt\)mt=Fpe\(bt,mt\);return\{commandString:mt/, note: "Bash tool: the command string wrapped by the prefix" },
  { cls: "i", before: /\{if\(i\.$/, after: /^\)return"\{ shopt -u extglob \|\| setopt NO_EXTENDED_G/, note: "Bash tool: the prefix-only extglob segment (a W5 listed shape)" },
  { cls: "ii", before: /\(\(\)=>\(\{shellPrefix:i\.$/, after: /^,inherited:\{\.\.\.Po\(\)\}\}\)\)/, note: "command hooks: the prefix captured for the runner" },
  { cls: "ii", before: /yo\.shellPrefix:i\.$/, after: /^,to=!qt&&!Xt&&sn\?Fpe\(sn,on\):on/, note: "command hooks: the hook command wrapped by the prefix" },
  { cls: "iii", before: /="stdio"\|\|!\w+\.type\)\{jx\(\);let \w+=\(\)=>\(\{shellPrefix:i\.$/, after: /^,baseEnv:/, note: "MCP stdio: the prefix becomes the program" },
  { cls: "iv", before: /function Mt\(e\)\{if\(e\.omit\.includes\("$/, after: /^"\)\)return;let n=e\.base\./, note: "cloud-device hooks: the omit check" },
  { cls: "iv", before: /\)\)return;let n=e\.base\.$/, after: /^\?\.trim\(\)\|\|void 0;return n!==void 0/, note: "cloud-device hooks: the read" },
  { cls: "iv", before: /,wn=Dr\(nt\.$/, after: /^\?\?"",\{home:nt\.HOME,launchDir:/, note: "cloud-device hooks: the check of the device's prefix" },
  { cls: "iv", before: /&&!ot\.omit\.includes\("$/, after: /^"\)\?\{\.\.\.ot,omit:\[\.\.\.ot\.omit,"/, note: "cloud-device hooks: the omission" },
  { cls: "iv", before: /\{\.\.\.ot,omit:\[\.\.\.ot\.omit,"$/, after: /^"\],extra:Wo\(ot\.extra,"/, note: "cloud-device hooks: the omission" },
  { cls: "iv", before: /\],extra:Wo\(ot\.extra,"$/, after: /^"\)\}:ot;if\(nt\./, note: "cloud-device hooks: the omission" },
  { cls: "iv", before: /\}:ot;if\(nt\.$/, after: /^\?\.trim\(\)&&ke\.hook\.type==="command"/, note: "cloud-device hooks: the unwrapped warning test" },
  { cls: "v", before: /,shellPrefix:ve\.base\.$/, after: /^,mcpShellPrefix:i\./, note: "carrier: the served-call object (feeds ii/iii)" },
  { cls: "v", before: /,mcpShellPrefix:i\.$/, after: /^,mcpPath:Po\(\)\.PATH\?\?""/, note: "carrier: the served-call object (feeds ii/iii)" },
  { cls: "v", before: /function Xdr\(e\)\{return e\.$/, after: /^\?\.trim\(\)\|\|void 0\}/, note: "carrier: cloud hook verification" },
  { cls: "vi", before: /(?:your |or a )$/, after: /^,? (?:which|that|here)\b/, note: "text: a message" },
  { cls: "vi", before: /,CLAUDE_CODE_SHELL:\(\)=>\w+,$/, after: /^:\(\)=>\w+,CLAUDE_CODE_SIMPLE:/, note: "text: the env name table" },
  { cls: "vi", before: /\0$/, after: /^\n?\0/, note: "text: a string-pool entry" },
];

export type ShellSiteReport = { ok: boolean; total: number; counts: Record<ShellSiteClass, number>; unclassed: number[] };

/** Classes every occurrence of the name in `text` (a CLI binary read as latin1). `ok` only when every one is classed. */
export function classifyShellPrefixSites(text: string, rules: readonly Rule[] = SHELL_SITE_RULES): ShellSiteReport {
  const counts: Record<ShellSiteClass, number> = { i: 0, ii: 0, iii: 0, iv: 0, v: 0, vi: 0 };
  const unclassed: number[] = [];
  let total = 0;
  for (let at = text.indexOf(SHELL_PREFIX_NAME); at !== -1; at = text.indexOf(SHELL_PREFIX_NAME, at + 1)) {
    total++;
    const before = text.slice(Math.max(0, at - 160), at);
    const after = text.slice(at + SHELL_PREFIX_NAME.length, at + SHELL_PREFIX_NAME.length + 160);
    const rule = rules.find((one) => one.before.test(before) && one.after.test(after));
    if (rule) counts[rule.cls]++;
    else unclassed.push(at);
  }
  return { ok: unclassed.length === 0, total, counts, unclassed };
}

/** The engine-check entry: the gate CLI's binary (or its JS bundle). */
export function checkClaudeShellSites(binaryPath: string): ShellSiteReport {
  return classifyShellPrefixSites(readFileSync(binaryPath).toString("latin1"));
}
