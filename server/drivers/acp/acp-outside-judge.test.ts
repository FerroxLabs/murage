// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 (1.0.18), Astra r1 findings 2 to 6 on the shared ACP core (Gemini, Cursor, Fuigo, Grok Build and every
// other engine on drivers/acp/core.ts), against the scripted fake CLI. The driver hands every call it sees to the server's
// ACP lane hooks (judge, mark), wired here to the real outside rules and marks:
//   (2) a tool_call_update is judged again on the merged call; an update with no start is judged as its own item
//   (3) every permission request is judged on its full call BEFORE it is answered, item seen or not
//   (4) a kindless call is judged on its raw protocol fields (URL check included), MCP namespaces kept
//   (5) a pre-prompt tool frame marks; a load's history marks unless the session's origin is proven (M7 (a) record)
//   (6) helper (subagent) frames mark, and so does any vendor notification off the closed allowlist
// Every value here is fake.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { beginOutsideTurn, downloadRegistry, endOutsideTurn, forgetOutsideState, markTurnOutside, turnOutsideRead, wireOutsideStore, type OutsideSource } from "../../email/external-marks.ts";
import { registryKey } from "../../download-registry.ts";
import { fileOutsideStore } from "../../outside-store.ts";
import * as wire from "../../outside-wire.ts";
import * as core from "./core.ts";
import { EventBus } from "../../harness/bus.ts";

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const SUPPORT: core.AcpSupport = {
  driverKind: "acpOutsideJudgeTest",
  displayName: "Judge Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-judge",
  nativeSource: "judge.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  // the envfix H2 / G1 row: a PATH the driver sets itself is the one the child gets (core.ts keeps it over the owner map's;
  // the instance environment's PATH never reaches the child)
  finishTurnEnv: (env) => { if (driverPath !== undefined) env.PATH = driverPath; },
};
let driverPath: string | undefined;
const Driver = core.createAcpDriver(SUPPORT) as unknown as ProviderDriver<core.AcpConfig>;

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let home = "";
const dirs: string[] = [];
let judged: Array<Record<string, unknown>> = [];
let marks: OutsideSource[] = [];
let answeredAtJudge: string[] = [];
let scriptLog = "";

beforeEach(() => {
  ensureDirs();
  home = mkdtempSync(join(tmpdir(), "murage-acp-judge-"));
  dirs.push(home);
  scriptLog = join(home, "script.log");
  writeFileSync(scriptLog, "");
  judged = []; marks = []; answeredAtJudge = [];
  expect(wireOutsideStore(fileOutsideStore(join(home, "outside-state.jsonl")))).toBe(true);
  core.setAcpOutsideHooks({
    judge: (threadId: string, call: core.AcpOutsideCall, register: boolean) => {
      judged.push(call as unknown as Record<string, unknown>);
      answeredAtJudge.push(readFileSync(scriptLog, "utf8"));
      wire.noteAcpCallOutside(threadId, call as never, home, register);
    },
    mark: (threadId: string, source: OutsideSource) => { marks.push(source); markTurnOutside(threadId, source); },
  });
});
afterEach(async () => {
  core.setAcpOutsideHooks?.(null);
  driverPath = undefined;
  recorder?.stop();
  recorder = undefined;
  await instance?.dispose();
  instance = undefined;
  forgetOutsideState();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

type Step = Record<string, unknown>;
const update = (at: number, body: Record<string, unknown>, extra: Step = {}): Step => ({ at, update: body, ...extra });
const endTurn = (at: number, after?: number): Step => ({ at, result: { stopReason: "end_turn" }, ...(after !== undefined ? { after } : {}) });
const localRead = (id: string) => ({ sessionUpdate: "tool_call", toolCallId: id, kind: "read", title: "Read", status: "pending", rawInput: { path: join(home, "a.txt") } });

/** One turn on thread `threadId` (its outside turn begun first, a fresh engine session unless `resumed`). */
async function turn(threadId: string, script: Step[], options: { env?: Record<string, string>; resumeCursor?: string; resumed?: boolean } = {}) {
  beginOutsideTurn(threadId, "acp-judge", undefined, options.resumed === true);
  instance = await Driver.create({ instanceId: "acp-judge", displayName: "Judge Test", enabled: true,
    config: Driver.decodeConfig({ cli, fullAuto: true }),
    // every turn says something first: a turn with no reply and no item ends as an empty-reply failure
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script",
      FAKE_ACP_SCRIPT: JSON.stringify([update(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } }), ...script]),
      FAKE_ACP_SCRIPT_LOG: scriptLog, FAKE_ACP_MCP_READY: "1", ...(options.env ?? {}) } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId, text: "hello", cwd: home, ...(options.resumeCursor ? { resumeCursor: options.resumeCursor } : {}) });
  const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 15_000) as RuntimeEvent & { ok: boolean };
  expect(done.ok).toBe(true);
}

