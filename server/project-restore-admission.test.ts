import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

// Every wait in these tests ends on the state it names, or on a definitive
// failure (the server exited, the restore answered without reaching Git, the
// writer reached the engine) — never on a wall-clock window. Under load the
// same steps take longer; they must not change the outcome. The test timeout
// stays the only hang guard, and its abort signal still runs cleanup.
//
// The Stop → close window: the Claude driver's interrupt requests SIGTERM and
// returns, so the bot reads idle at once, while the turn's project-folder
// writer lease is released only when the CLI child closes and `turn.completed`
// reaches the bus. The bus delivers synchronously in registration order and
// the lease subscriber precedes the SSE runtime broadcast, so the frame is
// observable only after the lease was released. FAKE_CLAUDE_SIGTERM_DELAY_MS
// makes the fake CLI take a fixed time to close, so a test can stand inside
// that window deterministically (STOPRESTORE1).

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Answer = { status: number; body: any };

interface Fixture {
  root: string; project: string; marker: string; dump: string; ready: string; release: string;
  child: ChildProcess; api: Api; events: SseRecorder;
  until: <T>(what: string, check: () => T | Promise<T>) => Promise<NonNullable<T>>;
  /** Bot on `project` with the host computer off. */
  create: () => Promise<any>;
  /** Run one held turn on the bot (the fixture engine hangs), returning the
   * thread id and the engine child's pid once it has the prompt. */
  holdTurn: (botId: string, text: string) => Promise<{ threadId: string; pid: number }>;
  /** The bot's newest checkpoint hash for `project`. */
  checkpointOf: (botId: string) => Promise<string>;
  terminalFrame: (threadId: string) => any;
  stderr: () => string;
}

