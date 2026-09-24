// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the composer's engine group may show, how a typed "/name" is read back,
// and the per-bot cache that keeps the menu filled between runs.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_BUILTIN_COMMANDS, EngineCommandCache, engineCommandsView, normalizeEngineCommands } from "./engine-commands.ts";
import { engineCommandInText, engineCommandText } from "../shared/engine-commands.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("normalizeEngineCommands", () => {
  it("reads every engine's shape and drops the leading slash", () => {
    expect(normalizeEngineCommands([
      { name: "web", description: "Search the web", input: { hint: "query" } }, // ACP
      { name: "/compact", description: "Compact", argumentHint: "<focus>" }, // Claude initialize
      "context", // Claude init names
    ])).toEqual([
      { name: "web", description: "Search the web", hint: "query" },
      { name: "compact", description: "Compact", hint: "<focus>" },
      { name: "context" },
    ]);
  });

  it("keeps out screen-bound, session-bound and approval-bound commands, and Murage's own", () => {
    const names = ["login", "logout", "config", "theme", "vim", "terminal-setup", "ide", "exit", "clear", "resume", "model",
      "permissions", "always-approve", "hooks-trust", "plugins", "learn", "setup", "hooks-list", "compact", "goal"];
    expect(normalizeEngineCommands(names).map((command) => command.name)).toEqual(["hooks-list", "compact", "goal"]);
  });

  it("drops what the engine itself marks terminal-only", () => {
    expect(normalizeEngineCommands(["statusline", "review"], ["statusline"]).map((command) => command.name)).toEqual(["review"]);
  });

  it("refuses malformed names and keeps the first of a duplicate", () => {
    expect(normalizeEngineCommands([{ name: "two words" }, { name: "" }, 7, null, { name: "Review", description: "first" }, { name: "review", description: "second" }]))
      .toEqual([{ name: "Review", description: "first" }]);
    expect(normalizeEngineCommands("compact")).toEqual([]);
  });
});

describe("engineCommandInText", () => {
  const commands = [{ name: "compact" }, { name: "plugin:deploy" }];
  it("reads the command and its arguments", () => {
    expect(engineCommandInText("/compact keep the plan", commands)).toEqual({ name: "compact", args: "keep the plan" });
    expect(engineCommandInText("/COMPACT", commands)).toEqual({ name: "compact", args: "" });
    expect(engineCommandInText("/plugin:deploy staging\nnow", commands)).toEqual({ name: "plugin:deploy", args: "staging\nnow" });
  });
  it("leaves everything else as chat", () => {
    expect(engineCommandInText("/unknown", commands)).toBeNull();
    expect(engineCommandInText(" /compact", commands)).toBeNull();
    expect(engineCommandInText("please /compact", commands)).toBeNull();
    expect(engineCommandInText("/usr/bin/env", commands)).toBeNull();
  });
  it("rebuilds the exact text the engine receives", () => {
    expect(engineCommandText({ name: "compact", args: "" })).toBe("/compact");
    expect(engineCommandText({ name: "review", args: "the auth change" })).toBe("/review the auth change");
  });
});

describe("EngineCommandCache and engineCommandsView", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-engine-commands-")); });
  afterEach(async () => { await removeTempDir(dir); });

  it("says unknown until the engine has reported, then keeps the report across restarts", () => {
    const cache = new EngineCommandCache(dir);
    expect(engineCommandsView(cache, "bot-1", "fuigoAgent")).toEqual({ engine: "Fuigo", driver: "fuigoAgent", status: "unknown", commands: [] });
    expect(cache.record("bot-1", "fuigoAgent", [{ name: "compact", description: "Compact" }])).toBe(true);
    expect(cache.record("bot-1", "fuigoAgent", [{ name: "compact", description: "Compact" }])).toBe(false);
    const file = join(dir, "engine-commands.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = new EngineCommandCache(dir);
    expect(engineCommandsView(reloaded, "bot-1", "fuigoAgent")).toEqual({
      engine: "Fuigo", driver: "fuigoAgent", status: "ready", commands: [{ name: "compact", description: "Compact" }],
    });
    // another engine on the same bot starts from its own state
    expect(engineCommandsView(reloaded, "bot-1", "grokAgent")).toMatchObject({ engine: "Grok Build", status: "unknown" });
    reloaded.forget("bot-1");
    expect(JSON.parse(readFileSync(file, "utf8")).bots).toEqual({});
  });

  it("offers Codex's built-in pair before any run, and nothing for the Grok API", () => {
    const cache = new EngineCommandCache(dir);
    expect(engineCommandsView(cache, "bot-1", "codex")).toEqual({ engine: "Codex", driver: "codex", status: "ready", commands: [...CODEX_BUILTIN_COMMANDS] });
    expect(engineCommandsView(cache, "bot-1", "grok")).toEqual({ engine: "grok", driver: "grok", status: "unsupported", commands: [] });
    expect(engineCommandsView(cache, "bot-1", "grok", "Grok (API)").engine).toBe("Grok (API)");
    expect(engineCommandsView(cache, "bot-1", "claudeAgent", "Claude").engine).toBe("Claude Code");
    expect(engineCommandsView(cache, "bot-1", "opencodeGo", "My OpenCode").engine).toBe("OpenCode");
    expect(engineCommandsView(cache, "bot-1", "customAcp", "My agent")).toMatchObject({ engine: "My agent", status: "unknown" });
  });

  it("reads a damaged file as empty rather than failing", () => {
    writeFileSync(join(dir, "engine-commands.json"), "{not json");
    expect(engineCommandsView(new EngineCommandCache(dir), "bot-1", "claudeAgent").status).toBe("unknown");
  });
});