describe("(4) the raw-field rule for a kindless ACP call (outside-wire)", () => {
  const raw = (title: string, input: unknown) => wire.toolStartOutside({ origin: "engine", title, input }, undefined, { acpRaw: true });
  it("a kindless Read that names a URL marks web page, one with no input or an unknown name marks outside tool", () => {
    expect(raw("Read", { url: "https://example.com/a" })).toBe("web page");
    expect(raw("Read", {})).toBe("outside tool");
    expect(raw("think", { thought: "x" })).toBe("outside tool");
    expect(raw("", undefined)).toBe("outside tool");
  });
  it("a kindless reader that names only a local path stays local; a Claude item (no acpRaw) keeps its name rule", () => {
    expect(raw("Read", { path: "/w/a.txt" })).toBeNull();
    expect(raw("grep", { pattern: "x", path: "/w" })).toBeNull();
    expect(wire.toolStartOutside({ origin: "engine", title: "Read", input: { file_path: "/w/a.txt" } })).toBeNull();
  });
});

describe("(2) tool_call_update is judged on the merged call", () => {
  it("an update that brings in kind fetch and a URL after a local start marks the turn", async () => {
    await turn("j-upd-fetch", [
      update(10, localRead("c1")),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "c1", kind: "fetch", status: "in_progress", rawInput: { url: "https://example.com/x" } }),
      update(50, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "ok" }),
      endTurn(80),
    ]);
    expect(judged.some((c) => c.toolKind === "fetch" && (c.input as { url?: string })?.url === "https://example.com/x")).toBe(true);
    expect(turnOutsideRead("j-upd-fetch")).not.toBeNull();
  }, 20_000);

  it("an update that renames a local start to an outside MCP tool marks outside tool", async () => {
    await turn("j-upd-mcp", [
      update(10, localRead("c2")),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "c2", title: "mcp__github__get_issue", status: "in_progress" }),
      update(50, { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed" }),
      endTurn(80),
    ]);
    expect(turnOutsideRead("j-upd-mcp")).toBe("outside tool");
  }, 20_000);

  it("an update with no tool_call before it is judged as its own item and marks", async () => {
    await turn("j-orphan", [
      update(10, { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed", rawOutput: "fetched text" }),
      endTurn(60),
    ]);
    expect(judged.length).toBeGreaterThan(0);
    expect(turnOutsideRead("j-orphan")).toBe("outside tool");
  }, 20_000);
});

describe("(3) every permission request is judged before it is answered", () => {
  it("an ask for an outside call that never came as an item marks the turn, judged before the answer (Full access)", async () => {
    await turn("j-ask", [
      { at: 10, request: { id: 901, method: "session/request_permission", params: {
        toolCall: { toolCallId: "p1", kind: "fetch", title: "Fetch", rawInput: { url: "https://example.com/x" } },
        options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } } },
      endTurn(10, 901),
    ]);
    const index = judged.findIndex((c) => c.toolKind === "fetch" && c.title === "Fetch");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(answeredAtJudge[index]).toBe("");
    expect(readFileSync(scriptLog, "utf8")).toContain("\"id\":901");
    expect(turnOutsideRead("j-ask")).toBe("outside tool");
  }, 20_000);

  it("a local shell ask whose title is its command (dots and all) is judged by its kind and command, and does not mark", async () => {
    await turn("j-ask-local", [
      { at: 10, request: { id: 902, method: "session/request_permission", params: {
        toolCall: { toolCallId: "p2", kind: "execute", title: "cat .env", rawInput: { command: "cat .env" } },
        options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } } },
      endTurn(10, 902),
    ]);
    expect(judged.some((c) => c.toolKind === "execute")).toBe(true);
    expect(turnOutsideRead("j-ask-local")).toBeNull();
  }, 20_000);
});

