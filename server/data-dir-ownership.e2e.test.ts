import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(serverDirectory, "..");
const fakeCli = join(serverDirectory, "testing", "fake-claude-cli.ts");
const children: ChildProcess[] = [];
const homes: string[] = [];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "murage-data-owner-http-"));
  homes.push(home);
  const data = join(home, "data");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { quiet: { driver: "claudeAgent", config: { cli: fakeCli }, environment: { FAKE_CLAUDE_MODE: "hang" } } },
  }));
  return { home, data };
}

async function launch(home: string, data: string, extra: Record<string, string> = {}) {
  const port = await freePortBlock([0, 1]);
  const child = spawn(process.execPath, [join(serverDirectory, "index.ts")], {
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stdout!.resume();
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8_000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return { child, base, ready: false, stderr };
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json() as { pid?: number };
      if (response.ok && health.pid === child.pid) return { child, base, ready: true, stderr };
    } catch { /* exact owned child is still starting */ }
    if (Date.now() >= deadline) throw new Error(`Owned fixture startup timed out: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGTERM" });
  }
  for (const home of homes.splice(0)) await removeTempDir(home);
});

it("refuses a second data writer before it can change the existing installation", async () => {
  const { home, data } = fixture();
  const first = await launch(home, data);
  expect(first.ready, first.stderr).toBe(true);
  const response = await fetch(`${first.base}/api/bots`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Existing owner sentinel", modelSelection: { instanceId: "quiet", model: "claude-sonnet-5" } }),
  });
  expect(response.status).toBe(201);
  const before = readFileSync(join(data, "bots.json"));
  const second = await launch(home, data);
  expect(second.ready, "A second harness became a concurrent writer").toBe(false);
  expect(second.child.exitCode).not.toBe(0);
  expect(second.stderr).toMatch(/lease|owner|data.directory/i);
  expect(readFileSync(join(data, "bots.json"))).toEqual(before);
  expect((await fetch(`${first.base}/api/health`)).status).toBe(200);
  await waitForExit(first.child, { signal: "SIGTERM" });
  const reopened = await launch(home, data);
  expect(reopened.ready, reopened.stderr).toBe(true);
  const state = await (await fetch(`${reopened.base}/api/bots`)).json() as { bots: Array<{ name: string }> };
  expect(state.bots.map(bot => bot.name)).toContain("Existing owner sentinel");
}, 40_000);

it("allows independent data roots instead of using a process-wide singleton", async () => {
  const firstRoot = fixture();
  const secondRoot = fixture();
  const first = await launch(firstRoot.home, firstRoot.data);
  const second = await launch(secondRoot.home, secondRoot.data);
  expect(first.ready, first.stderr).toBe(true);
  expect(second.ready, second.stderr).toBe(true);
  expect(first.child.pid).not.toBe(second.child.pid);
});

it("refuses a forged parent lease capability before loading persistent state", async () => {
  const { home, data } = fixture();
  const before = readFileSync(join(data, "config.json"));
  const started = await launch(home, data, { MURAGE_INTERNAL_DATA_DIR_LEASE: "invalid-proof-canary" });
  expect(started.ready, "A forged parent capability was ignored").toBe(false);
  expect(started.child.exitCode).not.toBe(0);
  expect(started.stderr).not.toContain("invalid-proof-canary");
  expect(readFileSync(join(data, "config.json"))).toEqual(before);
});

it.each(['{"private":"config-preservation-canary",', '[]', '{"instances":{"invalid":{"driver":42}}}'])(
  "refuses damaged configuration before creating replacement state: %s",
  async raw => {
    const { home, data } = fixture();
    const file = join(data, "config.json");
    writeFileSync(file, raw);
    const started = await launch(home, data);
    expect(started.ready).toBe(false);
    expect(started.child.exitCode).not.toBe(0);
    expect(started.stderr).toContain("PERSISTED_STATE_RECOVERY_REQUIRED");
    expect(started.stderr).not.toContain("config-preservation-canary");
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(existsSync(join(data, "bots.json"))).toBe(false);
    expect(existsSync(join(data, "messages.db"))).toBe(false);
  },
);
