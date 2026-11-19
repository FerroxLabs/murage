// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 r4.5 S4p-sites: every CLAUDE_CODE_SHELL_PREFIX occurrence is classed (i)-(vi); an extra wrap pattern or an unclassed
// read fails. MK9 (new occurrences ignored) turns the "fails" rows red. The real-binary row runs where the gate names the
// CLI (MURAGE_GATE_CLAUDE_BIN, e.g. hz 2.1.309: 26 occurrences).

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHELL_PREFIX_NAME as N, checkClaudeShellSites, classifyShellPrefixSites } from "./claude-shell-sites.ts";

// Synthetic stand-ins for the 2.1.309 sites (short code shapes, not the CLI text), one per occurrence.
const SITES: Array<[string, string]> = [
  ["\0\0", "\0\0k"], ["it would run through your ", ", which this machine cannot verify"], ["WITHOUT your ", " here: this machine"],
  ["A read-only BUN_OPTIONS, or a ", " that drops the environment"], ["hooks: it would run through your ", ", which this machine"],
  ["X:()=>jS,CLAUDE_CODE_SHELL:()=>vR,", ":()=>yR,CLAUDE_CODE_SIMPLE:()=>ZS"],
  ["function HEr(e){if(i.", ')return"{ shopt -u extglob || setopt NO_EXTENDED_GLOB'], ["or a ", " that drops the environment"],
  ['let mt=Je.join(" && "),bt=i.', ";if(bt)mt=Fpe(bt,mt);return{commandString:mt,cwdFile"],
  ["yo=uo?Rxe(()=>({shellPrefix:i.", ",inherited:{...Po()}})):void 0"], ["yo!==void 0?yo.shellPrefix:i.", ",to=!qt&&!Xt&&sn?Fpe(sn,on):on"],
  ["spawnCwd:We,shellPrefix:ve.base.", ",mcpShellPrefix:i.CLAUDE"], ["ve.base.CLAUDE,mcpShellPrefix:i.", ',mcpPath:Po().PATH??"",launchDir'],
  ['function Mt(e){if(e.omit.includes("', '"))return;let n=e.base.CLAUDE'], ['"))return;let n=e.base.', '?.trim()||void 0;return n!==void 0&&'],
  ["Or(fe,pt),wn=Dr(nt.", '??"",{home:nt.HOME,launchDir:O'], ['.some(Bo))&&!ot.omit.includes("', '")?{...ot,omit:[...ot.omit,"CLAUDE'],
  ['")?{...ot,omit:[...ot.omit,"', '"],extra:Wo(ot.extra,"CLAUDE'], ['"],extra:Wo(ot.extra,"', '")}:ot;if(nt.CLAUDE'],
  ['")}:ot;if(nt.', '?.trim()&&ke.hook.type==="command"&&'], ["for the cloud session WITHOUT your ", " here: this machine"],
  ["notice:I?`${y}: it would run through your ", ", which this machine"], ["for them until you do).`}function Xdr(e){return e.", "?.trim()||void 0}var To"],
  ['if(r.type==="stdio"||!r.type){jx();let S=()=>({shellPrefix:i.', ",baseEnv:N_n()?{...Jt()}"],
  ['if(n.type==="stdio"||!n.type){jx();let L=()=>({shellPrefix:i.', ",baseEnv:N_n()?{...ko()}"],
  ['shell_prefix:"it would run through your ', ', which this machine cannot verify"'],
];
const text = (sites: Array<[string, string]>) => sites.map(([before, after]) => `${before}${N}${after}`).join("\n;;;;\n");

describe("X3 r4.5 S4p-sites: the shell-prefix site check", () => {
  it("the 26 2.1.309 shapes are all classed: (i) 2, (ii) 2, (iii) 2, (iv) 7, (v) 3, (vi) 10", () => {
    const report = classifyShellPrefixSites(text(SITES));
    expect(report.unclassed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(26);
    expect(report.counts).toEqual({ i: 2, ii: 2, iii: 2, iv: 7, v: 3, vi: 10 });
  });

  it("a NUL-delimited string-pool entry may include a trailing newline", () => {
    expect(classifyShellPrefixSites(`\0${N}\n\0`)).toMatchObject({ ok: true, total: 1, counts: { vi: 1 }, unclassed: [] });
  });

  it("[MK9] an extra wrap pattern fails the check", () => {
    const report = classifyShellPrefixSites(text([...SITES, ["let q=i.", ";if(q)z=Gpe(q,z);return{commandString:z"]]));
    expect(report.ok).toBe(false);
    expect(report.unclassed).toHaveLength(1);
  });

  it("[MK9] an unclassed read (a new spawn site handing the prefix on) fails the check", () => {
    const report = classifyShellPrefixSites(text([...SITES, ["spawnFoo({prefix:process.env.", ",argv})"]]));
    expect(report.ok).toBe(false);
  });

  const bin = process.env.MURAGE_GATE_CLAUDE_BIN;
  it.skipIf(!bin || !existsSync(bin))("gate CLI binary: every occurrence is classed", () => {
    const report = checkClaudeShellSites(bin!);
    expect(report.unclassed).toEqual([]);
    expect(report.ok).toBe(true);
    console.info(`shell-prefix sites ${bin} total=${report.total} ${JSON.stringify(report.counts)}`);
  });
});
