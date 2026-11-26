// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 group B, rows S5/S6 (+ AMEND X5/X6) of cause22-eng-design3-fable/DESIGN.md (owner lane cause22-eng). One real engine frame,
// every field unchanged, reaches the real Claude / Codex / Pi driver through adapter.sendTurn longer than any string the runtime can
// hold (the REAL limit, buffer.constants.MAX_STRING_LENGTH): the pad rig (testing/cause22-fit-pad.fixture.mjs) wraps the driver's
// own fake engine and puts one `_pad` member of LIMIT + 1 units in front of the named frame. A fitted terminal frame settles the
// turn with the mark set before it (R2, X6); a fitted request to us gets the driver's own negative answer by its id, read back
// from the engine's side, so the engine goes on and the turn completes (R1); an allow/accept (or no answer) on cut text fails at
// each request row's `answer` assertion. The Claude ask socket (the broker the ask proxy writes to) and the Pi catalog probe
// (X5) are read the same way through their own entry points. MAIN-RULING groupB-pick-path (1)/(2).
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { constants } from "node:buffer";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { turnOutsideMark } from "../email/external-marks.ts";
import { LINE_FITTED_NOTICE, OVERSIZE_FITTED_ASK_LINE } from "../owner-turn-caps.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { CLAUDE_BASH_WIPE_CALLBACK } from "./claude-bash-hook.ts";
import { ClaudeDriver, createPermissionBroker } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { CodexDriver } from "./codex.ts";
import { fetchPiModels, PiDriver } from "./pi.ts";

useOutsideStoreFixture();
const LIMIT = constants.MAX_STRING_LENGTH;
const rig = fileURLToPath(new URL("../testing/cause22-fit-pad.fixture.mjs", import.meta.url));
const fake = (name: string) => fileURLToPath(new URL(`../testing/${name}`, import.meta.url));
let instance: ProviderInstance | undefined;
const touched: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await instance?.dispose().catch(() => {}); instance = undefined; resetClaudeVersionGate();
  for (const key of touched.splice(0)) delete process.env[key];
  for (const undo of cleanups.splice(0)) undo();
});
const readLines = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

