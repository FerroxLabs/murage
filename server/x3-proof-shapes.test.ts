// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 phase 2, builder B: proof selection (r5 rev 3.2 section 1), P-SPAWN, P-FUIGO, the snapshot key row and the replay
// endpoints. Rows from designs/X3-A-DESIGN-1018.md section 6 (kept list, X3-A-SIMPLE-1018-r2.md:41), r2 S7-S9 and
// rev 3.2 section 5 (T-P, T-SP1..3) and section 7 (MF2). Every verdict runs through the full No-limits owner context.
// Rows marked [waits A] or [waits C] assert the proof selection here; their judge outcome needs builder A's record
// (K, capped) or builder C's witness judge (dot rule).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, startSetFor, type CredentialGlobFs, type ShellCall } from "./auto-approve.ts";
import { ShellSessionRegistry } from "./shell-session-state.ts";
import { claudeExecProof, FUIGO_CWD_CONTRACT, readClaudeExecProof, replayEndpoints, replayUnion, shellStartCounts, versionAtLeast, type ClaudeExecProof } from "./shell-proof.ts";
import type { ShellCwdState } from "../shared/sensitive-globs.ts";

const HOME = "/h";
// Fixture tree: a trailing `/` marks a folder.
const TREE: Record<string, string[]> = {
  "/w": ["README.md", "notes.md", "src/"],
  "/w/src": ["index.ts"],
  "/h": ["README.md", ".ssh/"],
  "/h/.ssh": ["id_rsa", "config"],
  "/srv/export": ["credentials.json", "README.md"],
  "/d": [".env", "README.md"],
  "/c": [".credentials.json"],
};
for (let k = 1; k <= 40; k++) TREE[`/w/d${String(k).padStart(2, "0")}`] = ["README.md"];
const strip = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
function exists(path: string): boolean {
  const p = strip(path);
  // a real fs resolves the root and every folder above a listed one (C walks parents physically)
  if (p === "/" || TREE[p] || Object.keys(TREE).some(key => key.startsWith(p + "/"))) return true;
  const at = p.lastIndexOf("/");
  const parent = at <= 0 ? "/" : p.slice(0, at), name = p.slice(at + 1);
  return Boolean(TREE[parent]?.some(entry => entry.replace(/\/$/, "") === name));
}
function fixtureFs(): { fs: CredentialGlobFs; listed: string[] } {
  const listed: string[] = [];
  return { listed, fs: {
    realpath: async path => { if (!exists(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); return strip(path); },
    opendir: async path => {
      const names = TREE[strip(path)];
      if (!names) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      listed.push(strip(path));
      let index = 0;
      return {
        read: async () => {
          const entry = names[index++];
          if (entry === undefined) return null;
          const dir = entry.endsWith("/");
          return { name: entry.replace(/\/$/, ""), isDirectory: () => dir, isSymbolicLink: () => false };
        },
        close: async () => {},
      };
    },
  } };
}

const bot = { id: "x3-proof", autoApprove: true, fullAccess: true, noLimits: false };
const owner = (command: string, rule: string | null = null) => autoVerdict(bot, "Bash", command, { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: rule });
const CARDS = (command: string, rule: string | null) => expect(owner(command, rule).approve, `${command} should card`).toBeNull();
const QUIET = (command: string, rule: string | null) => expect(owner(command, rule).approve, `${command} should stay quiet`).not.toBeNull();

const state = (...folders: string[]): ShellCwdState => ({ targets: new Map(folders.map(folder => [folder, "fixture"])) });
const unknownState = (): ShellCwdState => ({ targets: new Map(), unknown: "fixture unknown" });
const exec = (over: Partial<ClaudeExecProof> = {}): ClaudeExecProof => ({ cwd: "/w", shell: "bash", proven: true, refused: false, globignore: false, shellFunctions: false, ...over });
const claude = (over: Partial<ClaudeExecProof> = {}, mode = "murage-exec"): ShellCall => ({ driver: "claude", claude: { mode, exec: exec(over) } });
const fuigo = (cwd: string | null | undefined, over: { version?: string | null; dotglob?: unknown } = {}): ShellCall => ({ driver: "fuigo", namedCwd: cwd, fuigo: { version: "version" in over ? over.version! : FUIGO_CWD_CONTRACT, dotglob: over.dotglob } });
async function judge(command: string, record: ShellCwdState, call: ShellCall) {
  const { fs } = fixtureFs();
  return prepareShellJudgement(command, record, { ...call, attributed: true, home: HOME, fs });
}
const folders = (s: ShellCwdState) => [...s.targets.keys()].sort();

describe("T-P proof isolation (rev 3.2 section 5)", () => {
  it("T-P: P-CLAUDE PROVEN=1, E=/w, record unknown: `ls *.md` judged at /w, QUIET", async () => {
    const result = await judge("ls *.md", unknownState(), claude());
    expect(result.start.source).toBe("claude");
    expect(folders(result.local)).toEqual(["/w"]);
    expect(result.local.unknown).toBeUndefined();
    QUIET("ls *.md", result.rule);
  });
});

describe("P-CLAUDE rows (A section 6)", () => {
  it("R1: `cd ~/.ssh` is shadow state; `cat *` at E=/w is QUIET (M18)", async () => {
    const first = await judge("cd ~/.ssh", state("/w"), claude());
    expect(folders(first.parent)).toEqual(["/h/.ssh", "/w"]);
    const second = await judge("cat *", first.parent, claude());
    expect(folders(second.local)).toEqual(["/w"]);
    QUIET("cat *", second.rule);
  });
  it("R2: E=~/.ssh, record {/w}: `cat *` CARDS W (M34)", async () => {
    const result = await judge("cat *", state("/w"), claude({ cwd: "/h/.ssh" }));
    expect(folders(result.local)).toEqual(["/h/.ssh"]);
    CARDS("cat *", result.rule);
  });
  it("R3: E=/w, `cd \"$D\"; cat *` CARDS P5 within the command (M28)", async () => {
    const result = await judge('cd "$D"; cat *', state("/w"), claude());
    expect(result.local.unknown).toBeTruthy();
    CARDS('cd "$D"; cat *', result.rule);
  });
  it("R4: 40 additive cds; the proven call 41 is judged at E alone, the zsh floor twin on the record [waits A: capped, K]", async () => {
    let record = state("/w");
    for (let k = 1; k <= 40; k++) record = (await judge(`cd /w/d${String(k).padStart(2, "0")}; true`, record, claude())).parent;
    const proven = await judge("ls *.md", record, claude());
    expect(proven.start.source).toBe("claude");
    expect(folders(proven.local)).toEqual(["/w"]);
    QUIET("ls *.md", proven.rule);
    const twin = await judge("ls *.md", record, claude({ shell: "zsh" }));
    expect(twin.start).toMatchObject({ source: "record", floor: "claude-zsh" });
  });
  it("R9: BASH_FUNC_ in the map: floor, R1's sequence CARDS (M25)", async () => {
    const proof = claudeExecProof("MURAGE_EXEC_CWD=/w\0MURAGE_EXEC_SHELL=/bin/bash\0MURAGE_EXEC_PROVEN=1\0BASH_FUNC_shopt%%=() { builtin cd ~/.ssh; }\0", null);
    expect(proof.shellFunctions).toBe(true);
    const call: ShellCall = { driver: "claude", claude: { mode: "murage-exec", exec: proof } };
    const first = await judge("cd ~/.ssh", state("/w"), call);
    const second = await judge("cat *", first.parent, call);
    expect(second.start).toMatchObject({ source: "record", floor: "claude-map" });
    CARDS("cat *", second.rule);
  });
  it("R10b: a refusal in the flag file: floor, R1's sequence CARDS (M33)", async () => {
    const proof = claudeExecProof("MURAGE_EXEC_CWD=/w\0MURAGE_EXEC_SHELL=/bin/bash\0MURAGE_EXEC_PROVEN=1\0", "reason=snapshot shape=123\n");
    expect(proof.refused).toBe(true);
    const call: ShellCall = { driver: "claude", claude: { mode: "murage-exec", exec: proof } };
    const second = await judge("cat *", (await judge("cd ~/.ssh", state("/w"), call)).parent, call);
    expect(second.start).toMatchObject({ source: "record", floor: "claude-refused" });
    CARDS("cat *", second.rule);
  });
  it("R11: MURAGE_EXEC_SHELL=/bin/zsh: floor, R1's sequence CARDS (M35)", async () => {
    const call = claude({ shell: claudeExecProof("MURAGE_EXEC_SHELL=/bin/zsh\0", null).shell });
    const second = await judge("cat *", (await judge("cd ~/.ssh", state("/w"), call)).parent, call);
    expect(second.start).toMatchObject({ source: "record", floor: "claude-zsh" });
    CARDS("cat *", second.rule);
  });
  it("no-skip (c): a powershell-inherit turn judges on the floor even with a PROVEN env file (M22)", async () => {
    const call = claude({}, "powershell-inherit");
    const second = await judge("cat *", (await judge("cd ~/.ssh", state("/w"), call)).parent, call);
    expect(second.start).toMatchObject({ source: "record", floor: "claude-mode" });
    CARDS("cat *", second.rule);
  });
  it("PROVEN=0 and a missing env file stay on the floor", () => {
    expect(startSetFor(claude({ proven: false }), state("/w")).floor).toBe("claude-not-proven");
    expect(startSetFor({ driver: "claude", claude: { mode: "murage-exec", exec: null } }, state("/w")).floor).toBe("claude-no-env");
    expect(startSetFor(claude({ cwd: "rel" }), state("/w")).floor).toBe("claude-no-cwd");
  });
  it("the env file reader: E, shell, PROVEN and the flag file, value-free otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "x3-proof-"));
    const file = join(dir, "0123456789abcdef01234567");
    writeFileSync(file, "MURAGE_EXEC_CWD=/w\0MURAGE_EXEC_SHELL=/usr/bin/bash\0MURAGE_EXEC_PROVEN=1\0PATH=/usr/bin\0");
    expect(readClaudeExecProof(file)).toEqual(exec());
    writeFileSync(`${file}.flag`, "reason=shape shape=9\n");
    expect(readClaudeExecProof(file)?.refused).toBe(true);
    expect(readClaudeExecProof(join(dir, "missing"))).toBeNull();
  });
});

