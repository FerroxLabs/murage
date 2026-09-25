// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  commandFromToolInput,
  commandCwdFromToolInput,
  exactCommandKey,
  isExactCommandKey,
  normalizeCommand,
  parseExactCommandKey,
} from "./exact-command.ts";

describe("normalizeCommand", () => {
  it("trims and collapses spaces and tabs between words", () => {
    expect(normalizeCommand("  git   status\t--short  ")).toBe("git status --short");
  });

  it("keeps whitespace inside quotes exactly", () => {
    expect(normalizeCommand(`echo "a   b"  'c\t d'`)).toBe(`echo "a   b" 'c\t d'`);
  });

  it("keeps an escaped space and the space after it", () => {
    expect(normalizeCommand("ls a\\  b")).toBe("ls a\\  b");
  });

  it("keeps line breaks, which separate commands", () => {
    expect(normalizeCommand("npm test  \n   npm run build")).toBe("npm test\nnpm run build");
  });

  it("leaves a here-doc untouched apart from the ends", () => {
    const text = "cat <<EOF\n  a   b\nEOF";
    expect(normalizeCommand(`  ${text}  `)).toBe(text);
  });

  it("only trims a command with nested substitution, whose quotes a flat scan misreads", () => {
    expect(normalizeCommand(`echo "$(printf "a  b")"`)).toBe(`echo "$(printf "a  b")"`);
    expect(normalizeCommand("echo  `date`")).toBe("echo  `date`");
    expect(normalizeCommand(`echo "\${x:-"a  b"}"`)).toBe(`echo "\${x:-"a  b"}"`);
    expect(normalizeCommand("echo  $'a\\'  b'")).toBe("echo  $'a\\'  b'");
  });

  it("never merges two different commands", () => {
    expect(normalizeCommand("git status")).not.toBe(normalizeCommand("git status --short"));
    expect(normalizeCommand("rm a b")).not.toBe(normalizeCommand("rm ab"));
    expect(normalizeCommand("echo 'a b'")).not.toBe(normalizeCommand("echo 'a  b'"));
  });
});

describe("exactCommandKey", () => {
  const base = { engine: "claude", cwd: "/Users/ada/project", command: "npm test" };

  it("round-trips command, folder and engine", () => {
    const key = exactCommandKey(base)!;
    expect(isExactCommandKey(key)).toBe(true);
    expect(parseExactCommandKey(key)).toEqual(base);
  });

  it("is the same key for the same command spelled with extra spaces", () => {
    expect(exactCommandKey({ ...base, command: "  npm   test " })).toBe(exactCommandKey(base));
  });

  it("differs by folder, engine and command", () => {
    const key = exactCommandKey(base);
    expect(exactCommandKey({ ...base, cwd: "/Users/ada/other" })).not.toBe(key);
    expect(exactCommandKey({ ...base, engine: "codex" })).not.toBe(key);
    expect(exactCommandKey({ ...base, command: "npm test -- --watch" })).not.toBe(key);
  });

  it("refuses what cannot name one exact place", () => {
    expect(exactCommandKey({ ...base, cwd: "project" })).toBeUndefined();
    expect(exactCommandKey({ ...base, cwd: "/Users/ada/../bob" })).toBeUndefined();
    expect(exactCommandKey({ ...base, cwd: "" })).toBeUndefined();
    expect(exactCommandKey({ ...base, engine: "" })).toBeUndefined();
    expect(exactCommandKey({ ...base, command: "   " })).toBeUndefined();
    expect(exactCommandKey({ ...base, command: "echo \u0000" })).toBeUndefined();
    expect(exactCommandKey({ ...base, command: "x".repeat(5_000) })).toBeUndefined();
  });

  it("accepts a Windows folder", () => {
    expect(exactCommandKey({ ...base, cwd: "C:\\Users\\ada\\project" })).toBeDefined();
  });

  it("parses only well-formed keys", () => {
    expect(parseExactCommandKey("Bash:git")).toBeUndefined();
    expect(parseExactCommandKey("exact:not json")).toBeUndefined();
    expect(parseExactCommandKey('exact:["claude","relative","ls"]')).toBeUndefined();
    // a key must already be in its normalized form
    expect(parseExactCommandKey('exact:["claude","/p","  ls"]')).toBeUndefined();
  });
});

describe("command from the engine's own tool input", () => {
  it("reads a command string", () => {
    expect(commandFromToolInput({ command: "git status" })).toBe("git status");
  });

  it("quotes an argument list so different lists never read the same", () => {
    expect(commandFromToolInput({ command: ["git", "status"] })).toBe("git status");
    expect(commandFromToolInput({ command: ["echo", "a b"] })).toBe("echo 'a b'");
    expect(commandFromToolInput({ command: ["echo", "a", "b"] })).toBe("echo a b");
    expect(commandFromToolInput({ command: ["echo", "it's"] })).toBe("echo 'it'\\''s'");
    expect(commandFromToolInput({ command: ["echo", ""] })).toBe("echo ''");
  });

  it("has no command for anything else", () => {
    expect(commandFromToolInput(undefined)).toBeUndefined();
    expect(commandFromToolInput({ command: 3 })).toBeUndefined();
    expect(commandFromToolInput({ command: ["ls", 3] })).toBeUndefined();
    expect(commandFromToolInput("ls")).toBeUndefined();
  });

  it("reads the folder the engine reports, never a relative one", () => {
    expect(commandCwdFromToolInput({ cwd: "/work" })).toBe("/work");
    expect(commandCwdFromToolInput({ workdir: "/work" })).toBe("/work");
    // a folder the engine names but Murage cannot place is not the turn's folder
    expect(commandCwdFromToolInput({ cwd: "work" })).toBeNull();
    expect(commandCwdFromToolInput({})).toBeUndefined();
    // two folders that disagree say nothing about where it runs
    expect(commandCwdFromToolInput({ cwd: "/a", workdir: "/b" })).toBeNull();
  });
});
