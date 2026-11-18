import { stoppedTurnFixture } from "./testing/stopped-turn-fixture.ts";
import { engineCloseGate } from "./testing/engine-close-gate.ts";
import { ENGINE_CLOSED_LATE_NOTE } from "./direct-late-close.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

// STOPRESTORE2: the workspace editor's Save inside the Stop → engine-close
// window, through the real server (server/index.ts) with the suite's fake
// engine. The Claude driver's interrupt is "requested, not observed": the
// bot reads idle as soon as Stop returns, while the turn's project-folder
// writer lease is released only when the CLI child closes and
// `turn.completed` reaches the bus. Before this fix an overwrite saved in
// that window was refused 423 `bot-writing`. Now it waits for the release —
// bounded by the engine's close budget, providerCloseDeadlineMs (5 s,
// MURAGE_PROVIDER_CLOSE_MS) — exactly as a Restore does (STOPRESTORE1).
//
// Every wait ends on the state it names or on a definitive failure (the
// server exited), never on a wall-clock window. FAKE_CLAUDE_SIGTERM_DELAY_MS
// makes the fake CLI take a fixed time to close after SIGTERM, so a test can
// stand inside the window deterministically. Nothing here touches a real
// app, ~/.murage, a provider or the network.

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Answer = { status: number; body: any };

interface Fixture {
  closeGate?: ReturnType<typeof engineCloseGate>;
  /** `stopInterrupt: "gate"`: written when the Stop reaches the engine call; the test's write lets it through. */
  stopCalled: string; stopRelease: string; setupCalled: string; setupRelease: string;
  /** A turn whose prompt carries TURN_HOLD waits for this file, then plays (TURN_FINISH: to its normal result). */
  turnRelease: string;
  root: string; project: string; note: string; dump: string;
  child: ChildProcess; api: Api; events: SseRecorder;
  until: <T>(what: string, check: () => T | Promise<T>) => Promise<NonNullable<T>>;
  /** Bot on `project` with the host computer off. */
  create: () => Promise<any>;
  /** Run one held turn on the bot (the fixture engine hangs), returning the
   * thread id and the engine child's pid once it has the prompt. */
  holdTurn: (botId: string, text: string) => Promise<{ threadId: string; pid: number }>;
  /** The editor's view of notes.md for one conversation: the revision a save
   * must be based on. */
  openNote: (botId: string, threadId: string) => Promise<{ revision: string; content: string }>;
  /** The editor's Save: an overwrite of notes.md based on `revision`. */
  saveNote: (botId: string, threadId: string, revision: string, content: string) => Promise<Answer>;
  idle: (botId: string) => Promise<boolean>;
  terminalFrame: (threadId: string) => any;
  stderr: () => string;
  /** Let the held fixture turn of this engine pid finish on its own (a normal end). */
  finishTurn: (pid: number) => void;
  /** holdTerminalFold: written once the first turn.completed is held from the folder-lease subscriber and the fold; write release to deliver both. */
  fold: { ready: string; release: string };
  /** lateBind: write release to run the held folder-lease bind; done is written once it ran. */
  bind: { release: string; done: string };
  /** holdProbe: once `hold` exists, the engine's next `--version` probe writes `held`, answers only after `release`, then writes `answered`. */
  probe: { hold: string; held: string; release: string; answered: string };
}

