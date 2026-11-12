import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Ask hard stop (ask-stop.ts) for the three engines that cannot ask before every change: Cursor, OpenClaw and
// Antigravity. At Ask they may read and plan; every file change or command is refused before it runs, a turn whose
// read-only switch cannot be set does not run, and the bot shows one plain note. Auto runs exactly as before.
// Runs against the scripted fake ACP CLI and fake agy; no real engine is started.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { HOOK_LOADER } from "../hook-canon.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { turnPermissionEnforcement } from "../routine-permissions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { createAcpDriver } from "./acp/core.ts";
import { createCursorAgentDriver } from "./acp/cursor.ts";
import {
  applyOpenclawAskStop,
  OPENCLAW_DENY_REFUSAL,
  OPENCLAW_READ_ONLY_NOTICE,
  openclawHasPermissionMode,
  OPENCLAW_ASK_STOP_DIRECTIVE,
  openclawPromptText,
  openclawSupport,
  openclawVersionNote,
} from "./acp/openclaw.ts";
import { buildAntigravityScopedHome } from "./antigravity-scope.ts";
import {
  ANTIGRAVITY_ASK_HOOK_SOURCE,
  ANTIGRAVITY_ASK_READS,
  AntigravityDriver,
  antigravityAskStopHooks,
} from "./antigravity.ts";
import { TURN_ASK_RULES } from "../../shared/ask-wording.ts";
import {
  ASK_STOP_NOTE,
  ASK_STOP_PROMPT,
  askStopChangeKind,
  askStopRefusesKind,
  askStopUnavailableLine,
  replyCarriesAskStopNote,
} from "./ask-stop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(HERE, "..", "testing", "fake-acp-cli.ts");
const FAKE_AGY = join(HERE, "..", "testing", "fake-agy-cli.ts");
const CURSOR_MODES = JSON.stringify({ currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }] });

const notes = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "item.started" && (e as { toolKind?: string }).toolKind === "notice" && (e as { title?: string }).title === ASK_STOP_NOTE);

const FAKE_ENV = [
  "FAKE_ACP_MODE", "FAKE_ACP_DUMP", "FAKE_ACP_PROMPT_DUMP", "FAKE_ACP_SESSION_MODES", "FAKE_ACP_PERMISSION_COMMAND",
  "FAKE_AGY_DUMP", "FAKE_AGY_TOOL", "FAKE_AGY_RUN_HOOKS", "FAKE_AGY_HOME_DUMP", "FAKE_ACP_VERSION",
];

describe("Ask hard stop: copy and the level a turn carries", () => {
  it("an Ask bot's turn says so; Auto and Full access do not", () => {
    expect(turnPermissionEnforcement({ autoApprove: false })).toEqual({ routeAsks: true, askLevel: true });
    expect(turnPermissionEnforcement({ autoApprove: true })).toEqual({ routeAsks: true });
    expect(turnPermissionEnforcement({ autoApprove: true, fullAccess: true })).toEqual({ stopLine: true });
  });

  it("the note says what the bot can do, in plain words", () => {
    expect(ASK_STOP_NOTE).toBe("At Ask, I can read and plan. Choose Auto to let me make changes.");
    for (const text of [ASK_STOP_NOTE, ASK_STOP_PROMPT, askStopUnavailableLine("Cursor")]) {
      expect(text).not.toMatch(/\u2014|\bsafe|unsafe|safety/i);
    }
    expect(ASK_STOP_PROMPT).toContain(ASK_STOP_NOTE);
    expect(replyCarriesAskStopNote(`I would edit it.\n\nAt Ask, I can read and plan.\nChoose Auto to let me make changes.`)).toBe(true);
    expect(replyCarriesAskStopNote("Switch to Agent mode")).toBe(false);
  });

  it("fails closed: only a read, search, think or fetch reaches a card; changes are what stop a turn", () => {
    for (const kind of ["read", "search", "think", "fetch"]) expect(askStopRefusesKind(kind)).toBe(false);
    for (const kind of ["edit", "delete", "move", "execute", "switch_mode", "other", "", undefined, 7]) expect(askStopRefusesKind(kind)).toBe(true);
    for (const kind of ["edit", "delete", "move", "execute"]) expect(askStopChangeKind(kind)).toBe(true);
    for (const kind of ["read", "other", undefined]) expect(askStopChangeKind(kind)).toBe(false);
  });
});

