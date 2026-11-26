// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 withheld-compaction (Fuigo canary, owner rule): an owner turn on Fuigo (local 32k-window model) that threw away
// think-only attempts, compacted mid-turn and re-ran its 2 tool calls ended on Murage 1.0.21 with REPLY_WITHHELD ("Murage held
// back this message...") and every tool row named «redacted». Nothing in it was private.
// Owners: lane fix1022-withheld-compaction owns this witness; the turn policy (server/redact-turn.ts) and the collector
// (server/harness/audience-collector.ts) are owned by their modules.
// Real server, real dispatch, real ACP driver (server/drivers/acp/core.ts) over a real fake ACP process that advertises
// Fuigo's retryDiscard. The frames copy the SHAPES of the canary turn (never its text): reasoning chunks of a discarded
// attempt end mid-line (a think-only attempt is cut where the engine gave up), then `retry_state` discardEmitted; the two
// use_tool calls; the compaction notices and the `session_summary` frame; the in-flight attempt discarded; the same two
// calls run again under new ids; the reply.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const IDLE_LOAD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href;
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const MARKER = "«redacted»";
// The fixture credential of the redact witnesses (joined at run time).
const FIXTURE_VALUE = "FIXTURESECRET" + "123456";
const FIXTURE_SECRET = "api_key=" + FIXTURE_VALUE;
/** A value that is only secret by its label (nothing in it is secret-shaped on its own). */
const LABELLED_VALUE = "hunter" + "2fixturevalue";
const STAMP = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", read_only: false } };
const TOOLS = ["browser__agent_browser_tab_list", "computer__get_screen_size"] as const;
const REPLY = "COMPACT_DONE 1 tab open, screen size: 1440x900 points @ 1x";
const NOTE = "_fuigo/session_notification";
/** What a held-back row or tool row reads instead of its words. */
const WITHHELD = [REPLY_WITHHELD, "Tool details withheld"];
const isMarked = (text: string) => text.includes(MARKER) || WITHHELD.some(line => text.includes(line));
/** The unfinished last words of each discarded attempt (think-only, and the one compaction cut off). */
const DISCARDED = ["First the tab list, then", "the answer is", "with the tab count and"];

type Step = Record<string, unknown>;
/** Fuigo-shaped frames, `at` ms after the prompt (the first waits until the prompt is certainly written). */
function script(build: (add: (step: Step, gap?: number) => void) => void): Step[] {
  const steps: Step[] = [];
  let at = 600;
  build((step, gap = 40) => { at += gap; steps.push({ at, ...step }); });
  steps.push({ at: at + 140, result: { stopReason: "end_turn" } });
  return steps;
}
const thought = (text: string, startMs: number) => ({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }, meta: { streamStartMs: startMs } });
const chunk = (text: string, startMs: number) => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, meta: { streamStartMs: startMs } });
const discard = (startMs: number, attempt: number) => ({ rail: NOTE, update: { sessionUpdate: "retry_state", type: "retrying", attempt, discardEmitted: true, streamStartMs: startMs } });
const completed = () => ({ rail: NOTE, update: { sessionUpdate: "response_completed", stop_reason: "tool_use" } });
const call = (id: string, tool: string, startMs: number, input: Record<string, unknown> = {}) => ({ update: { sessionUpdate: "tool_call", toolCallId: id, title: "use_tool", kind: "other", status: "pending",
  rawInput: { variant: "UseTool", tool_name: tool, tool_input: input }, _meta: STAMP }, meta: { streamStartMs: startMs } });
const done = (id: string, text: string) => ({ update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { content: [{ type: "text", text }], isError: false } } });
/** The two calls of the row (tab list, screen size), under the ids of one attempt. */
const twoCalls = (add: (step: Step, gap?: number) => void, tag: string, startMs: number, secretInput = false) => {
  add(chunk(`Calling ${TOOLS[0]} first.\n`, startMs));
  add(call(`call_${tag}_tabs_0123456`, TOOLS[0], startMs));
  add(done(`call_${tag}_tabs_0123456`, "1 tab: about:blank"));
  add(call(`call_${tag}_screen_0123456`, TOOLS[1], startMs, secretInput ? { note: FIXTURE_SECRET } : {}));
  add(done(`call_${tag}_screen_0123456`, "1440x900 points @ 1x"));
  add(completed());
};
/** Think-only attempts: each streams reasoning that stops mid-line and is then discarded (the canary's attempts 1-5). */
const thinkOnly = (add: (step: Step, gap?: number) => void, attempts: number) => {
  for (let n = 1; n <= attempts; n++) { add(thought("The user wants two tool calls. ", n)); add(thought("First the tab list, then", n)); add(discard(n, n)); }
};
/** Compaction mid-turn: Fuigo's notices around a summary of the turn so far, and the attempt that overflowed discarded. */
const compaction = (add: (step: Step, gap?: number) => void, overflowStart: number) => {
  add(thought("Now I should answer with the tab count and", overflowStart));
  add(chunk("Both calls returned; the answer is", overflowStart));
  add({ rail: NOTE, update: { sessionUpdate: "auto_compact_started" } });
  add(discard(overflowStart, overflowStart));
  add({ rail: NOTE, update: { sessionUpdate: "session_summary", session_summary: "The user asked for two tool calls: the tab list and the screen size." } });
  add({ rail: NOTE, update: { sessionUpdate: "auto_compact_completed" } });
};
const reply = (add: (step: Step, gap?: number) => void, startMs: number) => { add(chunk(REPLY, startMs)); add({ rail: NOTE, update: { sessionUpdate: "response_completed", stop_reason: "end_turn" } }); };

