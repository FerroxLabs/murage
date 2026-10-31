// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-KEY-TEXT, the 1.0.13 cut (design section 14): real keys stay carded, false hits go. The corpus names every
// command by class; the structured calls below it are the file tools, read by role.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { commandDataRead, keyValueShapeIn, withoutProjectTemplates } from "./key-text.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";

interface Row { lane: string; class: "partA" | "covered" | "cards" | "hole"; text: string; part?: string; why?: string }
const corpus = JSON.parse(readFileSync(new URL("./fixtures/key-text-corpus-1013.json", import.meta.url), "utf8")) as { rows: Row[] };
const rows = corpus.rows.filter((row) => row.lane === "key-text");

const ASK = { autoApprove: false, alwaysAllow: [] };
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const CWD = "/work/proj";

const shellContext = (text: string, extra: Partial<AutoContext> = {}): AutoContext => ({
  exactCommand: { command: text, cwd: CWD } as AutoContext["exactCommand"],
  commandText: text,
  commandCwd: CWD,
  call: { engine: "claude", toolCall: { name: "Bash", input: { command: text } } } as GrantCall,
  ...extra,
});
const shell = (bot: typeof NO_LIMITS | typeof FULL | typeof AUTO | typeof ASK, text: string, extra: Partial<AutoContext> = {}) => autoVerdict(bot as never, "Bash", text, shellContext(text, extra));
const OUTSIDE = { fullAccessOrigin: "other" as const, unattended: true };

describe("the corpus", () => {
  it("has the rows the design names", () => {
    expect(rows.filter((row) => row.class === "partA").length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((row) => row.class === "covered").length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((row) => row.class === "cards").length).toBeGreaterThanOrEqual(100);
  });

  for (const row of rows) {
    const label = `${row.class}${row.why ? ` (${row.why})` : ""}: ${row.text}`;
    it(label, () => {
      const levels = { ask: shell(ASK, row.text), auto: shell(AUTO, row.text), full: shell(FULL, row.text), noLimits: shell(NO_LIMITS, row.text) };
      const uncovered = { full: shell(FULL, row.text, OUTSIDE), noLimits: shell(NO_LIMITS, row.text, OUTSIDE) };
      if (row.class === "cards") {
        // the reader or the unread rule may speak first; either way nothing answers it
        for (const [level, verdict] of Object.entries({ ...levels, fullOut: uncovered.full, noLimitsOut: uncovered.noLimits })) {
          expect(verdict.approve, level).toBeNull();
          expect(["sensitive-guard", "always-ask", "unread-call"], level).toContain(verdict.source);
        }
      } else if (row.class === "partA") {
        expect(levels.noLimits.approve).toBeTruthy();
        expect(levels.full.approve).toBeTruthy();
        for (const verdict of [levels.ask, levels.auto, uncovered.full, uncovered.noLimits]) expect(verdict.source).not.toBe("sensitive-guard");
      } else if (row.class === "covered") {
        expect(levels.noLimits.approve).toBeTruthy();
        expect(levels.full.approve).toBeTruthy();
        // never at Ask or Auto, never on a turn the level does not cover
        for (const verdict of [levels.ask, levels.auto, uncovered.full, uncovered.noLimits]) {
          expect(verdict.approve).toBeNull();
          expect(verdict.source).toBe("sensitive-guard");
        }
      } else {
        expect(levels.noLimits.approve).toBeTruthy();
      }
    });
  }
});

