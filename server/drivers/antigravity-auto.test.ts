// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Antigravity at Auto and Full access (lanes/release103/AGY-AUTO-DESIGN.md): agy runs with its own permissions
// skipped and Murage's relay hook in front of every tool, so commands and Murage's tools work and the stop line
// still holds. Ask is unchanged. A relay that cannot be set up keeps accept-edits; an agy that did not load the hook
// gets no prompt at all.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { classifyAsk, type StopHit } from "../stop-line.ts";
import { stopLineRealpath } from "../stop-line-state.ts";
import { removeTempDir, removeTempDirSync } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import * as antigravity from "./antigravity.ts";
import { ANTIGRAVITY_HOOK_NOT_LOADED, ANTIGRAVITY_HOOK_SKIPPED, AntigravityDriver } from "./antigravity.ts";
import * as relayModule from "./antigravity-relay.ts";
import { antigravityRelayAsk, relayHookLoadState } from "./antigravity-relay.ts";
import { ASK_STOP_NOTE, ASK_STOP_PROMPT } from "./ask-stop.ts";

const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const FAKE_ENV = ["FAKE_AGY_DUMP", "FAKE_AGY_TOOL_CALLS", "FAKE_AGY_RUN_HOOKS", "FAKE_AGY_SKIP_HOOKS", "FAKE_AGY_HOOKS_IGNORED", "FAKE_AGY_HOME_OVERRIDE", "FAKE_AGY_HOME_DUMP", "FAKE_AGY_MCP_DUMP", "FAKE_AGY_UNHOOKED_ERROR", "FAKE_AGY_CREATE_REPO_HOOK"];

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;
const call = (name: string, args: Record<string, unknown>) => ({ name, args });
const mcp = (server: string, tool: string, args: Record<string, unknown>) => call("call_mcp_tool", { ServerName: server, ToolName: tool, Arguments: args });