describe("Ask hard stop: Cursor (ACP, read-only session mode)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_ACP, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-ask-stop-cursor-"));
    process.env.FAKE_ACP_SESSION_MODES = CURSOR_MODES;
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    for (const name of FAKE_ENV) delete process.env[name];
    await removeTempDir(scratch);
  });

  const create = async () => {
    instance = await createCursorAgentDriver().create({
      instanceId: "cursor-ask-stop", displayName: "Cursor", environment: {}, enabled: true,
      config: { cli: FAKE_ACP, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  const run = async (turn: SendTurnInput) => {
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), ...turn });
    return recorder!.until((e) => e.type === "turn.completed" && e.threadId === turn.threadId);
  };
  const ASK = { routeAsks: true as const, askLevel: true as const };

  it("at Ask, sets Cursor's read-only \"ask\" mode before the prompt and tells the model what it can do", async () => {
    const dump = join(scratch, "dump.json");
    const promptDump = join(scratch, "prompt.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
    await create();
    const done = await run({ threadId: "t-ask", text: "read notes.txt", ...ASK });
    expect(done).toMatchObject({ ok: true });
    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string; params: { modeId?: string } }>;
    expect(applied).toContainEqual({ method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "ask" } });
    const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    // 1.0.4 QW (21e9b0f53): the ask rule line rides in the system text, in front of the Ask preamble and the owner's words.
    expect(text.startsWith(`${TURN_ASK_RULES}\n\n${ASK_STOP_PROMPT}\n\nread notes.txt`)).toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["acp"]);
  });

  it("at Auto, nothing changes: no mode is set and the prompt carries no Ask line", async () => {
    const dump = join(scratch, "dump.json");
    const promptDump = join(scratch, "prompt.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
    await create();
    const done = await run({ threadId: "t-auto", text: "edit notes.txt", routeAsks: true });
    expect(done).toMatchObject({ ok: true });
    expect(existsSync(`${dump}.config.json`)).toBe(false);
    const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    expect(text).not.toContain(ASK_STOP_PROMPT);
    expect(notes(recorder!.events)).toEqual([]);
  });

  it("fails closed: an Ask turn whose read-only mode cannot be set does not run", async () => {
    process.env.FAKE_ACP_MODE = "no-session-config";
    await create();
    const done = await run({ threadId: "t-no-mode", text: "edit notes.txt", ...ASK });
    expect(done).toMatchObject({ ok: false });
    const err = recorder!.events.find((e) => e.type === "runtime.error") as { message: string } | undefined;
    expect(err?.message).toContain(askStopUnavailableLine("Cursor"));
    expect(recorder!.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("fails closed: an engine that does not list the read-only mode is not prompted at Ask", async () => {
    process.env.FAKE_ACP_SESSION_MODES = JSON.stringify({ currentModeId: "agent", availableModes: [{ id: "agent" }] });
    await create();
    const done = await run({ threadId: "t-unlisted", text: "edit notes.txt", ...ASK });
    expect(done).toMatchObject({ ok: false });
    expect(recorder!.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("at Ask, a shell or edit ask is refused with no card, and the note shows once", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_COMMAND = "echo PROBE > ran.txt";
    await create();
    const done = await run({ threadId: "t-ask-shell", text: "run it", ...ASK });
    expect(done).toMatchObject({ ok: true });
    expect(recorder!.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Auto, the same shell ask still opens the owner's card", async () => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_COMMAND = "echo PROBE > ran.txt";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-auto-shell", text: "run it", routeAsks: true });
    const opened = await recorder!.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
    await instance!.adapter.interruptTurn("t-auto-shell");
    expect(notes(recorder!.events)).toEqual([]);
  });

  it("at Ask, an edit the engine reports as done stops the turn at once, with the note", async () => {
    process.env.FAKE_ACP_MODE = "unasked-edit";
    await create();
    const done = await run({ threadId: "t-ask-ran", text: "edit notes.txt", ...ASK });
    expect(done).toMatchObject({ stopReason: "cancelled" });
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Auto, the same edit is the engine's own business, as before", async () => {
    process.env.FAKE_ACP_MODE = "refused-edit";
    await create();
    const done = await run({ threadId: "t-auto-edit", text: "edit notes.txt", routeAsks: true });
    expect(done).toMatchObject({ ok: true, stopReason: null });
    expect(notes(recorder!.events)).toEqual([]);
  });

  it("a later Auto turn on the same session puts Cursor back in \"agent\" mode", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();
    const first = await run({ threadId: "t-back", text: "look", ...ASK });
    const started = recorder!.events.find((e) => e.type === "session.started" && e.threadId === "t-back") as { sessionId: string };
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-back", text: "now change it", routeAsks: true, resumeCursor: started.sessionId });
    const second = await recorder!.until((e) => e.type === "turn.completed" && e.threadId === "t-back" && e !== first);
    expect(second).toMatchObject({ ok: true });
    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string; params: { modeId?: string } }>;
    expect(applied.filter((c) => c.method === "session/set_mode").map((c) => c.params.modeId)).toEqual(["agent"]);
  });

  it("a session that reports the read-only mode as current is put back in \"agent\" at Auto (after a restart)", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_SESSION_MODES = JSON.stringify({ currentModeId: "ask", availableModes: [{ id: "agent" }, { id: "ask" }] });
    await create();
    await run({ threadId: "t-restart", text: "change it", routeAsks: true });
    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string; params: { modeId?: string } }>;
    expect(applied).toEqual([{ method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "agent" } }]);
  });
});