const SCRIPTS: Record<string, Step[]> = {
  // R1 the canary row: think-only attempts, the calls, compaction, the calls again, the reply
  canary: script(add => { thinkOnly(add, 5); twoCalls(add, "first", 6); compaction(add, 7); twoCalls(add, "rerun", 8); reply(add, 8); }),
  // R2 think-only discards alone
  thinkonly: script(add => { thinkOnly(add, 3); twoCalls(add, "first", 4); reply(add, 5); }),
  // R3 compaction alone (the attempt it cut off was mid-line), no think-only attempt before it
  compaction: script(add => { twoCalls(add, "first", 1); compaction(add, 2); twoCalls(add, "rerun", 3); reply(add, 3); }),
  // C1 control: the same canary row with a real credential in the re-run call's input
  secret: script(add => { thinkOnly(add, 2); twoCalls(add, "first", 3); compaction(add, 4); twoCalls(add, "rerun", 5, true); reply(add, 5); }),
  // C2 privacy: a discarded attempt held an open label head (clean on its own, the probes find nothing), the next attempt
  // writes the rest of the label and a value: the held head may name that value, so the reset still holds the turn
  labelopen: script(add => { add(chunk("Here is the **pass", 1)); add(discard(1, 1)); add(chunk("word**: " + LABELLED_VALUE + "\n", 2)); twoCalls(add, "first", 2); reply(add, 2); }),
};

let port: number, base: string, home: string, child: ChildProcess, stderr = "";
let desktopHeaders: Record<string, string> = {};
const dbPath = () => join(home, ".murage", "messages.db");
const rawRequest = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const message = method === "POST" && /^\/api\/bots\/([^/]+)\/messages$/.exec(path);
  if (message && typeof (body as { threadId?: unknown })?.threadId === "string") await prepareFixtureRecall(join(home, ".murage"), message[1]!, (body as { threadId: string }).threadId);
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const request = fixtureDisplayApi(dbPath, rawRequest);
const api = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
async function transcript(threadId: string): Promise<any[]> {
  // the display fixture reads the store beside the live server: a write in flight can hold its lock for a moment
  for (let attempt = 0; ; attempt++) {
    try { return ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[]; }
    catch (error) { if (attempt >= 20 || !/database is locked/.test(String(error))) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
}
/** The stored rows of a thread, straight from the store file. */
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); }
  finally { db.close(); }
}
/** Every piece of text a row can show. */
const shown = (row: any): string => JSON.stringify([row.text ?? "", row.tool ?? "", row.card ?? ""]);
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 300)); }
}
async function makeBot(name: string, instanceId: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  // the canary row ran at No limits (its calls were approved by the host; the "Approved 4 steps" row)
  expect((await api("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
  const seen = (await api("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", targetLevel: "no-limits" })).body;
  const saved = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", previewId: seen.previewId, ifRev: seen.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", rosterId: seen.rosterId, targetLevel: seen.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev })).status).toBe(200);
  return bot;
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
/** Send one owner line; wait until the turn's last reply is stored and the row count stops changing. */
async function ownerTurn(botName: string, instanceId: string) {
  const bot = await makeBot(botName, instanceId);
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  // a server that stopped answering shows its own last words, not only the failed read
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line: make the two tool calls, then reply." })
    .catch((error: unknown) => { throw new Error(`${String(error)}; server stderr tail:\n${stderr.slice(-6000)}`); });
  expect(sent.status).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    const final = String(engineReplies(rows).at(-1)?.text ?? "");
    const finished = final.includes("COMPACT_DONE") || isMarked(final);
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return finished && still >= 4 ? rows : null;
  }, 90_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  return { read, stored, ended: ended !== null };
}
const rowsLine = (rows: any[]) => JSON.stringify(rows.map(m => [m.role, m.kind, shown(m).slice(0, 100)]));
/** The owner's read and the store: no row reads «redacted» or REPLY_WITHHELD, the reply and both tool names are real. */
function expectShown(read: any[], stored: any[], calls: number) {
  const masked = [...read, ...stored].filter(m => isMarked(shown(m)));
  expect(masked.map(m => [m.kind, shown(m).slice(0, 100)]), rowsLine(read)).toEqual([]);
  expect(String(engineReplies(read).at(-1)?.text ?? ""), rowsLine(read)).toBe(REPLY);
  const tools = read.filter(m => m.tool).map(shown);
  for (const tool of TOOLS) expect(tools.filter(t => t.includes(tool)).length, `${tool}: ${rowsLine(read)}`).toBe(calls);
  expect(stored.map(shown).join("\n")).toContain(REPLY);
  // what the discarded attempts held goes with them: never shown, never stored
  const all = [...read, ...stored].map(shown).join("\n");
  for (const words of DISCARDED) expect(all, words).not.toContain(words);
}

