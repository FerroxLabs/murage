import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFlagPath, readExecFlag } from "./drivers/murage-exec.ts";
import { readClaudeExecProof } from "./shell-proof.ts";
import { describe, expect, it } from "vitest";
import { shellGlobWords } from "./x3-glob-words.ts";
import { autoVerdict, GLOB_BUDGET_WORDS, K_CARD_RULE, P5_CARD_PREFIX, SHELL_DEADLINE_CARD_RULE, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";

const initial = () => ({ targets: new Map([["/fixture", "spawn"]]) });
const fs: CredentialGlobFs = { realpath: async path => path, opendir: async () => ({ read: async () => null, close: async () => {} }) };
for (const token of ["/*", "/**"]) for (const noLimits of [false, true])
  it(`X3 root fixture ${noLimits ? "No limits runs" : "Full access cards"}: cat ${token}`, async () => {
    const opened: string[] = [];
    const rootFs: CredentialGlobFs = { realpath: async path => path, opendir: async path => {
      opened.push(path);
      if (path !== "/") throw new Error(`Unexpected fixture directory: ${path}`);
      const names = ["credentials.json", "README.md"];
      return { read: async () => {
        const name = names.shift();
        return name === undefined ? null : { name, isDirectory: () => false, isSymbolicLink: () => false };
      }, close: async () => {} };
    } };
    const command = `cat ${token}`;
    const prepared = await prepareShellJudgement(command, initial(), { fs: rootFs });
    expect(opened).toEqual(["/"]);
    expect(prepared.expansions).toHaveLength(1);
    expect(prepared.expansions[0]).toMatchObject({ available: true, witness: "/credentials.json", outcome: { kind: "witness", cards: true } });
    expect(prepared.rule).not.toBeNull();
    const owner = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null,
      commandText: command, commandCwd: "/fixture", shellCwdPrepared: true, globExpansionRule: prepared.rule };
    const bot = { autoApprove: true, fullAccess: true, noLimits };
    const verdict = autoVerdict(bot, "Bash", command, owner);
    expect(verdict.approve !== null).toBe(noLimits);
    expect(verdict.source).toBe(noLimits ? "no-limits" : "sensitive-guard");
    if (noLimits) expect(autoVerdict(bot, "Bash", "rm -rf /", { ...owner, commandText: "rm -rf /", globExpansionRule: null }).approve).toBeNull();
  });

for (const [name, command, options] of [
  ["recursion limit", "cat fixture-*", { depth: 9 }],
  ["nested local shells", "eval ".repeat(10) + "cat fixture-*", {}],
  ["lexer error", "cat fixture-* '", {}],
  ["lexer error in a payload", 'bash -c "cat fixture-* \'"', {}],
  ["lexer error in a substitution", "printf '%s' $(cat fixture-* ')", {}],
] as const) it(`X3 incomplete: ${name} cannot report a clean word list`, async () => {
  expect(shellGlobWords(command, options).incomplete).toBe(true);
  if ("depth" in options) return;
  const prepared = await prepareShellJudgement(command, initial(), { fs });
  expect(prepared.rule).toBe(GLOB_BUDGET_WORDS);
  const context = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null,
    commandText: command, commandCwd: "/fixture", shellCwdPrepared: true, globExpansionRule: prepared.rule };
  expect(autoVerdict({ autoApprove: true, fullAccess: true }, "Bash", command, context).approve).toBeNull();
  expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: true }, "Bash", command, context).approve).not.toBeNull();
});

for (const [name, word] of [
  ["parameter alternatives before a glob suffix", "${a:-x}".repeat(9) + "*"],
  ["brace alternatives before a glob suffix", "{a,b}".repeat(10) + "*"],
  ["parameter alternatives inside a local shell payload", "bash -c 'cat " + "${a:-x}".repeat(9) + "*'"],
  ["parameter alternatives inside command substitution", "$(cat " + "${a:-x}".repeat(9) + "*)"],
] as const) it(`X3 cap: ${name} reports incomplete checking`, async () => {
  const command = word.startsWith("bash ") ? word : "cat " + word;
  expect((shellGlobWords(command) as { incomplete?: boolean }).incomplete).toBe(true);
  const prepared = await prepareShellJudgement(command, initial(), { fs });
  expect(prepared.rule).toBe(GLOB_BUDGET_WORDS);
  const context = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null,
    commandText: command, commandCwd: "/fixture", shellCwdPrepared: true, globExpansionRule: prepared.rule };
  const bot = { autoApprove: true, fullAccess: true, noLimits: true };
  expect(autoVerdict(bot, "Bash", command, context).approve).not.toBeNull();
  expect(autoVerdict({ ...bot, noLimits: false }, "Bash", command, context).approve).toBeNull();
});
it("X3 cap: exactly 256 alternatives retain the final glob suffix", () => {
  const words = shellGlobWords("cat " + "${a:-x}".repeat(8) + "*");
  expect((words as { incomplete?: boolean }).incomplete).not.toBe(true);
  expect(words).toHaveLength(256);
  expect(words.every(word => word.token.endsWith("*"))).toBe(true);
});
it("X3 English inventory includes the current card strings and wrapper refusals", () => {
  const path = new URL("../docs/verification/x3-english-strings.md", import.meta.url);
  expect(existsSync(path)).toBe(true);
  const inventory = readFileSync(path, "utf8");
  for (const text of [K_CARD_RULE, P5_CARD_PREFIX, GLOB_BUDGET_WORDS, SHELL_DEADLINE_CARD_RULE,
    "too many file patterns to check", "Murage could not confirm the folder this command starts in, so it did not run it; the next try is checked the slow way",
    "shell folder lookup could not finish", "managed settings", "MURAGE_EXEC_", "unreadable", "shape"]) expect(inventory).toContain(text);
});