describe("value shapes reach every string at every level (A10)", () => {
  // invented, and spelled apart so nothing here reads as a key at rest
  const key = `sk-${"proj-"}${"FAKE".repeat(10)}`;
  const token = `ghp_${"FAKE".repeat(10)}`;
  const block = `-----BEGIN ${"PRIVATE"} KEY-----`;
  it("cards a token in a command, a message and a Write's content, at each level", () => {
    for (const bot of [ASK, AUTO, FULL, NO_LIMITS]) {
      expect(shell(bot, `git commit -m "rotate ${key}"`).source).toBe("sensitive-guard");
      expect(shell(bot, `echo ${token}`).source).toBe("sensitive-guard");
      const input = { file_path: `${CWD}/README.md`, content: `a ${block} line` };
      const verdict = autoVerdict(bot as never, "Write", JSON.stringify(input).slice(0, 200), { call: { engine: "claude", toolCall: { name: "Write", input } } as GrantCall });
      expect(verdict.source).toBe("sensitive-guard");
    }
  });
  it("reads a card number by its network, so a time in milliseconds is no card", () => {
    expect(keyValueShapeIn("card 4242 4242 4242 4242 here")).not.toBeNull();
    expect(keyValueShapeIn("/tmp/run_1761900000123/out.log")).toBeNull();
    expect(keyValueShapeIn("/tmp/run_1761900000131/out.log")).toBeNull();
    expect(keyValueShapeIn("channels/1234567890123456789")).toBeNull();
    expect(keyValueShapeIn("pip install sk-learn")).toBeNull();
  });
});

