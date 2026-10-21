// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-turn isolation setup is cached on its inputs: 50 turns with nothing changed rebuild nothing,
// and an owner-file change (or a CLI update) rebuilds exactly once.
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../config.ts";
import { grokIsolationArgs } from "./acp/grok.ts";
import { isolateGeminiFromPersonalSetup } from "./acp/gemini-isolation.ts";
import { isolateOpenCodeFromPersonalSetup } from "./acp/opencode-go.ts";
import { buildAntigravityScopedHome } from "./antigravity-scope.ts";
import { codexIsolationArgs, codexPersonalSkillFiles } from "./codex-isolation.ts";
import { codexConfigMcpServerNames } from "./codex-mcp-names.ts";
import { cliSig, engineLaunchFile, isolationStats, knownCliVersion, rememberCliVersion, noteVersionProbe, resetIsolationCache, VERSION_PROBE_BACKOFF_MAX_MS, VERSION_PROBE_BACKOFF_MIN_MS, versionProbeAllowed } from "./isolation-cache.ts";
import { piIsolationArgs } from "./pi.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resolveCliSpawn } from "../env-path.ts";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
beforeEach(() => { ensureDirs(); resetIsolationCache(); });
afterEach(() => { for (const d of dirs.splice(0)) removeTempDirSync(d); });
/** Make a rewrite visible to an mtime check even inside one filesystem-timestamp tick. */
const bump = (path: string) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); utimesSync(path, t, t); };
const turns = (n: number, fn: () => void) => { for (let i = 0; i < n; i++) fn(); };

