import { describe, expect, it } from "vitest";
import * as AA from "./auto-approve.ts";
import { ShellSessionRegistry } from "./shell-session-state.ts";
import type { AutoContext, CredentialGlobFs } from "./auto-approve.ts";

const tree = (names: string[]): CredentialGlobFs => ({
  realpath: async path => path,
  opendir: async () => {
    let at = 0;
    return { read: async () => {
      const name = names[at++];
      return name === undefined ? null : { name, isDirectory: () => false, isSymbolicLink: () => false };
    }, close: async () => {} };
  },
});
const owner = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const noLimits = { id: "x3-port", autoApprove: true, fullAccess: true, noLimits: true };

describe("l4 X3 findings and final policy are separate", () => {
  it.each(["credentials.json", "murage-hook.mjs"])("%s: mode/origin matrix and N2 metadata", async name => {
    const command = "cat *";
    const prepared = await AA.prepareShellJudgement(command, { targets: new Map([["/w", "spawn"]]) }, { fs: tree([name]) });
    expect(prepared.rule).toBeTruthy();
    const context: AutoContext = { ...owner, commandText: command, commandCwd: "/w", shellCwdPrepared: true,
      globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome) };
    for (const [mode, bot, origin] of [
      ["Auto", { ...noLimits, fullAccess: false, noLimits: false }, "owner"],
      ["Full", { ...noLimits, noLimits: false }, "owner"],
      ["No limits owner", noLimits, "owner"],
      ["No limits other", noLimits, "other"],
    ] as const) {
      const verdict = AA.autoVerdict(bot, "Bash", command, { ...context, fullAccessOrigin: origin });
      expect(verdict.approve !== null, mode).toBe(mode === "No limits owner");
      if (mode === "No limits owner" && name === "murage-hook.mjs") expect(AA.noLimitsFacts(verdict)).toEqual({ initiator: "owner", n2: false });
    }
  });
  it("an earlier unreadable finding cannot hide an expanded hook path", async () => {
    const prepared = await AA.prepareShellJudgement("cat *", { targets: new Map([["/w", "spawn"]]) }, { fs: tree(["credentials.json", "murage-hook.mjs"]) });
    const verdict = AA.autoVerdict(noLimits, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
      globExpansionRule: "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) });
    expect(verdict.approve).not.toBeNull();
  expect(AA.autoVerdict({ ...noLimits, noLimits: false }, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule || "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) }).approve).toBeNull();
    expect(AA.noLimitsFacts(verdict)?.n2).toBe(false);
  });
  it.each(["cat *", "ls *.md"])("unknown ordinary glob %s runs under owner No limits", async command => {
    const prepared = await AA.prepareShellJudgement(command, { targets: new Map(), unknown: "no bound incarnation" }, { fs: tree([]) });
    expect(prepared.rule).toBeTruthy();
    expect(AA.autoVerdict(noLimits, "Bash", command, { ...owner, commandText: command, shellCwdPrepared: true,
      globExpansionRule: prepared.rule }).approve).not.toBeNull();
  });
});

describe("l4 descriptor destinations", () => {
  it.each(["ls .ss?/* &>names >&2", "ls .ss?/* 2>names >&2", "ls .ss?/* 2>&1 >&2 | xargs cat", "ls .ss?/* | sort | xargs cat"])("reader: %s", command => {
    expect(AA.shellGlobWords(command).find(word => word.token === ".ss?/*")?.reader).toBe(true);
  });
  it.each(["ls .ss?/* >&2", "ls .ss?/* 2>errors", "ls .ss?/* | sort -r | head -n 3"])("bare: %s", command => {
    expect(AA.shellGlobWords(command).find(word => word.token === ".ss?/*")?.reader).toBe(false);
  });
});


it("l4 P1: a semicolon list cannot propose a replacement", async () => {
  const prepared = await AA.prepareShellJudgement("cd /w; true", { targets: new Map(), unknown: "prior dynamic cd" }, { fs: tree([]) });
  expect(prepared.replacement).toBeUndefined();
  expect(prepared.parent.unknown).toBeTruthy();
});
it("l4 owner-shadowed cd has no builtin proof on an unverified driver", async () => {
  const prepared = await AA.prepareShellJudgement("cd /w && cat *", { targets: new Map([["/w", "spawn"]]) }, { driver: "other", fs: tree([]) });
  expect(prepared.replacement).toBeUndefined();
  expect(prepared.local.unknown).toBeTruthy();
  expect(prepared.rule).toBeTruthy();
});
it("r5 POSIX dot rule on a known plain bash start", async () => {
  const prepared = await AA.prepareShellJudgement("cat *", { targets: new Map([["/w", "spawn"]]) }, { fs: tree([".env"]) });
  expect(prepared.rule).toBeNull();
});


it("r5 P6: dequoted link operands are checked by preparation itself", async () => {
  const prepared = await AA.prepareShellJudgement("ln -s ~/.s'sh' k && cd k && cat *", { targets: new Map([["/w", "spawn"]]) }, { home: "/home/me", fs: tree([]) });
  expect(prepared.rule).toBeTruthy();
  expect(prepared.rule).toContain("\\.ssh");
});
it("r5 P1: denied execution cannot replace the ssh starting place", async () => {
  const registry = new ShellSessionRegistry();
  const identity = { thread: "t", provider: "p", native: "n", incarnation: 1 };
  registry.launch("g", { ...identity, identity }); registry.accept("g", "T", "/home/me/.ssh");
  const record = registry.select("t", "p", "T")!;
  const seq = registry.claim(record);
  const prepared = await AA.prepareShellJudgement("cd /w && ls", registry.snapshot(record), { fs: tree([]) });
  registry.publish(record, prepared.parent, seq);
  expect(prepared.replacement).toBeDefined();
  registry.propose(record, "T", "denied", prepared.replacement!);
  registry.completeRequest("t", "p", "T", "denied", undefined);
  expect(record.state.targets.has("/home/me/.ssh")).toBe(true);
  const next = await AA.prepareShellJudgement("cat *", registry.snapshot(record), { fs: tree(["id_rsa"]) });
  expect(next.rule).toBeTruthy();
});
it("l4: a linked ordinary name transports its real hook witness past a cut-input finding", async () => {
  const fs = tree(["alias"]);
  fs.realpath = async path => path.endsWith("/alias") ? "/w/murage-hook.mjs" : path;
  fs.opendir = async () => {
    let read = false;
    return { read: async () => read ? null : (read = true, { name: "alias", isDirectory: () => false, isSymbolicLink: () => true }), close: async () => {} };
  };
  const prepared = await AA.prepareShellJudgement("cat *", { targets: new Map([["/w", "spawn"]]) }, { fs });
  const verdict = AA.autoVerdict(noLimits, "Bash", "cat *", { ...owner, inputTruncated: true, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome) });
  expect(verdict.approve).not.toBeNull();
  expect(AA.autoVerdict({ ...noLimits, noLimits: false }, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule || "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) }).approve).toBeNull();
  expect(AA.noLimitsFacts(verdict)?.n2).toBe(false);
});
it("r5 R3: a later dynamic cd cancels the first cd replacement", async () => {
  const prepared = await AA.prepareShellJudgement('cd /w && cd "$D"', { targets: new Map([["/w", "spawn"]]) }, { fs: tree([]) });
  expect(prepared.replacement).toBeUndefined();
  expect(prepared.parent.unknown).toBeTruthy();
  const next = await AA.prepareShellJudgement("cat *", prepared.parent, { fs: tree([]) });
  expect(next.rule).toMatch(/not known/);
});
it.each(["murage-ho''ok.mjs", "murage-hook.mjs'backup", "murage-hook.mjs'", "murage-hook.mjs\n", "murage-hook.mjs\r\n", "codex-scope\n"].map(name => [JSON.stringify(name), name] as const))("literal expansion %s is not reparsed as shell source under No limits", async (_label, name) => {
  const prepared = await AA.prepareShellJudgement("cat *", { targets: new Map([["/w/.ssh", "spawn"]]) }, { fs: tree([name]) });
  expect(prepared.rule).toBeTruthy();
  const verdict = AA.autoVerdict(noLimits, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome) });
  expect(verdict.approve).not.toBeNull();
  expect(AA.autoVerdict({ ...noLimits, noLimits: false }, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule || "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) }).approve).toBeNull();
});
it.each([["/w", "'/w/*'/*"], ["/w", "'/w/[x]'/*"], ["/w", String.raw`/w/\[x\]/*`], ["/w/*", "*"]])("r5 G1: a quoted wildcard directory (cwd %s, word %s) keeps its literal bytes before a real glob", async (cwd, spelling) => {
  const names = tree(["murage-hook.mjs"]);
  const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
  const fs: CredentialGlobFs = {
    realpath: async path => { if (["/", "/w", "/w/*", "/w/[x]"].includes(path)) return path; throw absent(); },
    opendir: async path => { if (path === "/w/*" || path === "/w/[x]") return names.opendir(path); throw absent(); },
  };
  const command = `cat ${spelling}`;
  const prepared = await AA.prepareShellJudgement(command, { targets: new Map([[cwd, "spawn"]]) }, { fs });
  expect(prepared.rule).toBeTruthy();
  const verdict = AA.autoVerdict(noLimits, "Bash", command, { ...owner, commandText: command, shellCwdPrepared: true,
    globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome) });
  expect(verdict.approve).not.toBeNull();
  expect(AA.autoVerdict({ ...noLimits, noLimits: false }, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule || "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) }).approve).toBeNull();
  expect(AA.noLimitsFacts(verdict)?.n2).toBe(false);
});
it.each(["id_[r]sa", "id_?sa", "id_*sa"])("r5 W: a directory entry's brackets or wildcard bytes %s are literal, not another pattern", async name => {
  const prepared = await AA.prepareShellJudgement("cat id_r*", { targets: new Map([["/w/.ssh", "spawn"]]) }, { fs: tree([name]) });
  expect(prepared.rule).toBeNull();
});
it("r5 G1: literal encoding does not make a valid long cwd unavailable", async () => {
  const cwd = "/w/" + Array(10).fill("*".repeat(250)).join("/");
  const names = tree(["murage-hook.mjs"]);
  const fs: CredentialGlobFs = {
    realpath: async path => path,
    opendir: async path => { expect(path).toBe(cwd); return names.opendir(path); },
  };
  const prepared = await AA.prepareShellJudgement("cat *", { targets: new Map([[cwd, "spawn"]]) }, { fs });
  expect(prepared.expansions[0]?.outcome.kind).toBe("witness");
  const verdict = AA.autoVerdict(noLimits, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule, globFindings: prepared.expansions.map(result => result.outcome) });
  expect(verdict.approve).not.toBeNull();
  expect(AA.autoVerdict({ ...noLimits, noLimits: false }, "Bash", "cat *", { ...owner, commandText: "cat *", shellCwdPrepared: true,
    globExpansionRule: prepared.rule || "shell folder lookup could not finish", globFindings: prepared.expansions.map(result => result.outcome) }).approve).toBeNull();
  expect(AA.noLimitsFacts(verdict)?.n2).toBe(false);
});
