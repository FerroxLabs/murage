// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 B2 groups 1 to 3: the recording stub binary behind the headless
// text-only turn (Fuigo, Grok, Claude), host preflight before any spawn, and
// process ownership. The stub runs only under vitest; nothing here spawns a real engine.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { spawnCli } from "../procs.ts";
import { CLAUDE_ALLOWED_HOME_NEW, claudeTextOnlyTurn, headlessTextOnlyTurn, type ClaudeTextOnlyConfig, type HeadlessEngineConfig } from "./headless-text-only.ts";
import {
  FUIGO_OFF_SWITCHES, GROK_OFF_SWITCHES, emptyMissHistory, managedConfigIdentity, preflightRoute, preflightTargets, recordMiss,
  type AttemptTransport, type TextOnlyTurnInput, type TransportChild, type TransportIntent,
} from "../memory/pip-transport.ts";
import {
  ensureDeadline, killAndVerify, reapAttemptProcess, reconcileAttempt, registerChild, remainingMs, sweepByArgv, sweepOrphanTempDirs,
} from "../memory/pip-reaper.ts";
import type { ProviderTurnRoute } from "../provider-routing.ts";

const posix = describe.skipIf(process.platform === "win32");
const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
// macOS stamps __CF_USER_TEXT_ENCODING onto every exec'd process; it is not something the driver passed.
const envKeys = (env: Record<string, string>) => Object.keys(env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let base: string, out: string, etc: string, home: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pip-b2-"));
  out = join(base, "rec.jsonl"); etc = join(base, "etc"); home = join(base, "home");
  mkdirSync(etc); mkdirSync(home);
});
// Windows: a child still exiting can hold the folder for a moment (EPERM/EBUSY); rm retries those.
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
// The 1.0.0 Windows job supervisor compiles its C# (Add-Type) on every launch and every stop, a
// second or more each on a loaded runner; Windows gets the room that costs (the native job helper removes it).
const WIN_SLOW = process.platform === "win32";

const preflight = () => ({ etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(base, "no-managed.json") });
const cfg = (scenario: string, extra: Partial<HeadlessEngineConfig> = {}): HeadlessEngineConfig => ({
  engine: "fuigo", cli: process.execPath, cliPrefixArgs: [STUB, `--stub=${scenario}`, `--stub-out=${out}`],
  tmpBase: join(base, "tmp"),
  // Windows resolves powershell.exe (the job supervisor) through this PATH, so it must be the real one there
  pathValue: process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin", fluxKey: "flux-test-key", preflight: preflight(), postResultGraceMs: 3000, ...extra,
});
const input = (over: Partial<TextOnlyTurnInput> = {}): TextOnlyTurnInput => ({
  system: "SYS", text: "USER", model: "model-1", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 2000, maxOutputBytes: 12 * 1024, context: { botId: "bot", runId: "run1", family: "lived", attempt: 1 }, ...over,
});
type Rec = { argv: string[]; env: Record<string, string>; cwd: string; prompt: string | null; pid: number; homeFiles: string[] | null; stdin?: string; settingsContent?: string | null };
const records = (): Rec[] => existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.argv && r.stdin === undefined) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
const route: ProviderTurnRoute = { connectionId: "conn-a", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "route-key-1", model: "route-model", revision: "r1" };

