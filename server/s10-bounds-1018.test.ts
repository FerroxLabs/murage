// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10): the verdict stays synchronous, so the walker's work is bounded by counts, never by the clock: the same text
// always gets the same answer. Past a bound the reader could not follow the text, which asks wherever could-not-read asks.
// Each bound has a row just inside it and a row past it, and a wipe command past it is never let through. Fixture strings are
// inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict, looksDestructive } = await import("./auto-approve.ts");
const { alwaysAskUnreadableReason } = await import("./always-ask.ts");
const { MAX_COMMAND_SEPARATORS, overCommandBudget, pinOverrideIn } = await import("../shared/prompt-capable.ts");
const { SENSITIVE_PATHS, SENSITIVE_TEXT } = await import("../shared/sensitive-paths.ts");
const { approvalSummary } = await import("../shared/approval-summary.ts");

const AUTO = { autoApprove: true };
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null } as const;
const verdictAt = (bot: object, command: string, extra: object = {}) => autoVerdict(bot as never, "shell", approvalSummary(command), { ownerStarted: true, exactCommand: { command } as never, ...extra } as never);
const owner = (command: string) => verdictAt(NO_LIMITS, command, OWNER);
const reason = (command: string) => alwaysAskUnreadableReason(command) ?? "";
const WIPE = "rm -rf ~";

/** Each row: a text just inside the bound, the same shape past it, and the words the reader's stop carries. */
const names = (count: number) => Array.from({ length: count }, (_, k) => `x${k}=1;`).join("");
const files = (count: number) => Array.from({ length: count }, (_, k) => `echo a > f${k};`).join("");
const doubling = (count: number) => `x=a;${"x=$x$x;".repeat(count)}echo $x`;
const BOUNDS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["separators", "a\n".repeat(MAX_COMMAND_SEPARATORS - 1), "a\n".repeat(MAX_COMMAND_SEPARATORS + 1), "budget: more commands"],
  ["names before a branch", `${names(500)}(a)`, `${names(520)}(a)`, "budget: more names or files"],
  ["files before a branch", `${files(500)}(a)`, `${files(520)}(a)`, "budget: more names or files"],
  ["files before an interpreter", `${files(500)}sh run`, `${files(520)}sh run`, "budget: more names or files"],
  ["wrappers", `${"env ".repeat(60)}echo hi`, `${"env ".repeat(70)}echo hi`, "budget: more wrappers"],
  ["a value's parts", doubling(8), doubling(14), "expansion: a value too long"],
];

describe("every bound on the reader's work", () => {
  it.each(BOUNDS)("%s: just inside it the reader still reads", (_name, within, _past, words) => {
    expect(reason(within)).not.toContain(words);
  });
  it.each(BOUNDS)("%s: past it the reader says it could not follow, in its own words", (_name, _within, past, words) => {
    expect(reason(past)).toContain(words);
  });
  it.each(BOUNDS)("%s: past it asks at Auto", (_name, _within, past) => {
    const verdict = verdictAt(AUTO, past);
    expect(verdict.approve, JSON.stringify(verdict.source)).toBeNull();
  });
  it.each(BOUNDS)("%s: a wipe command after a harmless prefix past it never runs on an owner No limits turn", (_name, _within, past) => {
    const verdict = owner(`${past};${WIPE}`);
    expect(verdict.approve, JSON.stringify(verdict.source)).toBeNull();
  });
  it("the wipe list reads a wipe past the walker's budget by its name, on the same owner turn", () => {
    const verdict = owner(`${"a\n".repeat(MAX_COMMAND_SEPARATORS + 1)}${WIPE}`);
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("always-ask");
  });
  it("counts a separator wherever it stands, so quoting does not buy more commands", () => {
    expect(overCommandBudget(`echo '${"a;".repeat(MAX_COMMAND_SEPARATORS + 1)}'`)).toBe(true);
    expect(overCommandBudget(`echo '${"a;".repeat(MAX_COMMAND_SEPARATORS)}'`)).toBe(false);
    expect(overCommandBudget("a".repeat(256 * 1024))).toBe(false);
  });
});

