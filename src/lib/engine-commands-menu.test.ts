// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { composerSlashTrigger } from "./composer-commands";
import { engineCommandPick, engineCommandsNote, matchEngineCommands } from "./engine-commands-menu";

const COMMANDS = [
  { name: "compact", description: "Clear conversation history but keep a summary", hint: "<instructions>" },
  { name: "context", description: "Show current context usage" },
  { name: "review", description: "Review a pull request" },
  { name: "plugin:deploy", description: "Deploy the current branch" },
];

describe("engine group of the composer's / menu", () => {
  it("lists everything for a bare slash, then name matches before description matches", () => {
    expect(matchEngineCommands(COMMANDS, "").map((command) => command.name)).toEqual(["compact", "context", "review", "plugin:deploy"]);
    expect(matchEngineCommands(COMMANDS, "co").map((command) => command.name)).toEqual(["compact", "context"]);
    expect(matchEngineCommands(COMMANDS, "pull").map((command) => command.name)).toEqual(["review"]);
    expect(matchEngineCommands(COMMANDS, "CONTEXT").map((command) => command.name)).toEqual(["context"]);
    expect(matchEngineCommands(COMMANDS, "summary").map((command) => command.name)).toEqual(["compact"]);
  });

  it("sends a command that takes nothing and leaves one that takes input in the draft", () => {
    expect(engineCommandPick(COMMANDS[1]!)).toEqual({ kind: "send", text: "/context" });
    expect(engineCommandPick(COMMANDS[0]!)).toEqual({ kind: "insert", text: "/compact " });
  });

  it("says how to load the list before the engine has reported, and nothing otherwise", () => {
    expect(engineCommandsNote({ engine: "Claude Code", driver: "claudeAgent", status: "unknown", commands: [] }))
      .toBe("Start a chat to load Claude Code commands");
    expect(engineCommandsNote({ engine: "Codex", driver: "codex", status: "ready", commands: [] })).toBeNull();
    expect(engineCommandsNote({ engine: "Grok (API)", driver: "grok", status: "unsupported", commands: [] })).toBeNull();
    expect(engineCommandsNote(null)).toBeNull();
  });

  it("keeps the menu open while an engine command name is typed, digits and colons included", () => {
    expect(composerSlashTrigger("/plugin:dep", 11)).toEqual({ query: "plugin:dep", start: 0, end: 11 });
    expect(composerSlashTrigger("/web2_x.y", 9)).toEqual({ query: "web2_x.y", start: 0, end: 9 });
    expect(composerSlashTrigger("/compact now", 12)).toBeNull();
  });
});