describe("(4) a kindless or wrapped ACP item is judged on its protocol fields", () => {
  it("a kindless Read that names a URL marks web page", async () => {
    await turn("j-kindless", [
      update(10, { sessionUpdate: "tool_call", toolCallId: "k1", title: "Read", status: "pending", rawInput: { url: "https://example.com/a" } }),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "k1", status: "completed" }),
      endTurn(60),
    ]);
    expect(turnOutsideRead("j-kindless")).toBe("web page");
  }, 20_000);

  it("a wrapper call keeps the MCP namespace of the tool it names (the chip shows only the leaf)", async () => {
    await turn("j-wrapper", [
      update(10, { sessionUpdate: "tool_call", toolCallId: "w1", kind: "think", title: "use a tool", status: "pending",
        rawInput: { tool_name: "mcp__github__get_issue", tool_input: { number: 1 } } }),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed" }),
      endTurn(60),
    ]);
    expect(judged.some((c) => c.title === "mcp__github__get_issue")).toBe(true);
    expect(turnOutsideRead("j-wrapper")).toBe("outside tool");
  }, 20_000);
});

describe("(5) pre-prompt frames and loaded history", () => {
  it("a tool frame before the prompt on a new session marks the turn", async () => {
    await turn("j-pre", [endTurn(30)], { env: { FAKE_ACP_PRE_FRAMES: JSON.stringify([{ update: localRead("pre1") }]) } });
    expect(marks).toContain("outside tool");
    expect(turnOutsideRead("j-pre")).toBe("outside tool");
  }, 20_000);

  it("a load whose session has no start record (origin not proven) marks earlier session", () => {
    beginOutsideTurn("j-unproven", "acp-judge", undefined, true);
    expect(turnOutsideRead("j-unproven")).toBe("earlier session");
  });

  it("a proven session's loaded history does not mark: its replayed tool frames are not judged again", async () => {
    // the session started under v1 judging (its start record) and nothing marked it
    beginOutsideTurn("j-proven", "acp-judge", undefined, false);
    await turn("j-proven", [endTurn(30)], {
      resumed: true, resumeCursor: "fake-acp-session",
      env: { FAKE_ACP_PRE_FRAMES: JSON.stringify([{ update: localRead("old1") }, { update: { sessionUpdate: "tool_call", toolCallId: "old2", kind: "read", title: "Read", rawInput: { path: join(home, "b.txt") } }, meta: { isReplay: true } }]) },
    });
    expect(marks).toEqual([]);
    expect(turnOutsideRead("j-proven")).toBeNull();
  }, 20_000);
});