describe("the deny rows read a long run of their first word in time with its length", () => {
  const envGrep = SENSITIVE_TEXT.find((row) => row.id === "env-grep")!.re;
  it.each([
    ["env | grep KEY", true], ["env env | grep KEY", true], ["env a b | grep KEY", true], ["env a; env b | grep KEY", true],
    ["printenv | grep KEY", false], ["env a; | grep KEY", false], ["env a && echo b | grep KEY", false], ["environment | grep KEY", false],
  ] as const)("env-grep reads %s as it always did", (text, hit) => {
    expect(envGrep.test(text)).toBe(hit);
  });
  it.each([
    ["dd if=a of=/dev/sda", true], ["dd dd of=/dev/sda", true], ["dd if=a dd of=/dev/sda", true], ["dd if=a | x of=/dev/sda", false], ["dd if=a of=b", false], ["add of=/dev/sda", false],
  ] as const)("the disk row reads %s as it always did", (text, hit) => {
    expect(looksDestructive(text)).toBe(hit);
  });
  it.each([
    ["env-grep", () => envGrep.test("env ".repeat(32_000))],
    ["env-grep with a pipe at the end", () => envGrep.test(`${"env ".repeat(32_000)};| grep`)],
    ["the disk row", () => looksDestructive("dd if=a of=b;".repeat(10_000))],
  ] as const)("%s on 128 KB is far from the minutes it took", (_name, run) => {
    const started = performance.now();
    run();
    // the old pattern's square costs about 100 s here; this margin is for a loaded test box
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("the other rows with a long reach read the same matches, in time with their length", () => {
  const row = (id: string) => [...SENSITIVE_TEXT, ...SENSITIVE_PATHS].find((each) => each.id === id)!.re;
  const fuigoRow = SENSITIVE_PATHS.find((each) => each.re.source.includes("FUIGO_HOME"))!.re;
  const sshRow = SENSITIVE_PATHS.find((each) => each.re.source.includes("id_ecdsa"))!.re;
  it.each([
    ["cat ~/.fuigo/config.toml", true], ["FUIGO_HOME=x FUIGO_HOME=y; cat requirements.toml", true], ["cd .fuigo && cd .fuigo && printf x >> sandbox.toml", true], ["config.toml then FUIGO_HOME", true], ["sandbox.toml config.toml and .fuigo", true],
    [".fuigo/sessions/a/permission-1.toml", true], [".fuigo/x.toml", false], [".fuigo-old/config.toml", false], [".fuigo/config.tomlx", false], ["config.toml alone", false],
  ] as const)("the Fuigo home row reads %s as it always did", (text, hit) => {
    expect(fuigoRow.test(text)).toBe(hit);
  });
  it.each([
    ["Command Processor x AutoRun", true], ["Command Processor Command Processor\nAutoRun", true], ["Command Processor x", false],
  ] as const)("the AutoRun row reads %s as it always did", (text, hit) => {
    expect(row("cmd-autorun").test(text)).toBe(hit);
  });
  it.each([
    ["git push origin --force", true], ["git push git push --force", true], ["git push a | x --force", false], ["git push a", false], ["git reset --hard", true],
    [":(){ :|:& };:", true], [":(){ :(){ a };:", true], [":(){ a", false],
    ["echo; Remove-Item -Force a", true], ["ri ri -r a", true], ["ri a b -r", true], ["ri a; b -r", false], ["del /s a", true], ["del del /s a", true], ["(del x /s)", true], ["remove-item x", false],
  ] as const)("the deny rows read %s as they always did", (text, hit) => {
    expect(looksDestructive(text)).toBe(hit);
  });
  it.each([
    ["Fuigo home, one direction", () => fuigoRow.test("FUIGO_HOME ".repeat(12_000))],
    ["Fuigo home, the other", () => fuigoRow.test("config.toml ".repeat(11_000))],
    ["a long permission word", () => fuigoRow.test(`.fuigo ${"permission".repeat(13_000)}`)],
    ["AutoRun", () => row("cmd-autorun").test("Command Processor ".repeat(7_000))],
    ["a key folder word", () => sshRow.test(".ssh/".repeat(26_000))],
    ["git push", () => looksDestructive("git push ".repeat(14_000))],
    ["fork bomb", () => looksDestructive(":(){ ".repeat(26_000))],
    ["the delete row", () => looksDestructive("rm ".repeat(43_000))],
    ["the delete row's other words", () => looksDestructive("rd ".repeat(43_000))],
  ] as const)("%s on 128 KB is far from the minutes it took", (_name, run) => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("the pin reader keeps one list of names for a run of export and unset", () => {
  const pins = new Map([["PAGER", "cat"]]);
  it("an export and a later one still reach the command after them", () => {
    expect(pinOverrideIn("export PAGER=other; export A=1; git log", pins)).not.toBeNull();
    expect(pinOverrideIn("export A=1; export PAGER=other; git log", pins)).not.toBeNull();
  });
  it("what one text's exports leave never reaches the next text", () => {
    expect(pinOverrideIn("export A=1; export B=2; echo hi", pins)).toBeNull();
    expect(pinOverrideIn("git log", pins)).toBeNull();
  });
  it("unset -f leaves the names as they were", () => {
    expect(pinOverrideIn("export PAGER=other; unset -f PAGER; git log", pins)).not.toBeNull();
  });
  it("a long run costs its length", () => {
    const text = Array.from({ length: 20_000 }, (_, k) => `export x${k}=1;`).join("");
    const started = performance.now();
    pinOverrideIn(text, pins);
    // one copy of the list per export is 200,000,000 entries here, about a minute; this margin is for a loaded test box
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
