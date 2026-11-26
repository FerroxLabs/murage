// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 withheld (field gate), the real path. Owners: lane fix1022-withheld-fable owns this witness and the take-back rule it
// pins (redact-turn.ts retract, reset, complete); the drivers own their frames (drivers/acp/core.ts resetForRetry, drivers/claude.ts
// stream_event and assistant); the harness owns the collector; redact2-1020 owns the stored row's owner view.
//
// Real server (the verification fixture, scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages), real drivers
// over real fake engine processes, the owner's transcript read and the store file. Two field shapes of 1.0.21, both ending in "Murage held back this message because it may repeat
// something that must stay hidden." on ordinary replies:
//  - an ACP engine (the canary's shapes, never its text): two tool calls, a compaction summary that streams and is voided by a
//    retry notice mid-line, the same two tools again, then the one-line answer. Every tool row read «redacted» as well.
//  - Claude: text streams, then the completed message is not what streamed (a stream cut and sent again), then a second message.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
// ASTRA 2c4cea9ffe High 2: pi resets both streams when an attempt that streamed ends in an error and pi retries
// (drivers/pi.ts:1396, message_start after stopReason "error"). Frame order as pi-settle.test.ts partial_break_retry (real pi 1.4.0).
const PI_TAKEN_BACK = "The first thing to";
const piFrames = () => {
  const opened = { type: "message_start", message: { role: "assistant" } }, usage = { input: 10, output: 2 };
  const text = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  return [{ type: "agent_start" }, { type: "turn_start" }, opened, text(PI_TAKEN_BACK),
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated" } }, { type: "turn_end", message: { role: "assistant", stopReason: "error" }, toolResults: [] },
    { type: "agent_end", willRetry: true }, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 50, errorMessage: "terminated" }, { type: "agent_start" },
    opened, text(ANSWER), { type: "message_end", message: { role: "assistant", stopReason: "stop", usage } }, { type: "turn_end", message: { role: "assistant", stopReason: "stop", usage }, toolResults: [] },
    { type: "agent_end", willRetry: false }, { type: "auto_retry_end", success: true }, { type: "agent_settled", aborted: false }];
};
const MARKER = "«redacted»";
const FIXTURE_VALUE = "FIXTURESECRET" + "123456";
const FIXTURE_SECRET = "api_key=" + FIXTURE_VALUE;
const STAMP = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", read_only: false } };
const callId = (n: number) => `call_fixture_retry_${String(n).padStart(3, "0")}_0123456`;
const stepCommand = (n: number) => `echo canary-step-${n}-ok`;
const DONE_LINE = "CANARY_DONE one tab open, screen size 1440x900 points.";
const SUMMARY_HEAD = "<summary>\n1. Primary request: list the open tabs and read the screen size.\n";
const SUMMARY_TAIL = "2. Next step: call both tools again and answer in one li";
const ANSWER = "Here is the answer you asked for.";
const NEXT = "Anything else you want me to look into?";

/** One scripted ACP turn: steps 1 and 2, a streamed summary voided by a retry notice mid-line, steps 3 and 4 (the same tools
 * again), then the answer. `takenBack` is the unfinished line the retry voids. */
function compactedTurn(takenBack: string): unknown[] {
  const steps: unknown[] = [];
  let at = 600;
  const call = (n: number) => {
    const rawInput = { variant: "UseTool", tool_name: "run_terminal_cmd", tool_input: { command: stepCommand(n), description: `Canary step ${n}`, timeout_ms: 120000, is_background: false } };
    steps.push({ at, update: { sessionUpdate: "tool_call", title: "use_tool", status: "pending", toolCallId: callId(n), kind: "other", rawInput, _meta: STAMP } });
    steps.push({ at: at + 20, update: { sessionUpdate: "tool_call_update", toolCallId: callId(n), status: "completed", rawOutput: { type: "exec", description: null, exit_code: 0, signal: null, timed_out: false, total_bytes: 18 + n, truncated: false } } });
    at += 60;
  };
  call(1); call(2);
  steps.push({ at, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The context is full, so I will summarise" } } });
  steps.push({ at: at + 10, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: SUMMARY_HEAD } } });
  steps.push({ at: at + 20, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: takenBack } } });
  // the engine voids the attempt (drivers/acp/core.ts onRetryState -> resetForRetry: content.reset of the open text item)
  steps.push({ at: at + 60, update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, reason: "context compacted" } });
  at += 120;
  call(3); call(4);
  steps.push({ at: at + 40, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: DONE_LINE } } });
  steps.push({ at: at + 140, result: { stopReason: "end_turn" } });
  return steps;
}

let fixture: VerificationServer, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
async function transcript(threadId: string): Promise<any[]> {
  const read = await api("GET", `/api/threads/${threadId}/messages?limit=200`);
  return (read.body?.messages ?? []) as any[];
}
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); }
  finally { db.close(); }
}
const shown = (row: any): string => JSON.stringify([row.text ?? "", row.tool ?? "", row.card ?? ""]);
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 300)); }
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
/** One owner line on a new bot of that engine; waits until `replies` engine replies are stored and the rows stop changing. */
async function ownerTurn(name: string, modelSelection: { instanceId: string; model: string }, replies: number) {
  const created = await api("POST", "/api/bots", { name, modelSelection });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line: list the tabs and read the screen size." })).status).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= replies && still >= 4 ? rows : null;
  }, 90_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  return { read, stored, ended: ended !== null };
}
const diag = (read: any[]) => `rows ${JSON.stringify(read.map(m => [m.role, m.kind, shown(m).slice(0, 110)]))}`;

