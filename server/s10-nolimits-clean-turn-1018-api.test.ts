// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10 with NOLIMITS), real starts over real HTTP with a fake engine: every real ask carries its turn's outside mark, so
// a clean owner turn is never carded for a mark nobody stated, on Grok's and Claude's paths, past a read's bound too, and a
// routine keeps its own card with no mark at all. These rows need both lanes, so they run from the tree with the outside wire.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is probed from the fixture band. Commands are inert.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { raiseLevel } from "./testing/raise-level.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOTH_LANES = existsSync(join(SERVER_DIR, "outside-wire.ts"));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAR = "cat | ".repeat(40);
const FAR_SHELL = `echo ls | ${FAR}sh`;
const FAR_WIPE = `echo /tmp/x | ${FAR}xargs rm -rf`;
const LONG_SCRIPT = Array.from({ length: 700 }, (_, k) => `echo "step ${k}" && mkdir -p build/${k % 9} # line`).join("\n");

let port: number;
let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";
let stdout = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cards = async (threadId: string) => (await threadMessages(threadId)).filter((m) => m.kind === "options" && m.card?.requestId);
const liveCard = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && m.card?.answered === undefined) ?? null;
const chip = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.tool?.name === "Approved 1 step (No limits)") ?? null;
async function poll<T>(read: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const waitIdle = (botId: string, threadId: string) => poll(async () => {
  const bot = (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId);
  const task = bot?.tasks.find((t: any) => t.threadId === threadId);
  return task && !task.busy ? task : null;
});
const deny = async (threadId: string, requestId: string) => {
  expect((await desktopApi("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "deny" })).status).toBe(200);
};
async function makeBot(name: string, instanceId: string, level: "task" | "bot" = "task") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const raised = level === "bot"
    ? await raiseLevel(desktopApi, bot.id, { noLimits: true, acknowledgeNoLimits: true })
    : await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { noLimits: true, acknowledgeNoLimits: true });
  expect(raised.status).toBe(200);
  return bot;
}
const asked = (botId: string) => stdout.split("\n").filter((line) => line.includes("approvals: asked") && line.includes(`bot=${botId.slice(0, 8)}`));

describe.skipIf(process.platform === "win32" || !BOTH_LANES)("a real owner turn at No limits and its outside mark", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
    home = makeTestHome("murage-s10-clean-turn-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    // the throwaway HOME's signed-in marker, as attachment-remove-api.test.ts sets it: no key, the engine is the fake
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    // FAKE_ACP_TOOL_KIND think: the fake's scripted row is a local one, so the turn is clean; with no kind it is an outside tool and marks it
    const grok = (command: string, kind: object = { FAKE_ACP_TOOL_KIND: "think" }) => ({ driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission", ...kind, FAKE_ACP_PERMISSION_COMMAND: command }, config: { cli: FAKE_CLI, fullAuto: false } });
    const claude = (command: string) => ({ driver: "claudeAgent", environment: { FAKE_CLAUDE_PERM_TOOL: "Bash", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command }) }, config: { cli: FAKE_CLAUDE } });
    // A Fuigo turn as the engine sends it: one tool row, then the ask for a shell call, both stamped with the engine's own identity
    const stamp = (name: string, kind: string) => ({ _meta: { "fuigo/tool": { version: 1, namespace: "fuigo_build", name, kind } } });
    const fuigo = (row: object) => ({
      driver: "fuigoAgent",
      environment: {
        FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_MCP_READY: "1",
        FAKE_ACP_SCRIPT: JSON.stringify([
          { at: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } } },
          { at: 10, update: { sessionUpdate: "tool_call", toolCallId: "row-1", status: "pending", ...row } },
          { at: 20, request: { id: 951, method: "session/request_permission", params: {
            toolCall: { toolCallId: "ask-1", kind: "execute", title: "run", rawInput: { command: FAR_SHELL }, ...stamp("run_terminal_command", "execute") },
            options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } } },
          { at: 10, after: 951, result: { stopReason: "end_turn" } },
        ]),
      },
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const inFolder = { rawInput: { path: join(home, "work", "a.txt") } };
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        fuigoRead: fuigo({ title: "read_file", kind: "read", ...inFolder, ...stamp("read_file", "read") }),
        fuigoReadFree: fuigo({ title: `Read ${join(home, "work", "a.txt")}`, kind: "read", ...inFolder, ...stamp("read_file", "read") }),
        fuigoSearchTool: fuigo({ title: "search_tool", rawInput: { query: "notes" }, ...stamp("search_tool", "search_tool") }),
        fuigoNoStamp: fuigo({ title: "read_file", ...inFolder }),
        far: grok(FAR_SHELL), script: grok(LONG_SCRIPT), wipe: grok(FAR_WIPE), marked: grok(FAR_SHELL, {}),
        claudeFar: claude(FAR_SHELL), claudeScript: claude(LONG_SCRIPT), routine: grok("cat .env"),
      },
    }));
    child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_WARM_ACTIVITY_WINDOW_MS: "3000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stdout += c));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 120_000);
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each([
    ["a shell past the pipe bound", "far"],
    ["a long script", "script"],
  ])("Grok, %s: the owner's clean line runs with no card", async (name, instance) => {
    const bot = await makeBot(name, instance);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it" })).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(asked(bot.id)).toEqual([]);
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
  }, 60_000);

  // the marker sends the fake's call through Claude's permission prompt, so the verdict really runs: its answer comes back in the turn
  it.each([
    ["a shell past the pipe bound", "claudeFar"],
    ["a long script", "claudeScript"],
  ])("Claude, %s: the owner's clean line is asked of Murage and allowed with no card", async (name, instance) => {
    const bot = await makeBot(name, instance);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it __fixture_permission_tool__" })).status).toBe(202);
    expect(await poll(async () => ((await threadMessages(bot.threadId)).some((m) => /permission: allowed/.test(m.text ?? "")) ? true : null), 60_000), `the verdict never came back. stderr: ${stderr.slice(-1500)}`).toBe(true);
    expect(asked(bot.id)).toEqual([]);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 90_000);

  // The warm pool's own idle control (MURAGE_WARM_ACTIVITY_WINDOW_MS above) lets the first turn's engine go, so the second send really starts cold and the driver really emits the chip
  it("Claude, the wake chip on a cold start leaves the turn clean: the next ask is allowed with no card", async () => {
    const bot = await makeBot("Wake", "claudeFar");
    const allowedCount = async () => (await threadMessages(bot.threadId)).filter((m) => /permission: allowed/.test(m.text ?? "")).length;
    // the first turn asks too: the fake's plain reply plays a Bash row with no input, which marks and would taint the session on its own
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "one __fixture_permission_tool__" })).status).toBe(202);
    expect(await poll(async () => ((await allowedCount()) === 1 ? true : null), 60_000), `the first verdict never came back. stderr: ${stderr.slice(-1500)}`).toBe(true);
    expect(await waitIdle(bot.id, bot.threadId), `first turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(await poll(async () => (stdout.includes(`claude close thread=${bot.threadId} reason=activity window`) ? true : null), 30_000), "the pool never let the engine go").toBe(true);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "two __fixture_permission_tool__" })).status).toBe(202);
    expect(await poll(async () => (stdout.includes(`claude wake thread=${bot.threadId} cold=true`) ? true : null), 30_000), "this turn never showed the wake chip").toBe(true);
    const allowed = await poll(async () => ((await allowedCount()) === 2 ? true : null), 40_000);
    const seen = (await threadMessages(bot.threadId)).map((m) => `${m.kind ?? m.role}:${String(m.tool?.name ?? m.text ?? "").slice(0, 60)}`).join(" | ");
    expect(allowed, `the verdict never came back. messages: ${seen} asked: ${asked(bot.id).join(" | ")} stdout: ${stdout.slice(-1200)} stderr: ${stderr.slice(-600)}`).toBe(true);
    expect(asked(bot.id)).toEqual([]);
    expect(await cards(bot.threadId)).toHaveLength(0);
  }, 150_000);

  it("xargs rm -rf past the pipe bound cards as unreadable, not as an outside turn", async () => {
    const bot = await makeBot("Wipe", "wipe");
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it" })).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "a far xargs rm -rf ran with no card").not.toBeNull();
    const lines = await poll(async () => (asked(bot.id).length ? asked(bot.id) : null));
    expect(lines?.join("\n")).toContain("reason=unreadable");
    expect(lines?.join("\n")).not.toContain("outside=");
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it.each([
    ["read_file inside the work folder", "fuigoRead"],
    ["read_file whose title is free text", "fuigoReadFree"],
    ["its own search_tool", "fuigoSearchTool"],
  ])("Fuigo, %s: a local tool leaves the turn clean, so the next ask runs with no card", async (name, instance) => {
    const bot = await makeBot(name, instance);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it" })).status).toBe(202);
    expect(await waitIdle(bot.id, bot.threadId), `turn never finished. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    expect(asked(bot.id)).toEqual([]);
    expect(await cards(bot.threadId)).toHaveLength(0);
    expect(await chip(bot.threadId)).not.toBeNull();
  }, 60_000);

  it("Fuigo, a tool row with no stamp and no kind proves nothing, so it marks: the rows above are not clean by accident", async () => {
    const bot = await makeBot("No stamp", "fuigoNoStamp");
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it" })).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "an unproven row left the turn clean").not.toBeNull();
    const lines = await poll(async () => (asked(bot.id).length ? asked(bot.id) : null));
    expect(lines?.join("\n")).toMatch(/outside=[a-z-]+/);
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("a turn an outside tool marked cards, and its line names the mark", async () => {
    const bot = await makeBot("Marked", "marked");
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "run it" })).status).toBe(202);
    const card = await poll(() => liveCard(bot.threadId));
    expect(card, "a marked turn ran with no card").not.toBeNull();
    const lines = await poll(async () => (asked(bot.id).length ? asked(bot.id) : null));
    expect(lines?.join("\n")).toMatch(/outside=[a-z-]+/);
    await deny(bot.threadId, card.card.requestId);
    await waitIdle(bot.id, bot.threadId);
  }, 60_000);

  it("a routine's turn keeps its own card with no outside mark: the mark is the owner's lane only", async () => {
    const bot = await makeBot("Scheduled", "routine", "bot");
    const routine = await desktopApi("POST", "/api/routines", { name: "Nightly", prompt: "Read it", botId: bot.id, runOn: "ember", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false });
    expect(routine.status).toBe(201);
    const started = await desktopApi("POST", `/api/routines/${routine.body.routine.id}/run`);
    expect(started.status).toBe(201);
    const threadId = await poll(async () => ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === started.body.run.id)?.threadId ?? null);
    const card = await poll(() => liveCard(threadId!), 30_000);
    expect(card, "a routine ran with no card").not.toBeNull();
    const lines = await poll(async () => (asked(bot.id).length ? asked(bot.id) : null));
    expect(lines?.join("\n")).not.toContain("outside=");
    await deny(threadId!, card.card.requestId);
  }, 60_000);
});