posix("headless text-only: stub binary (group 1)", () => {
  it("passes the full A.1 argv, the env allowlist and nothing else, with binding files under T/home", async () => {
    const result = await headlessTextOnlyTurn(input({ providerRoute: route }), cfg("ok"));
    expect(result.verdict.state).toBe("validated");
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    // The report includes allowed files too: the stub writes the root debug
    // log requested by A.1, and the result carries its stop reason (§3.3).
    expect(result.isolation).toEqual({ mcpServers: [], tools: [], homeNewFiles: ["<root>/debug.log"], cwdNewFiles: [], stopReason: "end_turn", exited: true, initLine: true });
    const [r] = records();
    const T = r.env.HOME;
    expect(r.argv).toEqual([
      "--cwd", `${T}/work`, "--no-leader", "-m", "murage_selected", "--permission-mode", "dontAsk", "--max-turns", "1",
      "--tools", "mcp__murage__none", "--disallowed-tools", "search_tool,use_tool,Agent", "--disable-web-search", "--no-memory", "--no-auto-update", "--verbatim",
      "--output-format", "streaming-messages-json", "--json-schema", JSON.stringify(SCHEMA), "--prompt-file", `${T}/prompt.txt`, "--debug-file", `${T}/debug.log`,
    ]);
    expect(envKeys(r.env)).toEqual(["FUIGO_API_BASE_URL", "FUIGO_HOME", "FUIGO_MODELS_BASE_URL", "HOME", "MURAGE_PROVIDER_API_KEY", "PATH", ...Object.keys(FUIGO_OFF_SWITCHES)].sort());
    expect(r.env.FUIGO_HOME).toBe(`${T}/home`);
    expect(r.env.HOME).toBe(r.env.FUIGO_HOME.replace(/\/home$/, ""));
    // a child's cwd is reported canonical (macOS /var is /private/var)
    expect(r.cwd.replace(/^\/private(?=\/var\/)/, "")).toBe(`${T}/work`);
    expect(r.homeFiles).toContain("config.toml");
    expect(r.prompt).toBe("SYS\n\nUSER");
    expect(existsSync(T)).toBe(false); // temp root gone after confirmed exit
  });

  it("native Fuigo uses the Flux key as the whole credential; without one the route is unsupported and nothing spawns", async () => {
    const ok = await headlessTextOnlyTurn(input(), cfg("ok"));
    expect(ok.verdict.state).toBe("validated");
    expect(records()[0].env.FUIGO_API_KEY).toBe("flux-test-key");
    rmSync(out);
    const none = await headlessTextOnlyTurn(input(), cfg("ok", { fluxKey: undefined }));
    expect(none.verdict).toEqual({ state: "unsupported", reason: "login-route" });
    expect(records()).toHaveLength(0);
  });

  it("Grok: GROK switches, auth.json copied alone into T/home, no key injected; missing auth.json is unsupported", async () => {
    const parent = join(home, ".grok"); mkdirSync(parent);
    writeFileSync(join(parent, "auth.json"), "{}"); writeFileSync(join(parent, "history.txt"), "other");
    const result = await headlessTextOnlyTurn(input(), cfg("ok", { engine: "grok", parentGrokHome: parent }));
    expect(result.verdict.state).toBe("validated");
    const [r] = records();
    expect(r.homeFiles).toEqual(["auth.json"]);
    expect(envKeys(r.env)).toEqual(["GROK_HOME", "HOME", "PATH", ...Object.keys(GROK_OFF_SWITCHES)].sort());
    rmSync(out); rmSync(join(parent, "auth.json"));
    const missing = await headlessTextOnlyTurn(input(), cfg("ok", { engine: "grok", parentGrokHome: parent }));
    expect(missing.verdict).toEqual({ state: "unsupported", reason: "auth" });
    expect(records()).toHaveLength(0);
  });

  it("settles only after the process has exited", async () => {
    const started = Date.now();
    const result = await headlessTextOnlyTurn(input(), cfg("slow-exit"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(result.verdict.state).toBe("validated");
    expect(alive(records()[0].pid)).toBe(false);
  });

  it("abort with a stub that ignores SIGTERM for 2 s rejects cancelled only after confirmed exit", async () => {
    const controller = new AbortController();
    const run = headlessTextOnlyTurn(input({ signal: controller.signal }), cfg("ignore-term"));
    const settled = run.then(() => "resolved", (e: Error) => e.name);
    for (let i = 0; i < 100 && !records().length; i++) await sleep(50);
    await sleep(300);
    const abortedAt = Date.now();
    controller.abort();
    expect(await settled).toBe("cancelled");
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(1800);
    expect(alive(records()[0].pid)).toBe(false);
    expect(existsSync(records()[0].env.HOME)).toBe(false);
  });

  it("no init line is refused isolation no-init-line, third time unsupported transport", async () => {
    const first = await headlessTextOnlyTurn(input(), cfg("no-init"));
    expect(first.verdict).toMatchObject({ state: "refused", reason: "isolation", detail: "no-init-line", counted: true });
    expect(first.text).toBe("");
    expect(first.isolation.initLine).toBe(false);
    let history = emptyMissHistory();
    history = recordMiss(recordMiss(history, first.verdict), first.verdict);
    const third = await headlessTextOnlyTurn(input({ transport: { history } }), cfg("no-init"));
    expect(third.verdict).toMatchObject({ state: "unsupported", reason: "transport" });
  });

  it("an init line with one MCP server is unsupported managed-config and the bytes are discarded", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("mcp"));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(r.text).toBe("");
    expect(r.isolation.mcpServers).toEqual(["evil"]);
  });

  it("a file written into cwd is refused isolation, then unsupported managed-config on repeat", async () => {
    const first = await headlessTextOnlyTurn(input(), cfg("agents-md"));
    expect(first.verdict).toMatchObject({ state: "refused", reason: "isolation", counted: true, missKey: "cwd:AGENTS.md" });
    expect(first.isolation.cwdNewFiles).toEqual(["AGENTS.md"]);
    const second = await headlessTextOnlyTurn(input({ transport: { history: recordMiss(emptyMissHistory(), first.verdict) } }), cfg("agents-md"));
    expect(second.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
  });

  it("a tool-call line or a non-empty tool list is unsupported tools", async () => {
    expect((await headlessTextOnlyTurn(input(), cfg("tool-call"))).verdict).toMatchObject({ state: "unsupported", reason: "tools" });
    expect((await headlessTextOnlyTurn(input(), cfg("tools"))).verdict).toMatchObject({ state: "unsupported", reason: "tools" });
  });

  it("a cancelled result and a schema failure are refused bad-output; nothing is replayed", async () => {
    const c = await headlessTextOnlyTurn(input(), cfg("cancelled"));
    expect(c.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "cancelled", counted: true });
    const b = await headlessTextOnlyTurn(input(), cfg("bad-schema"));
    expect(b.verdict).toMatchObject({ state: "refused", reason: "bad-output" });
    expect(records()).toHaveLength(2); // one spawn per call, no replay
  });

  it("stdout over 12 KB kills the tree and refuses", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("big"));
    expect(r.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "over-byte-cap" });
    expect(r.isolation.exited).toBe(true);
    expect(alive(records()[0].pid)).toBe(false);
  });

  it("no first byte within the timer refuses transient", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("late-first-byte", { firstByteMs: 250, cliPrefixArgs: [STUB, "--stub=late-first-byte", "--stub-delay=5000", `--stub-out=${out}`] }));
    expect(r.verdict).toMatchObject({ state: "refused", reason: "transient", counted: false });
    expect(alive(records()[0].pid)).toBe(false);
  });

  it("Claude: reduced env, stdin prompt, credentials copied, the A.1 Claude argv", async () => {
    const config = join(base, "claude-config"); mkdirSync(config); writeFileSync(join(config, ".credentials.json"), "{}");
    const full = { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "ak", HOME: "/should/not/leak", XAI_API_KEY: "leak", OPENAI_API_KEY: "leak" };
    const result = await claudeTextOnlyTurn(input(), {
      cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${out}`], tmpBase: join(base, "tmp"),
      env: full, credentialsDir: config, preflight: preflight(),
    });
    expect(result.verdict.state).toBe("validated");
    const [r] = records();
    expect(r.argv).toEqual([
      "-p", "--model", "model-1", "--system-prompt", "SYS", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(SCHEMA),
      "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--settings", join(r.env.HOME, "settings.json"), "--debug-file", join(r.env.HOME, "debug.log"),
    ]);
    // The settings ride in a per-attempt file whose path names the temp root (finding 4), carrying the same hook switch.
    expect(r.settingsContent).toBe('{"disableAllHooks":true}');
    expect(envKeys(r.env)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_TELEMETRY", "HOME", "PATH"]);
    expect(r.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2000");
    expect(r.homeFiles).toEqual([".credentials.json"]);
    expect(readFileSync(out, "utf8")).toContain('"stdin":"USER"');
  });
});

posix("host preflight (group 2)", () => {
  it("a fake /etc/fuigo/managed-config.toml refuses without spawning", async () => {
    mkdirSync(join(etc, "fuigo")); writeFileSync(join(etc, "fuigo", "managed-config.toml"), "x");
    const r = await headlessTextOnlyTurn(input(), cfg("ok"));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(records()).toHaveLength(0);
  });

  it("a Claude managed-settings path refuses a Claude route without spawning", async () => {
    writeFileSync(join(base, "no-managed.json"), "{}");
    const r = await claudeTextOnlyTurn(input(), { cli: process.execPath, cliPrefixArgs: [STUB, `--stub-out=${out}`], tmpBase: join(base, "tmp"), env: {}, preflight: preflight() });
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(records()).toHaveLength(0);
  });

  it("a plugin-bearing parent Grok home refuses native Grok; an empty one does not", async () => {
    const parent = join(home, ".grok"); mkdirSync(join(parent, "plugins"), { recursive: true });
    expect(preflightRoute("grok", preflight())).toMatchObject({ ok: true });
    writeFileSync(join(parent, "plugins", "p.json"), "{}");
    const held = preflightRoute("grok", preflight());
    expect(held).toMatchObject({ ok: false, verdict: { reason: "managed-config" }, copy: "Reflection on this engine is held while plugins are installed in its home." });
    writeFileSync(join(parent, "auth.json"), "{}");
    const r = await headlessTextOnlyTurn(input(), cfg("ok", { engine: "grok", parentGrokHome: parent }));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(records()).toHaveLength(0);
    // The same plugin directory does not refuse Fuigo by itself.
    expect(preflightRoute("fuigo", preflight())).toMatchObject({ ok: true });
  });

  it("the identity changes when a watched path's mtime changes, and when a plugin dir appears", () => {
    const before = managedConfigIdentity(preflightTargets("fuigo", preflight()));
    const plugins = join(home, ".claude", "plugins"); mkdirSync(plugins, { recursive: true });
    const created = managedConfigIdentity(preflightTargets("fuigo", preflight()));
    expect(created).not.toBe(before);
    expect(managedConfigIdentity(preflightTargets("fuigo", preflight()))).toBe(created);
    utimesSync(plugins, new Date(1_000_000), new Date(1_000_000));
    expect(managedConfigIdentity(preflightTargets("fuigo", preflight()))).not.toBe(created);
  });
});

posix("process ownership (group 3)", () => {
  const spawnSleeper = (extraArgs: string[] = []) => spawnCli(process.execPath, [STUB, "--stub=sleep", `--stub-out=${out}`, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
  const epochA = { pid: 1111, startedAt: 1 }, epochB = { pid: process.pid, startedAt: 2 };
  const intent = (root: string): TransportIntent => ({ runId: "r", family: "lived", attempt: 1, tempRoot: root, bootEpoch: epochA, intentAt: 1, deadlineAt: 2 });

  it("writes intent before spawn and the child registration right after, with a real start time", async () => {
    const seen: string[] = [];
    let child: TransportChild | undefined;
    const r = await headlessTextOnlyTurn(input({ transport: { hooks: {
      onIntent: (i) => { seen.push(`intent:${existsSync(out)}`); expect(i.tempRoot).toContain("run1-1-"); },
      onChild: (c) => { child = c; seen.push("child"); },
    } } }), cfg("ok"));
    expect(r.verdict.state).toBe("validated");
    expect(seen).toEqual(["intent:false", "child"]);
    expect(child!.pid).toBe(records()[0].pid);
    expect(child!.startTime.length).toBeGreaterThan(0);
  });

  it("a simulated restart reaps a live stub, verifies ESRCH, then removes T", async () => {
    const root = join(base, "tmp", "r-1-aaaa"); mkdirSync(root, { recursive: true });
    const child = spawnSleeper();
    await sleep(300);
    const reg = await registerChild(child.pid);
    expect(reg).not.toBeNull();
    const t: AttemptTransport = { intent: intent(root), child: reg! };
    const action = await reconcileAttempt(t, 1, epochB, join(base, "tmp"));
    expect(action).toMatchObject({ action: "retry", attempt: 2 });
    expect(alive(child.pid!)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("a pid whose start time differs is treated as gone and never killed", async () => {
    const root = join(base, "tmp", "r-1-bbbb"); mkdirSync(root, { recursive: true });
    const child = spawnSleeper();
    await sleep(200);
    const t: AttemptTransport = { intent: intent(root), child: { pid: child.pid!, startTime: "not-the-start-time", registeredAt: 1 } };
    expect(await reconcileAttempt(t, 1, epochB, join(base, "tmp"))).toMatchObject({ action: "retry" });
    expect(alive(child.pid!)).toBe(true);
    expect(await killAndVerify(child.pid!)).toBe(true);
  });

  it("a stub that cannot be killed leaves T in place, stays uncertain-transport, and becomes unstable after 3 failures", async () => {
    const root = join(base, "tmp", "r-1-cccc"); mkdirSync(root, { recursive: true });
    const deps = { signal: () => {}, startTime: async () => "same", termGraceMs: 30, forceWaitMs: 30 };
    let t: AttemptTransport = { intent: intent(root), child: { pid: 4242, startTime: "same", registeredAt: 1 } };
    for (let n = 1; n <= 2; n++) {
      const a = await reconcileAttempt(t, 1, epochB, join(base, "tmp"), deps);
      expect(a.action).toBe("unconfirmed");
      t = (a as { transport: AttemptTransport }).transport;
      expect(t.reaperFailures).toBe(n);
      expect(existsSync(root)).toBe(true);
    }
    const last = await reconcileAttempt(t, 1, epochB, join(base, "tmp"), deps);
    expect(last).toMatchObject({ action: "unstable", reason: "reaper" });
    expect((last as { note: string }).note).toContain(root);
    expect(existsSync(root)).toBe(true);
  });

  it("an attempt without transport.child is found by the argv sweep", async () => {
    const root = join(base, "tmp", "r-1-dddd"); mkdirSync(root, { recursive: true });
    const child = spawnSleeper(["--prompt-file", join(root, "prompt.txt")]);
    await sleep(400);
    const t: AttemptTransport = { intent: intent(root) };
    expect(await reconcileAttempt(t, 1, epochB, join(base, "tmp"))).toMatchObject({ action: "retry", attempt: 2 });
    expect(alive(child.pid!)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("the same boot epoch is left alone; the third attempt ends refused unstable; an HTTP attempt retries without a sweep", async () => {
    const root = join(base, "tmp", "r-1-eeee"); mkdirSync(root, { recursive: true });
    expect(await reconcileAttempt({ intent: { ...intent(root), bootEpoch: epochB } }, 1, epochB, join(base, "tmp"))).toEqual({ action: "none" });
    expect(await reconcileAttempt({ kind: "http", intent: intent(root) }, 3, epochB, join(base, "tmp"))).toMatchObject({ action: "unstable", reason: "attempts" });
    const root2 = join(base, "tmp", "r-1-ffff"); mkdirSync(root2, { recursive: true });
    expect(await reconcileAttempt({ kind: "http", intent: intent(root2) }, 1, epochB, join(base, "tmp"))).toMatchObject({ action: "retry", attempt: 2 });
  });

  it("orphan temp dirs are removed only when no process names them", async () => {
    const tmp = join(base, "tmp"); const free = join(tmp, "orphan-a"), busy = join(tmp, "orphan-b");
    mkdirSync(free, { recursive: true }); mkdirSync(busy, { recursive: true });
    const child = spawnSleeper(["--prompt-file", join(busy, "prompt.txt")]);
    await sleep(400);
    const res = await sweepOrphanTempDirs(tmp, new Set());
    expect(res.removed).toEqual([free]); expect(res.kept).toEqual([busy]);
    expect(await killAndVerify(child.pid!)).toBe(true);
  });

  it("deadlineAt is set once and shared by retries", () => {
    const first = ensureDeadline({}, 1_000);
    expect(first.deadlineAt).toBe(1_000 + 270_000);
    const retry = ensureDeadline(first, 99_000);
    expect(retry.deadlineAt).toBe(first.deadlineAt);
    expect(remainingMs(first.deadlineAt, 1_000 + 270_000 + 5)).toBe(0);
    expect(remainingMs(first.deadlineAt, 1_000)).toBe(270_000);
  });

  it("a run whose deadline has passed is cancelled after confirmed exit", async () => {
    const run = headlessTextOnlyTurn(input({ transport: { deadlineAt: Date.now() + 400 } }), cfg("sleep"));
    await expect(run).rejects.toMatchObject({ name: "cancelled" });
  });
});

// ---------------------------------------------------------------------------
// P2 code audit of B1+B2 (Astra): findings 1 to 7 and 15 at the process level.
// ---------------------------------------------------------------------------

const claudeCfg = (scenario: string, extra: Partial<ClaudeTextOnlyConfig> = {}): ClaudeTextOnlyConfig => ({
  cli: process.execPath, cliPrefixArgs: [STUB, `--stub=${scenario}`, `--stub-out=${out}`], tmpBase: join(base, "tmp"),
  env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv, preflight: preflight(), postResultGraceMs: 3000, ...extra,
});
const epochA = { pid: 1111, startedAt: 1 }, epochB = { pid: process.pid, startedAt: 2 };
const intent = (root: string): TransportIntent => ({ runId: "r", family: "lived", attempt: 1, tempRoot: root, bootEpoch: epochA, intentAt: 1, deadlineAt: 2 });
const waitForRecord = async () => { for (let i = 0; i < 100 && !records().length; i++) await sleep(50); await sleep(100); };
const tmpDirs = () => existsSync(join(base, "tmp")) ? readdirSync(join(base, "tmp")) : [];

posix("audit finding 1: preflight reads the files and the preference the binaries read", () => {
  it("managed_config.toml (the real filename) in /etc/fuigo refuses without spawning", async () => {
    mkdirSync(join(etc, "fuigo")); writeFileSync(join(etc, "fuigo", "managed_config.toml"), "x");
    const r = await headlessTextOnlyTurn(input(), cfg("ok"));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect((r.verdict as { detail?: string }).detail).toContain("managed_config.toml");
    expect(records()).toHaveLength(0);
  });
  it("requirements.toml and managed_config.toml in the parent Grok home refuse native Grok", () => {
    const parent = join(home, ".grok"); mkdirSync(parent);
    expect(preflightRoute("grok", preflight())).toMatchObject({ ok: true });
    for (const name of ["managed_config.toml", "requirements.toml"]) {
      writeFileSync(join(parent, name), "x");
      expect(preflightRoute("grok", preflight()), name).toMatchObject({ ok: false, verdict: { reason: "managed-config" } });
      rmSync(join(parent, name));
    }
  });
  it("the forced ai.x.grok preference refuses Fuigo and Grok; an unreadable answer refuses too; absent passes", () => {
    for (const engine of ["fuigo", "grok"] as const) {
      expect(preflightRoute(engine, { ...preflight(), readMdm: () => "absent" })).toMatchObject({ ok: true });
      const present = preflightRoute(engine, { ...preflight(), readMdm: () => "present" });
      expect(present).toMatchObject({ ok: false, verdict: { state: "unsupported", reason: "managed-config" } });
      expect((present as { verdict: { detail?: string } }).verdict.detail).toContain("ai.x.grok:requirements_toml_base64");
      const unknown = preflightRoute(engine, { ...preflight(), readMdm: () => "unknown" });
      expect(unknown).toMatchObject({ ok: false, verdict: { reason: "managed-config" } });
      expect((unknown as { verdict: { detail?: string } }).verdict.detail).toContain("inspection-failed");
    }
    // the preference is part of the route identity
    const t = preflightTargets("fuigo", preflight());
    expect(managedConfigIdentity(t, "present")).not.toBe(managedConfigIdentity(t, "absent"));
  });
  it("an inspection failure is not absence: a symlink loop under /etc/fuigo refuses instead of passing", () => {
    symlinkSync("fuigo", join(etc, "fuigo"));
    const r = preflightRoute("fuigo", preflight());
    expect(r).toMatchObject({ ok: false, verdict: { reason: "managed-config" } });
    expect((r as { verdict: { detail?: string } }).verdict.detail).toContain("inspection-failed");
  });
  it("a custom parent Grok home with plugins is held even when preflight was configured with another home", async () => {
    const custom = join(base, "custom-grok"); mkdirSync(join(custom, "plugins"), { recursive: true }); writeFileSync(join(custom, "plugins", "p.json"), "{}"); writeFileSync(join(custom, "auth.json"), "{}");
    const r = await headlessTextOnlyTurn(input(), cfg("ok", { engine: "grok", parentGrokHome: custom }));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(records()).toHaveLength(0);
  });
});

posix("audit findings 6, 7 and 15: the per-run gate", () => {
  const grokParent = () => { const parent = join(home, ".grok"); mkdirSync(parent, { recursive: true }); writeFileSync(join(parent, "auth.json"), "{}"); return parent; };
  it("Fuigo and Grok start-up artifacts (docs/user-guide, active_sessions) do not make a conforming run refuse", async () => {
    const fuigo = await headlessTextOnlyTurn(input(), cfg("startup-artifacts"));
    expect(fuigo.verdict.state).toBe("validated");
    expect(fuigo.isolation.homeNewFiles).toEqual(expect.arrayContaining(["active_sessions.json", "active_sessions.lock", "docs/user-guide/01-intro.md"]));
    const grok = await headlessTextOnlyTurn(input(), cfg("startup-artifacts", { engine: "grok", parentGrokHome: grokParent() }));
    expect(grok.verdict.state).toBe("validated");
  });
  it("Claude no longer admits arbitrary top-level files: an instruction file in its config dir is an isolation miss", async () => {
    const r = await claudeTextOnlyTurn(input(), claudeCfg("home-instruction"));
    expect(r.verdict).toMatchObject({ state: "refused", reason: "isolation", missKey: "home:CLAUDE.md" });
    expect(CLAUDE_ALLOWED_HOME_NEW.some((re) => re.test("CLAUDE.md"))).toBe(false);
    expect(CLAUDE_ALLOWED_HOME_NEW.some((re) => re.test(".claude.json"))).toBe(true);
    expect(CLAUDE_ALLOWED_HOME_NEW.some((re) => re.test("settings.json"))).toBe(false);
  });
  it("the real HOME (the temp root) is inventoried too, not only T/home and T/work", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("root-file"));
    expect(r.verdict).toMatchObject({ state: "refused", reason: "isolation", missKey: "root:.cache-note" });
    expect(r.text).toBe("");
  });
  it("a backend search event (server_tool_use) is unsupported tools", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("server-tool-use"));
    expect(r.verdict).toMatchObject({ state: "unsupported", reason: "tools" });
  });
  it("a malformed output line, a missing or mistyped is_error, and a result before init are refused, never admitted", async () => {
    expect((await headlessTextOnlyTurn(input(), cfg("malformed"))).verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "malformed-output" });
    expect((await headlessTextOnlyTurn(input(), cfg("no-is-error"))).verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "invalid-is-error" });
    expect((await headlessTextOnlyTurn(input(), cfg("string-is-error"))).verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "invalid-is-error" });
    expect((await headlessTextOnlyTurn(input(), cfg("result-first"))).verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "result-before-init" });
  });
  it("Fuigo and Grok must answer in structured_output; only Claude's result text is a fallback", async () => {
    expect((await headlessTextOnlyTurn(input(), cfg("text-result"))).verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "no-structured-output" });
    expect((await headlessTextOnlyTurn(input(), cfg("text-result", { engine: "grok", parentGrokHome: grokParent() }))).verdict).toMatchObject({ state: "refused", reason: "bad-output" });
    expect((await claudeTextOnlyTurn(input(), claudeCfg("text-result"))).verdict).toEqual({ state: "validated", structured: { ok: true } });
  });
  it("a rejected attempt keeps its reported usage while its content is discarded (A.3)", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("bad-schema"));
    expect(r.verdict).toMatchObject({ state: "refused", reason: "bad-output" });
    expect(r.text).toBe("");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const cancelled = await headlessTextOnlyTurn(input(), cfg("cancelled"));
    expect(cancelled.verdict).toMatchObject({ state: "refused", detail: "cancelled" });
    expect(cancelled.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const tools = await headlessTextOnlyTurn(input(), cfg("tool-call"));
    expect(tools.verdict).toMatchObject({ state: "unsupported", reason: "tools" });
    expect(tools.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
  it("a same-group helper that outlives the root is stopped before the run settles", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("helper"));
    expect(r.verdict.state).toBe("validated");
    const helper = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((x) => x.event === "helper");
    expect(alive(helper.pid)).toBe(false);
  });
});

posix("audit finding 2: exceptions after spawn never remove the root under a live child", () => {
  it("an onChild rejection stops and awaits the child, removes the root, then rethrows the original error", async () => {
    await expect(headlessTextOnlyTurn(input({ transport: { hooks: { onChild: async () => { await sleep(600); throw new Error("persist failed"); } } } }), cfg("sleep"))).rejects.toThrow("persist failed");
    const [r] = records();
    expect(alive(r.pid)).toBe(false);
    expect(existsSync(r.env.HOME)).toBe(false);
  });
  it("the same holds for Claude: the credential directory is removed only after the child is gone", async () => {
    const config = join(base, "claude-config"); mkdirSync(config); writeFileSync(join(config, ".credentials.json"), "{}");
    await expect(claudeTextOnlyTurn(input({ transport: { hooks: { onChild: async () => { await sleep(600); throw new Error("persist failed"); } } } }), claudeCfg("sleep", { credentialsDir: config }))).rejects.toThrow("persist failed");
    const [r] = records();
    expect(alive(r.pid)).toBe(false);
    expect(existsSync(r.env.HOME)).toBe(false);
  });
  it("an abort during the awaited onIntent write cancels before any spawn and leaves no directory", async () => {
    const controller = new AbortController();
    const run = headlessTextOnlyTurn(input({ signal: controller.signal, transport: { hooks: { onIntent: async () => { controller.abort(); await sleep(30); } } } }), cfg("ok"));
    await expect(run).rejects.toMatchObject({ name: "cancelled" });
    expect(records()).toHaveLength(0);
    expect(tmpDirs()).toEqual([]);
  });
  it("an onIntent rejection spawns nothing and removes the root", async () => {
    await expect(headlessTextOnlyTurn(input({ transport: { hooks: { onIntent: async () => { throw new Error("no durable intent"); } } } }), cfg("ok"))).rejects.toThrow("no durable intent");
    expect(records()).toHaveLength(0);
    expect(tmpDirs()).toEqual([]);
  });
});

posix("audit finding 3: the reaper separates absent, present and unknown", () => {
  const rootAt = (name: string) => { const root = join(base, "tmp", name); mkdirSync(root, { recursive: true }); return root; };
  it("a failed look at the registered pid keeps the root and stays uncertain, never confirmed gone", async () => {
    const root = rootAt("r-1-u001");
    const t: AttemptTransport = { intent: intent(root), child: { pid: 4242, startTime: "same", registeredAt: 1 } };
    const a = await reconcileAttempt(t, 1, epochB, join(base, "tmp"), { observe: async () => ({ state: "unknown" }) });
    expect(a).toMatchObject({ action: "unconfirmed" });
    expect(existsSync(root)).toBe(true);
    // an injected start-time reader that fails is the same failed look
    expect(await reapAttemptProcess(t, { startTime: async () => null })).toEqual({ confirmed: false, how: "unconfirmed" });
  });
  it("a failed process listing is not an empty sweep: the root stays; the orphan sweep keeps the directory", async () => {
    const root = rootAt("r-1-u002");
    expect(await reconcileAttempt({ intent: intent(root) }, 1, epochB, join(base, "tmp"), { sweep: async () => null })).toMatchObject({ action: "unconfirmed" });
    expect(existsSync(root)).toBe(true);
    const res = await sweepOrphanTempDirs(join(base, "tmp"), new Set(), { sweep: async () => null });
    expect(res.removed).toEqual([]); expect(res.kept).toContain(root);
    expect(existsSync(root)).toBe(true);
  });
  it("the registered root exits while a same-group helper survives: the group is killed and verified before the root is removed", async () => {
    const root = rootAt("r-1-u003");
    const script = "const {spawn}=require('node:child_process');const h=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});process.stdout.write(String(h.pid));setTimeout(()=>process.exit(0),900)";
    const rootChild = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let helperPid = 0;
    try {
      helperPid = await new Promise<number>((done) => rootChild.stdout.once("data", (d) => done(Number(String(d)))));
      const reg = await registerChild(rootChild.pid);
      expect(reg).not.toBeNull();
      await new Promise<void>((done) => rootChild.once("close", () => done()));
      expect(alive(helperPid)).toBe(true); // the root is gone, the helper is not
      const action = await reconcileAttempt({ intent: intent(root), child: reg! }, 1, epochB, join(base, "tmp"));
      expect(action).toMatchObject({ action: "retry", attempt: 2 });
      for (let i = 0; i < 40 && alive(helperPid); i++) await sleep(50);
      expect(alive(helperPid)).toBe(false);
      expect(existsSync(root)).toBe(false);
    } finally { if (helperPid) try { process.kill(helperPid, "SIGKILL"); } catch { /* already gone */ } }
  });
  it("Windows job termination confirms members gone without PID signals", async () => {
    const signals: string[] = [];
    const jobName = "Local\\murage-pip-fixture";
    const ok = await killAndVerify(4242, {
      platform: "win32", jobName, signal: (pid, sig) => { signals.push(`${pid}:${sig}`); },
      jobRunner: async () => ({ ok: true, out: '{"state":"present","activeProcesses":0}' }),
      termGraceMs: 50, forceWaitMs: 50,
    });
    expect(ok).toBe(true); expect(signals).toEqual([]);
    const stuck = await killAndVerify(4242, { platform: "win32", jobName, jobRunner: async () => ({ ok: true, out: '{"state":"present","activeProcesses":1}' }) });
    expect(stuck).toBe(false);
  });
});

posix("audit finding 4: a Claude child is recoverable by the registration-gap sweep", () => {
  it("the unique temp path rides in Claude's argv through its settings file, so the sweep finds the process and the reaper kills it", async () => {
    const run = claudeTextOnlyTurn(input(), claudeCfg("sleep"));
    const settled = run.then(() => "resolved", (e: Error) => e.name);
    await waitForRecord();
    const [r] = records();
    const root = r.env.HOME;
    expect(r.argv).toContain(join(root, "settings.json"));
    expect(await sweepByArgv(root)).toContain(r.pid);
    // crash between spawn and registration: the attempt has intent but no child
    const action = await reconcileAttempt({ intent: intent(root) }, 1, epochB, join(base, "tmp"));
    expect(action).toMatchObject({ action: "retry", attempt: 2 });
    expect(alive(r.pid)).toBe(false);
    await settled;
  });
});

posix("audit finding 5: reconciliation of a same-epoch uncertain attempt", () => {
  it("an uncertain attempt of this process is reconciled at the idle tick; an active one is left alone", async () => {
    const root = join(base, "tmp", "r-1-s001"); mkdirSync(root, { recursive: true });
    const t: AttemptTransport = { intent: { ...intent(root), bootEpoch: epochB } };
    expect(await reconcileAttempt(t, 1, epochB, join(base, "tmp"), { sweep: async () => [] })).toEqual({ action: "none" });
    expect(await reconcileAttempt(t, 1, epochB, join(base, "tmp"), { sweep: async () => [] }, { uncertain: true })).toMatchObject({ action: "retry", attempt: 2 });
    expect(existsSync(root)).toBe(false);
  });
});

posix("audit finding 1 (parent home) and 14 (Claude route model)", () => {
  it("a routed Claude turn runs the route's model, not the turn's", async () => {
    const r = await claudeTextOnlyTurn(input({ model: "turn-model", providerRoute: route }), claudeCfg("ok"));
    expect(r.verdict.state).toBe("validated");
    expect(records()[0].argv[records()[0].argv.indexOf("--model") + 1]).toBe("route-model");
  });
});

describe("Astra audit2 transport regressions", () => {
  it("3: Windows root disappearance cannot release an unaccounted descendant", async () => {
    const deps = { platform: "win32" as const, observe: async () => ({ state: "absent" as const }), taskkill: async () => true, sweep: async () => [] };
    expect(await killAndVerify(999888, deps)).toBe(false);
    const tempRoot = join(base, "tmp", "owned"); mkdirSync(tempRoot, { recursive: true });
    const t: AttemptTransport = { kind: "cli", intent: { runId: "owned", family: "lived", attempt: 1, tempRoot, bootEpoch: { pid: 1, startedAt: 1 }, intentAt: 1, deadlineAt: 2 }, child: { pid: 999888, startTime: "old", registeredAt: 1 } };
    expect(await reapAttemptProcess(t, deps)).toEqual({ confirmed: false, how: "unconfirmed" });
    expect((await reconcileAttempt(t, 1, { pid: 2, startedAt: 2 }, join(base, "tmp"), deps)).action).toBe("unconfirmed");
    expect(existsSync(tempRoot)).toBe(true);
  });

  it("15: abort settles already received usage through the production lease", async () => {
    const { withContinuityInferenceLease, continuityDay, continuityLedgerId } = await import("../memory/extract.ts");
    const { database } = await import("../database.ts");
    const { DATA_DIR } = await import("../config.ts"); mkdirSync(DATA_DIR, { recursive: true });
    const abort = new AbortController();
    let turn: unknown;
    const pending = withContinuityInferenceLease(lease => lease.request(async () => { const r = await headlessTextOnlyTurn(input({ signal: abort.signal }), cfg("usage-before-abort")); turn = r; return r.text; }, "system", 2000, abort.signal, [{ role: "user", content: "fixture" }], "continuity", { botId: "usage-abort", family: "lived" })).catch(e => e);
    for (let i = 0; i < (WIN_SLOW ? 1000 : 100) && (!existsSync(out) || !readFileSync(out, "utf8").includes('"usage-ready"')); i++) await sleep(20);
    if (!existsSync(out)) {
      // Diagnose before failing: the lease or the turn may have settled without the
      // stub ever starting (the pending result is otherwise swallowed by .catch above).
      const early = await Promise.race([pending, sleep(2000).then(() => "still pending")]);
      const detail = early instanceof Error ? `${early.name}: ${early.message}\n${early.stack ?? ""}` : JSON.stringify(early);
      throw new Error(`the stub never wrote ${out}; the leased turn gave: ${detail}; turn result: ${JSON.stringify(turn)}; files in base: ${JSON.stringify(readdirSync(base, { recursive: true }))}`);
    }
    expect(readFileSync(out, "utf8")).toContain('"usage-ready"');
    await sleep(30); abort.abort();
    expect(await pending).toMatchObject({ name: "cancelled" });
    const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(continuityLedgerId("usage-abort", continuityDay()))!.intent));
    expect(ledger.input).toBe(10); expect(ledger.output).toBe(5);
  }, WIN_SLOW ? 60_000 : undefined);

  it("21: rejects hook execution found only in the debug log", async () => {
    const got = await headlessTextOnlyTurn(input(), cfg("debug-hook"));
    expect(got.verdict).toMatchObject({ state: "unsupported", reason: "managed-config", detail: "hook-execution" });
    expect(got.text).toBe("");
  }, WIN_SLOW ? 60_000 : undefined);

  it("23: delivers a large reflection prompt verbatim through the production argv", async () => {
    const text = "You are reliable. ".repeat(2000);
    const got = await headlessTextOnlyTurn(input({ text }), cfg("require-verbatim"));
    expect(got.verdict.state).toBe("validated");
    expect(records()[0].argv).toContain("--verbatim");
    expect(records()[0].prompt).toBe("SYS\n\n" + text);
  }, WIN_SLOW ? 60_000 : undefined);
});
