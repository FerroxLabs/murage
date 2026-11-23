// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 redact-acp (owner rule): a long CLEAN owner turn on an ACP engine (Fuigo, Grok, Gemini, OpenCode) is never shown or
// stored as «redacted». Live report (real-engine matrix, dev/1020q-late a2d7e660): a real Fuigo 72-step owner turn came back
// with every tool row and the final reply masked, while Claude and Codex passed.
// Owners: the redact-acp closer owns this witness; the collector and turn policy are owned by their modules.
// Real server, real dispatch, real ACP driver (server/drivers/acp/core.ts) over a real fake ACP process. The frames copy the
// SHAPES and counts of recorded real Fuigo turns (never their text): a text chunk, a `tool_call` through the use_tool wrapper
// with the engine stamp, a `session/request_permission` for it (answered by the host at full access), then a
// `tool_call_update` whose rawOutput is the seven-key result record with null, number and boolean leaves.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { prepareFixtureRecall } from "./testing/recall-ready-fixture.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const IDLE_LOAD_PRELOAD = pathToFileURL(join(SERVER_DIR, "testing", "idle-load-preload.mjs")).href;
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const MARKER = "«redacted»";
const STEPS = 72;
// The fixture credential of the redact witnesses (joined at run time).
const FIXTURE_VALUE = "FIXTURESECRET" + "123456";
const FIXTURE_SECRET = "api_key=" + FIXTURE_VALUE;
const STAMP = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", read_only: false } };
const OPTIONS = [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }];
const callId = (n: number) => `call_fixture_step_${String(n).padStart(3, "0")}_0123456`;
const stepText = (n: number) => `Step ${n} of ${STEPS}: reading the next source.`;
const stepCommand = (n: number) => `echo research-step-${n}-ok`;
const DONE_LINE = "RESEARCH_DONE all seventy-two steps are summarised above.";

/** The result record of an MCP call that returns a whole object: more leaves than one policy batch holds. */
const wideRecord = (n: number) => ({ content: [{ type: "text", text: `created item ${n}` }], isError: false,
  structuredContent: { item: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`field_${k}`, k % 3 ? `value ${k}` : k])) } });
const WIDE_STEPS = 12;
/** More fields than the turn's table holds with these shapes (about 23 new fields a step: full near step 90). */
const TABLE_STEPS = 130;
/** One scripted Fuigo-shaped turn. `secretStep` puts a credential in that step's command (the control); `wide` makes
 * every result a wide record. */