/** The fixture engine's pid is still a live process (not yet exited and reaped). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const NOTE = "# Notes\n\nWritten before the turn.\n";
const EDIT = "# Notes\n\nEdited by the owner right after Stop.\n";

const TURN_HOLD = "__fixture_hold_turn__", TURN_FINISH = "__fixture_finish_turn__";

async function startFixture(signal: AbortSignal, env: Record<string, string>, gateClose = false, legacyRequestedStop = false, stopControl?: "refuse" | "gate" | { rejectingStop?: boolean; holdTerminalFold?: boolean; lateBind?: boolean; holdProbe?: boolean }, holdSetup = false, unknownCloseKnowledge = false): Promise<Fixture> {
  const engine = typeof stopControl === "object" ? stopControl : {};
  const stopInterrupt = typeof stopControl === "string" ? stopControl : undefined;
  const root = mkdtempSync(join(tmpdir(), "murage-editor-stopped-turn-"));
  const data = join(root, "data"), project = join(root, "project"), dump = join(root, "fake-engine.json");
  for (const path of [data, project]) mkdirSync(path);
  const note = join(project, "notes.md"); writeFileSync(note, NOTE);
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  // holdProbe: the configured CLI is a test-side launcher for the same fake
  // CLI. Its `--version` answer waits on the test, so a Stop can land while
  // the turn is still in setup, before it has any engine process.
  const probe = { hold: join(root, "probe-hold"), held: join(root, "probe-held"), release: join(root, "probe-release"), answered: join(root, "probe-answered") };
  const heldCli = join(root, "held-probe-cli.mjs");
  if (engine.holdProbe) {
    writeFileSync(heldCli, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
if (process.argv[2] === "--version" && existsSync(${JSON.stringify(probe.hold)})) {
  appendFileSync(${JSON.stringify(probe.held)}, "held");
  while (!existsSync(${JSON.stringify(probe.release)})) await new Promise(resolve => setTimeout(resolve, 10));
  appendFileSync(${JSON.stringify(probe.answered)}, "answered");
}
await import(${JSON.stringify(pathToFileURL(fakeCli).href)});
`);
    chmodSync(heldCli, 0o755);
  }
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixture: { driver: "claudeAgent", config: { cli: engine.holdProbe ? heldCli : fakeCli } } } }));
  const port = await freePortBlock([0, 1]), secret = "7".repeat(64);
  const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const execution = stoppedTurnFixture(root, { legacyRequestedStop, stopInterrupt, holdSetup, unknownCloseKnowledge, ...engine });
  const turnRelease = join(root, "turn-release");
  const finishGates = join(root, "finish-gates"); mkdirSync(finishGates);
  const closeGate = gateClose ? engineCloseGate(root) : undefined;
  const child = spawn(process.execPath, [...execution.args, ...(closeGate?.args ?? []), fileURLToPath(new URL("./index.ts", import.meta.url))], { windowsHide: true, cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...fixturePlatformEnv(),
    HOME: root, USERPROFILE: root, PATH: process.env.PATH ?? "/usr/bin:/bin", MURAGE_DATA_DIR: data,
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: secret, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump,
    FAKE_CLAUDE_HOLD_MARKER: TURN_HOLD, FAKE_CLAUDE_HOLD_GATE: turnRelease,

    FAKE_CLAUDE_FINISH_GATE_DIR: finishGates, ...env,
  }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const api: Api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal, headers: { ...desktop, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const until = async <T>(what: string, check: () => T | Promise<T>): Promise<NonNullable<T>> => {
    for (;;) {
      if (signal.aborted) throw new Error(`test aborted while waiting for ${what}`);
      const value = await check();
      if (value) return value as NonNullable<T>;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited while waiting for ${what}: ${stderr.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let events: SseRecorder | undefined;
  try {
    await until("the server to answer health", async () => { try { return (await api("GET", "/api/health")).body.pid === child.pid; } catch { return false; } });
    events = await openSse(`http://127.0.0.1:${port}/api/events`, desktop);
  } catch (error) {
    events?.close();
    await stopFixtureServer(child);
    await removeTempDir(root);
    throw error;
  }
  const frames = events;
  const create = async () => {
    const result = await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "claude-sonnet-5" } });
    expect(result.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${result.body.bot.id}`, { cwd: project, computer: "off" })).status).toBe(200);
    return result.body.bot;
  };
  const holdTurn = async (botId: string, text: string) => {
    rmSync(dump, { force: true });
    const turn = await api("POST", `/api/bots/${botId}/messages`, { text });
    expect(turn.status).toBe(202);
    const threadId: string = turn.body.threadId;
    expect(threadId).toBeTruthy();
    // The dump is observable before its bytes are complete under load: wait
    // for a parseable record that names the engine's pid.
    const pid = await until("the fixture engine to receive the turn", () => {
      if (!existsSync(dump)) return 0;
      try { return Number(JSON.parse(readFileSync(dump, "utf8")).pid) || 0; } catch { return 0; }
    });
    expect(pid).toBeGreaterThan(0);
    return { threadId, pid };
  };
  const scopeQuery = (botId: string, threadId: string) => `botId=${encodeURIComponent(botId)}&threadId=${encodeURIComponent(threadId)}`;
  const openNote = async (botId: string, threadId: string) => {
    const read = await api("GET", `/api/workspace-files/read?${scopeQuery(botId, threadId)}&path=notes.md`);
    expect(read, JSON.stringify(read.body)).toMatchObject({ status: 200, body: { content: NOTE } });
    return { revision: read.body.revision as string, content: read.body.content as string };
  };
  const saveNote = (botId: string, threadId: string, revision: string, content: string) =>
    api("POST", "/api/workspace-files/write", { scope: { botId, threadId }, relativePath: "notes.md", baseRevision: revision, requestId: "editor-save-1", content, bom: false });
  const idle = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId).busy === false;
  // MAIN RULING INT-CONFLICT-DEFAULT: native terminal evidence stays private; public SSE is unchanged.
  const terminalFrame = execution.terminalFrame;
  return { closeGate, stopCalled: execution.stopCalled, stopRelease: execution.stopRelease, setupCalled: execution.setupCalled, setupRelease: execution.setupRelease, turnRelease, root, project, note, dump, child, api, events: frames, until, create, holdTurn, openNote, saveNote, idle, terminalFrame, stderr: () => stderr,
    finishTurn: pid => writeFileSync(join(finishGates, String(pid)), "finish"), fold: { ready: execution.foldReady, release: execution.foldRelease },
    bind: { release: execution.bindRelease, done: execution.bindDone }, probe };
}

async function stopFixture(fixture: Fixture | undefined, pending: Array<Promise<unknown> | undefined>): Promise<void> {
  if (!fixture) return;
  fixture.events.close();
  if (fixture.closeGate) writeFileSync(fixture.closeGate.release, "cleanup");
  for (const gate of [fixture.stopRelease, fixture.turnRelease]) writeFileSync(gate, "cleanup");
  writeFileSync(fixture.fold.release, "cleanup");
  writeFileSync(fixture.probe.release, "cleanup");
  for (const promise of pending) await promise?.catch(() => undefined);
  await stopFixtureServer(fixture.child);
  await removeTempDir(fixture.root);
}

// Windows TerminateProcess cannot deliver a catchable SIGTERM to the delayed-exit fixture.
// The live-writer row and the native Windows Stop/Save twin still run there.
const delayedSigterm = it.skipIf(process.platform === "win32");

delayedSigterm("Stop then an immediate editor Save waits for the stopped turn's engine to close, then writes", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let save: Promise<Answer> | undefined;
  try {
    // The fixture CLI closes 2 s after SIGTERM; the engine close budget stays
    // at its 5 s default, so the save must wait, not refuse.
    fixture = await startFixture(signal, { FAKE_CLAUDE_SIGTERM_DELAY_MS: "2000" });
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    const stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    // The shipped Stop confirms the engine close before it answers. While it
    // is in flight the engine child is still closing and the turn still
    // owns the folder: a concurrent Save is refused at once, nothing written.
    expect(processAlive(pid), "the fixture engine must still be closing while Stop is in flight").toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    // Stop answers only once the close is confirmed; the immediate Save then
    // lands on the released folder.
    expect(await stop).toMatchObject({ status: 200 });
    expect(processAlive(pid)).toBe(false);
    save = fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    expect(await save).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    // The writer lease is released on the engine's terminal event, which the
    // driver emits only once the child closed: the bytes landing after that
    // close proves the save waited for the stopped turn rather than
    // overlapping it.
    expect(processAlive(pid)).toBe(false);
    expect(readFileSync(note, "utf8")).toBe(EDIT);
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    // The revision the save replaced was kept in Files.
    const artifacts = await api("GET", `/api/artifacts?botId=${bot.id}`);
    expect(artifacts.status).toBe(200);
    expect(JSON.stringify(artifacts.body)).toContain("notes.md");
  } finally {
    await stopFixture(fixture, [save]);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

it("an editor Save while a live (not stopped) turn holds the folder is still refused at once with bot-writing", async ({ signal }) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startFixture(signal, { FAKE_CLAUDE_SIGTERM_DELAY_MS: "2000" });
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "keep working on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    const started = Date.now();
    const refused = await fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    expect(refused).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(refused.body.error).toMatch(/A bot is working in this workspace/);
    // Refused immediately, not after the close budget: the live turn is
    // untouched and nothing was written.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(processAlive(pid)).toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await until("the interrupted turn to reach its terminal event", () => fixture!.terminalFrame(threadId));
  } finally {
    await stopFixture(fixture, []);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

delayedSigterm("a stopped turn that does not close within the engine's budget refuses the Save as workspace_stopped_turn_closing, and a retry after the close writes", async ({ signal }) => {
  let fixture: Fixture | undefined;
  try {
    // A 1 s close budget (the isolated fixture may shorten it, never disable
    // it) against a CLI that takes 6 s to close after SIGTERM.
    fixture = await startFixture(signal, { FAKE_CLAUDE_SIGTERM_DELAY_MS: "6000", MURAGE_PROVIDER_CLOSE_MS: "1000" }, false, true);
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    await until("the bot to read idle", () => fixture!.idle(bot.id));
    expect(processAlive(pid)).toBe(true);
    const refused = await fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    expect(refused).toMatchObject({ status: 423, body: { code: "workspace_stopped_turn_closing" } });
    expect(refused.body.error).toMatch(/stopped bot turn is still closing/);
    expect(refused.body.error).toMatch(/save again/);
    // The bound expired while the engine was still closing: nothing was
    // written and the stopped turn still owns the folder.
    expect(processAlive(pid), "the still-closing refusal must arrive while the engine is still closing").toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    // The message says to save again: once the engine has closed, the retry writes.
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 200, body: { previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally {
    await stopFixture(fixture, []);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

// Legacy requested-stop adapter (Stop returns once requested): the stopped-closing admission window.
for (const expire of [false, true]) it(`controlled Windows-compatible close boundary: Save budget expires=${expire}`, async ({ signal }) => {
  let fixture: Fixture | undefined;
  let save: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, true, true);
    const { api, until, note, closeGate } = fixture;
    const bot = await fixture.create();
    const { threadId } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    await until("the engine close notification to be held", () => existsSync(closeGate!.ready));
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    save = fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    let answer: Answer | undefined;
    save.then(value => { answer = value; }, () => undefined);
    await until("admission to wait or answer", () => existsSync(closeGate!.waiting) || answer);
    expect(answer, "the action must wait while close is unconfirmed").toBeUndefined();
    expect(existsSync(closeGate!.waiting)).toBe(true);
    if (expire) {
      expect(await save).toMatchObject({ status: 423, body: { code: "workspace_stopped_turn_closing" } });
      expect(readFileSync(note, "utf8")).toBe(NOTE);
      expect(fixture.terminalFrame(threadId)).toBeUndefined();
    } else {
      expect(readFileSync(note, "utf8")).toBe(NOTE);
    }
    writeFileSync(closeGate!.release, "allow close");
    if (expire) {
      await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
      save = fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    }
    expect(await save).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    const artifacts = await api("GET", `/api/artifacts?botId=${bot.id}`);
    expect(artifacts.status).toBe(200);
    expect(JSON.stringify(artifacts.body)).toContain("notes.md");
  } finally { await stopFixture(fixture, [save]); }
}, 30000);

it("shipped Stop with the engine close held: Save is refused bot-writing and nothing is written when the close stays unconfirmed", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, true);
    const { api, until, note, closeGate } = fixture;
    const bot = await fixture.create();
    const { threadId } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    await until("the engine close notification to be held", () => existsSync(closeGate!.ready));
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    // Held past the engine budget the shipped Stop answers provider_stop_unconfirmed and the turn keeps the folder.
    expect(await stop).toMatchObject({ status: 409, body: { code: "provider_stop_unconfirmed" } });
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    // The confirmed late close is what releases the folder: Save then writes.
    writeFileSync(closeGate!.release, "allow close");
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    // The late-close note and release share a step: within the existing close budget, one Save must write.
    const lateNotes = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[])
      .filter(message => message.kind === "activity" && message.tool?.name === ENGINE_CLOSED_LATE_NOTE);
    await expect.poll(async () => (await lateNotes()).length, { timeout: 1000 }).toBe(1);
    expect(await lateNotes()).toHaveLength(1);
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

for (const unknownCloseKnowledge of [false, true]) it(`${unknownCloseKnowledge ? "unknown close knowledge: " : ""}shipped Stop with the engine close held: the turn settles unconfirmed, Save stays refused, and only the engine's later confirmed close lets it write`, async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, true, false, undefined, false, unknownCloseKnowledge);
    const { api, until, note, closeGate } = fixture;
    const bot = await fixture.create();
    const { threadId } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    await until("the engine close notification to be held", () => existsSync(closeGate!.ready));
    expect(await stop).toMatchObject({ status: 409, body: { code: "provider_stop_unconfirmed" } });
    // The engine settles the turn it could not confirm stopped: a terminal event, not a close receipt.
    await until("the unconfirmed turn's terminal event", () => fixture!.terminalFrame(threadId));
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    // Held fail closed past the bounded teardown, and the owner is told why.
    await until("the refusal to say the engine has not confirmed its close", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      expect(answer).toMatchObject({ status: 423, body: { code: "bot-writing" } });
      expect(readFileSync(note, "utf8")).toBe(NOTE);
      return /engine has not confirmed that it closed/.test(answer.body.error);
    });
    writeFileSync(closeGate!.release, "allow close");
    // Each refused Save writes nothing; the first one after the confirmed close writes.
    const saved = await until("a Save after the engine's confirmed close", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status === 200) return answer;
      expect(answer).toMatchObject({ status: 423, body: { code: "bot-writing" } });
      expect(readFileSync(note, "utf8")).toBe(NOTE);
      return undefined;
    });
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// MurageCloud review of the Stop-asked hold (HIGH): a Stop that reached no live
// child of the turn has no close proof to wait for, so the turn's own terminal
// event is its receipt. The turn ends on its own: by its normal result, or by
// the engine process exiting. The Stop either lands only after that ending
// ("late", held at the engine call) or is refused by the engine ("refused").
for (const ending of ["finishes", "exits"] as const) for (const stopping of ["late", "refused"] as const) {
  delayedSigterm(`a Stop that reaches no live child (${stopping}) does not hold the folder after the turn ${ending} on its own: Save then writes`, async ({ signal }) => {
    let fixture: Fixture | undefined;
    let stop: Promise<Answer> | undefined;
    try {
      fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, false, false, stopping === "late" ? "gate" : "refuse");
      const { api, until, note } = fixture;
      const bot = await fixture.create();
      const { threadId, pid } = await fixture.holdTurn(bot.id, `work on the notes ${TURN_HOLD} ${ending === "finishes" ? TURN_FINISH : ""}`);
      const opened = await fixture.openNote(bot.id, threadId);
      stop = api("POST", `/api/bots/${bot.id}/interrupt`);
      if (stopping === "late") await until("the Stop to reach the engine call", () => existsSync(fixture!.stopCalled));
      else expect(await stop).toMatchObject({ status: 409, body: { code: "provider_stop_unconfirmed" } });
      // The Stop was asked: a Save is still refused while the turn runs.
      expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
      if (ending === "finishes") writeFileSync(fixture.turnRelease, "finish");
      else process.kill(pid, "SIGKILL");
      await until("the turn's own terminal event", () => fixture!.terminalFrame(threadId));
      if (stopping === "late") { writeFileSync(fixture.stopRelease, "stop"); await stop; }
      const saved = await until("a Save after the turn ended on its own", async () => {
        const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
        if (answer.status === 200) return answer;
        expect(answer).toMatchObject({ status: 423, body: { code: "bot-writing" } });
        expect(readFileSync(note, "utf8")).toBe(NOTE);
        return undefined;
      });
      expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
      expect(readFileSync(note, "utf8")).toBe(EDIT);
    } finally { await stopFixture(fixture, [stop]); }
  }, 30000);
}

// MurageCloud review of the Stop-asked hold (HIGH), the case that hung: a Stop
// that reaches the turn in setup, before its engine exists. The engine's stop
// MAIN Q1=B: the setup unwind proves nothing launched, so Stop confirms that
// exact turn and its terminal event leaves the folder writable.
delayedSigterm("a Stop that reaches the turn in setup, before its engine exists, does not hold the folder after the turn ends: Save then writes", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, false, false, undefined, true);
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const turn = await api("POST", `/api/bots/${bot.id}/messages`, { text: "work on the notes" });
    expect(turn.status).toBe(202);
    const threadId: string = turn.body.threadId;
    await until("the turn to reach its held setup step", () => existsSync(fixture!.setupCalled));
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    await until("the Stop to reach the engine during setup", () => existsSync(fixture!.stopCalled));
    // The Stop was asked: a Save is still refused while the turn is in setup.
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    writeFileSync(fixture.setupRelease, "release");
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    expect(await stop).toMatchObject({ status: 200, body: { ok: true } });
    expect(existsSync(fixture.dump)).toBe(false);
    const saved = await until("a Save after the stopped turn ended", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status === 200) return answer;
      expect(answer).toMatchObject({ status: 423, body: { code: "bot-writing" } });
      expect(readFileSync(note, "utf8")).toBe(NOTE);
      return undefined;
    });
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// MurageCloud review of the trainred-stopwrite fix (MEDIUM): the folder an
// unconfirmed Stop keeps is not held forever. The child's later confirmed
// close (awaitTurnClose) releases it, and only then does Save write.
delayedSigterm("shipped Stop with the engine close held: the child's later confirmed close frees the folder for Save", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, true);
    const { api, until, note, closeGate } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    await until("the engine close notification to be held", () => existsSync(closeGate!.ready));
    expect(await stop).toMatchObject({ status: 409, body: { code: "provider_stop_unconfirmed" } });
    await until("the unconfirmed stop's terminal event", () => fixture!.terminalFrame(threadId));
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    writeFileSync(closeGate!.release, "allow close");
    await until("the stopped engine to exit", () => !processAlive(pid));
    const saved = await until("Save to be admitted after the confirmed close", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status === 423) { expect(answer.body).toMatchObject({ code: "bot-writing" }); return undefined; }
      return answer;
    });
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// arev-trainred-stopwrite-n4 (Medium): the server passes the engine that
// ended the turn to its lease completion (index.ts complete(..., turnAdapter)).
// A Stop-held generation bound only after that terminal event is released on
// that engine's evidence: its close is still unconfirmed, so the folder stays held.
it("a Stop-held turn bound only after its terminal event keeps the folder while the engine's close stays unconfirmed", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { MURAGE_PROVIDER_CLOSE_MS: "1000" }, true, false, { lateBind: true });
    const { api, until, note, closeGate } = fixture;
    const bot = await fixture.create();
    const { threadId } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    expect(existsSync(fixture.bind.done)).toBe(false);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    await until("the engine close notification to be held", () => existsSync(closeGate!.ready));
    expect(await stop).toMatchObject({ status: 409, body: { code: "provider_stop_unconfirmed" } });
    await until("the unconfirmed stop's terminal event", () => fixture!.terminalFrame(threadId));
    expect(existsSync(fixture.bind.done)).toBe(false);
    writeFileSync(fixture.bind.release, "bind");
    await until("the late folder-lease bind", () => existsSync(fixture!.bind.done));
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    writeFileSync(closeGate!.release, "allow close");
    const saved = await until("late-bound Save after confirmed close", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status === 423) { expect(answer.body).toMatchObject({ code: "bot-writing" }); return undefined; }
      return answer;
    });
    expect(saved).toMatchObject({ status: 200, body: { previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
    expect(await api("POST", `/api/bots/${bot.id}/interrupt`)).toMatchObject({ status: 200 });
    expect(await fixture.saveNote(bot.id, threadId, saved.body.revision, NOTE)).toMatchObject({ status: 200 });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// MAIN 10:01Z witnesses (MurageCloud review of f2e5db5e98, HIGH): a Stop
// that reaches no live child of the turn must not keep the folder past the
// turn's terminal event. (a) The Stop lands once the turn's own completion
// has started: the engine finished the turn and its terminal event is held
// from the server's fold until the Stop was asked. (b) The engine's
// interruptTurn rejects and the turn then ends normally.
it("a Stop that lands after the turn's own completion started does not keep the folder past the terminal event", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, {}, false, false, { holdTerminalFold: true });
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    fixture.finishTurn(pid);
    await until("the turn's own completion to be held from its folder lease and the fold", () => existsSync(fixture!.fold.ready));
    expect(await fixture.idle(bot.id)).toBe(false);
    // The completion has started but its folder lease was not completed yet: the turn still owns the folder.
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    const stopped = await stop;
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(500);
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    writeFileSync(fixture.fold.release, "deliver");
    await until("the turn's terminal event", () => fixture!.terminalFrame(threadId));
    // The release follows the engine's evidence for the ended turn; a folder held past it never answers 200.
    const saved = await until("Save to be admitted after the turn's terminal event", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status !== 423) return answer;
      expect(["bot-writing", "workspace_stopped_turn_closing"]).toContain(answer.body.code);
      return undefined;
    });
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

it("a Stop whose interruptTurn rejects, on a turn that then ends normally, does not keep the folder", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, {}, false, false, { rejectingStop: true });
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    const stopped = await stop;
    expect(stopped.status, JSON.stringify(stopped.body)).toBeLessThan(500);
    // The engine never stopped the turn: it is still writing, Save is refused.
    expect(processAlive(pid)).toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(readFileSync(note, "utf8")).toBe(NOTE);
    fixture.finishTurn(pid);
    await until("the turn's own terminal event", () => fixture!.terminalFrame(threadId));
    // The release follows the engine's evidence for the ended turn; a folder held past it never answers 200.
    const saved = await until("Save to be admitted after the turn's terminal event", async () => {
      const answer = await fixture!.saveNote(bot.id, threadId, opened.revision, EDIT);
      if (answer.status !== 423) return answer;
      expect(["bot-writing", "workspace_stopped_turn_closing"]).toContain(answer.body.code);
      return undefined;
    });
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// MAIN Q1=B (11-17, with the MurageCloud C1-C3 addendum): a Stop that lands
// while the turn is still in setup, before it has any engine process or MCP
// child, ends that setup StoppedBeforeLaunch. Nothing can ever close, so the
// Stop is confirmed: the owner gets 200 and the bot and folder are released
// through the same lease close as a confirmed stop. The version probe answers
// only after the Stop (the race): the stopped setup must not spawn, so no
// engine starts and nothing writes, and no lease or held turn is left behind.
// The launcher is a POSIX script, as the delayed-SIGTERM fixture is.
delayedSigterm("a Stop during the turn's setup, before it has any engine process, is confirmed: the probe answering afterwards spawns nothing and Save writes", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, {}, false, false, { holdProbe: true });
    const { api, until, note, dump } = fixture;
    const bot = await fixture.create();
    writeFileSync(fixture.probe.hold, "hold");
    const turn = await api("POST", `/api/bots/${bot.id}/messages`, { text: "work on the notes" });
    expect(turn.status).toBe(202);
    const threadId: string = turn.body.threadId;
    await until("the turn's setup to wait on the engine's version probe", () => existsSync(fixture!.probe.held));
    const opened = await fixture.openNote(bot.id, threadId);
    // The turn is in setup: it owns the folder and has spawned no engine.
    expect(await fixture.idle(bot.id)).toBe(false);
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 423, body: { code: "bot-writing" } });
    expect(existsSync(dump)).toBe(false);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    // Nothing launched, so nothing is left to close: the Stop is confirmed.
    expect(await stop).toMatchObject({ status: 200 });
    await until("the stopped setup's terminal event", () => fixture!.terminalFrame(threadId));
    // The probe answers only now, after the Stop: the stopped setup must not go on to start an engine.
    expect(existsSync(fixture.probe.answered)).toBe(false);
    writeFileSync(fixture.probe.release, "answer");
    await until("the held version probe to answer", () => existsSync(fixture!.probe.answered));
    // The bot and the folder are free: no lease or held turn outlives the confirmed Stop.
    await until("the bot to be idle after the confirmed setup Stop", () => fixture!.idle(bot.id));
    const saved = await fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    expect(saved).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
    // A second Stop finds nothing unconfirmed left to report.
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    expect(existsSync(dump)).toBe(false);
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);

// Retain the original platform-specific receipt test alongside the controlled close-window cases.
it.runIf(process.platform === "win32")("Windows Stop then editor Save joins the engine close and records the previous revision", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let stop: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, {});
    const { api, until, note } = fixture;
    const bot = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(bot.id, "work on the notes");
    const opened = await fixture.openNote(bot.id, threadId);
    stop = api("POST", `/api/bots/${bot.id}/interrupt`);
    stop.catch(() => undefined);
    await until("the stopped engine's terminal event", () => fixture!.terminalFrame(threadId));
    expect(processAlive(pid)).toBe(false);
    expect(await stop).toMatchObject({ status: 200 });
    expect(await fixture.saveNote(bot.id, threadId, opened.revision, EDIT)).toMatchObject({ status: 200, body: { requestId: "editor-save-1", previousRevision: opened.revision } });
    expect(readFileSync(note, "utf8")).toBe(EDIT);
    const artifacts = await api("GET", `/api/artifacts?botId=${bot.id}`);
    expect(artifacts.status).toBe(200);
    expect(JSON.stringify(artifacts.body)).toContain("notes.md");
  } finally { await stopFixture(fixture, [stop]); }
}, 30000);