describe("(6) helper and vendor notifications", () => {
  it("a subagent_spawned helper frame marks the turn helper", async () => {
    await turn("j-helper", [
      update(10, { sessionUpdate: "subagent_spawned", subagent_id: "s1", description: "look around" }, { rail: "_fuigo/session_notification" }),
      update(30, { sessionUpdate: "subagent_finished", subagent_id: "s1", status: "completed" }, { rail: "_fuigo/session_notification" }),
      endTurn(60),
    ]);
    expect(marks).toContain("helper");
    expect(turnOutsideRead("j-helper")).toBe("helper");
  }, 20_000);

  it("a vendor notification off the allowlist marks the turn outside tool", async () => {
    await turn("j-vendor", [{ at: 10, notify: { method: "_vendor/web_lookup", params: { query: "x" } } }, endTurn(40)]);
    expect(marks).toContain("outside tool");
    expect(turnOutsideRead("j-vendor")).toBe("outside tool");
  }, 20_000);

  // NL-WIN-1018 D3: Fuigo's `_fuigo/mcp/servers_updated` (real frame: params keys `mcpServers` only) is config; exempt only for exactly { mcpServers: [] }
  const config = (params: unknown): Step => ({ at: 10, notify: { method: "_fuigo/mcp/servers_updated", params, raw: true } });
  it("D3: the confirmed config notification with exactly { mcpServers: [] } leaves the turn clean", async () => {
    await turn("j-cfg", [config({ mcpServers: [] }), endTurn(40)]);
    expect(marks).toEqual([]);
    expect(turnOutsideRead("j-cfg")).toBeNull();
  }, 20_000);
  it("D3: the same method with a tool field, another key or a non-empty list marks", async () => {
    let n = 0;
    for (const params of [{ mcpServers: [], sessionUpdate: "tool_call" }, { mcpServers: [], toolCallId: "x" }, { mcpServers: [], _meta: { "fuigo/tool": {} } }, { mcpServers: [], content: "x" },
      { mcpServers: [{ name: "x" }] }, { mcpServers: "x" }, {}, [], null]) {
      marks = [];
      const id = `j-cfg-bad-${n++}`;
      await turn(id, [config(params), endTurn(40)]);
      expect(marks, JSON.stringify(params)).toContain("outside tool");
      expect(turnOutsideRead(id), JSON.stringify(params)).toBe("outside tool");
      await instance?.dispose(); instance = undefined;
    }
  }, 120_000);
  it("D3: after a clean config frame an outside tool frame still marks", async () => {
    await turn("j-cfg-then-tool", [config({ mcpServers: [] }), update(20, { sessionUpdate: "tool_call", toolCallId: "wf1", kind: "fetch", title: "web_fetch", status: "pending", rawInput: { url: "https://example.com" } }), endTurn(60)]);
    expect(turnOutsideRead("j-cfg-then-tool")).not.toBeNull();
  }, 20_000);
  it("D3: acpConfigNotification is payload-only, whatever the timing, and names only the confirmed method", () => {
    expect(core.acpConfigNotification("_fuigo/mcp/servers_updated", { mcpServers: [] })).toBe(true);
    expect(core.acpConfigNotification("_fuigo/mcp/servers_updated", { mcpServers: [], extra: 1 })).toBe(false);
    expect(core.acpConfigNotification("_fuigo/mcp_initialized2", { mcpServers: [] })).toBe(false);
    expect(core.acpConfigNotification("_vendor/web_lookup", { mcpServers: [] })).toBe(false);
    expect(core.acpConfigNotification(undefined, { mcpServers: [] })).toBe(false);
  });

  // 1.0.19 S2 (U10c, U11): the server's own ACP hooks (outside-wire acpOutsideHooks, as index.ts wires them), driven by the
  // driver: what a call brings in is registered at its start, and a helper's mark spans the turn, so a fresh chat's read Matches
  describe("1.0.19 S2: the server's ACP hooks register what a call brings in (U10c) and span a helper's turn (U11)", () => {
    beforeEach(() => core.setAcpOutsideHooks(wire.acpOutsideHooks(() => home)));
    const fresh = (threadId: string, input: Record<string, unknown>, title = "Bash") => {
      beginOutsideTurn(threadId, "acp-judge-fresh", undefined, false);
      // a fresh chat's engine is spawned (spawnCli notes its PATH for the thread) before any of its tools is judged
      wire.noteEnginePath(threadId, process.env.PATH);
      wire.noteToolStartOutside(threadId, { origin: "engine", title, input }, home);
      return turnOutsideRead(threadId);
    };
    it("U10c: a stamped `curl -o p.html URL` on Fuigo registers p.html (its own entry, not the span) under the call's own mark; a fresh chat's `cat p.html` marks downloaded file", async () => {
      await turn("j-u10c", [
        update(10, { sessionUpdate: "tool_call", toolCallId: "d1", kind: "execute", title: "curl -o p.html https://example.com/p", status: "pending",
          rawInput: { command: "curl -o p.html https://example.com/p" },
          _meta: { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "run_terminal_command", kind: "execute" } } }),
        update(30, { sessionUpdate: "tool_call_update", toolCallId: "d1", status: "completed", rawOutput: "" }),
        endTurn(60),
      ]);
      expect(turnOutsideRead("j-u10c")).toBe("network command");
      // the per-call mark: the turn's mark is d1's own (read without it, the call that brought p.html in is clean, once)
      expect(wire.outsideContextFields("j-u10c", home, { key: "d1" }).outsideRead).toBeNull();
      expect(wire.outsideContextFields("j-u10c", home, { key: "other" }).outsideRead).toEqual(["network command"]);
      // the destination itself is registered, not only covered by a span
      expect(downloadRegistry().list().some((e) => e.kind !== "span" && e.path === registryKey(join(home, "p.html")))).toBe(true);
      endOutsideTurn("j-u10c", undefined);
      writeFileSync(join(home, "p.html"), "<p>fetched</p>");
      expect(fresh("j-u10c-fresh", { command: "cat p.html" })).toBe("downloaded file");
    }, 20_000);
    it("U11: a helper frame on Fuigo spans the turn; after the turn closes, a fresh chat reading a file the helper wrote marks downloaded file", async () => {
      await turn("j-u11", [
        update(10, { sessionUpdate: "subagent_spawned", subagent_id: "s1", description: "write notes" }, { rail: "_fuigo/session_notification" }),
        update(30, { sessionUpdate: "subagent_finished", subagent_id: "s1", status: "completed" }, { rail: "_fuigo/session_notification" }),
        endTurn(60),
      ]);
      expect(turnOutsideRead("j-u11")).toBe("helper");
      expect(downloadRegistry().spanCount()).toBeGreaterThan(0);
      // the helper's write lands while the turn runs; the turn then closes (its span gets its end)
      const wrote = join(home, "helper-notes.md");
      writeFileSync(wrote, "from the helper");
      endOutsideTurn("j-u11", undefined);
      expect(fresh("j-u11-fresh", { file_path: wrote }, "Read")).toBe("downloaded file");
    }, 20_000);
  });

  // Astra r1 H2 (on 4774e38b1): an ask seen first must not stop its later, fuller tool_call from registering new paths
  it("H2: on a marked turn, an edit ask naming A, then its tool_call naming A and B, registers B", async () => {
    const a = join(home, "a.md"), b = join(home, "b.md");
    const entry = (p: string) => downloadRegistry().list().some((e) => e.kind !== "span" && e.path === registryKey(p));
    await turn("j-h2", [
      update(5, { sessionUpdate: "tool_call", toolCallId: "f1", kind: "fetch", title: "Fetch", status: "pending", rawInput: { url: "https://example.com/x" } }),
      update(8, { sessionUpdate: "tool_call_update", toolCallId: "f1", status: "completed", rawOutput: "page" }),
      { at: 15, request: { id: 911, method: "session/request_permission", params: {
        toolCall: { toolCallId: "e1", kind: "edit", title: "Edit", rawInput: { path: a }, locations: [{ path: a }] },
        options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } } },
      update(5, { sessionUpdate: "tool_call", toolCallId: "e1", kind: "edit", title: "Edit", status: "in_progress", rawInput: { path: a }, locations: [{ path: a }, { path: b }] }, { after: 911 }),
      update(25, { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" }, { after: 911 }),
      endTurn(50, 911),
    ]);
    // the turn is marked by the fetch; an unstamped `fetch` kind marks `outside tool` (outside-wire.ts, "as before"),
    // only a stamped one names `web page` (design O1), so the label is not what this test pins
    expect(turnOutsideRead("j-h2")).not.toBeNull();
    expect(entry(a)).toBe(true);
    expect(entry(b)).toBe(true);
  }, 20_000);

  // 1.0.19 relay 5: an ask registers what its call brings in only once the call is allowed. A denied ask (one with no call
  // id, as the fake's default ask, and one with an id) leaves no registry entry, span or session write behind, so a later
  // clean owner turn, a new chat of the same bot or another bot's, does not read as marked (cloned folder / earlier turn)
  describe("relay 5: a denied ask registers nothing", () => {
    beforeEach(() => core.setAcpOutsideHooks(wire.acpOutsideHooks(() => home)));
    const entry = (p: string) => downloadRegistry().list().some((e) => e.kind !== "span" && e.path === registryKey(p));
    const freshRead = (threadId: string, instanceId: string, input: Record<string, unknown>, title: string) => {
      beginOutsideTurn(threadId, instanceId, undefined, false);
      // a fresh chat's engine is spawned (spawnCli notes its PATH for the thread) before any of its tools is judged
      wire.noteEnginePath(threadId, process.env.PATH);
      wire.noteToolStartOutside(threadId, { origin: "engine", title, input }, home);
      return turnOutsideRead(threadId);
    };
    it("asks denied on a marked turn leave no entry or span; a later clean turn of the same bot or another bot stays clean", async () => {
      const a = join(home, "a.md"), c = join(home, "c.txt");
      const options = [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }];
      const script: Step[] = [
        update(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } }),
        { at: 15, request: { id: 921, method: "session/request_permission", params: {
          toolCall: { kind: "execute", title: "echo hi > c.txt", rawInput: { command: "echo hi > c.txt" } }, options } } },
        { at: 5, after: 921, request: { id: 922, method: "session/request_permission", params: {
          toolCall: { toolCallId: "e1", kind: "edit", title: "Edit", rawInput: { path: a }, locations: [{ path: a }] }, options } } },
        endTurn(20, 922),
      ];
      beginOutsideTurn("j-deny", "acp-judge", undefined, false);
      // relay 6: the turn is marked at its start, not by a fetch call: an unstamped fetch kind is an unknown tool, and on a
      // marked turn its own start spans the turn (V4 (b)), which would hide whether the denied asks span it
      markTurnOutside("j-deny", "web page");
      instance = await Driver.create({ instanceId: "acp-judge", displayName: "Judge Test", enabled: true,
        config: Driver.decodeConfig({ cli, fullAuto: false }),
        environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script),
          FAKE_ACP_SCRIPT_LOG: scriptLog, FAKE_ACP_MCP_READY: "1" } });
      recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({ threadId: "j-deny", text: "hello", cwd: home });
      const answered = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const opened = await recorder.until((e) => e.threadId === "j-deny" && e.type === "request.opened" &&
          !answered.has(String((e as { requestId?: unknown }).requestId)), 15_000) as RuntimeEvent & { requestId: string };
        answered.add(opened.requestId);
        await instance.adapter.respondToRequest("j-deny", opened.requestId, { behavior: "deny" });
      }
      await recorder.until((e) => e.threadId === "j-deny" && e.type === "turn.completed", 15_000);
      expect(turnOutsideRead("j-deny")).toBe("web page");
      expect(entry(a)).toBe(false);
      expect(entry(c)).toBe(false);
      expect(downloadRegistry().spanCount()).toBe(0);
      // files that land while the marked turn is still open (as the fixtures of later bots do) are not under any span
      writeFileSync(a, "# a");
      writeFileSync(c, "hi");
      endOutsideTurn("j-deny", undefined);
      expect(freshRead("j-deny-same-bot", "acp-judge", { command: "cat c.txt" }, "Bash")).toBeNull();
      expect(freshRead("j-deny-other-bot", "acp-judge-other", { file_path: a }, "Read")).toBeNull();
      expect(freshRead("j-deny-other-bot-2", "acp-judge-other-2", { command: "cat c.txt" }, "Bash")).toBeNull();
    }, 30_000);
    it("an allowed ask with no tool_call still registers what it brings in (A3)", async () => {
      const a = join(home, "a2.md");
      await turn("j-allow", [
        update(5, { sessionUpdate: "tool_call", toolCallId: "f2", kind: "fetch", title: "Fetch", status: "pending", rawInput: { url: "https://example.com/x" } }),
        update(8, { sessionUpdate: "tool_call_update", toolCallId: "f2", status: "completed", rawOutput: "page" }),
        { at: 15, request: { id: 931, method: "session/request_permission", params: {
          toolCall: { toolCallId: "e2", kind: "edit", title: "Edit", rawInput: { path: a }, locations: [{ path: a }] },
          options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } } },
        endTurn(20, 931),
      ]);
      expect(turnOutsideRead("j-allow")).not.toBeNull();
      expect(entry(a)).toBe(true);
    }, 20_000);
  });

  it("known non-tool notifications, the command list and a local read do not mark", async () => {
    await turn("j-benign", [
      { at: 5, notify: { method: "_fuigo/mcp/init_progress", params: { server: "x", status: "ready" } } },
      { at: 6, notify: { method: "_x.ai/models/update", params: { models: [] } } },
      { at: 7, notify: { method: "_fuigo/queue/changed", params: { queue: [] } } },
      { at: 8, notify: { method: "_fuigo/session/interjection", params: { interjectionId: "none" } } },
      update(9, { sessionUpdate: "available_commands_update", availableCommands: [] }),
      update(10, localRead("ok1")),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "ok1", status: "completed", rawOutput: "text" }),
      endTurn(60),
    ], { env: { FAKE_ACP_COMMANDS: "[]" } });
    expect(marks).toEqual([]);
    expect(turnOutsideRead("j-benign")).toBeNull();
  }, 20_000);
});