describe("known file tools, by field role (B1)", () => {
  const claude = (name: string, input: Record<string, unknown>, extra: Partial<AutoContext> = {}, bot: unknown = NO_LIMITS) =>
    autoVerdict(bot as never, name, JSON.stringify(input).slice(0, 200), { call: { engine: "claude", toolCall: { name, input } } as GrantCall, turnCwd: CWD, ...extra });

  it("a Write or Edit whose content names a key place runs; its path decides", () => {
    expect(claude("Write", { file_path: `${CWD}/README.md`, content: "copy .env and provider-keys, set OPENAI_API_KEY=your-key-here" }).approve).toBeTruthy();
    expect(claude("Edit", { file_path: `${CWD}/README.md`, old_string: "credentials.json", new_string: ".npmrc" }).approve).toBeTruthy();
    expect(claude("MultiEdit", { file_path: `${CWD}/README.md`, edits: [{ old_string: ".env", new_string: "~/.ssh/id_rsa" }] }).approve).toBeTruthy();
    expect(claude("Write", { file_path: `${CWD}/.env`, content: "x" }).source).toBe("sensitive-guard");
    expect(claude("Write", { file_path: `${CWD}/.husky/pre-commit`, content: "x" }).source).toBe("sensitive-guard");
    expect(claude("Write", { file_path: `${CWD}/.vscode/tasks.json`, content: "x" }).source).toBe("sensitive-guard");
    expect(claude("Edit", { file_path: `${CWD}/.git/hooks/pre-commit`, old_string: "a", new_string: "b" }).source).toBe("sensitive-guard");
  });
  it("a Read of a tooling place runs; a key place cards; a climb is judged whole", () => {
    expect(claude("Read", { file_path: `${CWD}/.vscode/tasks.json` }).approve).toBeTruthy();
    expect(claude("Read", { file_path: `${CWD}/.husky/pre-push`, limit: 10 }).approve).toBeTruthy();
    expect(claude("Read", { file_path: `${CWD}/.git/hooks/pre-commit` }).approve).toBeTruthy();
    expect(claude("Read", { file_path: `${CWD}/.env` }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: `${CWD}/.git/config` }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: `${CWD}/.git/hooks/../config` }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: "/home/ada/.gitconfig" }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: "/data/murage-exec-abc/env/1" }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: "/data/native/codex-scope/murage-hook.env" }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: "/home/ada/.fuigo/config.toml" }).source).toBe("sensitive-guard");
  });
  it("a link's real place is read", () => {
    expect(claude("Read", { file_path: `${CWD}/notes.md` }, { realPaths: ["/home/ada/.ssh/id_rsa"] }).source).toBe("sensitive-guard");
    expect(claude("Read", { file_path: `${CWD}/.vscode/tasks.json` }, { realPaths: ["/home/ada/.ssh/id_rsa"] }).source).toBe("sensitive-guard");
  });
  it("a search pattern is data; a root or a glob field chooses whose contents print", () => {
    expect(claude("Grep", { pattern: ".env", path: `${CWD}/src` }).approve).toBeTruthy();
    expect(claude("Glob", { pattern: "**/.env", path: `${CWD}/src` }).approve).toBeTruthy();
    expect(claude("Grep", { pattern: "x", path: `${CWD}/.env` }).source).toBe("sensitive-guard");
    expect(claude("Grep", { pattern: "x", glob: ".env" }).source).toBe("sensitive-guard");
    expect(claude("Grep", { pattern: "x", glob: ".env*" }).source).toBe("sensitive-guard");
    expect(claude("Grep", { pattern: "x", glob: "credentials.json" }).source).toBe("sensitive-guard");
  });
  it("a field the table does not name, or a card text not built from the input, keeps the whole read", () => {
    expect(claude("Read", { file_path: `${CWD}/a.md`, extra: ".env" }).source).toBe("sensitive-guard");
    const input = { file_path: `${CWD}/a.md`, content: "see .env" };
    expect(autoVerdict(NO_LIMITS as never, "Write", "a card that says .env", { call: { engine: "claude", toolCall: { name: "Write", input } } as GrantCall }).source).toBe("sensitive-guard");
  });
  it("at Ask, Auto and on an uncovered turn the content still reads whole", () => {
    const input = { file_path: `${CWD}/README.md`, content: "copy .env" };
    expect(claude("Write", input, {}, AUTO).source).toBe("sensitive-guard");
    expect(claude("Write", input, { fullAccessOrigin: "other", unattended: true }).source).toBe("sensitive-guard");
  });
  it("an MCP tool or a tool with another name keeps the whole read", () => {
    const input = { src: "/x/.env" };
    expect(autoVerdict(NO_LIMITS as never, "mcp__files__copy", "copy", { call: { engine: "claude", toolCall: { name: "mcp__files__copy", input } } as GrantCall }).approve).toBeNull();
    const shaped = { file_path: `${CWD}/a.md`, content: "see .env" };
    expect(autoVerdict(NO_LIMITS as never, "Write", "x", { call: { engine: "codex", toolCall: { name: "Write", input: shaped } } as GrantCall }).source).toBe("sensitive-guard");
  });
  it("Pi's own tools, by Pi's own fields", () => {
    const pi = (tool: string, name: string, input: Record<string, unknown>, summary: string) => autoVerdict(NO_LIMITS as never, tool, summary, { call: { engine: "pi", toolCall: { name, input } } as GrantCall });
    expect(pi("Write", "write", { path: "README.md", content: "see .env" }, "Write README.md").approve).toBeTruthy();
    expect(pi("Write", "write", { path: ".env", content: "x" }, "Write .env").source).toBe("sensitive-guard");
    expect(pi("read", "read", { path: ".vscode/tasks.json" }, "pi wants to use read").approve).toBeTruthy();
    expect(pi("read", "read", { path: ".env" }, "pi wants to use read").source).toBe("sensitive-guard");
  });
  it("an ACP edit or read by its kind; the title stays in the read", () => {
    const acp = (toolKind: string, input: Record<string, unknown>, title: string) => autoVerdict(NO_LIMITS as never, title, title, { call: { engine: "acp", toolKind, toolCall: { name: title, input } } as GrantCall });
    expect(acp("edit", { path: "README.md", content: "see .env" }, "Write README.md").approve).toBeTruthy();
    expect(acp("edit", { path: ".env", content: "x" }, "Write a file").source).toBe("sensitive-guard");
    expect(acp("read", { path: ".vscode/tasks.json" }, "Read a file").approve).toBeTruthy();
    expect(acp("read", { path: ".env" }, "Read a file").source).toBe("sensitive-guard");
    expect(acp("edit", { path: "README.md", patch: "see .env" }, "Write README.md").source).toBe("sensitive-guard");
  });
});