type Row = {
  name: string; engine: "claude" | "codex" | "pi"; frames?: string; env?: Record<string, string>; site?: string; fullAuto?: boolean;
  /** R1 request rows: the answer the engine itself read back, from the fake's own log (env `logKey`, a fresh file per run). */
  logKey?: string; answer?: (log: string) => unknown; expected?: unknown;
};
const claudeAnswer = (log: string) => readLines(log).find((m) => m?.type === "control_response" && m.response?.request_id === "cli-ctl-1")?.response;
const ROWS: Row[] = [
  { name: "S5b claude: the turn's terminal `result` is fitted", engine: "claude", frames: "result", site: "claude-line-fitted" },
  { name: "S5 claude: an MCP elicitation control_request is fitted", engine: "claude", frames: "control_request",
    env: { FAKE_CLAUDE_ELICIT: JSON.stringify([{ subtype: "elicitation", mcp_server_name: "fixture", message: "Pick one", requested_schema: { type: "object", properties: {} } }]) },
    logKey: "FAKE_CLAUDE_ELICIT_LOG", answer: claudeAnswer,
    expected: { subtype: "error", request_id: "cli-ctl-1", error: OVERSIZE_FITTED_ASK_LINE } },
  { name: "S5h claude: a Bash wipe hook_callback control_request is fitted (claude.ts onFit hook deny)", engine: "claude", frames: "control_request",
    env: { FAKE_CLAUDE_ELICIT: JSON.stringify([{ subtype: "hook_callback", callback_id: CLAUDE_BASH_WIPE_CALLBACK, tool_use_id: "fit-tool-1",
      input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo fitted" } } }]) },
    logKey: "FAKE_CLAUDE_ELICIT_LOG", answer: claudeAnswer,
    expected: { subtype: "success", request_id: "cli-ctl-1", response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: OVERSIZE_FITTED_ASK_LINE } } } },
  { name: "S5n claude: a fitted line that is JSON null before the `result` (ASTRA claude.ts:6030)", engine: "claude",
    env: { CAUSE22_PAD_NULL_BEFORE: "result" }, site: "claude-line-fitted" },
  { name: "S5c claude: a fitted `assistant` frame holding a null content block (ASTRA 629eae4816 claude.ts:6224)", engine: "claude",
    frames: "assistant", env: { CAUSE22_PAD_NULL_IN: "assistant" }, site: "claude-line-fitted" }, { name: "S5u claude: a whole (not fitted) line ` null` before the `result` (claude.ts:6011 guard, onLine path)", engine: "claude", env: { CAUSE22_PAD_NULL_BEFORE: "result", CAUSE22_PAD_UNITS: "1" } },
  { name: "S5 codex: the turn's turn/completed is fitted", engine: "codex", frames: "turn/completed", site: "codex-line-fitted" },
  { name: "S5r codex: a server request (execCommandApproval) is fitted (codex.ts onFit refusal)", engine: "codex", frames: "execCommandApproval",
    fullAuto: false, env: { FAKE_CODEX_MODE: "approval" },
    logKey: "FAKE_CODEX_DUMP", answer: (log) => existsSync(log) ? JSON.parse(readFileSync(log, "utf8")).decision : undefined,
    expected: { decision: "denied" } },
  { name: "S6 pi: the turn's agent_end is fitted", engine: "pi", frames: "agent_end", site: "pi-line-fitted" },
  { name: "S6 pi: an extension_ui_request dialog is fitted", engine: "pi", frames: "extension_ui_request", env: { FAKE_PI_MODE: "permission" },
    logKey: "FAKE_PI_COMMAND_LOG", answer: (log) => readLines(log).find((m) => m?.type === "extension_ui_response"),
    expected: { type: "extension_ui_response", id: expect.anything(), cancelled: true } },
];

const create = async (row: Row, environment: Record<string, string>) => {
  const config = { cli: rig, fullAuto: row.fullAuto ?? true, permissionMode: "bypassPermissions" as const };
  const input = { instanceId: `fit-${row.engine}`, displayName: row.engine, enabled: true, environment, config };
  if (row.engine === "claude") return admittedFixtureInstance(ClaudeDriver.create(input));
  if (row.engine === "codex") return CodexDriver.create(input);
  return PiDriver.create(input);
};

/** Every error that escapes a live listener (a stdout `data` handler) during the turn; vitest's own handlers are put back after. */
const catchUncaught = () => {
  const caught: string[] = [];
  const prior = process.rawListeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const own = (error: unknown) => { caught.push(String(error)); };
  process.on("uncaughtException", own);
  cleanups.push(() => { process.off("uncaughtException", own); for (const listener of prior) process.on("uncaughtException", listener); });
  return caught;
};

it.each(ROWS)("$name: the turn settles ok; a request gets the driver's own negative answer; any other frame is marked and told once", async (row) => {
  ensureDirs();
  const real = fake(row.engine === "claude" ? "fake-claude-cli.ts" : row.engine === "codex" ? "fake-codex-app-server.ts" : "fake-pi-cli.ts");
  chmodSync(real, 0o755); chmodSync(rig, 0o755);
  const log = join(mkdtempSync(join(tmpdir(), "cause22-fit-")), "engine.log");
  const environment = { CAUSE22_REAL_CLI: real, CAUSE22_PAD_UNITS: String(LIMIT + 1), CAUSE22_PAD_FRAMES: row.frames ?? "",
    ...(row.logKey ? { [row.logKey]: log } : {}), ...(row.env ?? {}) };
  for (const [key, value] of Object.entries(environment)) { process.env[key] = value; touched.push(key); }
  const caught = catchUncaught();
  instance = await create(row, environment);
  const recorder = recordEvents(instance.adapter);
  try {
    const threadId = `fit-${row.engine}-${row.frames ?? "null"}`;
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "hello" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 90_000).catch(() => undefined) as (RuntimeEvent & { ok?: boolean }) | undefined;
    expect(caught, `${row.name}: nothing thrown from the live listener`).toEqual([]);
    if (row.answer) expect(row.answer(log), `${row.name}: answer`).toEqual(row.expected);
    expect(done?.ok, `${row.name}: settled`).toBe(true);
    const notices = recorder.events.filter((e) => e.turnId === turnId && e.type === "item.started" && (e as { title?: string }).title === LINE_FITTED_NOTICE);
    if (row.site) {
      expect(turnOutsideMark(threadId)?.site, `${row.name}: marked`).toBe(row.site);
      expect(notices, `${row.name}: told once`).toHaveLength(1);
    }
  } finally { recorder.stop(); }
}, 200_000);

it("S5a claude ask socket: an ask past the string limit gets the oversize deny by its id, never the owner's allow (claude.ts broker onFit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cause22-ask-"));
  const asks: string[] = [];
  // The owner allows every ask shown: an ask on cut text that reached the card would come back allowed.
  const broker = await createPermissionBroker({
    socketPaths: [join(dir, "p.sock")],
    onAsk: (ask) => { asks.push(ask.id); broker.answer(ask.id, "allow", "Owner decision"); },
    onResolve: () => {},
  });
  cleanups.push(() => broker.close());
  const socket = connect(broker.socketPath);
  cleanups.push(() => socket.destroy());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let received = "";
  const answered = new Promise<any>((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(received.slice(0, newline)));
    });
    socket.once("close", () => resolve(undefined));
    setTimeout(() => resolve(undefined), 60_000).unref();
  });
  // The proxy's ask frame, every field unchanged, with one `_pad` member of LIMIT + 1 units in front, written in 1 MiB pieces.
  const piece = "x".repeat(1024 * 1024);
  const write = (text: string) => new Promise<void>((resolve) => { if (socket.write(text)) resolve(); else socket.once("drain", () => resolve()); });
  await write('{"_pad":"');
  for (let left = LIMIT + 1; left > 0; left -= piece.length) await write(left >= piece.length ? piece : piece.slice(0, left));
  await write('","t":"ask","id":"fit-ask-1","tool":"Bash","input":{"command":"echo fitted"}}\n');
  const answer = await answered;
  expect(answer, "ask socket: answer").toEqual({ t: "answer", id: "fit-ask-1", behavior: "deny", message: OVERSIZE_FITTED_ASK_LINE });
  expect(asks, "ask socket: no card on cut text").toEqual([]);
}, 200_000);

it("X5 pi catalog probe: a get_available_models reply past the string limit is fitted and read, never dropped (pi.ts catalog onFit)", async () => {
  chmodSync(fake("fake-pi-cli.ts"), 0o755); chmodSync(rig, 0o755);
  const catalog = await fetchPiModels(rig, {
    PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "cause22-pi-catalog-")),
    CAUSE22_REAL_CLI: fake("fake-pi-cli.ts"), CAUSE22_PAD_UNITS: String(LIMIT + 1), CAUSE22_PAD_FRAMES: "response",
  });
  expect(catalog.options.length, "pi catalog: models").toBeGreaterThan(0);
}, 200_000);