function fuigoTurn(count: number, secretStep = 0, wide = false, asks = true): unknown[] {
  const steps: unknown[] = [];
  // the first frame waits until the prompt is certainly written (a frame racing the prompt is not this turn's)
  let at = 600;
  for (let n = 1; n <= count; n++, at += 45) {
    const command = n === secretStep ? `export ${FIXTURE_SECRET}` : stepCommand(n);
    const rawInput = { variant: "UseTool", tool_name: "run_terminal_cmd", tool_input: { command, description: `Research step ${n}`, timeout_ms: 120000, is_background: false } };
    const toolCall = { toolCallId: callId(n), kind: "other", rawInput, _meta: STAMP };
    steps.push({ at, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${stepText(n)}\n` } } });
    steps.push({ at: at + 5, update: { sessionUpdate: "tool_call", title: "use_tool", status: "pending", ...toolCall } });
    const done = { sessionUpdate: "tool_call_update", toolCallId: callId(n), status: "completed",
      rawOutput: wide ? wideRecord(n) : { type: "exec", description: null, exit_code: 0, signal: null, timed_out: false, total_bytes: 18 + n, truncated: false } };
    // `asks` false: the same frames without the permission ask (the 130-step script must fit one environment value)
    if (asks) {
      steps.push({ at: at + 10, request: { id: 7000 + n, method: "session/request_permission", params: { toolCall, options: OPTIONS } } });
      steps.push({ after: 7000 + n, at: 2, update: done });
    } else steps.push({ at: at + 20, update: done });
  }
  if (!asks) return [...steps, { at: at + 60, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: DONE_LINE } } }, { at: at + 140, result: { stopReason: "end_turn" } }];
  steps.push({ after: 7000 + count, at: 60, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: DONE_LINE } } });
  steps.push({ after: 7000 + count, at: 140, result: { stopReason: "end_turn" } });
  return steps;
}

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
/** The owner transcript read, every page (one page holds only the newest rows of a long turn). */
async function transcript(threadId: string): Promise<any[]> {
  const rows: any[] = [];
  let before = "";
  for (let page = 0; page < 40; page++) {
    const read = await api("GET", `/api/threads/${threadId}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    const got = (read.body?.messages ?? []) as any[];
    rows.unshift(...got.filter(m => !rows.some(r => r.id === m.id)));
    if (read.body?.hasMore !== true || !got.length || got[0].id === before) break;
    before = got[0].id;
  }
  return rows;
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
  // The live turn ran at No limits: every step's permission ask is answered by the host and leaves its own note row
  // (the raise is the one demo-replay-1118-api.test.ts uses).
  expect((await api("POST", "/api/no-limits/terms", { acknowledgeNoLimits: true })).status).toBe(200);
  const seen = (await api("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", targetLevel: "no-limits" })).body;
  const saved = await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", previewId: seen.previewId, ifRev: seen.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/permissions/refresh`, { scope: "open", rosterId: seen.rosterId, targetLevel: seen.targetLevel, afterRev: saved.body.bot?.permissionRev ?? saved.body.permissionRev })).status).toBe(200);
  return bot;
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
/** Send one owner line and wait until the row count stops changing after the last step's reply or a mask is stored. */
async function ownerTurn(botName: string, instanceId: string, count = STEPS) {
  const bot = await makeBot(botName, instanceId);
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line: run the research steps." })).status).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    const final = engineReplies(rows).at(-1);
    const done = final !== undefined && (String(final.text ?? "").includes("RESEARCH_DONE") || (String(final.text ?? "").includes(MARKER) && rows.length > count));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return done && still >= 4 ? rows : null;
  }, 180_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  return { bot, read, stored, ended: ended !== null };
}

describe("a long clean owner turn on an ACP engine (Fuigo shapes) is shown and stored, never «redacted»", () => {
  beforeAll(async () => {
    port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-redact-acp-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    const engine = (script: unknown[]) => ({ driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true },
      environment: { FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script) } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: { clean: engine(fuigoTurn(STEPS)), secret: engine(fuigoTurn(STEPS, 50)), wide: engine(fuigoTurn(WIDE_STEPS, 0, true)), table: engine(fuigoTurn(TABLE_STEPS, 0, false, false)) } }));
    child = spawn(process.execPath, ["--import", new URL("./testing/recall-ready-preload.mjs", import.meta.url).href, "--import", IDLE_LOAD_PRELOAD,
      "--import", "data:text/javascript," + encodeURIComponent("globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;"), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), NODE_ENV: "test", ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", c => { stderr = (stderr + c).slice(-400_000); });
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
  afterAll(async () => { await stopFixtureServer(child); await removeTempDir(home); });

  it("W1 72 clean steps: no tool row and no reply reads «redacted»; the store holds the real text and the transcript read returns it", async () => {
    const { read, stored, ended } = await ownerTurn("Long research", "clean");
    const tail = () => stderr.split("\n").filter(line => /acpdiag/.test(line)).slice(0, 12).join(" | ");
    const diag = () => `rows ${read.length}, stored ${stored.length}, kinds ${JSON.stringify(read.slice(0, 8).map(m => [m.role, m.kind, shown(m).slice(0, 90)]))}; ${tail()}`;
    expect(ended, diag()).toBe(true);
    // the transcript read (the owner view)
    const masked = read.filter(m => shown(m).includes(MARKER));
    expect(masked.length, `first masked rows: ${JSON.stringify(masked.slice(0, 3).map(m => [m.kind, shown(m).slice(0, 80)]))}; ${diag()}`).toBe(0);
    const replies = engineReplies(read).map(m => String(m.text ?? ""));
    for (const n of [1, 2, 36, 50, 71, STEPS]) expect(replies.some(text => text.includes(stepText(n))), `step ${n} reply`).toBe(true);
    expect(replies.at(-1)).toContain(DONE_LINE);
    const readTools = read.filter(m => m.tool).map(shown).join("\n");
    for (const n of [1, 2, 36, 50, 71, STEPS]) expect(readTools, `step ${n} tool row`).toContain(stepCommand(n));
    // the store itself
    const storedAll = stored.map(shown).join("\n");
    expect(storedAll).not.toContain(MARKER);
    for (const n of [1, 36, 50, STEPS]) { expect(storedAll).toContain(stepText(n)); expect(storedAll).toContain(stepCommand(n)); }
    expect(storedAll).toContain(DONE_LINE);
    expect(stored.filter(m => m.tool && shown(m).includes("research-step-")).length).toBeGreaterThanOrEqual(STEPS);
    // the host answered the asks at No limits (the live turn's shape): no card was raised for the owner
    expect(read.some(m => /Approved/.test(shown(m)))).toBe(true);
    expect(read.filter(m => /Approval needed/.test(shown(m)))).toEqual([]);
  }, 240_000);

  it("W3 130 clean steps (more fields than the turn's table holds): the late rows and the reply are shown and stored", async () => {
    const { read, stored, ended } = await ownerTurn("Longer research", "table", TABLE_STEPS);
    const first = [...read, ...stored].filter(m => shown(m).includes(MARKER)).slice(0, 3).map(m => [m.kind, shown(m).slice(0, 80)]);
    expect(ended, JSON.stringify(first)).toBe(true);
    expect(first).toEqual([]);
    const replies = engineReplies(read).map(m => String(m.text ?? ""));
    for (const n of [1, 89, 90, 91, 110, TABLE_STEPS]) expect(replies.some(text => text.includes(`Step ${n} of`)), `step ${n} reply`).toBe(true);
    expect(replies.at(-1)).toContain(DONE_LINE);
    const readTools = read.filter(m => m.tool).map(shown).join("\n"), storedAll = stored.map(shown).join("\n");
    for (const n of [1, 89, 90, 91, 110, TABLE_STEPS]) { expect(readTools, `step ${n} tool row`).toContain(stepCommand(n)); expect(storedAll).toContain(stepCommand(n)); }
    expect(storedAll).toContain(DONE_LINE);
  }, 300_000);

  it("W2 12 steps whose results are wide records (an MCP object result): nothing reads «redacted»", async () => {
    const { read, stored, ended } = await ownerTurn("Wide results", "wide", WIDE_STEPS);
    const first = [...read, ...stored].filter(m => shown(m).includes(MARKER)).slice(0, 3).map(m => [m.kind, shown(m).slice(0, 80)]);
    expect(ended, JSON.stringify(first)).toBe(true);
    expect(first).toEqual([]);
    const replies = engineReplies(read).map(m => String(m.text ?? ""));
    for (const n of [1, 6, WIDE_STEPS]) expect(replies.some(text => text.includes(stepText(n))), `step ${n} reply`).toBe(true);
    expect(replies.at(-1)).toContain(DONE_LINE);
    const storedAll = stored.map(shown).join("\n");
    for (const n of [1, WIDE_STEPS]) { expect(storedAll).toContain(stepText(n)); expect(storedAll).toContain(stepCommand(n)); }
    expect(storedAll).toContain(DONE_LINE);
  }, 240_000);

  it("C1 control: the same turn with a real credential in step 50 is still redacted, in the owner read and in the store", async () => {
    const { read, stored } = await ownerTurn("Long research with a credential", "secret");
    const all = [...read, ...stored].map(shown).join("\n");
    expect(all).not.toContain(FIXTURE_VALUE);
    // the hit is marked, and the existing secret rule covers the rest of this turn
    expect(read.some(m => shown(m).includes(MARKER))).toBe(true);
    expect(stored.some(m => shown(m).includes(MARKER))).toBe(true);
    // what was shown before the hit stays real
    expect(read.map(shown).join("\n")).toContain(stepText(1));
  }, 240_000);
});