describe("Antigravity at Auto and Full access: Murage's relay hook", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch = "";
  let work = "";
  let outside = "";
  let home = "";
  let dump = "";
  /** What the test's broker decided for each relayed ask, by the stop line exactly as the server reads it. */
  let decided: Array<{ tool: string; hit: StopHit | null }> = [];

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_AGY, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-agy-auto-"));
    work = join(scratch, "work");
    outside = join(scratch, "outside");
    home = join(scratch, "home");
    for (const dir of [work, outside, home]) mkdirSync(dir, { recursive: true });
    dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_RUN_HOOKS = "1";
    decided = [];
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    for (const name of FAKE_ENV) delete process.env[name];
    await removeTempDir(scratch);
  });

  /** The instance's environment is read when it is created, so the turn's tool steps are set first. */
  const create = async (calls: Array<{ name: string; args: Record<string, unknown> }> = []) => {
    process.env.FAKE_AGY_TOOL_CALLS = JSON.stringify(calls);
    instance = await AntigravityDriver.create({
      instanceId: "agy-auto", displayName: "Antigravity", environment: { HOME: home }, enabled: true,
      config: { cli: FAKE_AGY, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    // The broker's stop line (server/index.ts stopLineFor reads the same fields): a hit is refused, anything else allowed.
    instance.adapter.onEvent((e) => {
      if (e.type !== "request.opened") return;
      const hit = classifyAsk({ ...e, engine: e.toolEngine, inputMissing: e.toolInputMissing }, {
        cwd: work, roots: [work], home, knownRecipients: new Set(), realpath: stopLineRealpath,
      });
      decided.push({ tool: e.tool, hit });
      void instance!.adapter.respondToRequest(e.threadId, e.requestId ?? "", hit ? { behavior: "deny", message: `Murage stopped first: ${hit.what}` } : { behavior: "allow" });
    });
  };
  const turn = async (level: Pick<SendTurnInput, "routeAsks" | "stopLine" | "askLevel">, extra: Partial<SendTurnInput> = {}) => {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-agy-auto", text: "do the work", cwd: work, ...level, ...extra });
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const steps = recorder!.events.filter((e): e is Extract<RuntimeEvent, { type: "item.completed" }> => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool");
    return {
      done: done as Extract<RuntimeEvent, { type: "turn.completed" }>,
      opened: recorder!.events.filter((e): e is Opened => e.type === "request.opened"),
      okSteps: steps.filter((e) => (e as { ok?: boolean }).ok === true).length,
      notices: recorder!.events.filter((e) => e.type === "item.started" && (e as { toolKind?: string }).toolKind === "notice").map((e) => (e as { title?: string }).title),
      seen: JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; prompt?: string },
    };
  };

  it("Ask is unchanged: accept-edits, the Ask hook, no relay, no Murage tools", async () => {
    process.env.FAKE_AGY_HOME_DUMP = join(scratch, "home.json");
    process.env.FAKE_AGY_MCP_DUMP = join(scratch, "mcp.json");
    await create([call("view_file", { AbsolutePath: join(work, "a.txt") })]);
    const r = await turn({ routeAsks: true, askLevel: true }, {
      integrations: { custom: { notes: { command: process.execPath, args: [], env: {} } } } as never,
    });
    expect(r.seen.argv).toContain("accept-edits");
    expect(r.seen.argv).not.toContain("--dangerously-skip-permissions");
    expect(r.seen.argv).not.toContain("--log-file");
    expect(r.opened).toEqual([]);
    expect(readFileSync(join(scratch, "mcp.json"), "utf8")).toBe("null");
  });

  for (const [label, level] of [["Auto", { routeAsks: true as const }], ["Full access", { stopLine: true as const }]] as const) {
    it(`${label}: a command runs through Murage's check, and the bot's MCP call reaches Murage with its identity`, async () => {
      process.env.FAKE_AGY_MCP_DUMP = join(scratch, "mcp.json");
      await create([call("run_command", { CommandLine: "echo x > f.txt" }), mcp("murage-custom-notes", "lookup", { q: "today" })]);
      const r = await turn(level, {
        integrations: { custom: { notes: { command: process.execPath, args: [], env: {} } } } as never,
      });
      expect(r.done).toMatchObject({ ok: true });
      expect(r.seen.argv).toContain("--dangerously-skip-permissions");
      expect(r.seen.argv).toContain("--log-file");
      expect(readFileSync(join(work, "f.txt"), "utf8").trim()).toBe("x");
      expect(r.opened[0]).toMatchObject({ requestType: "permission", tool: "run_command", toolCall: { name: "run_command", input: { command: "echo x > f.txt" } }, toolEngine: "antigravity" });
      expect(r.opened[1]).toMatchObject({ tool: "mcp__murage-custom-notes__lookup", toolIdentity: { namespace: "mcp", name: "murage-custom-notes__lookup" }, toolCall: { input: { q: "today" } } });
      expect(r.opened[1]!.mcpMounts).toContainEqual({ engineName: "murage-custom-notes", mountId: "custom:murage-custom-notes", provenance: "custom" });
      expect(Object.keys(JSON.parse(readFileSync(join(scratch, "mcp.json"), "utf8")).mcpServers)).toContain("murage-custom-notes");
      expect(decided.map((d) => d.hit)).toEqual([null, null]);
      expect(r.okSteps).toBe(2);
      expect(r.notices).toEqual([]);
    });

    it(`${label}: each stop-line action is refused before it runs (delete outside by path, .. and a link; pay; message someone new; a tool Murage does not read)`, async () => {
      for (const name of ["v1.txt", "v2.txt", "v3.txt"]) writeFileSync(join(outside, name), "keep");
      symlinkSync(outside, join(work, "link"));
      await create([
        call("run_command", { CommandLine: `rm ${join(outside, "v1.txt")}` }),
        call("run_command", { CommandLine: "rm ../outside/v2.txt" }),
        call("run_command", { CommandLine: "rm link/v3.txt" }),
        mcp("murage-custom-stripe", "create_charge", { customer: "cus_1", amount: 500 }),
        mcp("murage-custom-telegram", "send_message", { text: "hello" }),
        call("browser_subagent", { Task: "open the bank and pay" }),
      ]);
      const r = await turn(level, {
        integrations: { custom: { stripe: { command: process.execPath, args: [], env: {} }, telegram: { command: process.execPath, args: [], env: {} } } } as never,
      });
      expect(decided.map((d) => d.hit?.kind ?? null)).toEqual(["delete", "delete", "delete", "pay", "message", "delete"]);
      for (const name of ["v1.txt", "v2.txt", "v3.txt"]) expect(readFileSync(join(outside, name), "utf8")).toBe("keep");
      expect(r.okSteps).toBe(0);
      expect(r.opened).toHaveLength(6);
    });
  }

  it("a relay that cannot be set up keeps accept-edits with no Murage tools", async () => {
    const relayRoot = join(DATA_DIR, "native", "antigravity-relay");
    removeTempDirSync(relayRoot);
    mkdirSync(dirname(relayRoot), { recursive: true });
    writeFileSync(relayRoot, "not a folder");
    process.env.FAKE_AGY_MCP_DUMP = join(scratch, "mcp.json");
    try {
      await create([]);
      const r = await turn({ routeAsks: true }, { integrations: { custom: { notes: { command: process.execPath, args: [], env: {} } } } as never });
      expect(r.seen.argv).toContain("accept-edits");
      expect(r.seen.argv).not.toContain("--dangerously-skip-permissions");
      expect(readFileSync(join(scratch, "mcp.json"), "utf8")).toBe("null");
    } finally {
      rmSync(relayRoot, { force: true });
    }
  });

  it("an agy that did not load the hook gets no prompt: the turn is refused with one line", async () => {
    process.env.FAKE_AGY_HOOKS_IGNORED = "1";
    await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
    const r = await turn({ routeAsks: true });
    expect(r.done).toMatchObject({ ok: false, stopReason: "hook_not_loaded" });
    expect(r.seen.prompt).toBeUndefined();
    expect(existsSync(join(work, "f.txt"))).toBe(false);
    expect(r.notices).toEqual([ANTIGRAVITY_HOOK_NOT_LOADED]);
  });

  it("Cloud: the hook lives in the turn's own HOME; an agy whose HOME was replaced without it is refused, never run unguarded", async () => {
    process.env.FAKE_AGY_HOME_DUMP = join(scratch, "home.json");
    await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
    const ok = await turn({ routeAsks: true });
    const child = JSON.parse(readFileSync(join(scratch, "home.json"), "utf8")) as { home: string; seen: string[] };
    expect(child.home).not.toBe(home);
    expect(child.seen).toContain(join(".gemini", "config", "hooks.json"));
    expect(existsSync(join(home, ".gemini", "config", "hooks.json"))).toBe(false);
    expect(ok.done).toMatchObject({ ok: true });
    expect(ok.opened).toHaveLength(1);
    recorder!.stop();
    await instance!.dispose();
    rmSync(join(work, "f.txt"), { force: true });
    // a launcher put agy in another HOME, with no hooks.json there (or a broken one)
    for (const replaced of ["none", "broken"]) {
      const other = join(scratch, `replaced-${replaced}`);
      mkdirSync(join(other, ".gemini", "config"), { recursive: true });
      if (replaced === "broken") writeFileSync(join(other, ".gemini", "config", "hooks.json"), "{\"murage-relay\":");
      process.env.FAKE_AGY_HOME_OVERRIDE = other;
      await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
      const r = await turn({ routeAsks: true });
      expect(r.done).toMatchObject({ ok: false, stopReason: "hook_not_loaded" });
      expect(existsSync(join(work, "f.txt"))).toBe(false);
      recorder!.stop();
      await instance!.dispose();
      instance = undefined;
    }
  });

  it("a tool agy runs without the hook stops the turn at once", async () => {
    process.env.FAKE_AGY_SKIP_HOOKS = "1";
    await create([call("run_command", { CommandLine: "echo x > f.txt" }), call("run_command", { CommandLine: "echo y > g.txt" })]);
    const r = await turn({ routeAsks: true });
    expect(r.notices).toEqual([ANTIGRAVITY_HOOK_SKIPPED]);
  });

  // 1.0.3 hook self-guard, item 6: the backstop reads a failed tool too
  it("a tool agy fails without the hook stops the turn at once", async () => {
    process.env.FAKE_AGY_UNHOOKED_ERROR = "1";
    await create([call("run_command", { CommandLine: "echo x > f.txt" }), call("run_command", { CommandLine: "echo y > g.txt" })]);
    const r = await turn({ routeAsks: true });
    expect(r.opened).toEqual([]);
    expect(r.notices).toEqual([ANTIGRAVITY_HOOK_SKIPPED]);
  });

  // item 3: a call that names the relay's own folder is filed unread, so the broker holds it at every level
  for (const [label, level] of [["Auto", { routeAsks: true as const }], ["Full access", { stopLine: true as const }]] as const) {
    it(`${label}: a command that writes into Murage's relay folder is held, never run`, async () => {
      const probe = join(DATA_DIR, "native", "antigravity-relay", `probe-${process.pid}`);
      mkdirSync(probe, { recursive: true });
      try {
        await create([call("run_command", { CommandLine: `echo allow > ${join(probe, "murage-agy-relay.cjs")}` })]);
        const r = await turn(level);
        expect(r.opened).toHaveLength(1);
        expect(r.opened[0]!.toolInputMissing).toMatch(/Murage's check/);
        expect(decided[0]!.hit).not.toBeNull();
        expect(existsSync(join(probe, "murage-agy-relay.cjs"))).toBe(false);
        expect(r.okSteps).toBe(0);
      } finally {
        removeTempDirSync(probe);
      }
    });
  }

  // item 7 (agy 1.4.4 loads <cwd>/.agents/hooks.json and every --add-dir's beside Murage's, with no switch): a turn
  // whose folder has one runs as at Ask, with a line naming the file, checked again at every turn start
  const hookSources: Array<[string, string[], string, string[]?]> = [
    ["a project hook in .agents/hooks.json", [".agents", "hooks.json"], JSON.stringify({ "repo-allow": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true" }] }] } })],
    ["a broken .agents/hooks.json", [".agents", "hooks.json"], "{\"repo-lint\":"],
    ["an .agents/plugins.json", [".agents", "plugins.json"], "{\"plugins\":[\"/elsewhere\"]}"],
    ["a plugin's hooks.json beside its plugin.json", [".agents", "plugins", "p1", "hooks.json"], "{}", [".agents", "plugins", "p1", "plugin.json"]],
    ["a custom agent with hooks in its front matter", [".agents", "agents", "helper.md"], "---\nname: helper\nhooks:\n  PreToolUse: []\n---\n"],
  ];
  for (const [label, parts, text, extra] of hookSources) {
    it(`${label}: Auto runs as at Ask with a line naming the file, and the next turn without it is relayed`, async () => {
      const file = join(work, ...parts);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      if (extra) writeFileSync(join(work, ...extra), "{}");
      await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
      const r = await turn({ routeAsks: true });
      expect(r.seen.argv).toContain("accept-edits");
      expect(r.seen.argv).not.toContain("--dangerously-skip-permissions");
      expect(r.opened).toEqual([]);
      expect(existsSync(join(work, "f.txt"))).toBe(false);
      expect(r.notices[0]).toBe(antigravity.antigravityWorkspaceHooksNote?.(file));
      expect(r.notices.join("\n")).not.toMatch(/agy update/);
      recorder!.stop();
      await instance!.dispose();
      instance = undefined;
      removeTempDirSync(join(work, ".agents"));
      await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
      const next = await turn({ routeAsks: true });
      expect(next.seen.argv).toContain("--dangerously-skip-permissions");
      expect(next.done).toMatchObject({ ok: true });
      expect(readFileSync(join(work, "f.txt"), "utf8").trim()).toBe("x");
    });
  }

  // A folder's own hooks file turns Auto into Ask for the turn: its line says why, and Ask's "Choose Auto" line is
  // left out (the owner is on Auto). A real Ask turn still shows it.
  it("a folder's own hooks file: a refused change at Auto shows the folder's line and never Ask's \"Choose Auto\"; at Ask it still does", async () => {
    const file = join(work, ".agents", "hooks.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
    const auto = await turn({ routeAsks: true });
    expect(auto.seen.argv).toContain("accept-edits");
    expect(existsSync(join(work, "f.txt"))).toBe(false);
    expect(auto.done).toMatchObject({ ok: true });
    expect(auto.notices).toEqual([antigravity.antigravityWorkspaceHooksNote(file)]);
    expect(auto.seen.prompt).toContain("You can read files and plan, but you cannot change files or run commands.");
    expect(auto.seen.prompt).not.toContain(ASK_STOP_NOTE);
    recorder!.stop();
    await instance!.dispose();
    instance = undefined;
    await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
    const ask = await turn({ routeAsks: true, askLevel: true });
    expect(existsSync(join(work, "f.txt"))).toBe(false);
    expect(ask.notices).toEqual([ASK_STOP_NOTE]);
    expect(ask.seen.prompt?.startsWith(ASK_STOP_PROMPT)).toBe(true);
  });

  // item 7: "loaded 1 named hooks from 1 hooks.json file(s)" from the wrong file is not Murage's hook
  it("a hook count of 1 that comes from a project hooks file (one that appeared after Murage looked) refuses the turn", async () => {
    process.env.FAKE_AGY_HOOKS_IGNORED = "1";
    process.env.FAKE_AGY_CREATE_REPO_HOOK = "1";
    try {
      await create([call("run_command", { CommandLine: "echo x > f.txt" })]);
      const r = await turn({ routeAsks: true });
      expect(r.done).toMatchObject({ ok: false, stopReason: "hook_not_loaded" });
      expect(r.seen.prompt).toBeUndefined();
      expect(existsSync(join(work, "f.txt"))).toBe(false);
      expect(r.notices).toEqual([antigravity.antigravityForeignHooksNote?.(join(work, ".agents", "hooks.json"))]);
    } finally {
      delete process.env.FAKE_AGY_CREATE_REPO_HOOK;
    }
  });

  // item 7: the bot writing a workspace hooks file is held, never run
  for (const [label, level] of [["Auto", { routeAsks: true as const }], ["Full access", { stopLine: true as const }]] as const) {
    it(`${label}: a command that writes .agents/hooks.json is held, never run`, async () => {
      await create([call("run_command", { CommandLine: "mkdir -p .agents && echo '{}' > .agents/hooks.json" })]);
      const r = await turn(level);
      expect(r.opened).toHaveLength(1);
      expect(r.opened[0]!.toolInputMissing).toMatch(/hooks file Antigravity would load/);
      expect(decided[0]!.hit).not.toBeNull();
      expect(existsSync(join(work, ".agents", "hooks.json"))).toBe(false);
    });
  }
});

describe("Antigravity relay: reading agy's calls and its log", () => {
  const ours = "/d/native/antigravity-scope/t1/home/.gemini/config/hooks.json";
  const empty = mkdtempSync(join(tmpdir(), "murage-agy-empty-"));
  const none = { hooksPath: ours, workspaceDirs: [empty] };
  afterAll(() => removeTempDirSync(empty));
  /** The state, from the result object (or the bare string an older check returned). */
  const st = (result: unknown) => (typeof result === "string" ? result : (result as { state: string }).state);
  const line = (n: number, files: number) => `I1022 hooks_manager.go:53] loaded ${n} named hooks from ${files} hooks.json file(s)`;
  it("reads agy 1.4.4's hook-load line, and treats none, zero or a failure of Murage's own file as not loaded", () => {
    expect(st(relayHookLoadState(line(1, 1), none))).toBe("loaded");
    expect(st(relayHookLoadState(line(0, 0), none))).toBe("refused");
    expect(st(relayHookLoadState(`E1022 failed to parse hooks.json at ${ours}: unexpected end of JSON input\n${line(1, 1)}`, none))).toBe("refused");
    expect(st(relayHookLoadState(`E1022 Failed to parse hooks file ${ours.replace(/\//g, "\\").toUpperCase()}: bad\n${line(1, 1)}`, none))).toBe("refused");
    expect(st(relayHookLoadState(`W1022 No hooks.json found at ${ours}\n${line(1, 1)}`, none))).toBe("refused");
    expect(st(relayHookLoadState("I1022 starting", none))).toBe("pending");
  });

  // item 7: exact, never a count alone
  it("is exact: one hook from one file, every path named is Murage's own, and no workspace hooks file", () => {
    expect(st(relayHookLoadState(line(2, 2), none))).toBe("refused");
    expect(st(relayHookLoadState(line(1, 2), none))).toBe("refused");
    // a count of 1 next to a path that is not Murage's
    const foreign = relayHookLoadState(`I1022 hooks_manager.go:40] reading hooks from /w/.agents/hooks.json\n${line(1, 1)}`, none);
    expect(foreign).toEqual({ state: "foreign", file: "/w/.agents/hooks.json" });
    // a failure line for a project file is a hooks file that is not Murage's too
    expect(st(relayHookLoadState(`E1022 failed to parse hooks.json at /w/.agents/hooks.json: x\n${line(1, 1)}`, none))).toBe("foreign");
    // Murage's own path named, even with a space cut in it, is Murage's
    expect(st(relayHookLoadState(`I1022 reading hooks from ${ours}\n${line(1, 1)}`, none))).toBe("loaded");
    expect(st(relayHookLoadState(`I1022 reading hooks from /Users/Jo Smith/x/.gemini/config/hooks.json\n${line(1, 1)}`, { hooksPath: "/Users/Jo Smith/x/.gemini/config/hooks.json", workspaceDirs: [empty] }))).toBe("loaded");
    // a count of 1 while a workspace folder holds a hooks file
    const work = mkdtempSync(join(tmpdir(), "murage-agy-ws-"));
    try {
      mkdirSync(join(work, ".agents"), { recursive: true });
      writeFileSync(join(work, ".agents", "hooks.json"), "{}");
      expect(relayHookLoadState(line(1, 1), { hooksPath: ours, workspaceDirs: [work] })).toEqual({ state: "foreign", file: join(work, ".agents", "hooks.json") });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("finds every hooks source agy reads in a workspace folder: hooks.json, plugins.json, a plugin's hooks.json with its plugin.json, an agent with hooks in its front matter, links included", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-agy-repo-"));
    const found = (dir: string) => (relayModule.antigravityWorkspaceHookFiles?.([dir]) ?? []).sort();
    try {
      const at = (...parts: string[]) => join(root, ...parts);
      const write = (path: string, text = "{}") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
      for (const name of [".agents", ".agent", "_agents", "_agent"]) mkdirSync(at(name), { recursive: true });
      write(at(".agents", "hooks.json"));
      write(at(".agent", "plugins.json"), "{\"plugins\":[\"/anywhere/p\"]}");
      write(at(".agents", "plugins", "with", "plugin.json"));
      write(at(".agents", "plugins", "with", "hooks.json"));
      write(at(".agents", "plugins", "without", "hooks.json"));
      write(at(".agents", "agents", "hooked.md"), "---\nname: helper\nhooks:\n  PreToolUse: []\n---\nbody\n");
      write(at(".agents", "agents", "plain.md"), "---\nname: plain\n---\nhooks: only in the body\n");
      write(at(".agents", "agents", "nofront.md"), "hooks: not front matter\n");
      write(at(".agents", "skills", "hooks.json"));
      write(at(".agents", "hooks", "hooks.json"));
      write(at(".gemini", "hooks.json"));
      symlinkSync(at("nowhere.json"), at("_agent", "hooks.json"));
      expect(found(root)).toEqual([
        at(".agent", "plugins.json"),
        at(".agents", "agents", "hooked.md"),
        at(".agents", "hooks.json"),
        at(".agents", "plugins", "with", "hooks.json"),
        at("_agent", "hooks.json"),
      ].sort());
      // a parent folder's .agents is not read
      mkdirSync(at("sub"), { recursive: true });
      expect(found(at("sub"))).toEqual([]);
      expect(found(empty)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // item 3
  it("files a call that names the relay's own folder or files as unread", () => {
    const cwd = mkdtempSync(join(tmpdir(), "murage-agy-relay-"));
    const own = join(cwd, "data", "native", "antigravity-relay", "agy-t1");
    mkdirSync(own, { recursive: true });
    try {
      const ask = (tool_name: string, tool_input: Record<string, unknown>) => antigravityRelayAsk({ tool_name, tool_input, tool_use_id: "c:1" }, cwd, own);
      for (const [name, args] of [
        ["write_to_file", { TargetFile: join(own, "murage-agy-relay.cjs"), CodeContent: "x" }],
        ["write_to_file", { TargetFile: join(own, "murage-agy-relay.env").replace(/\//g, "\\").toUpperCase(), CodeContent: "x" }],
        ["replace_file_content", { TargetFile: join(realpathSync(own), "murage-agy-relay.cjs") }],
        ["run_command", { CommandLine: `cp /tmp/x ${own}/` }],
        ["run_command", { CommandLine: "cp /tmp/x ../data/native/antigravity-relay/agy-t2/murage-agy-relay.cjs" }],
        ["run_command", { CommandLine: "tee murage-agy-relay.cjs < /tmp/x" }],
        ["view_file", { AbsolutePath: join(own, "hooks.json") }],
        ["call_mcp_tool", { ServerName: "fs", ToolName: "write", Arguments: { files: [{ path: join(own, "murage-agy-relay.cjs") }] } }],
        // the Win32 spellings (SG-WIN-PATHTRICKS.md): a trailing dot, a stream suffix, the \\?\ prefix, a loopback share
        ["write_to_file", { TargetFile: `${join(own, "murage-agy-relay.cjs")}.`, CodeContent: "x" }],
        ["write_to_file", { TargetFile: `${join(own, "murage-agy-relay.env")}::$DATA`, CodeContent: "x" }],
        ["write_to_file", { TargetFile: `\\\\?\\C:\\data\\native\\antigravity-relay\\agy-t1\\murage-agy-relay.cjs`, CodeContent: "x" }],
        ["write_to_file", { TargetFile: `\\\\localhost\\C$\\data\\native\\antigravity-relay\\agy-t1\\murage-agy-relay.cjs:evil`, CodeContent: "x" }],
        ["run_command", { CommandLine: "Copy-Item -Recurse x C:\\work\\.agents\\plugins." }],
        ["run_command", { CommandLine: "Move-Item x .agents\\agents::$DATA" }],
      ] as const) {
        expect(ask(name, args).toolInputMissing, `${name} ${JSON.stringify(args)}`).toMatch(/Murage's check/);
      }
      expect(ask("write_to_file", { TargetFile: join(cwd, "src", "a.ts"), CodeContent: "x" }).toolInputMissing).toBeUndefined();
      expect(ask("run_command", { CommandLine: "npx vitest run server/drivers/antigravity-relay.test.ts" }).toolInputMissing).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("holds a command run from a folder outside the bot's, and any tool it does not read", () => {
    const cwd = mkdtempSync(join(tmpdir(), "murage-agy-relay-"));
    try {
      expect(antigravityRelayAsk({ tool_name: "run_command", tool_input: { CommandLine: "rm x", Cwd: "/" }, tool_use_id: "c:1" }, cwd).toolInputMissing).toMatch(/outside the bot's folder/);
      expect(antigravityRelayAsk({ tool_name: "run_command", tool_input: { CommandLine: "rm x", Cwd: cwd }, tool_use_id: "c:1" }, cwd).toolInputMissing).toBeUndefined();
      expect(antigravityRelayAsk({ tool_name: "run_command", tool_input: {}, tool_use_id: "c:1" }, cwd).toolInputMissing).toBe("CommandLine");
      expect(antigravityRelayAsk({ tool_name: "shell_v2", tool_input: { Cmd: "rm -rf /" }, tool_use_id: "c:1" }, cwd).toolInputMissing).toMatch(/does not read/);
      expect(antigravityRelayAsk({ tool_name: "send_command_input", tool_input: { Input: "rm ../x" }, tool_use_id: "c:1" }, cwd).toolCall).toEqual({ name: "run_command", input: { command: "rm ../x" } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