describe("S7-S9 (X3-A-SIMPLE-1018-r2.md section 6)", () => {
  it("S7: a proven call in a capped record reads no K [waits A: K consumption, MK]", async () => {
    const proven = await judge("ls *.md", { targets: new Map(), unknown: "too many possible shell folders" }, claude());
    expect(proven.start.source).toBe("claude");
    expect(proven.local.unknown).toBeUndefined();
  });
  it("S8 (owner ruling 8 Nov): a proven Claude call is dot ON with or without GLOBIGNORE in the map (MS8, MD4)", () => {
    expect(startSetFor(claude(), state("/d")).dotglob).toBe(true);
    const withIgnore = claudeExecProof("MURAGE_EXEC_CWD=/d\0MURAGE_EXEC_SHELL=bash\0MURAGE_EXEC_PROVEN=1\0GLOBIGNORE=x\0", null);
    expect(startSetFor({ driver: "claude", claude: { mode: "murage-exec", exec: withIgnore } }, state("/d")).dotglob).toBe(true);
  });
  it("S9: the floor side replays dot ON; the proof side starts at THAT command's E, not the spawn folder (MS9a, MS9b)", async () => {
    const endpoints = replayEndpoints({ execCwd: "/h/.ssh", spawnCwd: "/w" });
    expect(endpoints.floor.dotglob).toBe(true);
    expect(endpoints.proof).toEqual({ cwd: "/h/.ssh", dotglob: true });
    const proofSide = await judge("cat *", state("/w"), claude({ cwd: endpoints.proof!.cwd }));
    CARDS("cat *", proofSide.rule);
    expect(replayEndpoints({ spawnCwd: "/w" }).proof).toBeUndefined();
    // the union counts a command once when either side, or K, is a new card
    expect(replayUnion([{ proofNew: true, floorNew: false }, { floorNew: true }, { floorNew: true, proofNew: true }, { floorNew: false, kNew: true }, { floorNew: false }]))
      .toEqual({ union: 4, proof: 2, floor: 2, k: 1 });
  });
});