describe("isolation setup is cached on its inputs", () => {
  it("Grok: the plugin enumeration and stubs are built once for 50 turns, again after a plugin is added", () => {
    const home = tmp("murage-cache-grok-");
    mkdirSync(join(home, ".claude", "plugins", "p1", ".claude-plugin"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "p1", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p1" }));
    const env = { HOME: home, GROK_HOME: join(home, ".grok") };
    turns(50, () => grokIsolationArgs(env, "1.0.60"));
    expect(isolationStats("grok-isolation-args")).toEqual({ builds: 1, hits: 49 });
    mkdirSync(join(home, ".claude", "plugins", "p2", ".claude-plugin"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "p2", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p2" }));
    bump(join(home, ".claude", "plugins"));
    const args = grokIsolationArgs(env, "1.0.60");
    expect(isolationStats("grok-isolation-args").builds).toBe(2);
    expect(args.filter((a) => a === "--plugin-dir")).toHaveLength(2);
    // another CLI version is another key, and is itself cached
    turns(10, () => grokIsolationArgs(env, "1.0.49"));
    expect(isolationStats("grok-isolation-args").builds).toBe(2); // below the shadow floor: no enumeration at all
  });

  it("Codex: owner config names and personal skills are read once for 50 turns, again after an edit", () => {
    const home = tmp("murage-cache-codex-");
    mkdirSync(join(home, ".codex", "skills", "s1"), { recursive: true });
    writeFileSync(join(home, ".codex", "skills", "s1", "SKILL.md"), "# s1");
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.alpha]\ncommand = \"x\"\n");
    const env = { HOME: home, CODEX_HOME: join(home, ".codex") };
    turns(50, () => codexIsolationArgs(env, codexConfigMcpServerNames(env), new Set()));
    expect(isolationStats("codex-config-names")).toEqual({ builds: 1, hits: 49 });
    expect(isolationStats("codex-skills")).toEqual({ builds: 1, hits: 49 });
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.alpha]\ncommand = \"x\"\n[mcp_servers.beta]\ncommand = \"y\"\n");
    bump(join(home, ".codex", "config.toml"));
    const args = codexIsolationArgs(env, codexConfigMcpServerNames(env), new Set());
    expect(isolationStats("codex-config-names").builds).toBe(2);
    expect(args.join(" ")).toContain("mcp_servers.beta.enabled=false");
    mkdirSync(join(home, ".codex", "skills", "s2"), { recursive: true });
    writeFileSync(join(home, ".codex", "skills", "s2", "SKILL.md"), "# s2");
    bump(join(home, ".codex", "skills"));
    expect(codexPersonalSkillFiles(env)).toHaveLength(2);
    expect(isolationStats("codex-skills").builds).toBe(2);
  });

  it("pi: the project context walk is made once for 50 turns, again when an AGENTS.md appears", () => {
    const root = tmp("murage-cache-pi-");
    const home = join(root, "home");
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    turns(50, () => piIsolationArgs("0.70.0", cwd, home));
    const first = isolationStats("pi-context-files");
    expect(first.builds).toBeLessThanOrEqual(1);
    writeFileSync(join(cwd, "AGENTS.md"), "x");
    bump(cwd);
    const args = piIsolationArgs("0.70.0", cwd, home);
    if (first.builds === 1) expect(isolationStats("pi-context-files").builds).toBe(2);
    if (args.includes("--no-context-files")) expect(args).toContain(join(cwd, "AGENTS.md"));
  });

  it("OpenCode: the owner's server names are read once for 50 turns, again after an edit", () => {
    const home = tmp("murage-cache-oc-");
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ mcp: { one: { type: "remote", url: "https://a" } } }));
    const run = () => { const env: Record<string, string | undefined> = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }; isolateOpenCodeFromPersonalSetup(env); return env.OPENCODE_CONFIG_CONTENT; };
    turns(50, run);
    expect(isolationStats("opencode-owner-mcp")).toEqual({ builds: 1, hits: 49 });
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ mcp: { one: {}, two: { type: "remote", url: "https://b" } } }));
    bump(join(dir, "opencode.json"));
    expect(JSON.parse(run()!).mcp).toHaveProperty("two");
    expect(isolationStats("opencode-owner-mcp").builds).toBe(2);
  });

  it("Gemini: the scoped home is worked out once for 50 turns, again when the owner's ~/.gemini changes", () => {
    const home = tmp("murage-cache-gem-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const run = () => { const env: Record<string, string | undefined> = { HOME: home }; isolateGeminiFromPersonalSetup(env); return env.GEMINI_CLI_HOME; };
    const first = run();
    turns(49, run);
    expect(isolationStats("gemini-isolate")).toEqual({ builds: 1, hits: 49 });
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}");
    bump(join(home, ".gemini"));
    expect(run()).toBe(first); // a new login file refreshes the same stable scope in place
    expect(isolationStats("gemini-isolate").builds).toBe(2);
  });

  it("Antigravity: the owner's folder listings are read once across 50 scoped homes, again after a change", () => {
    const home = tmp("murage-cache-agy-");
    const root = tmp("murage-cache-agy-scope-");
    mkdirSync(join(home, ".gemini", "config", "skills"), { recursive: true });
    writeFileSync(join(home, ".gemini", "config", "config.json"), "{}");
    for (let i = 0; i < 50; i++) buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: `t${i}`, servers: {} }).dispose();
    const first = isolationStats("agy-entries");
    expect(first.builds).toBeLessThanOrEqual(4); // home, .gemini, config, antigravity-cli: one listing each
    expect(first.hits).toBeGreaterThanOrEqual(49 * 3);
    writeFileSync(join(home, ".gemini", "config", "new.json"), "{}");
    bump(join(home, ".gemini", "config"));
    const scoped = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "after", servers: {} });
    expect(isolationStats("agy-entries").builds).toBe(first.builds + 1);
    scoped.dispose();
  });

  it("CLI version probes are keyed on the CLI file: unchanged keeps the key, a replaced file changes it", () => {
    const dir = tmp("murage-cache-cli-");
    const cli = join(dir, "agy");
    writeFileSync(cli, "#!/bin/sh\necho 1.0.0\n");
    chmodSync(cli, 0o755);
    const env = { PATH: dir };
    const a = cliSig("agy", env);
    expect(cliSig("agy", env)).toBe(a);
    expect(cliSig(cli, env)).toBe(a);
    writeFileSync(cli, "#!/bin/sh\necho 1.0.1 and a longer file\n");
    bump(cli);
    expect(cliSig("agy", env)).not.toBe(a);
    expect(cliSig("nothing-here", env)).toBe("unresolved");
  });
});