/** The fixture engine's pid is still a live process (not yet exited and reaped). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function startFixture(signal: AbortSignal, options: { env?: Record<string, string>; gateRestore?: boolean } = {}): Promise<Fixture> {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), "murage-restore-admission-"));
  const data = join(root, "data"), bin = join(root, "bin"), project = join(root, "project");
  const ready = join(root, "restore-ready"), release = join(root, "restore-release"), dump = join(root, "fake-engine.json");
  for (const path of [data, bin, project]) mkdirSync(path);
  const marker = join(project, "work.txt"); writeFileSync(marker, "checkpoint contents");
  // Only this fixture's child PATH uses the wrapper. Every real Git operation
  // delegates unchanged, except restore waits at an explicit readiness gate.
  // The gate holds until the test releases it (the finally block always
  // does) or until the server that spawned it is gone. Tests that only need
  // "the restore reached Git" pre-open the gate and keep the ready marker.
  if (!options.gateRestore) writeFileSync(release, "open");
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');(async()=>{const args=process.argv.slice(2);if(args[0]==='restore'){const parent=process.ppid;fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)})){if(process.ppid!==parent){process.stderr.write('fixture restore gate lost its server');process.exit(2);}await new Promise(r=>setTimeout(r,10));}}const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);})().catch(()=>process.exit(2));\n`, { mode: 0o700 });
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixture: { driver: "claudeAgent", config: { cli: fakeCli } } } }));
  const port = await freePortBlock([0, 1]), secret = "7".repeat(64);
  const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
    HOME: root, USERPROFILE: root, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MURAGE_DATA_DIR: data,
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump,
    ...options.env,
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
    await until("the fixture engine to receive the turn", () => existsSync(dump));
    const pid = Number(JSON.parse(readFileSync(dump, "utf8")).pid);
    expect(pid).toBeGreaterThan(0);
    return { threadId, pid };
  };
  const checkpointOf = async (botId: string) => {
    const checkpoints = await api("GET", `/api/bots/${botId}/checkpoints?cwd=${encodeURIComponent(project)}`);
    const checkpoint = checkpoints.body.checkpoints[0]?.hash;
    expect(checkpoint).toMatch(/^[a-f0-9]{40}$/);
    return checkpoint as string;
  };
  const terminalFrame = (threadId: string) => frames.frames.find((frame: any) =>
    frame?.kind === "runtime" && frame.event?.threadId === threadId && frame.event.turnId
    && (frame.event.type === "turn.completed" || frame.event.type === "session.exited"));
  return { root, project, marker, dump, ready, release, child, api, events: frames, until, create, holdTurn, checkpointOf, terminalFrame, stderr: () => stderr };
}

async function stopFixture(fixture: Fixture | undefined, pending: Array<Promise<unknown> | undefined>): Promise<void> {
  if (!fixture) return;
  writeFileSync(fixture.release, "cleanup");
  fixture.events.close();
  for (const promise of pending) await promise?.catch(() => undefined);
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  await removeTempDir(fixture.root);
}

const posix = it.skipIf(process.platform === "win32");

posix("does not dispatch a new project writer while the actual restore is held inside Git", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let restore: Promise<Answer> | undefined;
  try {
    fixture = await startFixture(signal, { gateRestore: true });
    const { api, until, dump, ready, release, marker, project } = fixture;
    const restorer = await fixture.create(), writer = await fixture.create();
    const { threadId: restorerThread } = await fixture.holdTurn(restorer.id, "create fixture checkpoint");
    const checkpoint = await fixture.checkpointOf(restorer.id);
    await api("POST", `/api/bots/${restorer.id}/interrupt`);
    await until("the restorer's interrupted turn to reach its terminal event", () => fixture!.terminalFrame(restorerThread));
    await until("the restorer to read idle", async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy === false);
    rmSync(dump, { force: true });
    writeFileSync(marker, "newer project contents");
    let restoreAnswer: Answer | undefined;
    restore = api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
    restore.then(answer => { restoreAnswer = answer; }, () => undefined);
    await until("the restore to reach Git or answer", () => existsSync(ready) || restoreAnswer);
    expect(existsSync(ready), `restore answered before reaching Git: ${JSON.stringify(restoreAnswer)}`).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("newer project contents");
    const admission = await api("POST", `/api/bots/${writer.id}/messages`, { text: "must not reach the fake engine" });
    expect([202, 409]).toContain(admission.status);
    if (admission.status === 202) {
      // Refused, or dispatched to the engine (the dump); the assertion below tells them apart.
      await until("the writer to be refused or reach the engine", async () => {
        if (existsSync(dump)) return true;
        const bot = (await api("GET", "/api/bots?messages=50")).body.bots.find((bot: any) => bot.id === writer.id);
        return bot.busy === false && bot.messages.some((message: any) => /project|restor/i.test(message.tool?.name ?? ""));
      });
    }
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(release)).toBe(false);
    writeFileSync(release, "continue");
    expect(await restore).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(marker, "utf8")).toBe("checkpoint contents");
  } finally {
    await stopFixture(fixture, [restore]);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

posix("Stop then an immediate Restore waits for the stopped turn's engine to close, then restores", async ({ signal }) => {
  let fixture: Fixture | undefined;
  let restore: Promise<Answer> | undefined;
  try {
    // The fixture CLI closes 2 s after SIGTERM; the engine close budget stays
    // at its 5 s default, so the restore admission must wait, not refuse.
    fixture = await startFixture(signal, { env: { FAKE_CLAUDE_SIGTERM_DELAY_MS: "2000" } });
    const { api, until, ready, marker, project } = fixture;
    const restorer = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(restorer.id, "create fixture checkpoint");
    const checkpoint = await fixture.checkpointOf(restorer.id);
    writeFileSync(marker, "newer project contents");
    expect((await api("POST", `/api/bots/${restorer.id}/interrupt`)).status).toBe(200);
    // Inside the window: the bot is idle, the engine child is still closing,
    // and its terminal event has not been observed.
    await until("the restorer to read idle", async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy === false);
    expect(processAlive(pid), "the fixture engine must still be closing when the restore is sent").toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    let restoreAnswer: Answer | undefined;
    restore = api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
    restore.then(answer => { restoreAnswer = answer; }, () => undefined);
    await until("the restore to reach Git or answer", () => existsSync(ready) || restoreAnswer);
    expect(existsSync(ready), `restore answered before reaching Git: ${JSON.stringify(restoreAnswer)}`).toBe(true);
    // The writer lease is released on the engine's terminal event, which the
    // driver emits only once the child closed: reaching Git proves the
    // restore waited for the stopped turn rather than overlapping it.
    expect(processAlive(pid), "the restore reached Git while the stopped engine was still running").toBe(false);
    expect(await restore).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(marker, "utf8")).toBe("checkpoint contents");
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
  } finally {
    await stopFixture(fixture, [restore]);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

posix("a restore while a live (not stopped) turn holds the project folder is refused at once", async ({ signal }) => {
  let fixture: Fixture | undefined;
  try {
    fixture = await startFixture(signal, { env: { FAKE_CLAUDE_SIGTERM_DELAY_MS: "2000" } });
    const { api, until, ready, marker, project } = fixture;
    const restorer = await fixture.create(), writer = await fixture.create();
    const { threadId: restorerThread } = await fixture.holdTurn(restorer.id, "create fixture checkpoint");
    const checkpoint = await fixture.checkpointOf(restorer.id);
    await api("POST", `/api/bots/${restorer.id}/interrupt`);
    await until("the restorer's interrupted turn to reach its terminal event", () => fixture!.terminalFrame(restorerThread));
    await until("the restorer to read idle", async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy === false);
    // Another bot now works in the same folder and nobody stopped it.
    const { threadId: writerThread, pid: writerPid } = await fixture.holdTurn(writer.id, "keep writing in the project");
    writeFileSync(marker, "newer project contents");
    const refused = await api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
    expect(refused).toMatchObject({ status: 409, body: { code: "restore_folder_in_use" } });
    expect(refused.body.error).toMatch(/Another turn or restore is using this project folder/);
    // Refused immediately: the live turn is untouched and Git was never reached.
    expect(processAlive(writerPid)).toBe(true);
    expect(fixture.terminalFrame(writerThread)).toBeUndefined();
    expect(existsSync(ready)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("newer project contents");
    await api("POST", `/api/bots/${writer.id}/interrupt`);
    await until("the writer's interrupted turn to reach its terminal event", () => fixture!.terminalFrame(writerThread));
  } finally {
    await stopFixture(fixture, []);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);

posix("a stopped turn that does not close within the engine's budget refuses the restore as still closing, and a retry after the close succeeds", async ({ signal }) => {
  let fixture: Fixture | undefined;
  try {
    // A 1 s close budget (the isolated fixture may shorten it, never disable
    // it) against a CLI that takes 6 s to close after SIGTERM.
    fixture = await startFixture(signal, { env: { FAKE_CLAUDE_SIGTERM_DELAY_MS: "6000", MURAGE_PROVIDER_CLOSE_MS: "1000" } });
    const { api, until, ready, marker, project } = fixture;
    const restorer = await fixture.create();
    const { threadId, pid } = await fixture.holdTurn(restorer.id, "create fixture checkpoint");
    const checkpoint = await fixture.checkpointOf(restorer.id);
    writeFileSync(marker, "newer project contents");
    expect((await api("POST", `/api/bots/${restorer.id}/interrupt`)).status).toBe(200);
    await until("the restorer to read idle", async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy === false);
    expect(processAlive(pid)).toBe(true);
    const refused = await api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
    expect(refused).toMatchObject({ status: 409, body: { code: "restore_stopped_turn_closing" } });
    expect(refused.body.error).toMatch(/stopped turn is still closing/);
    expect(refused.body.error).toMatch(/retry/i);
    // The bound expired while the engine was still closing: nothing was
    // restored and the stopped turn still owns the folder.
    expect(processAlive(pid), "the still-closing refusal must arrive while the engine is still closing").toBe(true);
    expect(fixture.terminalFrame(threadId)).toBeUndefined();
    expect(existsSync(ready)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("newer project contents");
    // The message says to retry: once the engine has closed, the retry restores.
    await until("the stopped turn's terminal event", () => fixture!.terminalFrame(threadId));
    expect(await api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint })).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(marker, "utf8")).toBe("checkpoint contents");
  } finally {
    await stopFixture(fixture, []);
  }
  expect(fixture!.child.exitCode, fixture!.stderr()).toBe(0);
}, 30000);
