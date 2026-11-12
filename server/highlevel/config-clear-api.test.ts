import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "../testing/ports.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";

// The whole owner workflow over HTTP against a real server process: save, rotate, clear, the external-storage
// tombstone and restarts, asserting the HighLevel token both in the running server and in config.json.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const secret = "ab".repeat(32);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const oldToken = "hl-old-plaintext-fixture-not-real";
const tokenA = "hl-rotate-a-fixture-not-real";
const tokenB = "hl-rotate-b-fixture-not-real";
const shellToken = "hl-shell-held-fixture-not-real";

it("a cleared HighLevel token stays gone over HTTP, in config.json and across restarts; save and rotate persist", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-hl-clear-api-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>HighLevel fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  // An older plaintext token is still in config.json (hand-placed, or a no-shell install).
  const configFile = join(data, "config.json");
  writeFileSync(configFile, JSON.stringify({ engineDiscovery: "explicit", instances: { ghost: { driver: "fixture-unavailable" } }, highlevel: { privateToken: oldToken } }));
  const port = await freePortBlock([0, 1]); let child: ChildProcess | undefined; let stderr = "";
  const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { ...desktop, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() };
  };
  const boot = async (shellEnv?: string) => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH,
      ...(shellEnv ? { MURAGE_HIGHLEVEL_PRIVATE_TOKEN: shellEnv } : {}) };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(root, "server/index.ts")], { windowsHide: true, cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error("Fixture exited: " + stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
  };
  const restart = async (shellEnv?: string) => { await waitForExit(child, { signal: "SIGTERM" }); child = undefined; await boot(shellEnv); };
  const saved = async () => { const r = await request("GET", "/api/highlevel"); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.tokenSaved as boolean; };
  const disk = () => (JSON.parse(readFileSync(configFile, "utf8")) as { highlevel?: { privateToken?: string } }).highlevel?.privateToken;
  // While a token is saved, no read route echoes it (only configured-or-not booleans).
  const notEchoed = async (token: string) => {
    for (const path of ["/api/config", "/api/highlevel"]) {
      const r = await request("GET", path);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(token);
    }
  };
  try {
    await boot();
    expect(await saved()).toBe(true);
    await notEchoed(oldToken);
    // Clear (no desktop shell): gone at once, from disk, and after a restart.
    expect((await request("PATCH", "/api/config", { highlevel: { privateToken: "" } })).status).toBe(200);
    expect(await saved()).toBe(false);
    expect(disk()).toBe("");
    expect(readFileSync(configFile, "utf8")).not.toContain(oldToken);
    await restart();
    expect(await saved()).toBe(false);
    // Save and rotate (no desktop shell): each value persists and survives a restart.
    expect((await request("PATCH", "/api/config", { highlevel: { privateToken: tokenA } })).status).toBe(200);
    expect(disk()).toBe(tokenA);
    expect((await request("PATCH", "/api/config", { highlevel: { privateToken: tokenB } })).status).toBe(200);
    expect(disk()).toBe(tokenB);
    await restart();
    expect(await saved()).toBe(true);
    expect(disk()).toBe(tokenB);
    await notEchoed(tokenB);
    // The desktop shell path: the secret goes to the encrypted store, config.json gets the empty tombstone.
    expect((await request("PATCH", "/api/config?secretStorage=external", { highlevel: { privateToken: shellToken } })).status).toBe(200);
    expect(await saved()).toBe(true);
    expect(disk()).toBe("");
    expect(readFileSync(configFile, "utf8")).not.toContain(tokenB);
    // Next launch: the shell hands the stored secret back as env.
    await restart(shellToken);
    expect(await saved()).toBe(true);
    await notEchoed(shellToken);
    // The owner clears it through the shell: gone now and at the next launch (the shell store no longer holds it).
    expect((await request("PATCH", "/api/config?secretStorage=external", { highlevel: { privateToken: "" } })).status).toBe(200);
    expect(await saved()).toBe(false);
    expect(disk()).toBe("");
    await restart();
    expect(await saved()).toBe(false);
    const publicConfig = JSON.stringify((await request("GET", "/api/config")).body);
    for (const token of [oldToken, tokenA, tokenB, shellToken]) expect(publicConfig + stderr).not.toContain(token);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }
}, 180000);