describe("the engine's own hold, re-read (3.5)", () => {
  const read = (file: string, hold: string, name = "Read", bot: unknown = NO_LIMITS) => {
    const input = name === "Read" || name === "Write" ? { file_path: file } : { pattern: "x", path: file };
    return autoVerdict(bot as never, name, JSON.stringify(input).slice(0, 200), { localHold: hold, call: { engine: "claude", toolCall: { name, input } } as GrantCall });
  };
  it("drops only a tooling id on a Read whose path passes", () => {
    expect(read(`${CWD}/.vscode/tasks.json`, "project-tooling").approve).toBeTruthy();
    expect(read(`${CWD}/.agents/hooks.json`, "agy-workspace-hooks").approve).toBeTruthy();
    expect(read(`${CWD}/.git/hooks/pre-commit`, "project-git").approve).toBeTruthy();
  });
  it("keeps every other hold", () => {
    expect(read(`${CWD}/.git/config`, "project-git").approve).toBeNull();
    expect(read(`${CWD}/.env`, "env").approve).toBeNull();
    expect(read(`${CWD}/a.md`, "env").approve).toBeNull();
    expect(read(`${CWD}/.vscode/tasks.json`, "key-literal").approve).toBeNull();
    expect(read(`${CWD}/x`, "murage-exec").approve).toBeNull();
    expect(read(`${CWD}/.vscode/tasks.json`, "project-tooling", "Write").approve).toBeNull();
    expect(read(`${CWD}/src`, "project-git", "Grep").approve).toBeNull();
    expect(read(`${CWD}/src`, "project-tooling", "Glob").approve).toBeNull();
    expect(read(`${CWD}/.vscode/tasks.json`, "project-tooling", "Read", AUTO).approve).toBeNull();
  });
});

describe("PowerShell keeps today's read (3.6)", () => {
  const ps = (text: string) => autoVerdict(NO_LIMITS as never, "PowerShell", text, { exactCommand: { command: text, cwd: CWD } as AutoContext["exactCommand"], commandText: text, call: { engine: "claude", toolCall: { name: "PowerShell", input: { command: text } } } as GrantCall });
  it("no shell text exception applies", () => {
    for (const text of ["Write-Output .env", "echo .env", "Get-Content .vscode\\tasks.json", "git commit -m \"a .env note\""]) expect(ps(text).source, text).toBe("sensitive-guard");
  });
  it("a command a driver runs under PowerShell is the same", () => {
    const text = "echo .env";
    const verdict = autoVerdict(NO_LIMITS as never, "shell", text, { exactCommand: { command: text, cwd: CWD } as AutoContext["exactCommand"], commandText: text, call: { engine: "codex", commandShell: "pwsh", toolCall: { name: "shell", input: { command: text } } } as GrantCall });
    expect(verdict.source).toBe("sensitive-guard");
  });
  it("Part A still reaches it", () => {
    expect(ps("Get-Content .env.example").approve).toBeTruthy();
    expect(ps("pip install sk-learn").approve).toBeTruthy();
    expect(ps("gci env:").source).toBe("sensitive-guard");
  });
});