it.each([
  "${a:-x}".repeat(9),
  "{a,b}".repeat(10),
  "${a:-x}".repeat(9) + "'*'",
  "${a:-x}".repeat(9) + "$(printf fixture)",
  "${a:-x}".repeat(9) + "[",
  "{[,]}" + "${a:-x}".repeat(9),
  "'['" + "${a:-x}".repeat(9) + "]",
])("X3 cap keeps non-pattern alternatives quiet: %s", async word => {
  const command = "printf '%s' " + word;
  expect(shellGlobWords(command).incomplete).not.toBe(true);
  expect((await prepareShellJudgement(command, initial(), { fs })).rule).toBeNull();
});
it("X3 cap still inspects substitutions after many non-pattern alternatives", () => {
  const words = shellGlobWords("printf '%s' " + "${a:-x}".repeat(9) + "$(cat fixture-*)");
  expect(words.incomplete).not.toBe(true);
  expect(words.find(word => word.token === "fixture-*")?.reader).toBe(true);
});
it.each(["$?", "$*"])("X3 special parameter names are not patterns: %s", async parameter => {
  const command = "printf '%s' " + "${a:-x}".repeat(9) + '"' + parameter + '"';
  expect(shellGlobWords(command).incomplete).not.toBe(true);
  expect((await prepareShellJudgement(command, initial(), { fs })).rule).toBeNull();
});

// Owners: restored matcher/witnesses — x3-restore; Full access contract — MAIN.
it.each([
  `bash -c 'echo "$*"' -- y`,
  'echo ${X:-default} ${#X} ${X%%.*}',
  'HOME=/tmp/x; cd $HOME && rm -rf *',
  'cd /etc && ls',
])("Q1 train ordinary outcome: %s", command => {
  expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: false }, "Bash", command,
    { commandText: command, stopLine: null })).toMatchObject({ approve: expect.any(String), source: "full-access" });
});
it.each(['cat ~/.qwen/settings.json', 'cat ~/.qwen/settings*.json', 'cd ~/.qwen && cat settings*.json'])(
  "Q1 literal or resolved credential operand holds: %s", command => {
    expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: false }, "Bash", command,
      { commandText: command, stopLine: null })).toMatchObject({ approve: null, source: "sensitive-guard" });
  });

it("Q4 bare home star retains the train Full access verdict", () => {
  const command = "ls ~/*";
  expect(autoVerdict({ autoApprove: true, fullAccess: true, noLimits: false, fullAccessChannelMessages: true }, "Bash", command, {
    commandText: command, commandCwd: "/tmp/fixture", workFolder: "/tmp/fixture", stopLine: null, outsideRead: null,
    fullAccessOrigin: "owner", ownerStarted: true, promptFacts: { cwd: "/tmp/fixture", home: "/home/fixture" }, unseen: { platform: "posix" },
  })).toEqual({ approve: "auto-approved Bash (full access)", source: "full-access" });
});

it("X3 review: a link whose real path cannot be resolved is CANNOT evidence, never listed", async () => {
  const linkFs: CredentialGlobFs = {
    realpath: async path => { if (path.endsWith("/fixture-link")) throw Object.assign(new Error("fixture"), { code: "EACCES" }); return path; },
    opendir: async () => { const names = ["fixture-link"]; return { read: async () => { const name = names.shift(); return name === undefined ? null : { name, isDirectory: () => false, isSymbolicLink: () => true }; }, close: async () => {} }; },
  };
  const prepared = await prepareShellJudgement("cat /fixture/*", initial(), { fs: linkFs });
  expect(prepared.expansions[0]?.outcome.kind).not.toBe("listed");
  expect(prepared.expansions[0]?.available).toBe(false);
  expect(prepared.expansions[0]?.reason).toBe("EACCES");
});
describe("X3 review: the refusal flag is read from a fixed window", () => {
  const dir = mkdtempSync(join(tmpdir(), "x3-flag-"));
  const env = (name: string) => join(dir, name);
  it("a refusal at the head is read exactly", () => {
    writeFileSync(execFlagPath(env("a")), "reason=shape shape=9\n" + "reason=shape shape=1\n".repeat(100_000));
    expect(readExecFlag(env("a"))).toEqual({ reason: "shape", shape: "9" });
    writeFileSync(env("a"), "MURAGE_EXEC_CWD=/w\0MURAGE_EXEC_PROVEN=1\0");
    expect(readClaudeExecProof(env("a"))?.refused).toBe(true);
  });
  it("a long flag whose head holds no refusal line still fails closed", () => {
    writeFileSync(execFlagPath(env("b")), " ".repeat(8192) + "reason=shape shape=9\n");
    expect(readExecFlag(env("b"))).toEqual({ reason: "unreadable", shape: "0" });
    writeFileSync(env("b"), "MURAGE_EXEC_CWD=/w\0MURAGE_EXEC_PROVEN=1\0");
    expect(readClaudeExecProof(env("b"))?.refused).toBe(true);
  });
  it("no flag file is no refusal", () => {
    expect(readExecFlag(env("none"))).toBeNull();
  });
});