// NOLIMITS 1.0.18 logger lane (design NOLIMITS-S1S2-H6-ALLOWLIST.md L1-L4/L6, section 4.4 row 7): the event log keeps a Fuigo
// write's wrapped path and stamp name, never its file text; the live judge still sees the full rawInput.
describe("NOLIMITS L4: an ACP write's event log line (design 4.4 row 7)", () => {
  const SECRET = "confidential-plan-text-7f3a";
  it("a Fuigo-stamped write_file logs tool_input.path and title write_file, no summary, no file text", async () => {
    const path = join(home, "a.md");
    await turn("j-log-write", [
      update(10, { sessionUpdate: "tool_call", toolCallId: "w1", kind: "edit", title: "Writing to a.md", status: "pending",
        rawInput: { tool_name: "write_file", tool_input: { path, content: SECRET } },
        _meta: { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "write_file", kind: "edit" } } }),
      update(30, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", rawOutput: "" }),
      endTurn(60),
    ]);
    // the live judge saw the whole call
    expect(JSON.stringify(judged)).toContain(SECRET);
    const live = recorder!.events.filter((e) => e.type === "item.started" && (e as unknown as { itemId?: string }).itemId === "w1");
    expect(live).toHaveLength(1);
    expect(JSON.stringify(live[0])).toContain(SECRET);
    const writes: string[] = [];
    const bus = new EventBus(((_file: string, data: string) => { writes.push(data); }) as never);
    bus.publish(live[0]!);
    const row = JSON.parse(writes.join("").trim()) as Record<string, unknown>;
    expect(row.title).toBe("write_file");
    expect(row.input).toEqual({ tool_name: "write_file", tool_input: { path } });
    expect(Object.hasOwn(row, "summary")).toBe(false);
    expect(writes.join("")).not.toContain(SECRET);
  }, 20_000);
});