describe("P-SPAWN (A section 1, rev 3.2 sections 2 and 7)", () => {
  const identity = { thread: "t", provider: "p", native: "n", incarnation: 1 };
  function spawned(spawnCwd: string | undefined) {
    const registry = new ShellSessionRegistry();
    registry.launch("g", { thread: "t", provider: "p" });
    registry.accept("g", "turn-1", spawnCwd);
    registry.started(identity, "turn-1");
    return registry;
  }
  it("R14: the record starts at the folder handed to spawn; `Get-Content *.md` there is QUIET (M20)", async () => {
    const registry = spawned("/h");
    const record = registry.select("t", "p", "turn-1");
    expect(folders(registry.snapshot(record))).toEqual(["/h"]);
    const result = await judge("Get-Content *.md", registry.snapshot(record), { driver: "other" });
    QUIET("Get-Content *.md", result.rule);
  });
  it("S2': no recorded spawn folder: the record starts unknown", () => {
    const registry = spawned(undefined);
    expect(registry.snapshot(registry.select("t", "p", "turn-1")).unknown).toBeTruthy();
  });
  it("MF2 row: after a publish failure the floor is unknown and never re-seeded; `cat *.json` CARDS P5", async () => {
    const registry = spawned("/w");
    const record = registry.select("t", "p", "turn-1");
    const first = await judge("cd /srv/export; true", registry.snapshot(record), { driver: "other" });
    registry.exit("t", "p", "turn-1");
    expect(registry.publish(record, first.parent, registry.claim(record))).toBe(false);
    registry.started(identity, "turn-1");
    const next = registry.snapshot(registry.select("t", "p", "turn-1"));
    expect(next.unknown).toBeTruthy();
    const second = await judge("cat *.json", next, { driver: "other" });
    CARDS("cat *.json", second.rule);
  });
  it("P-SPAWN dot row: a proven Claude call at the spawn folder has dot matching off [waits C: dot rule outcome]", () => {
    expect(startSetFor(claude({ cwd: "/h" }), state("/h"))).toMatchObject({ source: "claude", dotglob: true });
  });
  it("T-SP1: Fuigo below its contract floor, spawn /w, `cd /srv/export; true` then `cat *.json` CARDS W (MA6)", async () => {
    const registry = spawned("/w");
    const record = registry.select("t", "p", "turn-1");
    const old = fuigo(undefined, { version: "1.0.37" });
    const first = await judge("cd /srv/export; true", registry.snapshot(record), old);
    expect(registry.publish(record, first.parent, registry.claim(record))).toBe(true);
    expect(folders(registry.snapshot(record))).toEqual(["/srv/export", "/w"]);
    const second = await judge("cat *.json", registry.snapshot(record), old);
    expect(second.start).toMatchObject({ source: "record", floor: "fuigo-old" });
    expect(folders(second.local)).toEqual(["/srv/export", "/w"]);
  });
  // [waits C] the W witness for `*.json` (r5 section 1): flip to it() once the witness judge lands.
  it("T-SP1 outcome: `cat *.json` on {/w, /srv/export} CARDS W", async () => {
    CARDS("cat *.json", (await judge("cat *.json", state("/w", "/srv/export"), fuigo(undefined, { version: "1.0.37" }))).rule);
  });
  it("T-SP2: spawn /w, `cd \"$D\"` then `ls *.md` CARDS P5 (MA6)", async () => {
    const registry = spawned("/w");
    const record = registry.select("t", "p", "turn-1");
    const old = fuigo(undefined, { version: "1.0.37" });
    registry.publish(record, (await judge('cd "$D"', registry.snapshot(record), old)).parent, registry.claim(record));
    const second = await judge("ls *.md", registry.snapshot(record), old);
    expect(second.local.unknown).toBeTruthy();
    CARDS("ls *.md", second.rule);
  });
  it("T-SP3: no Codex file:line binds a call without `params.cwd` to the spawn folder, so Codex follows the record: CARDS", async () => {
    const registry = spawned("/w");
    const record = registry.select("t", "p", "turn-1");
    registry.publish(record, (await judge("cd /srv/export", registry.snapshot(record), { driver: "codex" })).parent, registry.claim(record));
    const second = await judge("cat *.json", registry.snapshot(record), { driver: "codex" });
    expect(second.start).toMatchObject({ source: "record", floor: "codex-no-cwd" });
    expect(folders(second.local)).toEqual(["/srv/export", "/w"]);
    const withCwd = await judge("cat *.json", registry.snapshot(record), { driver: "codex", namedCwd: "/w" });
    expect(withCwd.start.source).toBe("codex-cwd");
    QUIET("cat *.json", withCwd.rule);
  });
});

