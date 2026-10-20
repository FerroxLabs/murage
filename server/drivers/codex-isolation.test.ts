// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Codex bot turns: Murage's own mounts present, the owner's MCP servers and personal skills
// switched off (codex-isolation.ts). Synthetic owner home only.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { codexIsolationArgs, codexPersonalSkillFiles, scopedCodexHome } from "./codex-isolation.ts";
import { codexScopeSpec } from "./codex-scope-spec.ts";
import { ensureDirs } from "../config.ts";
import { isolationStats, resetIsolationCache } from "./isolation-cache.ts";
import { ScopeUnavailableError } from "./scoped-cli-home.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const dirs: string[] = [];
afterEach(() => { delete process.env.FAKE_CODEX_DUMP; for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function ownerHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "murage-codex-iso-")));
  dirs.push(home);
  const codex = join(home, ".codex");
  for (const dir of ["skills/personal", "skills/nested/deep", "skills/.system/bundled", ".."].map((d) => join(codex, d))) mkdirSync(dir, { recursive: true });
  writeFileSync(join(codex, "skills", "personal", "SKILL.md"), "---\nname: personal\n---\n");
  writeFileSync(join(codex, "skills", "nested", "deep", "SKILL.md"), "---\nname: deep\n---\n");
  writeFileSync(join(codex, "skills", ".system", "bundled", "SKILL.md"), "---\nname: bundled\n---\n");
  mkdirSync(join(home, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\n---\n");
  writeFileSync(join(codex, "config.toml"), '[mcp_servers.tradingview]\nurl = "https://tv.example"\n\n[mcp_servers."my.server"]\ncommand = "x"\n\n[mcp_servers.agents]\ncommand = "owner-agents"\n');
  return { home, codex };
}

describe("codex personal setup isolation", () => {
  it("finds personal skills but leaves Codex's bundled .system ones", () => {
    const { home, codex } = ownerHome();
    expect(codexPersonalSkillFiles({ HOME: home })).toEqual([
      join(home, ".agents", "skills", "shared", "SKILL.md"),
      join(codex, "skills", "nested", "deep", "SKILL.md"),
      join(codex, "skills", "personal", "SKILL.md"),
    ].sort());
  });

  // Rule 68a: no owner hook is defined, trusted or runnable in a bot's scope.
  it("copies the owner's config.toml into a bot's scope without the owner's hooks table or its trust records", () => {
    const { home, codex } = ownerHome();
    writeFileSync(join(codex, "config.toml"), [
      'model = "gpt-x"', "[hooks]", 'owner = "hook"', "[hooks.state]", '"/o/hooks.json:pre_tool_use:0:0" = { trusted_hash = "sha256:aa" }',
      "[mcp_servers.agents]", 'command = "owner-agents"', "",
    ].join("\n"));
    const generated = (codexScopeSpec(codex).generated as () => Record<string, string>)();
    expect(generated["config.toml"]).toContain('model = "gpt-x"');
    expect(generated["config.toml"]).toContain("[mcp_servers.agents]");
    expect(generated["config.toml"]).not.toMatch(/hooks|trusted_hash/);
    expect(home).toBeTruthy();
  });

  it("disables every owner server except the names Murage mounts, and fails open on an unreadable config", () => {
    const { home } = ownerHome();
    const args = codexIsolationArgs({ HOME: home }, { kind: "names", names: new Set(["tradingview", "my.server", "agents"]) }, new Set(["agents"]));
    expect(args.slice(0, 4)).toEqual(["-c", 'mcp_servers."my.server".enabled=false', "-c", "mcp_servers.tradingview.enabled=false"]);
    expect(args[5]).toMatch(/^skills\.config=\[\{path=".*SKILL\.md",enabled=false\}(,\{path=".*",enabled=false\}){2}\]$/);
    expect(codexIsolationArgs({ HOME: join(home, "none") }, { kind: "unreadable", why: "x" }, new Set())).toEqual([]);
  });

  it("spawns the app-server with Murage's mounts and the owner's switched off", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const { home, codex } = ownerHome();
    const dump = join(home, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const instance = await CodexDriver.create({ instanceId: "codex-iso", displayName: "Codex", enabled: true,
      environment: { HOME: home, CODEX_HOME: codex }, config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      const sent = await instance.adapter.sendTurn({ threadId: "codex-iso-1", text: "go",
        integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} } } });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
      const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
      expect(argv).toContain("mcp_servers.tradingview.enabled=false");
      expect(argv).toContain('mcp_servers."my.server".enabled=false');
      expect(argv).not.toContain("mcp_servers.agents.enabled=false");
      expect(argv.join(" ")).toContain("mcp_servers.agents.command");
      // the path is a TOML string in the argument: a Windows backslash is written escaped
      expect(argv.find((arg) => arg.startsWith("skills.config="))).toContain(JSON.stringify(join(codex, "skills", "personal", "SKILL.md")).slice(1, -1));
      // the fake reports codex-cli 0.147.0: the global instructions are out through a scoped CODEX_HOME
      const childHome = JSON.parse(readFileSync(dump, "utf8")).env.CODEX_HOME as string;
      expect(childHome).not.toBe(codex);
      expect(existsSync(join(childHome, "AGENTS.md"))).toBe(false);
      expect(readFileSync(join(childHome, "config.toml"), "utf8")).toContain("tradingview");
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30000);

  it("each bot has its own CODEX_HOME state root: sessions, history and instruction files are not shared, the login is", () => {
    ensureDirs();
    resetIsolationCache();
    const { home, codex } = ownerHome();
    writeFileSync(join(codex, "auth.json"), "LOGIN");
    mkdirSync(join(codex, "sessions"));
    writeFileSync(join(codex, "sessions", "owner.jsonl"), "OWNER");
    const env = { HOME: home, CODEX_HOME: codex };
    const a = scopedCodexHome(env, "codex-cli 0.162.1", "bot-a")!;
    const b = scopedCodexHome(env, "codex-cli 0.162.1", "bot-b")!;
    const none = scopedCodexHome(env, "codex-cli 0.162.1")!;
    expect(new Set([a, b, none]).size).toBe(3);
    for (const scope of [a, b]) expect(existsSync(join(scope, "sessions")), scope).toBe(false);
    mkdirSync(join(a, "sessions"));
    writeFileSync(join(a, "sessions", "a.jsonl"), "A");
    writeFileSync(join(a, "AGENTS.md"), "BOT A INSTRUCTIONS");
    writeFileSync(join(a, "history.jsonl"), "A HISTORY");
    expect(existsSync(join(b, "sessions"))).toBe(false);
    expect(existsSync(join(b, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(b, "history.jsonl"))).toBe(false);
    expect(existsSync(join(codex, "history.jsonl"))).toBe(false);
    expect(existsSync(join(codex, "sessions", "a.jsonl"))).toBe(false);
    // the same bot gets its scope and its own state back
    expect(scopedCodexHome(env, "codex-cli 0.162.1", "bot-a")).toBe(a);
    expect(readFileSync(join(a, "sessions", "a.jsonl"), "utf8")).toBe("A");
    // the login is shared: a refresh in place through either bot's link reaches the owner's file
    writeFileSync(join(b, "auth.json"), "REFRESHED-BY-B");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("REFRESHED-BY-B");
    expect(readFileSync(join(a, "auth.json"), "utf8")).toBe("REFRESHED-BY-B");
  });

  it("scoped CODEX_HOME: global AGENTS.md, AGENTS.override.md and skills out; login and config linked through; version-gated", () => {
    ensureDirs();
    resetIsolationCache();
    const { home, codex } = ownerHome();
    writeFileSync(join(codex, "AGENTS.md"), "PERSONAL GLOBAL INSTRUCTIONS");
    writeFileSync(join(codex, "AGENTS.override.md"), "PERSONAL OVERRIDE");
    writeFileSync(join(codex, "auth.json"), "LOGIN");
    mkdirSync(join(codex, "sessions"));
    const env = { HOME: home, CODEX_HOME: codex };
    // fails closed: an older or unreadable Codex is rejected (update-required), never run in the owner's own CODEX_HOME
    for (const version of ["codex-cli 0.1.9", "codex-cli 0.2", undefined]) {
      const error = (() => { try { scopedCodexHome(env, version); } catch (e) { return e; } return null; })() as ScopeUnavailableError | null;
      expect(error).toBeInstanceOf(ScopeUnavailableError);
      expect(error!.code).toBe("update-required");
      expect(error!.engine).toBe("Codex");
    }
    const scoped = scopedCodexHome(env, "codex-cli 0.162.1")!;
    expect(scoped).toBeTruthy();
    for (const gone of ["AGENTS.md", "AGENTS.override.md", "skills"]) expect(existsSync(join(scoped, gone)), gone).toBe(false);
    expect(readlinkSync(join(scoped, "auth.json"))).toBe(join(codex, "auth.json"));
    // sessions and history are the bot's own: not the owner's folder linked through
    expect(existsSync(join(scoped, "sessions"))).toBe(false);
    expect(lstatSync(join(scoped, "config.toml")).isSymbolicLink()).toBe(false);
    // cached: 50 turns stat, never rebuild
    for (let i = 0; i < 50; i++) expect(scopedCodexHome(env, "codex-cli 0.162.1")).toBe(scoped);
    expect(isolationStats("codex-scope")).toEqual({ builds: 1, hits: 50 });
    // the first Codex whose CODEX_HOME and in-place auth.json write are in the published source (rust-v0.2.0) is accepted
    expect(scopedCodexHome({ ...env }, "codex-cli 0.2.0", "floor-bot")).toBeTruthy();
    // a login refresh written in place through the link (codex 0.146/0.162: O_TRUNC, no rename) lands in the owner's real file
    writeFileSync(join(scoped, "auth.json"), "REFRESHED");
    expect(readFileSync(join(codex, "auth.json"), "utf8")).toBe("REFRESHED");
    // Codex's own bundled skills are written in the scope, never into the owner's skills folder
    mkdirSync(join(scoped, "skills", ".system"), { recursive: true });
    expect(existsSync(join(codex, "skills", "personal", "SKILL.md"))).toBe(true);
    // a new owner entry is NOT linked in (history is per bot); what the scope holds stays
    writeFileSync(join(codex, "history.jsonl"), "h");
    expect(scopedCodexHome(env, "codex-cli 0.162.1")).toBe(scoped);
    expect(existsSync(join(scoped, "history.jsonl"))).toBe(false);
    expect(existsSync(join(scoped, "skills", ".system"))).toBe(true);
    // the owner's files are untouched
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toBe("PERSONAL GLOBAL INSTRUCTIONS");
  });
});