describe("the command's other fields", () => {
  it("a covered command's description is read for values, not paths", () => {
    const bash = (text: string, description: string, bot: unknown = NO_LIMITS) => autoVerdict(bot as never, "Bash", text, shellContext(text, { call: { engine: "claude", toolCall: { name: "Bash", input: { command: text, description } } } as GrantCall }));
    expect(bash("git status", "check .env is ignored").approve).toBeTruthy();
    expect(bash("echo .env", "note credentials.json").approve).toBeTruthy();
    expect(bash("git status", "check .env is ignored", AUTO).source).toBe("sensitive-guard");
    expect(bash("git status", "a key sk-" + "proj-" + "FAKE".repeat(10)).source).toBe("sensitive-guard");
    expect(bash("git status", "see $OPENAI_API_KEY").source).toBe("sensitive-guard");
    expect(bash("eval git status", "check .env is ignored").source).toBe("sensitive-guard");
  });
  it("a cwd field names a place; a wrapper keeps the whole read; a card text that is not the command keeps the whole read", () => {
    const text = "echo .env";
    expect(shell(NO_LIMITS, text, { call: { engine: "claude", toolCall: { name: "Bash", input: { command: text, cwd: "/home/ada/.ssh/" } } } as GrantCall }).source).toBe("sensitive-guard");
    expect(autoVerdict(NO_LIMITS as never, "Bash", "a title naming .env", shellContext(text)).source).toBe("sensitive-guard");
    expect(autoVerdict(NO_LIMITS as never, "Bash", text, { ...shellContext(text), exactCommand: { command: "echo x; cat .env", cwd: CWD } as AutoContext["exactCommand"] }).source).toBe("sensitive-guard");
    expect(autoVerdict(NO_LIMITS as never, "mcp__box__exec", text, { call: { engine: "claude", toolCall: { name: "mcp__box__exec", input: { command: text } } } as GrantCall }).approve).toBeNull();
  });
});

describe("the split", () => {
  it("gives the words left for the path rows", () => {
    expect(commandDataRead("echo .env >> .gitignore")?.paths).toBe("echo .gitignore");
    expect(commandDataRead("git commit -m \"a .env\" --amend && cat x")?.paths).toBe("git commit -m --amend cat x");
    expect(commandDataRead("echo .env 2>&1")?.paths).toBe("echo");
    expect(commandDataRead("echo .env > $HOME/x")?.paths).toBe("echo $HOME/x");
  });
  it("is silent on a text with no data operand", () => {
    expect(commandDataRead("cat .env")).toBeUndefined();
    expect(commandDataRead("git status")).toBeUndefined();
  });
  it("reads 64 simple commands and no more, under 5 ms", () => {
    const line = (n: number) => Array.from({ length: n }, () => "echo .env").join("; ");
    expect(commandDataRead(line(64))).toBeDefined();
    expect(commandDataRead(line(65))).toBeUndefined();
    const started = performance.now();
    for (let i = 0; i < 20; i++) commandDataRead(line(64));
    expect((performance.now() - started) / 20).toBeLessThan(5);
  });
});

describe("A1's scope", () => {
  it("a command that names another folder is not in the project", () => {
    expect(autoVerdict(NO_LIMITS as never, "Bash", "cat .env.example", { ...shellContext("cat .env.example"), turnCwd: CWD, commandCwd: "/srv/prod" }).source).toBe("sensitive-guard");
    expect(autoVerdict(NO_LIMITS as never, "Bash", "cat .env.example", { ...shellContext("cat .env.example"), turnCwd: CWD }).approve).toBeTruthy();
  });
  it("leaves every word it cannot place", () => {
    expect(withoutProjectTemplates("cat .env.example", CWD)).toBe("cat _");
    expect(withoutProjectTemplates("cat /work/proj/a/.env.dist", CWD)).toBe("cat _");
    for (const text of ["cat /work/proj/../.env.example", "cat /other/.env.example", "cat .env.example.", "cd x; cat .env.example", "cat $X/.env.example", "cat ../.env.example"]) expect(withoutProjectTemplates(text, CWD)).toBe(text);
  });
});

describe("the asked line (3.7)", () => {
  it("names the row and the class of read, by fixed names only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const bot = { ...NO_LIMITS, id: "key-text-log-1" };
    autoVerdict(bot as never, "Bash", "cat .env", shellContext("cat .env"));
    autoVerdict(bot as never, "Write", "w", { call: { engine: "claude", toolCall: { name: "Write", input: { file_path: "/p/.npmrc", content: "x" } } } as GrantCall });
    const lines = info.mock.calls.map((call) => String(call[0]));
    info.mockRestore();
    expect(lines[0]).toMatch(/held=key-row suppressed=0 row=env why=path$/);
    expect(lines[0]).not.toContain(".env");
  });
});