it("T-SP3 outcome: Codex without `params.cwd` on {/w, /srv/export}: `cat *.json` CARDS W", async () => {
  CARDS("cat *.json", (await judge("cat *.json", state("/w", "/srv/export"), { driver: "codex" })).rule);
});

describe("P-FUIGO rows (A section 6)", () => {
  it("R15: the bound cwd decides: ~/.ssh CARDS, /w QUIET, record {/w} (M36)", async () => {
    const key = await judge("cat *", state("/w"), fuigo("/h/.ssh"));
    expect(key.start.source).toBe("fuigo");
    CARDS("cat *", key.rule);
    QUIET("cat *", (await judge("cat *", state("/w"), fuigo("/w"))).rule);
  });
  it("R16: a relative cwd (extractor null) is the floor; unknown record, `cat *.md` CARDS P5 (M19)", async () => {
    const result = await judge("cat *.md", unknownState(), fuigo(null));
    expect(result.start).toMatchObject({ source: "record", floor: "fuigo-no-cwd" });
    CARDS("cat *.md", result.rule);
  });
  it("R17: a proven call publishes: cwd /w runs `cd ~/.ssh && true`, the next call without cwd CARDS W (M21)", async () => {
    const first = await judge("cd ~/.ssh && true", state("/w"), fuigo("/w"));
    expect(folders(first.parent)).toContain("/h/.ssh");
    const second = await judge("cat *", first.parent, fuigo(undefined));
    expect(second.start).toMatchObject({ source: "record", floor: "fuigo-no-cwd" });
    CARDS("cat *", second.rule);
  });
  it("R18: `dotglob: true` and a missing field both mean dot matching ON (M26)", async () => {
    expect(startSetFor(fuigo("/d", { dotglob: true }), state("/d")).dotglob).toBe(true);
    expect(startSetFor(fuigo("/d"), state("/d")).dotglob).toBe(true);
    expect(startSetFor(fuigo("/d", { dotglob: false }), state("/d")).dotglob).toBe(false);
  });
  // [waits C] the dot rule (r5:33) consumes the start set's dot state: flip to it() once the witness judge lands.
  it("R18 outcome: dot ON at /d, `cat *` CARDS on `.env`", async () => {
    CARDS("cat *", (await judge("cat *", state("/d"), fuigo("/d"))).rule);
  });
  it("R19: a Fuigo below the contract version is the floor; record {/w, ~/.ssh}, `cat *` CARDS W (M27)", async () => {
    const result = await judge("cat *", state("/w", "/h/.ssh"), fuigo("/w", { version: "1.0.37" }));
    expect(result.start).toMatchObject({ source: "record", floor: "fuigo-old" });
    CARDS("cat *", result.rule);
    expect(versionAtLeast("1.0.37", FUIGO_CWD_CONTRACT)).toBe(false);
    expect(versionAtLeast(FUIGO_CWD_CONTRACT, FUIGO_CWD_CONTRACT)).toBe(true);
    expect(versionAtLeast(null, FUIGO_CWD_CONTRACT)).toBe(false);
  });
});

