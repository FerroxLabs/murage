// The normal gate uses a synthetic corpus. X3_REPLAY_CORPUS selects the frozen
// 9,300-command rh3 fixture; results contain counts and indices, never commands.
import { readFileSync, writeFileSync } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { expect, it, vi } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs, K_CARD_RULE, noLimitsFacts, P5_CARD_PREFIX } from "./auto-approve.ts";
import { claudeExecProof, type ShellProofFacts } from "./shell-proof.ts";
import type { ShellCwdState } from "../shared/sensitive-globs.ts";

interface Row { i: number; command: string; thread: string; provider: string; tool: string }
const fixture: Row[] = ["ls *", "cat README*", "cat *.ts", "cat docs/old/*.json", "cd /missing && ls *.ts", "cd /w; true", "cat *", 'cd "$D"; cat README*']
  .map((command, i) => ({ i, command, thread: "fixture", provider: "fixture", tool: "Bash" }));
const home: Record<string, string[]> = {
  "/home/replay": [".ssh/", ".aws/"], "/home/replay/.ssh": ["id_rsa", "archive/"],
  "/home/replay/.ssh/archive": ["README-key"], "/home/replay/.aws": ["credentials"],
};
function replayFs(mode: "normal" | "mapped", tree?: string): CredentialGlobFs {
  const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
  const synthetic = (path: string): string[] | undefined => home[path] ?? (!tree && (path === "/tree" || path === "/w") ? ["README.md", "a.ts", "docs/"] : undefined);
  const syntheticFile = (path: string) => synthetic(posix.dirname(path))?.includes(posix.basename(path));
  const diskPath = (path: string) => {
    if (!tree || !(path === "/tree" || path.startsWith("/tree/"))) throw absent();
    const actual = resolve(tree, "." + path.slice(5));
    if (actual !== resolve(tree) && !actual.startsWith(resolve(tree) + sep)) throw absent();
    return actual;
  };
  return {
    realpath: async path => {
      path = posix.normalize(path);
      if (synthetic(path) || syntheticFile(path) || ["/", "/home"].includes(path)) return path;
      try {
        const actual = await realpath(diskPath(path));
        if (actual !== resolve(tree!) && !actual.startsWith(resolve(tree!) + sep)) throw absent();
        return "/tree" + actual.slice(resolve(tree!).length).split(sep).join("/");
      } catch (error) {
        if (mode === "mapped" && ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code))) return "/tree";
        throw error;
      }
    },
    opendir: async path => {
      const entries = synthetic(path);
      if (!entries) return opendir(diskPath(path), { bufferSize: 1 });
      let i = 0;
      return { read: async () => {
        const entry = entries[i++];
        return entry === undefined ? null : { name: entry.replace(/\/$/, ""), isDirectory: () => entry.endsWith("/"), isSymbolicLink: () => false };
      }, close: async () => {} };
    },
  };
}

