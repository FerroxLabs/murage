// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Ask hard stop (ask-stop.ts) for the three engines that cannot ask before every change: Cursor, OpenClaw and
// Antigravity. At Ask they may read and plan; every file change or command is refused before it runs, a turn whose
// read-only switch cannot be set does not run, and the bot shows one plain note. Auto runs exactly as before.
// Runs against the scripted fake ACP CLI and fake agy; no real engine is started.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { turnPermissionEnforcement } from "../routine-permissions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { openclawSessionKey } from "../openclaw-profiles.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { createAcpDriver } from "./acp/core.ts";
import { createCursorAgentDriver } from "./acp/cursor.ts";
import {
  applyOpenclawAskStop,
  openclawHasPermissionMode,
  OPENCLAW_ASK_STOP_DIRECTIVE,
  openclawAskStopRecordPath,
  openclawPromptText,
  openclawSupport,
  openclawVersionNote,
  type OpenclawGatewayCall,
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
  AskStopRefusal,
  ASK_STOP_OPENCLAW_OLD_NOTE,
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
    await instance!.adapter.sendTurn(turn);
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
    await instance!.adapter.sendTurn({ threadId: "t-auto-shell", text: "run it", routeAsks: true });
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
    await instance!.adapter.sendTurn({ threadId: "t-back", text: "now change it", routeAsks: true, resumeCursor: started.sessionId });
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

describe("Ask hard stop: OpenClaw (Gateway session read-only mode)", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "murage-ask-stop-openclaw-")); });
  afterEach(async () => { await removeTempDir(dataDir); });

  /** A Gateway stand-in: one session row whose permission mode the calls read and patch. */
  const gateway = (start: string | null, opts: { confirm?: boolean; fail?: string } = {}) => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let mode = start;
    const call: OpenclawGatewayCall = async (_cli, method, params) => {
      calls.push({ method, params });
      if (opts.fail === method) throw new Error("gateway closed");
      if (method === "sessions.list") return { sessions: [{ key: params.search, ...(mode ? { permissionMode: mode } : {}) }] };
      if (method === "sessions.patch") {
        if (opts.confirm !== false) mode = (params.permissionMode as string | null) ?? null;
        return { ok: true, key: params.key, entry: mode ? { permissionMode: mode } : {} };
      }
      throw new Error(`unexpected ${method}`);
    };
    return { call, calls, mode: () => mode };
  };
  const config = { cli: "openclaw", fullAuto: false, agent: "fred" } as never;
  // the turn's own Gateway session (1.0.4: one per conversation and audience, openclawSessionKey)
  const turn = { threadId: "t-ask", warmIdentity: { audience: "owner" } } as never;
  const KEY = openclawSessionKey("fred", { threadId: "t-ask", audience: "owner" });
  const okVersion = async () => "OpenClaw 2026.10.10-beta.3 (abc1234)";

  it("on a release below the floor (2026.7.35: no permissionMode on sessions.patch), an Ask turn is refused before anything runs, with one plain note", async () => {
    const gw = gateway("guarded");
    const old = async () => "OpenClaw 2026.7.35 (1b58cb9)";
    await expect(applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, old))
      .rejects.toThrow("At Ask, this OpenClaw version cannot stop before changes. Choose Auto to let me act, or install OpenClaw 2026.8.1 or newer.");
    expect(gw.calls).toEqual([]);
    expect(existsSync(openclawAskStopRecordPath("openclaw", KEY, dataDir))).toBe(false);
    // an unreadable version fails closed too
    await expect(applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, async () => { throw new Error("no cli"); })).rejects.toThrow(/cannot stop before changes/);
    expect(gw.calls).toEqual([]);
    // Auto on the old release calls nothing, as before
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: false }, gw.call, dataDir, old);
    expect(gw.calls).toEqual([]);
  });

  it("the permissionMode floor is 2026.8.1: it and later pass (extended-stable 2026.9.33, latest 2026.10.5); earlier releases and its betas fail", () => {
    for (const v of ["2026.8.1", "2026.8.35", "2026.9.1", "2026.9.33", "OpenClaw 2026.10.5 (1b58cb9)", "2026.10.10-beta.3", "2026.10.10", "2026.11.1", "2027.1.1"]) expect(openclawHasPermissionMode(v), v).toBe(true);
    for (const v of ["2026.7.35", "2026.7.1-2", "2026.8.1-beta.1", "2026.6.1", "2025.12.31", "", "latest"]) expect(openclawHasPermissionMode(v), v).toBe(false);
  });

  it("on the npm latest release (2026.10.5), an Ask turn passes the version gate and runs read-only", async () => {
    const gw = gateway("guarded");
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, async () => "OpenClaw 2026.10.5 (1b58cb9)");
    expect(gw.mode()).toBe("read-only");
    expect(gw.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.patch"]);
  });

  it("fails closed on the Gateway's stored state, not our request: a patch answer without a read-only entry refuses the Ask turn", async () => {
    const answers: Array<Record<string, unknown>> = [
      { ok: true, key: KEY, entry: {} }, // the field was taken but not applied
      { ok: true, key: KEY, entry: { permissionMode: "guarded" } }, // an older mode left in place
      { ok: true, key: KEY }, // no entry at all
      { ok: true, key: KEY, permissionMode: "read-only" }, // our request echoed, no stored entry
      { ok: false, entry: { permissionMode: "read-only" } },
    ];
    for (const answer of answers) {
      const call: OpenclawGatewayCall = async (_cli, method) =>
        method === "sessions.list" ? { sessions: [{ key: KEY, permissionMode: "guarded" }] } : answer;
      await expect(applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, call, dataDir, async () => "OpenClaw 2026.10.5 (1b58cb9)"),
        JSON.stringify(answer)).rejects.toThrow(/did not confirm read-only/);
    }
  });

  it("setup and engine detection show the same line beside an OpenClaw version below the floor, and none at or above it", () => {
    for (const v of ["OpenClaw 2026.7.35 (1b58cb9)", "2026.8.1-beta.1", ""]) {
      expect(openclawVersionNote(v)).toBe(ASK_STOP_OPENCLAW_OLD_NOTE);
      expect(openclawSupport.versionNote?.(v)).toBe(ASK_STOP_OPENCLAW_OLD_NOTE);
    }
    for (const v of ["OpenClaw 2026.10.5 (1b58cb9)", "2026.8.1", "OpenClaw 2026.10.10-beta.3 (abc1234)", "2026.10.10", "2026.11.1"]) expect(openclawSupport.versionNote?.(v)).toBeUndefined();
    expect(ASK_STOP_OPENCLAW_OLD_NOTE).toBe("At Ask, this OpenClaw version cannot stop before changes. Choose Auto to let me act, or install OpenClaw 2026.8.1 or newer.");
  });

  it("at Ask, records the session's mode once, then sets read-only and requires the Gateway to confirm it", async () => {
    const gw = gateway("guarded");
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, okVersion);
    expect(gw.mode()).toBe("read-only");
    expect(gw.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.patch"]);
    expect(gw.calls[1]!.params).toEqual({ key: KEY, permissionMode: "read-only" });
    const record = JSON.parse(readFileSync(openclawAskStopRecordPath("openclaw", KEY, dataDir), "utf8"));
    expect(record).toEqual({ key: KEY, previous: "guarded" });
    // a second Ask turn keeps the first record: it never records its own read-only as the owner's mode
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, okVersion);
    expect(gw.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.patch", "sessions.patch"]);
    expect(JSON.parse(readFileSync(openclawAskStopRecordPath("openclaw", KEY, dataDir), "utf8")).previous).toBe("guarded");
  });

  it("fails closed: a Gateway that does not confirm read-only, or cannot be reached, refuses the Ask turn", async () => {
    await expect(applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gateway(null, { confirm: false }).call, dataDir, okVersion)).rejects.toThrow(/did not confirm read-only/);
    await expect(applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gateway(null, { fail: "sessions.patch" }).call, dataDir, okVersion)).rejects.toThrow(/gateway closed/);
  });

  it("at Auto, puts back the mode an Ask turn replaced (none: cleared), then forgets it", async () => {
    const gw = gateway(null);
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, okVersion);
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: false }, gw.call, dataDir, okVersion);
    expect(gw.calls.at(-1)).toEqual({ method: "sessions.patch", params: { key: KEY, permissionMode: null } });
    expect(gw.mode()).toBeNull();
    expect(existsSync(openclawAskStopRecordPath("openclaw", KEY, dataDir))).toBe(false);
    const before = gw.calls.length;
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: false }, gw.call, dataDir, okVersion);
    expect(gw.calls.length).toBe(before); // no record: Auto calls nothing, exactly as before
  });

  it("at Auto, an owner who changed the mode since keeps their choice", async () => {
    const gw = gateway("guarded");
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: true }, gw.call, dataDir, okVersion);
    await gw.call("openclaw", "sessions.patch", { key: KEY, permissionMode: "workspace" }, {});
    await applyOpenclawAskStop({ env: {}, config, turn, askLevel: false }, gw.call, dataDir, okVersion);
    expect(gw.mode()).toBe("workspace");
    expect(existsSync(openclawAskStopRecordPath("openclaw", KEY, dataDir))).toBe(false);
  });

  it("at Ask, the prompt's directive denies every shell command (unchanged)", () => {
    expect(OPENCLAW_ASK_STOP_DIRECTIVE).toBe("/exec security=deny");
    expect(openclawPromptText({ text: "go", askLevel: true }).split("\n")[0]).toBe("/exec security=deny");
  });

  it("at Auto and Full access, the prompt carries no /exec directive, as in 1.0.2 (ask=always refused redirects and &&)", () => {
    const text = openclawPromptText({ text: "echo hi > out.txt && cat out.txt" });
    expect(text).toBe("echo hi > out.txt && cat out.txt");
    expect(text).not.toContain("/exec");
    expect(openclawPromptText({ system: "You are Fred.", text: "go" })).toBe("You are Fred.\n\ngo");
  });

  describe("driver turns (fake ACP CLI)", () => {
    let instance: ProviderInstance | undefined;
    let recorder: EventRecorder | undefined;
    let scratch: string;
    beforeEach(() => {
      ensureDirs();
      chmodSync(FAKE_ACP, 0o755);
      scratch = mkdtempSync(join(tmpdir(), "murage-ask-stop-oc-turn-"));
      process.env.FAKE_ACP_MODE = "no-auth";
    });
    afterEach(async () => {
      recorder?.stop();
      await instance?.dispose();
      instance = undefined;
      for (const name of FAKE_ENV) delete process.env[name];
      await removeTempDir(scratch);
    });
    const create = async (apply: (ctx: { askLevel: boolean }) => Promise<void>) => {
      instance = await createAcpDriver({ ...openclawSupport, askStop: { apply } }).create({
        instanceId: "openclaw-ask-stop", displayName: "OpenClaw", environment: {}, enabled: true,
        config: { cli: FAKE_ACP, fullAuto: false },
      });
      recorder = recordEvents(instance.adapter);
    };

    it("the driver wires the Gateway switch: OpenClaw's own support carries it", () => {
      expect(typeof openclawSupport.askStop?.apply).toBe("function");
    });

    it("engine detection carries the version line for an OpenClaw below the floor", async () => {
      process.env.FAKE_ACP_VERSION = "OpenClaw 2026.7.35 (1b58cb9)";
      await create(async () => {});
      const snap = await instance!.snapshot();
      expect(snap).toMatchObject({ state: "available", versionNote: ASK_STOP_OPENCLAW_OLD_NOTE });
      expect(snap.version).toContain("2026.7.35");
    });

    it("at Ask, read-only is set before the prompt, which starts with the deny directive and the Ask line", async () => {
      const promptDump = join(scratch, "prompt.json");
      process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
      const seen: boolean[] = [];
      await create(async ({ askLevel }) => { seen.push(askLevel); expect(existsSync(promptDump)).toBe(false); });
      await instance!.adapter.sendTurn({ threadId: "t-oc-ask", text: "edit notes", routeAsks: true, askLevel: true });
      const done = await recorder!.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(seen).toEqual([true]);
      const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
      expect(text.startsWith(`${OPENCLAW_ASK_STOP_DIRECTIVE}\n`)).toBe(true);
      expect(text).toContain(ASK_STOP_PROMPT);
    });

    it("fails closed: an Ask turn whose read-only switch throws is not prompted", async () => {
      await create(async ({ askLevel }) => { if (askLevel) throw new Error("gateway closed"); });
      await instance!.adapter.sendTurn({ threadId: "t-oc-fail", text: "edit notes", routeAsks: true, askLevel: true });
      const done = await recorder!.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false });
      const err = recorder!.events.find((e) => e.type === "runtime.error") as { message: string } | undefined;
      expect(err?.message).toContain(askStopUnavailableLine("OpenClaw"));
      expect(recorder!.events.some((e) => e.type === "content.delta")).toBe(false);
    });

    it("an OpenClaw too old for permissionMode refuses the turn with its own plain note, not the generic line", async () => {
      await create(async () => { throw new AskStopRefusal(ASK_STOP_OPENCLAW_OLD_NOTE); });
      await instance!.adapter.sendTurn({ threadId: "t-oc-old", text: "edit notes", routeAsks: true, askLevel: true });
      const done = await recorder!.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false });
      const err = recorder!.events.find((e) => e.type === "runtime.error") as { message: string } | undefined;
      expect(err?.message).toContain("At Ask, this OpenClaw version cannot stop before changes. Choose Auto to let me act, or install OpenClaw 2026.8.1 or newer.");
      expect(recorder!.events.some((e) => e.type === "content.delta")).toBe(false);
    });

    it("an edit OpenClaw's read-only mode refused shows the note once", async () => {
      process.env.FAKE_ACP_MODE = "refused-edit";
      await create(async () => {});
      await instance!.adapter.sendTurn({ threadId: "t-oc-refused", text: "edit notes", routeAsks: true, askLevel: true });
      await recorder!.until((e) => e.type === "turn.completed");
      expect(notes(recorder!.events)).toHaveLength(1);
    });

    it("at Auto, the switch is told so (it puts back what an Ask turn set) and the prompt carries no /exec directive", async () => {
      const promptDump = join(scratch, "prompt.json");
      process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
      const seen: boolean[] = [];
      await create(async ({ askLevel }) => { seen.push(askLevel); });
      await instance!.adapter.sendTurn({ threadId: "t-oc-auto", text: "edit notes", routeAsks: true });
      await recorder!.until((e) => e.type === "turn.completed");
      expect(seen).toEqual([false]);
      const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
      expect(text).not.toContain("/exec");
      expect(text).not.toContain(ASK_STOP_PROMPT);
    });

    for (const [level, flags] of [["Auto", { routeAsks: true }], ["Full access", { stopLine: true }]] as const) {
      it(`at ${level}, a command with a redirect and && is not routed to always-ask`, async () => {
        const promptDump = join(scratch, "prompt.json");
        process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
        const seen: boolean[] = [];
        await create(async ({ askLevel }) => { seen.push(askLevel); });
        await instance!.adapter.sendTurn({ threadId: `t-oc-redirect-${flags.routeAsks ? "auto" : "full"}`, text: "run: echo hi > out.txt && cat out.txt", ...flags });
        const done = await recorder!.until((e) => e.type === "turn.completed");
        expect(done).toMatchObject({ ok: true });
        expect(seen).toEqual([false]);
        const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
        expect(text).not.toContain("/exec");
        expect(text).toContain("echo hi > out.txt && cat out.txt");
        expect(text).not.toContain(ASK_STOP_PROMPT);
      });
    }

    it("at Ask, a command with a redirect still gets the deny directive (unchanged)", async () => {
      const promptDump = join(scratch, "prompt.json");
      process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
      await create(async () => {});
      await instance!.adapter.sendTurn({ threadId: "t-oc-redirect-ask", text: "run: echo hi > out.txt", routeAsks: true, askLevel: true });
      await recorder!.until((e) => e.type === "turn.completed");
      const text = (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
      expect(text.split("\n")[0]).toBe("/exec security=deny");
      expect(text.match(/\/exec/g)).toHaveLength(1);
    });
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
    return JSON.parse(execFileSync(process.execPath, [script], { input, encoding: "utf8" })) as { decision: string; reason?: string };
  };

  it("the hook allows only reads and denies everything else with the note, unknown input included", () => {
    for (const read of ANTIGRAVITY_ASK_READS) expect(runHook(read)).toEqual({ decision: "allow" });
    for (const other of ["write_file", "edit_file", "run_command", "invoke_subagent", "schedule", "manage_task", "", "READ_FILE"]) {
      expect(runHook(other)).toEqual({ decision: "deny", reason: ASK_STOP_NOTE });
    }
    expect(runHook("not json {")).toEqual({ decision: "deny", reason: ASK_STOP_NOTE });
  });

  it("hooks.json runs the hook on every tool, through this program, quoted for sh and for cmd", () => {
    const posix = JSON.parse(antigravityAskStopHooks(scratch, "/opt/Murage", "linux"));
    const group = posix["murage-ask-stop"].PreToolUse[0];
    expect(group.matcher).toBe("*");
    expect(group.hooks[0].command).toMatch(/^"\/opt\/Murage" ".*ask-hook-[0-9a-f]{16}\.cjs"$/);
    const win = JSON.parse(antigravityAskStopHooks(scratch, "C:\\Program Files\\Murage\\Murage.exe", "win32"));
    expect(win["murage-ask-stop"].PreToolUse[0].hooks[0].command).toMatch(/^""C:\/Program Files\/Murage\/Murage\.exe" ".*\.cjs""$/);
    const script = readdirSync(join(scratch, "native", "antigravity-ask")).find((name) => name.endsWith(".cjs"))!;
    expect(readFileSync(join(scratch, "native", "antigravity-ask", script), "utf8")).toBe(ANTIGRAVITY_ASK_HOOK_SOURCE);
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
    await instance!.adapter.sendTurn({ threadId: "t-agy-ask", text: "write notes", routeAsks: true, askLevel: true });
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
    await instance!.adapter.sendTurn({ threadId: "t-agy-shell", text: "run it", routeAsks: true, askLevel: true });
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
    await instance!.adapter.sendTurn({ threadId: "t-agy-read", text: "read notes", routeAsks: true, askLevel: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.hook.json`, "utf8"))).toEqual({ tool: "read_file", denial: null });
    expect(notes(recorder!.events)).toEqual([]);
  });

  it("at Ask, a change agy reports as done (the hook did not hold) stops the turn, with the note", async () => {
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-agy-ran", text: "write notes", routeAsks: true, askLevel: true });
    await recorder!.until((e) => e.type === "turn.completed");
    expect(notes(recorder!.events)).toHaveLength(1);
  });

  it("at Ask, a change that ran anyway ends the turn as Murage's Ask stop, never as the owner's Stop", async () => {
    // The comms GATE "Gemini Antigravity at ask": the turn ended "cancelled" (shown as "Stopped by you") and agy's
    // reply was dropped, so the chat never got its closing reply.
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-agy-halt", text: "write notes", routeAsks: true, askLevel: true });
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "ask_stop" });
    expect(notes(recorder!.events)).toHaveLength(1);
    expect(recorder!.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("at Ask, the halted turn still shows agy's reply: content.delta and assistant_text come before the settle", async () => {
    process.env.FAKE_AGY_TOOL = "write_file";
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-agy-halt-reply", text: "write notes", routeAsks: true, askLevel: true });
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
    await instance!.adapter.sendTurn({ threadId: "t-agy-auto", text: "write notes", routeAsks: true });
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
