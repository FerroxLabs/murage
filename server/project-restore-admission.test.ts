import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it.skipIf(process.platform === "win32")("does not dispatch a new project writer while the actual restore is held inside Git", async () => {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), "murage-restore-admission-"));
  const data = join(root, "data"), bin = join(root, "bin"), project = join(root, "project");
  const ready = join(root, "restore-ready"), release = join(root, "restore-release"), dump = join(root, "fake-engine.json");
  for (const path of [data, bin, project]) mkdirSync(path);
  const marker = join(project, "work.txt"); writeFileSync(marker, "checkpoint contents");
  // Only this fixture's child PATH uses the wrapper. Every real Git operation
  // delegates unchanged, except restore waits at an explicit readiness gate.
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');(async()=>{const args=process.argv.slice(2);if(args[0]==='restore'){fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end){process.stderr.write('fixture restore gate timed out');process.exit(2);}await new Promise(r=>setTimeout(r,10));}}const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);})().catch(()=>process.exit(2));\n`, { mode: 0o700 });
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixture: { driver: "claudeAgent", config: { cli: fakeCli } } } }));
  const port = await freePortBlock([0, 1]), secret = "7".repeat(64);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
    HOME: root, USERPROFILE: root, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MURAGE_DATA_DIR: data,
    MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump,
  }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  let restore: ReturnType<typeof api> | undefined;
  try {
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).body.pid; } catch { return null; } }, { timeout: 8000 }).toBe(child.pid);
    const create = async () => {
      const result = await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "claude-sonnet-5" } });
      expect(result.status).toBe(201);
      expect((await api("PATCH", `/api/bots/${result.body.bot.id}`, { cwd: project, computer: "off" })).status).toBe(200);
      return result.body.bot;
    };
    const restorer = await create(), writer = await create();
    expect((await api("POST", `/api/bots/${restorer.id}/messages`, { text: "create fixture checkpoint" })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 8000 }).toBe(true);
    const checkpoints = await api("GET", `/api/bots/${restorer.id}/checkpoints?cwd=${encodeURIComponent(project)}`);
    const checkpoint = checkpoints.body.checkpoints[0]?.hash;
    expect(checkpoint).toMatch(/^[a-f0-9]{40}$/);
    await api("POST", `/api/bots/${restorer.id}/interrupt`);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === restorer.id).busy).toBe(false);
    rmSync(dump, { force: true });
    writeFileSync(marker, "newer project contents");
    restore = api("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
    await expect.poll(() => existsSync(ready), { timeout: 8000 }).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("newer project contents");
    const admission = await api("POST", `/api/bots/${writer.id}/messages`, { text: "must not reach the fake engine" });
    expect([202, 409]).toContain(admission.status);
    if (admission.status === 202) {
      await expect.poll(async () => {
        const bot = (await api("GET", "/api/bots?messages=50")).body.bots.find((bot: any) => bot.id === writer.id);
        return bot.busy === false && bot.messages.some((message: any) => /project|restor/i.test(message.tool?.name ?? ""));
      }, { timeout: 5000 }).toBe(true);
    }
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(release)).toBe(false);
    writeFileSync(release, "continue");
    expect(await restore).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(marker, "utf8")).toBe("checkpoint contents");
  } finally {
    writeFileSync(release, "cleanup");
    await restore?.catch(() => undefined);
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(root);
  }
  expect(child.exitCode, stderr).toBe(0);
}, 30000);