it("r5 replay: both placement modes preserve No limits and report bounded findings", async () => {
  const corpus = process.env.X3_REPLAY_CORPUS;
  // Replay the current launch contract: the Bash-class wrapper starts each call
  // at its handed folder. The historical floor profile remains reproducible;
  // it must never borrow this proof for an unverified driver or existing shell.
  const profile = process.env.X3_REPLAY_PROFILE === "floor" ? "floor" : "wrapper";
  const wrapperProof = claudeExecProof("MURAGE_EXEC_CWD=/tree\0MURAGE_EXEC_SHELL=/bin/bash\0MURAGE_EXEC_PROVEN=1\0", null);
  const rows: Row[] = corpus ? readFileSync(corpus, "utf8").trim().split("\n").map(line => JSON.parse(line)) : fixture;
  const baseline: Array<{ hold: number }> | undefined = process.env.X3_REPLAY_BASELINE
    ? readFileSync(process.env.X3_REPLAY_BASELINE, "utf8").trim().split("\n").map(line => JSON.parse(line)) : undefined;
  if (corpus) { expect(rows).toHaveLength(9300); expect(rows.filter(row => /[*?]/.test(row.command))).toHaveLength(2847); }
  if (baseline) expect(baseline).toHaveLength(rows.length);
  const currentBase: typeof import("./auto-approve.ts") | undefined = process.env.X3_REPLAY_CURRENT_BASE
    ? await import(/* @vite-ignore */ process.env.X3_REPLAY_CURRENT_BASE) : undefined;
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const reports: unknown[] = [];
  try {
    for (const mode of ["normal", "mapped"] as const) {
      const fs = replayFs(mode, process.env.X3_REPLAY_TREE);
      const states = new Map<string, ShellCwdState>();
      const times: number[] = [], added: number[] = [], addedReasons: unknown[] = [], oldPolicyAdded: Array<{ i: number; glob: boolean; source: string; rule: string }> = [];
      const cannot: Record<string, number> = {}, ioFailures: Record<string, number> = {}, p5: Record<string, number> = {}, findings: Record<string, number> = {}, unknown: Record<string, number> = {}, ks: Record<string, number> = {};
      const trackedFs: CredentialGlobFs = {
        realpath: async path => { try { return await fs.realpath(path); } catch (error) {
          const code = String((error as { code?: unknown }).code ?? "EUNKNOWN"); ioFailures[code] = (ioFailures[code] ?? 0) + 1; throw error;
        } },
        opendir: async path => { try { return await fs.opendir(path); } catch (error) {
          const code = String((error as { code?: unknown }).code ?? "EUNKNOWN"); ioFailures[code] = (ioFailures[code] ?? 0) + 1; throw error;
        } },
      };
      let newNonGlob = 0;
      for (const row of rows) {
        const key = JSON.stringify([row.provider, row.thread]);
        const start = performance.now();
        const proof: ShellProofFacts = profile === "wrapper" && ["claudeAgent", "fixture"].includes(row.provider)
          ? { driver: "claude", claude: { mode: "murage-exec", exec: wrapperProof } }
          : profile === "wrapper" ? { driver: row.provider === "fuigoAgent" ? "fuigo" : "other" } : {};
        const prepared = await prepareShellJudgement(row.command, states.get(key) ?? { targets: new Map([["/tree", "synthetic recorded spawn"]]) }, { fs: trackedFs, home: "/home/replay", ...proof });
        times.push(performance.now() - start); states.set(key, prepared.parent);
        if (prepared.local.unknown) {
          const cause = prepared.local.unknown.includes("timed out") ? "deadline" : prepared.local.unknown.includes("32") ? "cap" : "directory-effect";
          const byCause = `${row.provider}:${cause}`; unknown[byCause] = (unknown[byCause] ?? 0) + 1;
          if (prepared.rule?.startsWith(P5_CARD_PREFIX)) p5[byCause] = (p5[byCause] ?? 0) + 1;
        }
        if (prepared.rule === K_CARD_RULE) ks[key] = (ks[key] ?? 0) + 1;
        for (const expansion of prepared.expansions) {
          if (expansion.outcome.code) cannot[expansion.outcome.code] = (cannot[expansion.outcome.code] ?? 0) + 1;
          if (expansion.outcome.cards) findings[expansion.outcome.kind] = (findings[expansion.outcome.kind] ?? 0) + 1;
        }
        const verdict = autoVerdict({ id: "x3-replay", autoApprove: true, fullAccess: true, noLimits: true }, row.tool, row.command, {
          fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null, stopLine: null, commandText: row.command, commandCwd: "/tree",
          shellCwdPrepared: true, globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome),
        });
        const oldPolicyAllow = baseline ? baseline[row.i]?.hold === 0 : true;
        const baseVerdict = currentBase?.autoVerdict({ id: "x3-replay", autoApprove: true, fullAccess: true, noLimits: true }, row.tool, row.command,
          { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null, stopLine: null, commandText: row.command, commandCwd: "/tree" });
        if (verdict.approve === null && oldPolicyAllow) oldPolicyAdded.push({ i: row.i, glob: /[*?]/.test(row.command), source: verdict.source, rule: verdict.rule ?? "" });
        if (verdict.approve === null && (baseVerdict ? baseVerdict.approve !== null : oldPolicyAllow)) {
          if (/[*?]/.test(row.command)) added.push(row.i); else newNonGlob++;
          addedReasons.push({ i: row.i, n2: noLimitsFacts(verdict)?.n2 ?? false,
            class: prepared.rule === K_CARD_RULE ? "K" : prepared.rule?.startsWith(P5_CARD_PREFIX) ? "U" : prepared.expansions.find(x => x.outcome.cards)?.outcome.kind ?? "legacy",
            rows: prepared.expansions.filter(x => x.outcome.cards).map(x => ({ row: x.outcome.rowId, code: x.outcome.code })) });
        }
      }
      times.sort((a, b) => a - b);
      reports.push({ mode, profile, commands: rows.length, oldPolicyAdded, newGlobCards: added.length, newNonGlob, addedIndices: added, addedReasons, cannot, ioFailures, findings,
        unknownByDriverAndCause: unknown, p5ByDriverAndCause: p5, exitStatusCommands: 0, attachedSessions: 0, kBySession: Object.values(ks), kCards: Object.values(ks).reduce((a, b) => a + b, 0), cappedSessions: Object.keys(ks).length,
        p50: times[Math.floor(times.length * .5)], p99: times[Math.floor(times.length * .99)] });
      if (process.env.X3_REPLAY_REPORT) writeFileSync(process.env.X3_REPLAY_REPORT, JSON.stringify(reports, null, 2));
      expect.soft(newNonGlob).toBe(0);
      expect.soft(added.length).toBeLessThanOrEqual(corpus ? 14 : 0);
    }
  } finally { log.mockRestore(); }
  if (process.env.X3_REPLAY_REPORT) writeFileSync(process.env.X3_REPLAY_REPORT, JSON.stringify(reports, null, 2));
  console.info(JSON.stringify({ synthetic: !corpus, reports }));
}, 1_800_000);
