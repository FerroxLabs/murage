import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

// Every wait in this test ends on the state it names, or on a definitive
// failure (the server exited, the restore answered without reaching Git, the
// writer reached the engine) — never on a wall-clock window. Under load the
// same steps take longer; they must not change the outcome. The test timeout
// below stays the only hang guard, and its abort signal still runs cleanup.
//
// Why the restore waits for the restorer's terminal runtime frame and not
// only for `busy:false`: the Claude driver's interrupt requests SIGTERM and
// returns, so the bot reads idle at once, while the turn's project-folder
// writer lease is released only when the CLI child closes and `turn.completed`
// reaches the bus. A restore sent inside that window is refused (409) before
// it reaches Git — correct, conservative product behavior, and exactly the
// window a loaded machine widens. The bus delivers synchronously in
// registration order and the lease subscriber precedes the SSE runtime
// broadcast, so the frame is observable only after the lease was released.
it.skipIf(process.platform === "win32")("does not dispatch a new project writer while the actual restore is held inside Git", async ({ signal }) => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), "murage-restore-admission-"));
  const data = join(root, "data"), bin = join(root, "bin"), project = join(root, "project");
  const ready = join(root, "restore-ready"), release = join(root, "restore-release"), dump = join(root, "fake-engine.json");
  for (const path of [data, bin, project]) mkdirSync(path);
  const marker = join(project, "work.txt"); writeFileSync(marker, "checkpoint contents");
  // Only this fixture's child PATH uses the wrapper. Every real Git operation
  // delegates unchanged, except restore waits at an explicit readiness gate.
  // The gate holds until the test releases it (the finally block always
  // does) or until the server that spawned it is gone.
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');(async()=>{const args=process.argv.slice(2);if(args[0]==='restore'){const parent=process.ppid;fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)})){if(process.ppid!==parent){process.stderr.write('fixture restore gate lost its server');process.exit(2);}await new Promise(r=>setTimeout(r,10));}}const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);})().catch(()=>process.exit(2));\n`, { mode: 0o700 });
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixture: { driver: "claudeAgent", config: { cli: fakeCli } } } }));
  const port = await freePortBlock([0, 1]), secret = "7".repeat(64);
  const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
    HOME: root, USERPROFILE: root, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MURAGE_DATA_DIR: data,
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump,
  }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
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
  let restore: ReturnType<typeof api> | undefined;
  let stream: SseRecorder | undefined;
  try {
    await until("the server to answer health", async () => { try { return (await api("GET", "/api/health")).body.pid === child.pid; } catch { return false; } });
    stream = await openSse(`http://127.0.0.1:${port}/api/events`, desktop);
    const events = stream;
    const create = async () => {
      const result = await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "claude-sonnet-5" } });
      expect(result.status).toBe(201);
      expect((await api("PATCH", `/api/bots/${result.body.bot.id}`, { cwd: project, computer: "off" })).status).toBe(200);
      return result.body.bot;
    };
    const restorer = await create(), writer = await create();
    const checkpointTurn = await api("POST", `/api/bots/${restorer.id}/messages`, { text: "create fixture checkpoint" });
    expect(checkpointTurn.status).toBe(202);
    const restorerThread: string = checkpointTurn.body.threadId;
    expect(restorerThread).toBeTruthy();
    await until("the fixture engine to receive the checkpoint turn", () => existsSync(dump));
    const checkpoints = await api("GET", `/api/bots/${restorer.id}/checkpoints?cwd=${encodeURIComponent(project)}`);
    const checkpoint = checkpoints.body.checkpoints[0]?.hash;
    expect(checkpoint).toMatch(/^[a-f0-9]{40}$/);
    await api("POST", `/api/bots/${restorer.id}/interrupt`);
    await until("the restorer's interrupted turn to reach its terminal event", () => events.frames.find((frame: any) =>
      frame?.kind === "runtime" && frame.event?.threadId === restorerThread && frame.event.turnId
      && (frame.event.type === "turn.completed" || frame.event.type === "session.exited")));
    await until("the restorer to read idle", async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy === false);
    rmSync(dump, { force: true });
    writeFileSync(marker, "newer project contents");
    let restoreAnswer: { status: number; body: any } | undefined;
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
    writeFileSync(release, "cleanup");
    stream?.close();
    await restore?.catch(() => undefined);
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(root);
  }
  expect(child.exitCode, stderr).toBe(0);
}, 30000);