describe("S-a / S-b: a proven call publishes additively only (X3-SIMPLIFY-SaSb-1107.md)", () => {
  it.each([
    ["Codex", (cwd: string): ShellCall => ({ driver: "codex", namedCwd: cwd })],
    ["Fuigo", (cwd: string): ShellCall => fuigo(cwd)],
  ])("G-H1 (%s): a proven `cd /w && true` keeps /srv/export in the record (MS-a)", async (_name, proven) => {
    const floor: ShellCall = { driver: "codex" };
    const first = await judge("cd /srv/export; true", state("/w"), floor);
    expect(folders(first.parent)).toEqual(["/srv/export", "/w"]);
    const second = await judge("cd /w && true", first.parent, proven("/w"));
    expect(second.start.source).not.toBe("record");
    expect(folders(second.parent)).toEqual(["/srv/export", "/w"]);
    const third = await judge("cat *.json", second.parent, floor);
    expect(folders(third.local)).toEqual(["/srv/export", "/w"]);
  });
  it("G-H2: a Fuigo bound cwd adds its folder and keeps `unknown`; the floor `cat *.json` CARDS P5 (MS-b)", async () => {
    const first = await judge('cd "$D"', state("/w"), fuigo(undefined));
    expect(first.parent.unknown).toBeTruthy();
    const second = await judge("true", first.parent, fuigo("/srv/export"));
    expect(second.start.source).toBe("fuigo");
    expect(folders(second.parent)).toEqual(["/srv/export", "/w"]);
    expect(second.parent.unknown).toBeTruthy();
    const third = await judge("cat *.json", second.parent, fuigo(undefined));
    expect(third.local.unknown).toBeTruthy();
    CARDS("cat *.json", third.rule);
  });
});