// NOLIMITS 1.0.18 envfix (Astra acct5 r1 items 1 and 2, GrokBuild r1 G1): through the real driver path, with NO manual
// noteEnginePath or noteSessionEdit call. The driver's spawn notes the engine's PATH for the thread; the judge records a
// write on a clean turn on the engine session.
describe("1.0.18 envfix: the engine PATH and the session's edits reach the shell scan through the ACP driver", () => {
  const exec = (at: number, id: string, command: string) =>
    update(at, { sessionUpdate: "tool_call", toolCallId: id, kind: "execute", title: command, status: "pending", rawInput: { command } });
  it("H2 / G1: a bare runner found only on the ENGINE's PATH (a symlink to node) marks interpreter; one on no PATH does not", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "runner"));
    const enginePath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    driverPath = enginePath;
    await turn("j-path", [exec(5, "x1", "runner -e 0"), update(8, { sessionUpdate: "tool_call_update", toolCallId: "x1", status: "completed", rawOutput: "" }), endTurn(20)],
      { env: { PATH: enginePath } });
    expect(turnOutsideRead("j-path")).toBe("interpreter");
    await instance?.dispose(); instance = undefined; recorder?.stop(); recorder = undefined;
    await turn("j-path-none", [exec(5, "x2", "nosuchrunner -e 0"), update(8, { sessionUpdate: "tool_call_update", toolCallId: "x2", status: "completed", rawOutput: "" }), endTurn(20)],
      { env: { PATH: enginePath } });
    expect(turnOutsideRead("j-path-none")).toBeNull();
  }, 40_000);
  it("H1: a file the engine writes on a clean turn, run by an interpreter on a later turn of the same session, marks interpreter", async () => {
    const script = join(home, "run.js");
    await turn("j-edit", [
      update(5, { sessionUpdate: "tool_call", toolCallId: "w1", kind: "edit", title: "Write", status: "pending", rawInput: { path: script, content: "0" }, locations: [{ path: script }] }),
      update(8, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed" }),
      endTurn(20),
    ]);
    expect(turnOutsideRead("j-edit")).toBeNull();
    writeFileSync(script, "0\n");
    await instance?.dispose(); instance = undefined; recorder?.stop(); recorder = undefined;
    await turn("j-edit", [exec(5, "r1", "node run.js"), update(8, { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawOutput: "" }), endTurn(20)],
      { resumed: true });
    expect(turnOutsideRead("j-edit")).toBe("interpreter");
  }, 40_000);
});