describe("a failed --version probe is not repeated on every turn", () => {
  it("backs off per CLI signature, doubling up to the cap, and starts over on success or a new CLI file", () => {
    const key = "grokAgent|grok";
    let now = 1_000_000;
    expect(versionProbeAllowed(key, "sig-a", now)).toBe(true);
    noteVersionProbe(key, "sig-a", false, now);
    // the next 30 s of turns skip the probe
    expect(versionProbeAllowed(key, "sig-a", now + 1)).toBe(false);
    expect(versionProbeAllowed(key, "sig-a", now + VERSION_PROBE_BACKOFF_MIN_MS - 1)).toBe(false);
    expect(versionProbeAllowed(key, "sig-a", now + VERSION_PROBE_BACKOFF_MIN_MS)).toBe(true);
    // a second failure doubles the window
    now += VERSION_PROBE_BACKOFF_MIN_MS;
    noteVersionProbe(key, "sig-a", false, now);
    expect(versionProbeAllowed(key, "sig-a", now + 2 * VERSION_PROBE_BACKOFF_MIN_MS - 1)).toBe(false);
    expect(versionProbeAllowed(key, "sig-a", now + 2 * VERSION_PROBE_BACKOFF_MIN_MS)).toBe(true);
    // bounded: many failures never wait longer than the cap
    for (let i = 0; i < 40; i++) noteVersionProbe(key, "sig-a", false, now);
    expect(versionProbeAllowed(key, "sig-a", now + VERSION_PROBE_BACKOFF_MAX_MS - 1)).toBe(false);
    expect(versionProbeAllowed(key, "sig-a", now + VERSION_PROBE_BACKOFF_MAX_MS)).toBe(true);
    // an updated CLI (new signature) is probed at once
    expect(versionProbeAllowed(key, "sig-b", now + 1)).toBe(true);
    // a success clears the record
    noteVersionProbe(key, "sig-a", true, now);
    expect(versionProbeAllowed(key, "sig-a", now + 1)).toBe(true);
    // other CLIs are unaffected
    noteVersionProbe(key, "sig-a", false, now);
    expect(versionProbeAllowed("pi|pi", "sig-a", now + 1)).toBe(true);
  });
});

describe("a successful version probe is remembered per binary", () => {
  it("is read back for the same file signature, forgotten when the file changes, and never stored for an unresolved CLI", () => {
    const dir = tmp("murage-known-version-");
    const cli = join(dir, "engine");
    writeFileSync(cli, "#!/bin/sh\n");
    const sig = cliSig(cli);
    expect(knownCliVersion("k|engine", sig)).toBeUndefined();
    rememberCliVersion("k|engine", sig, "engine 1.2.3");
    expect(knownCliVersion("k|engine", sig)).toBe("engine 1.2.3");
    expect(knownCliVersion("k|other", sig)).toBeUndefined();
    writeFileSync(cli, "#!/bin/sh\n# updated, a different size\n"); // an update replaces the file
    expect(knownCliVersion("k|engine", cliSig(cli))).toBeUndefined();
    rememberCliVersion("k|gone", "unresolved", "x 1.0.0");
    expect(knownCliVersion("k|gone", "unresolved")).toBeUndefined();
    resetIsolationCache();
    expect(knownCliVersion("k|engine", sig)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("engineLaunchFile: the engine file a turn spawns is the one found on the probe's PATH", () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) removeTempDirSync(dir); });
  const dirWith = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "murage-launch-file-"));
    made.push(dir);
    writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
    return dir;
  };

  it("pins a bare name to the probe PATH's file, ahead of any other PATH", () => {
    const probed = dirWith("eng");
    expect(engineLaunchFile("eng", { PATH: `${dirWith("other")}:${probed}` })).toBe(join(probed, "eng"));
  });

  it("pins the head word of a cli with fixed arguments, and the launcher splits it back to the same argv", () => {
    const probed = join(dirWith("ag"));
    const pinned = engineLaunchFile("ag claude 'two words'", { PATH: probed });
    expect(resolveCliSpawn(pinned, ["--x"])).toEqual({ command: join(probed, "ag"), args: ["claude", "two words", "--x"] });
  });

  it("leaves a cli that names a path as it is, so spawn reports its own ENOENT", () => {
    expect(engineLaunchFile("/no/such/eng", { PATH: "" })).toBe("/no/such/eng");
    expect(engineLaunchFile('"/usr/local/bin/node" "/tmp/x.mjs"', { PATH: "" })).toBe('"/usr/local/bin/node" "/tmp/x.mjs"');
  });

  it("throws ENOENT for a bare name the probe PATH lacks, never handing the name to another PATH", () => {
    let thrown: NodeJS.ErrnoException | undefined;
    try { engineLaunchFile("eng", { PATH: dirWith("other") }); } catch (error) { thrown = error as NodeJS.ErrnoException; }
    expect(thrown?.code).toBe("ENOENT");
  });
});
