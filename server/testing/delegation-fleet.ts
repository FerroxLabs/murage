// Boots the real harness server on a scratch data dir with a given fleet of
// instances, for delegation e2e tests (openclaw-delegation*.test.ts). Never
// touches the account's real ~/.murage: HOME and MURAGE_DATA_DIR both point at
// a fresh temp dir, and the config.json is written there.
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir, waitForExit } from "./cleanup.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_ACP_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const DESKTOP_SECRET = "c0ffee00c0ffee11".repeat(4);

export type Fleet = {
  home: string;
  dataDir: string;
  stderr: () => string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Poll /api/bots until `predicate` returns a value; throws with a tail on timeout. */
  waitFor: <T>(what: string, timeoutMs: number, predicate: (state: any) => T | undefined | false) => Promise<T>;
  stop: () => Promise<void>;
};

export async function bootFleet(instances: Record<string, unknown>, prefix: string): Promise<Fleet> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(home, ".murage");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances }));

  let stderr = "";
  let base = "";
  let child!: ChildProcess;
  // Shared dev Mac: another local server may already hold a port, so retry on a
  // bind clash. Range [18800, 27799] keeps the port and its consecutive
  // companion (port + 1) clear of the reserved desktop/companion ports.
  for (let attempt = 0; ; attempt++) {
    const port = 18800 + Math.floor(Math.random() * 9000);
    base = `http://127.0.0.1:${port}`;
    stderr = "";
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      MURAGE_DATA_DIR: dataDir,
      MURAGE_PORT: String(port),
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 25_000;
    let up = false;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      if (child.exitCode !== null || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (up) break;
    await waitForExit(child, { signal: "SIGTERM" });
    if (attempt >= 3) throw new Error(`server never came up after ${attempt + 1} attempts. stderr:\n${stderr}`);
  }

  const api: Fleet["api"] = (method, path, body) => {
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}${path}`,
        {
          method,
          agent: false,
          headers: {
            connection: "close",
            "x-murage-surface": "desktop",
            "x-murage-surface-secret": DESKTOP_SECRET,
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  };

  return {
    home,
    dataDir,
    stderr: () => stderr,
    api,
    async waitFor(what, timeoutMs, predicate) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const hit = predicate(state);
        if (hit) return hit as never;
        if (Date.now() > end) {
          throw new Error(`${what}: timed out.\nstate tail: ${JSON.stringify(state.bots.map((b: any) => ({ name: b.name, busy: b.busy, tail: b.messages.slice(-5) })))}\nstderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async stop() {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    },
  };
}