describe("R12 the snapshot key row (A section 6)", () => {
  // Base 1.0.19 (NOLIMITS-MEANS-IT 2.3): on a clean owner turn a gate file runs and is recorded by its row, so the snapshot
  // row is proven by that record; a marked turn (outside content read) still cards.
  it.each(["echo x >> ~/.claude/shell-snapshots/snapshot-bash-1-a.sh", "ls ~/.claude/shell-snapshots/"])("holds by its row at No limits on a clean owner turn: %s (M31, M31b)", command => {
    expect(owner(command)).toMatchObject({ approve: null, source: "sensitive-guard" });
    const marked = autoVerdict(bot, "Bash", command, { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: undefined, commandText: command, globExpansionRule: null });
    expect(marked.approve).toBeNull();
  });
});

describe("A2 counts (A section 5)", () => {
  it("counts proof and floor calls per driver by cause, value-free", async () => {
    const before = shellStartCounts();
    await judge("ls", state("/w"), claude());
    await judge("ls", state("/w"), fuigo("/w", { version: "1.0.37" }));
    const after = shellStartCounts();
    expect((after.get("claude:claude") ?? 0) - (before.get("claude:claude") ?? 0)).toBe(1);
    expect((after.get("fuigo:fuigo-old") ?? 0) - (before.get("fuigo:fuigo-old") ?? 0)).toBe(1);
    for (const key of after.keys()) expect(key).toMatch(/^[a-z]+:[a-z-]+$/);
  });
});

// Owner / MurageMain dot-match ruling (8 Nov): dot matching is ON for the floor (Claude Code) and Codex calls;
// P-CLAUDE follows its proof (GLOBIGNORE), P-FUIGO its field (missing = on). /c holds only `.credentials.json`.
describe("DOT: dot matching per engine (owner ruling; mutants MD1 floor default off, MD2 Codex proof off, MD3 Fuigo missing off, MD4 Claude follows GLOBIGNORE)", () => {
  it("DOT-FLOOR: a floor (Claude Code, no proof) call `cat *.json` in {/c} CARDS", async () => {
    const result = await judge("cat *.json", state("/c"), { driver: "claude" });
    expect(result.start.source).toBe("record");
    CARDS("cat *.json", result.rule);
  });
  it("DOT-CODEX: a Codex params.cwd /c call `cat *.json` CARDS", async () => {
    const result = await judge("cat *.json", state("/w"), { driver: "codex", namedCwd: "/c" });
    expect(result.start).toMatchObject({ source: "codex-cwd", dotglob: true });
    CARDS("cat *.json", result.rule);
  });
  it("DOT-CLAUDE-GLOBIGNORE: P-CLAUDE with GLOBIGNORE in the map, `cat *.json` in /c CARDS", async () => {
    const result = await judge("cat *.json", state("/w"), claude({ cwd: "/c", globignore: true }));
    expect(result.start).toMatchObject({ source: "claude", dotglob: true });
    CARDS("cat *.json", result.rule);
  });
  it("DOT-CLAUDE-PLAIN: P-CLAUDE without GLOBIGNORE is still dot ON (the shell snapshot may set dotglob): `cat *.json` in /c CARDS", async () => {
    const result = await judge("cat *.json", state("/w"), claude({ cwd: "/c" }));
    expect(result.start).toMatchObject({ source: "claude", dotglob: true });
    CARDS("cat *.json", result.rule);
  });
  it("DOT-FUIGO-MISSING: P-FUIGO with no dotglob field means on: `cat *.json` in /c CARDS", async () => {
    const result = await judge("cat *.json", state("/w"), fuigo("/c"));
    expect(result.start).toMatchObject({ source: "fuigo", dotglob: true });
    CARDS("cat *.json", result.rule);
  });
  it("DOT-FUIGO-OFF: P-FUIGO with dotglob false: `cat *.json` in /c stays QUIET", async () => {
    const result = await judge("cat *.json", state("/w"), fuigo("/c", { dotglob: false }));
    expect(result.start).toMatchObject({ source: "fuigo", dotglob: false });
    QUIET("cat *.json", result.rule);
  });
});