describe("1.0.22 withheld-compaction: a discarded or compacted attempt of a clean Fuigo turn does not hold its reply or redact its tool names", () => {
  // Each row boots its own server in a fresh home: a fixture server that dies (inherited SIGBUS after a turn, logged below)
  // cannot fail the rows after it, and no row reads another row's store.
  beforeEach(async () => {
    stderr = "";
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-withheld-compaction-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    const engine = (steps: Step[]) => ({ driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true },
      environment: { FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_RETRY_DISCARD: "1", FAKE_ACP_SCRIPT: JSON.stringify(steps) } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: Object.fromEntries(Object.entries(SCRIPTS).map(([name, steps]) => [name, engine(steps)])) }));
    child = spawn(process.execPath, ["--import", new URL("./testing/recall-ready-preload.mjs", import.meta.url).href, "--import", IDLE_LOAD_PRELOAD,
      "--import", "data:text/javascript," + encodeURIComponent("globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;"), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), NODE_ENV: "test", ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", c => { stderr = (stderr + c).slice(-400_000); });
    child.on("exit", (code, signal) => { stderr += `\n[server exited code=${code} signal=${signal}]\n`; });
    child.stdout!.on("data", () => {});
    const deadline = Date.now() + 25_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise(r => setTimeout(r, 150));
    }
    const proof = await rawRequest("GET", "/api/desktop-secret");
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 45_000);
  afterEach(async () => {
    // a server that died leaves its own account for the log
    if (stderr.includes("[server exited")) console.error(`server stderr tail:\n${stderr.slice(-8000)}`);
    await stopFixtureServer(child); await removeTempDir(home);
  });

  it("R1 the canary row (think-only discards, compaction, both calls re-run): real tool names, the reply shown and stored", async () => {
    const { read, stored, ended } = await ownerTurn("Canary row", "canary");
    expect(ended, rowsLine(read)).toBe(true);
    expectShown(read, stored, 2);
  }, 120_000);

  it("R2 think-only attempts discarded mid-line, then the calls: nothing reads «redacted» or held back", async () => {
    const { read, stored, ended } = await ownerTurn("Think-only row", "thinkonly");
    expect(ended, rowsLine(read)).toBe(true);
    expectShown(read, stored, 1);
  }, 120_000);

  it("R3 a compaction that discarded the attempt it cut mid-line, then both calls again: nothing reads «redacted» or held back", async () => {
    const { read, stored, ended } = await ownerTurn("Compaction row", "compaction");
    expect(ended, rowsLine(read)).toBe(true);
    expectShown(read, stored, 2);
  }, 120_000);

  it("C1 control: a real credential in a re-run call's input is still never shown (the turn's secret rule holds)", async () => {
    const { read, stored } = await ownerTurn("Secret row", "secret");
    const all = [...read, ...stored].map(shown).join("\n");
    expect(all).not.toContain(FIXTURE_VALUE);
    expect(read.some(m => isMarked(shown(m))), rowsLine(read)).toBe(true);
  }, 120_000);

  it("C2 privacy: an open label head held by a discarded attempt still holds the turn; the value it may name is never shown or stored", async () => {
    const { read, stored } = await ownerTurn("Label head row", "labelopen");
    expect([...read, ...stored].map(shown).join("\n"), rowsLine(read)).not.toContain(LABELLED_VALUE);
    expect(read.some(m => isMarked(shown(m))), rowsLine(read)).toBe(true);
  }, 120_000);
});