describe("Ask hard stop: OpenClaw deny fallback", () => {
  let dataDir: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  beforeEach(() => { ensureDirs(); chmodSync(FAKE_ACP, 0o755); dataDir = mkdtempSync(join(tmpdir(), "murage-ask-stop-openclaw-")); });
  afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; for (const name of FAKE_ENV) delete process.env[name]; await removeTempDir(dataDir); });

  it("R2 old and unreadable versions disclose refusal without an Auto escape", async () => {
    for (const version of ["2026.7.35", "2026.8.1-beta.1", ""]) {
      expect(openclawVersionNote(version)).toBe(OPENCLAW_DENY_REFUSAL);
      expect(openclawSupport.versionNote?.(version)).toBe(OPENCLAW_DENY_REFUSAL);
      await expect(applyOpenclawAskStop({ env: {}, config: { cli: FAKE_ACP, fullAuto: false }, turn: { threadId: "old" }, askLevel: false }, async () => { throw new Error("must not call"); }, dataDir, async () => version)).rejects.toThrow(OPENCLAW_DENY_REFUSAL);
    }
  });

  it("the permissionMode floor remains separate from admission", () => {
    for (const v of ["2026.8.1", "2026.10.5", "2026.10.10-beta.3", "2027.1.1"]) {
      expect(openclawHasPermissionMode(v)).toBe(true);
      expect(openclawVersionNote(v)).toBeUndefined();
    }
    for (const v of ["2026.7.35", "2026.8.1-beta.1", ""]) expect(openclawHasPermissionMode(v)).toBe(false);
  });

  it("R1 Ask and Auto both carry the deny directive", () => {
    expect(OPENCLAW_ASK_STOP_DIRECTIVE).toBe("/exec security=deny");
    for (const askLevel of [true, undefined] as const) expect(openclawPromptText({ text: "go", system: "Fred", askLevel })).toBe("/exec security=deny\nFred\n\ngo");
  });

  it("R6 the fallback notice is Murage authored even when the model refuses an edit", async () => {
    instance = await createAcpDriver({ ...openclawSupport, prePrompt: { notice: OPENCLAW_READ_ONLY_NOTICE, refusal: OPENCLAW_DENY_REFUSAL, apply: async () => {} } }).create({
      instanceId: "openclaw-ask", displayName: "OpenClaw", environment: { FAKE_ACP_MODE: "refused-edit" }, enabled: true,
      config: { cli: FAKE_ACP, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "ask", text: "edit", askLevel: true, routeAsks: true });
    await recorder.until(e => e.type === "turn.completed");
    expect(notes(recorder.events)).toHaveLength(1);
    expect(recorder.events.filter(e => e.type === "item.started" && e.itemType === "tool" && e.origin === "murage" && e.title === OPENCLAW_READ_ONLY_NOTICE)).toHaveLength(1);
  });
});

