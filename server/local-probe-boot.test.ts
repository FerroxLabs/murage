// SPDX-License-Identifier: AGPL-3.0-or-later
// RC5: a packaged boot opened 18 sockets to the owner's user-added local host
// at first health. This boots the real server entry the way the desktop app
// does (headless, throwaway HOME, node index.ts) with a user-added host that
// is a counting TCP listener, lets every start-up step and the first catalog
// refresh run, polls the routes the window polls, and asserts the host never
// saw a single connection. A control then asks for a fresh engine list (the
// owner's "Check again") and must see the host called, so a zero above means
// "not probed", not "the counter is broken".
//
// A child process cannot run on fake time, so the window is real wall clock:
// the catalog refresh fires at start (tick() runs immediately) and the 60 s
// timer is the same code path, covered by the unit tests in
// drivers/local-inject-probe.test.ts and harness/registry-probe-scope.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET = "probe-boot-secret-" + "a1b2c3d4".repeat(4);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("packaged boot never probes a user-added local host", () => {
  let child: ChildProcess | undefined, home = "", host: Server | undefined;
  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await new Promise<void>(resolve => (host ? host.close(() => resolve()) : resolve()));
    if (home) await removeTempDir(home);
  });

  it("makes zero connections to it through boot, deferred start-up and the window's polls", async () => {
    let connections = 0;
    host = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => host!.listen(0, "127.0.0.1", resolve));
    const hostPort = (host.address() as { port: number }).port;

    const port = await freePortBlock([0, 1], 19_499, 200);
    const base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-probe-boot-"));
    mkdirSync(join(home, ".murage", "local-models"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    const now = Date.now();
    writeFileSync(join(home, ".murage", "local-models", "local-servers.json"), JSON.stringify({
      version: 1,
      servers: [{ id: "srv_aabbccddeeff", name: "LAN", kind: "ollama", apiBase: `http://127.0.0.1:${hostPort}/v1`, createdAt: now, updatedAt: now }],
    }));
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TURN_TRACE: "1", MURAGE_DATA_DIR: join(home, ".murage"), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 45_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(10);
    }
    while (!stdout.includes("phase=startup.deferred.done") && Date.now() < deadline) await sleep(20);
    expect(stdout).toContain("phase=startup.deferred.done");

    // what the window does after first health: setup poll, engine list, health again
    for (let round = 0; round < 6; round++) {
      const setup = await fetch(`${base}/api/setup`, { headers: desktop });
      expect(setup.status, await setup.text()).toBe(200);
      await fetch(`${base}/api/health`).catch(() => undefined);
      await sleep(1_500);
    }
    expect(connections, `stdout:\n${stdout.slice(-2000)}`).toBe(0);

    // control: the owner asking for a fresh engine list does probe the host
    await fetch(`${base}/api/instances?fresh=1`, { headers: desktop });
    expect(connections).toBeGreaterThan(0);
  }, 120_000);
});
