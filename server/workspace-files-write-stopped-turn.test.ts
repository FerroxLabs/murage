import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

// STOPRESTORE2: the workspace editor's Save inside the Stop → engine-close
// window, through the real server (server/index.ts) with the suite's fake
// engine. The Claude driver's interrupt is "requested, not observed": the
// bot reads idle as soon as Stop returns, while the turn's project-folder
// writer lease is released only when the CLI child closes and
// `turn.completed` reaches the bus. Before this lane an overwrite saved in
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
}

/** The fixture engine's pid is still a live process (not yet exited and reaped). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

const NOTE = "# Notes\n\nWritten before the turn.\n";
const EDIT = "# Notes\n\nEdited by the owner right after Stop.\n";

async function startFixture(signal: AbortSignal, env: Record<string, string>): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "murage-editor-stopped-turn-"));
  const data = join(root, "data"), project = join(root, "project"), dump = join(root, "fake-engine.json");
  for (const path of [data, project]) mkdirSync(path);
  const note = join(project, "notes.md"); writeFileSync(note, NOTE);
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixture: { driver: "claudeAgent", config: { cli: fakeCli } } } }));
  const port = await freePortBlock([0, 1]), secret = "7".repeat(64);
  const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
    HOME: root, USERPROFILE: root, PATH: process.env.PATH ?? "/usr/bin:/bin", MURAGE_DATA_DIR: data,
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump,
    ...env,
  }, stdio: ["ignore", "ignore", "pipe"] });
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
    await waitForExit(child, { signal: "SIGTERM" });
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
  const terminalFrame = (threadId: string) => frames.frames.find((frame: any) =>
    frame?.kind === "runtime" && frame.event?.threadId === threadId && frame.event.turnId
    && (frame.event.type === "turn.completed" || frame.event.type === "session.exited"));
  return { root, project, note, dump, child, api, events: frames, until, create, holdTurn, openNote, saveNote, idle, terminalFrame, stderr: () => stderr };
}

async function stopFixture(fixture: Fixture | undefined, pending: Array<Promise<unknown> | undefined>): Promise<void> {
  if (!fixture) return;
  fixture.events.close();
  for (const promise of pending) await promise?.catch(() => undefined);
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  await removeTempDir(fixture.root);
}

const posix = it.skipIf(process.platform === "win32");

posix("Stop then an immediate editor Save waits for the stopped turn's engine to close, then writes", async ({ signal }) => {
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
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    // Inside the window: the bot is idle, the engine child is still closing,
    // and its terminal event has not been observed.
    await until("the bot to read idle", () => fixture!.idle(bot.id));
    expect(processAlive(pid), "the fixture engine must still be closing when the save is sent").toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    let answer: Answer | undefined;
    save = fixture.saveNote(bot.id, threadId, opened.revision, EDIT);
    save.then(value => { answer = value; }, () => undefined);
    // The save is held while the stopped engine is still running: nothing
    // is on disk and no answer has arrived.
    await until("the stopped engine to close", () => !processAlive(pid) || answer);
    expect(answer, `the save answered while the stopped engine was still running: ${JSON.stringify(answer)}`).toBeUndefined();
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

posix("an editor Save while a live (not stopped) turn holds the folder is still refused at once with bot-writing", async ({ signal }) => {
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

posix("a stopped turn that does not close within the engine's budget refuses the Save as workspace_stopped_turn_closing, and a retry after the close writes", async ({ signal }) => {
  let fixture: Fixture | undefined;
  try {
    // A 1 s close budget (the isolated fixture may shorten it, never disable
    // it) against a CLI that takes 6 s to close after SIGTERM.
    fixture = await startFixture(signal, { FAKE_CLAUDE_SIGTERM_DELAY_MS: "6000", MURAGE_PROVIDER_CLOSE_MS: "1000" });
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