describe("Ask hard stop: Antigravity (PreToolUse hook)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_AGY, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-ask-stop-agy-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    for (const name of FAKE_ENV) delete process.env[name];
    await removeTempDir(scratch);
  });
  const create = async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-ask-stop", displayName: "Antigravity", environment: {}, enabled: true,
      config: { cli: FAKE_AGY, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };
  const runHook = (tool: unknown) => {
    const script = join(scratch, "hook.cjs");
    writeFileSync(script, ANTIGRAVITY_ASK_HOOK_SOURCE);
    const input = typeof tool === "string" ? JSON.stringify({ toolCall: { name: tool, args: {} } }) : String(tool);
    return JSON.parse(execFileSync(process.execPath, [script], { windowsHide: true, input, encoding: "utf8" })) as { decision: string; reason?: string };
  };

  it("the hook allows only reads and denies everything else with the note, unknown input included", () => {
    for (const read of ANTIGRAVITY_ASK_READS) expect(runHook(read)).toEqual({ decision: "allow" });
    for (const other of ["write_file", "edit_file", "run_command", "invoke_subagent", "schedule", "manage_task", "", "READ_FILE"]) {
      expect(runHook(other)).toEqual({ decision: "deny", reason: ASK_STOP_NOTE });
    }
    expect(runHook("not json {")).toEqual({ decision: "deny", reason: ASK_STOP_NOTE });
  });

  it("hooks.json runs the hook on every tool, through this program, quoted for sh and for cmd", () => {
    const hash = createHash("sha256").update(ANTIGRAVITY_ASK_HOOK_SOURCE).digest("hex");
    const script = join(scratch, "native", "antigravity-ask", `ask-hook-${hash.slice(0, 16)}.cjs`);
    const posix = JSON.parse(antigravityAskStopHooks(scratch, "/opt/Murage", "linux"));
    const group = posix["murage-ask-stop"].PreToolUse[0];
    expect(group.matcher).toBe("*");
    expect(group.hooks[0].command).toMatch(/^'\/opt\/Murage' -e "/);
    expect(group.hooks[0].command).toMatch(/ '.*ask-hook-[0-9a-f]{16}\.cjs' [0-9a-f]{64}$/);
    const win = JSON.parse(antigravityAskStopHooks(scratch, "C:\\Program Files\\Murage\\Murage.exe", "win32"));
    const winCommand = win["murage-ask-stop"].PreToolUse[0].hooks[0].command;
    expect(winCommand).toMatch(/^""C:\\Program Files\\Murage\\Murage\.exe" -e "/);
    expect(winCommand).toMatch(/" ".*\.cjs" [0-9a-f]{64}"$/);
    for (const command of [group.hooks[0].command, winCommand]) {
      expect(command).toContain(`"${HOOK_LOADER.antigravity}"`);
      expect(command).toContain(hash);
    }
    expect(readFileSync(script, "utf8")).toBe(ANTIGRAVITY_ASK_HOOK_SOURCE);
    const command = JSON.parse(antigravityAskStopHooks(scratch))["murage-ask-stop"].PreToolUse[0].hooks[0].command;
    expect(JSON.parse(execSync(command, { input: JSON.stringify({ toolCall: { name: "write_file", args: {} } }), encoding: "utf8" }))).toEqual({ decision: "deny", reason: ASK_STOP_NOTE });
    // Design 3.3: the pinned loader verifies the full digest before executing the hook.
    expect(group.hooks[0].command).toBe(`'/opt/Murage' -e "${HOOK_LOADER.antigravity}" '${script}' ${hash}`);
    expect(win["murage-ask-stop"].PreToolUse[0].hooks[0].command).toBe(`""C:\\Program Files\\Murage\\Murage.exe" -e "${HOOK_LOADER.antigravity}" "${script}" ${hash}"`);
    expect(readFileSync(script, "utf8")).toBe(ANTIGRAVITY_ASK_HOOK_SOURCE);
  });

  it("the Ask hook file is Murage's: it goes with the scoped home and never reaches the owner's own setup", () => {
    const realHome = join(scratch, "real");
    const scopeRoot = join(scratch, "scopes");
    const scoped = buildAntigravityScopedHome({ realHome, scopeRoot, name: "ask-hook", servers: {}, askStopHooks: "{\"x\":{}}\n" });
    expect(readFileSync(join(scoped.home, ".gemini", "config", "hooks.json"), "utf8")).toBe("{\"x\":{}}\n");
    scoped.dispose();
    expect(existsSync(join(realHome, ".gemini", "config", "hooks.json"))).toBe(false);
    expect(existsSync(join(scratch, "antigravity-kept"))).toBe(false);
    expect(existsSync(scoped.home)).toBe(false);
  });

  it("at Ask, a write is denied by the hook before it runs, and the note shows once", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_TOOL = "write_file";
    process.env.FAKE_AGY_RUN_HOOKS = "1";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-ask", text: "write notes", routeAsks: true, askLevel: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.hook.json`, "utf8"))).toEqual({ tool: "write_file", denial: ASK_STOP_NOTE });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("accept-edits");
    expect(seen.argv).not.toContain("--dangerously-skip-permissions");
    expect(seen.prompt.startsWith(ASK_STOP_PROMPT)).toBe(true);
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Ask, a shell command is denied the same way", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_TOOL = "run_command";
    process.env.FAKE_AGY_RUN_HOOKS = "1";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-shell", text: "run it", routeAsks: true, askLevel: true });
    await recorder!.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.hook.json`, "utf8"))).toEqual({ tool: "run_command", denial: ASK_STOP_NOTE });
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Ask, a read still runs, with no note", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_TOOL = "read_file";
    process.env.FAKE_AGY_RUN_HOOKS = "1";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-read", text: "read notes", routeAsks: true, askLevel: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.hook.json`, "utf8"))).toEqual({ tool: "read_file", denial: null });
    expect(notes(recorder!.events)).toEqual([]);
  });

  it("at Ask, a change agy reports as done (the hook did not hold) stops the turn, with the note", async () => {
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-ran", text: "write notes", routeAsks: true, askLevel: true });
    await recorder!.until((e) => e.type === "turn.completed");
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Ask, a change that ran anyway ends the turn as Murage's Ask stop, never as the owner's Stop", async () => {
    // The comms GATE "Gemini Antigravity at ask": the turn ended "cancelled" (shown as "Stopped by you") and agy's
    // reply was dropped, so the chat never got its closing reply.
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-halt", text: "write notes", routeAsks: true, askLevel: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "ask_stop" });
    expect(notes(recorder!.events)).toHaveLength(1);
    expect(recorder!.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("at Ask, the halted turn still shows agy's reply: content.delta and assistant_text come before the settle", async () => {
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-halt-reply", text: "write notes", routeAsks: true, askLevel: true });
    await recorder!.until((e) => e.type === "turn.completed");
    const events = recorder!.events;
    const settled = events.findIndex((e) => e.type === "turn.completed");
    const delta = events.findIndex((e) => e.type === "content.delta" && (e as { streamKind?: string }).streamKind === "assistant_text");
    const text = events.findIndex((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text");
    expect(events[settled]).toMatchObject({ ok: true, stopReason: "ask_stop" });
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThan(settled);
    expect(text).toBeGreaterThanOrEqual(0);
    expect(text).toBeLessThan(settled);
    expect(String((events[text] as { text?: string }).text ?? "").length).toBeGreaterThan(0);
  });

  it("at Auto, no Ask hook and no Ask line: the write goes through Murage's relay and runs", async () => {
    const dump = join(scratch, "dump.json");
    const homeDump = join(scratch, "home.json");
    process.env.FAKE_AGY_DUMP = dump;
    process.env.FAKE_AGY_HOME_DUMP = homeDump;
    process.env.FAKE_AGY_TOOL = "write_file";
    process.env.FAKE_AGY_RUN_HOOKS = "1";
    await create();
    const off = instance!.adapter.onEvent((e) => {
      if (e.type === "request.opened") void instance!.adapter.respondToRequest(e.threadId, (e as { requestId: string }).requestId, { behavior: "allow" });
    });
    await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-agy-auto", text: "write notes", routeAsks: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    off();
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.hook.json`, "utf8"))).toEqual({ tool: "write_file", denial: null });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--dangerously-skip-permissions");
    expect(seen.argv).not.toContain("accept-edits");
    expect(seen.prompt.startsWith(ASK_STOP_PROMPT)).toBe(false);
    expect((JSON.parse(readFileSync(homeDump, "utf8")).seen as string[]).some((p) => p.endsWith("hooks.json"))).toBe(true);
    expect(recorder!.events.some((e) => e.type === "request.opened" && (e as { tool?: string }).tool === "write_file")).toBe(true);
    expect(notes(recorder!.events)).toEqual([]);
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