describe("1.0.22 withheld, real path: a reply after an engine takes text back is shown and stored, never held back", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755); chmodSync(FAKE_CLAUDE, 0o755); chmodSync(FAKE_PI, 0o755);
    const piScript = join(mkdtempSync(join(tmpdir(), "withheld-retract-pi-")), "script.json");
    writeFileSync(piScript, JSON.stringify(piFrames()));
    const acp = (script: unknown[]) => ({ driver: "grokAgent", displayName: "ACP fixture", config: { cli: FAKE_ACP, fullAuto: true },
      environment: { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script) } });
    const instances = {
      compacted: acp(compactedTurn(SUMMARY_TAIL)),
      compactedsecret: acp(compactedTurn(`2. Next step: export ${FIXTURE_SECRET}`)),
      // FAKE_CLAUDE_MODE=stream: text deltas ("hello from " "fake claude", no line end), then the completed messages below
      piretry: { driver: "piAgent", displayName: "Pi fixture", config: { cli: FAKE_PI, fullAuto: true }, environment: { FAKE_PI_SCRIPT: piScript } },
      resent: { driver: "claudeAgent", displayName: "Claude fixture", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_MODE: "stream", FAKE_CLAUDE_TEXT_ONLY: "1", FAKE_CLAUDE_REPLIES: JSON.stringify([[ANSWER, NEXT]]) } },
    };
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs'); const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      Object.assign(cfg.instances, ${JSON.stringify(instances)});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90_000);
  afterAll(async () => { await fixture?.close(); });

  it("R1 ACP: a compaction summary voided mid-line and the tools run again: the answer and all four tool rows are shown and stored", async () => {
    const { read, stored, ended } = await ownerTurn("Compacted turn", { instanceId: "compacted", model: "fake-model" }, 1);
    expect(ended, diag(read)).toBe(true);
    const replies = engineReplies(read).map(m => String(m.text ?? ""));
    // the owner read: the answer is the engine's own line, and nothing reads held back or «redacted»
    expect(replies.at(-1), diag(read)).toBe(DONE_LINE);
    expect(read.map(shown).filter(text => text.includes(REPLY_WITHHELD) || text.includes(MARKER)), diag(read)).toEqual([]);
    const readTools = read.filter(m => m.tool).map(shown).join("\n");
    for (const n of [1, 2, 3, 4]) expect(readTools, `step ${n} tool row`).toContain(stepCommand(n));
    // the store itself
    const storedAll = stored.map(shown).join("\n");
    expect(storedAll).toContain(DONE_LINE);
    expect(storedAll).not.toContain(REPLY_WITHHELD);
    expect(storedAll).not.toContain(MARKER);
    for (const n of [1, 2, 3, 4]) expect(storedAll).toContain(stepCommand(n));
    // the voided attempt's unfinished line is in no row
    expect(storedAll).not.toContain("call both tools again");
  }, 180_000);

  it("R2 Claude: a completed message that is not what streamed, then a second message: both are shown and stored whole", async () => {
    const { read, stored, ended } = await ownerTurn("Resent stream", { instanceId: "resent", model: "claude-sonnet-5" }, 2);
    expect(ended, diag(read)).toBe(true);
    expect(engineReplies(read).map(m => String(m.text ?? "")), diag(read)).toEqual([ANSWER, NEXT]);
    expect(engineReplies(stored).map(m => String(m.text ?? ""))).toEqual([ANSWER, NEXT]);
    const all = [...read, ...stored].map(shown).join("\n");
    expect(all).not.toContain(REPLY_WITHHELD);
    expect(all).not.toContain(MARKER);
    // the streamed text the completed message replaced is in no row
    expect(all).not.toContain("hello from fake claude");
  }, 180_000);

  it("P1 pi: an attempt that streamed half a line ends in an error and pi retries (pi.ts:1396 reset): the answer is shown and stored", async () => {
    const { read, stored, ended } = await ownerTurn("Retried pi turn", { instanceId: "piretry", model: "ollama-cloud/glm-5.2" }, 1);
    expect(ended, diag(read)).toBe(true);
    const all = [...read, ...stored].map(shown).join("\n");
    expect(engineReplies(read).map(m => String(m.text ?? "")).at(-1), diag(read)).toBe(ANSWER);
    expect(engineReplies(stored).map(m => String(m.text ?? "")).at(-1)).toBe(ANSWER);
    expect(all).not.toContain(REPLY_WITHHELD);
    expect(all).not.toContain(PI_TAKEN_BACK);
  }, 180_000);

  // CHANGED-EXPECTATION, 1.0.22 cause B (MAIN-RULING 2026-11-25T04:05:01Z R3 vs ckc: ckc wins; MAIN-RULING 2026-11-24T19:49:25Z: the attack set binds; held-back-attack-1022 row ckc is
  // this control on the fix): a credential in the line the retry voids no longer holds back a later answer that repeats nothing; the
  // value itself is still in no row. Before cause B this row expected REPLY_WITHHELD for the answer: that was the 1.0.21 field bug.
  it("R3 control: the same ACP turn with a credential in the line the retry voids shows the answer, and the value is in no row", async () => {
    const { read, stored, ended } = await ownerTurn("Compacted turn with a credential", { instanceId: "compactedsecret", model: "fake-model" }, 1);
    expect(ended, diag(read)).toBe(true);
    const all = [...read, ...stored].map(shown).join("\n");
    expect(all).not.toContain(FIXTURE_VALUE);
    expect(engineReplies(read).map(m => String(m.text ?? "")).at(-1)).toBe(DONE_LINE);
    expect(engineReplies(stored).map(m => String(m.text ?? "")).at(-1)).toBe(DONE_LINE);
  }, 180_000);
});
