// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// computer_exec stops a command on silence or Stop, never on a fixed clock.
// The fake box runs every posted command with the real bash (Linux only, as
// the real box is) under a throwaway HOME, and answers a command that takes
// longer than one request is allowed to with a 504, as a timed-out request
// does. A long command must therefore survive its own request.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "computer-proxy.ts");
const REQUEST_LIMIT_MS = 3_000;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform !== "linux")("computer_exec on the cloud box (real shell)", () => {
  let home = "";
  let box: Server;
  let boxPort = 0;
  let requests = 0;
  let silenceMs = 4_000;
  let beats = 0;
  const running = new Set<ChildProcess>();
  let proxy: ChildProcess | null = null;
  const results = new Map<number, any>();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "murage-exec-"));
    box = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (url.pathname === "/api/internal/computer-control") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ held: false, helpOpen: false }));
        }
        if (url.pathname === "/api/internal/computer-activity") {
          beats += 1;
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ silenceMs }));
        }
        if (!url.pathname.endsWith("/commands")) return res.writeHead(404).end("{}");
        requests += 1;
        const command = JSON.parse(body || "{}").command ?? "";
        const child = spawn("bash", ["-c", command], {
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        running.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (c) => (stdout += c));
        child.stderr!.on("data", (c) => (stderr += c));
        let answered = false;
        const limit = setTimeout(() => {
          answered = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* gone */
          }
          res.writeHead(504, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "command timed out" }));
        }, REQUEST_LIMIT_MS);
        child.on("close", (code) => {
          running.delete(child);
          clearTimeout(limit);
          if (answered) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ exitCode: code, stdout, stderr }));
        });
      });
    });
    await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
    boxPort = (box.address() as any).port;
  });

  afterAll(async () => {
    box.close();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) proxy.kill("SIGKILL");
    proxy = null;
    silenceMs = 4_000;
    beats = 0;
    results.clear();
    // leave nothing behind between cases
    await new Promise((r) => setTimeout(r, 200));
  });

  const start = (env: Record<string, string> = {}) => {
    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
      env: {
        ...process.env,
        MURAGEBOX_BOX_API: `http://127.0.0.1:${boxPort}`,
        MURAGEBOX_BOX_ID: "box-1",
        MURAGEBOX_BOX_TOKEN: "t",
        MURAGE_CONTROL_URL: `http://127.0.0.1:${boxPort}/api/internal/computer-control?botId=b1`,
        MURAGE_CONTROL_TOKEN: "control",
        MURAGE_EXEC_FIRST_WAIT_SEC: "1",
        MURAGE_EXEC_POLL_SEC: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    proxy.stdout!.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {
          /* not ours */
        }
      }
    });
    return proxy;
  };
  const rpc = (msg: unknown) => proxy!.stdin!.write(JSON.stringify(msg) + "\n");
  const exec = (id: number, command: string) =>
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "computer_exec", arguments: { command } } });
  const waitFor = async (id: number, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no response for id ${id}`);
  };
  const untilFile = async (path: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (existsSync(path) && readFileSync(path, "utf8").trim()) return Number(readFileSync(path, "utf8").trim());
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${path} never appeared`);
  };
  const untilDead = async (pid: number, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const jobDirs = () => {
    const root = join(home, ".cache", "murage-exec");
    return existsSync(root) ? readdirSync(root) : [];
  };

  it("keeps a command running past one request's limit while it prints, and returns its whole result", async () => {
    start();
    exec(1, "for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done; echo finished >&2; exit 3");
    const res = await waitFor(1);
    const text = res.result.content[0].text as string;
    expect(res.result.isError).not.toBe(true);
    expect(text).toMatch(/^exit 3\n/);
    expect(text).toContain("tick 1\n");
    expect(text).toContain("tick 6\n");
    expect(text).toContain("[stderr]\nfinished");
    // output is the turn working: the harness heard about it
    expect(beats).toBeGreaterThan(0);
    expect(jobDirs()).toEqual([]);
  }, 40_000);

  it("a quick command still answers in one round trip and leaves nothing on the computer", async () => {
    start();
    const before = requests;
    exec(2, "echo hello");
    const res = await waitFor(2);
    expect(res.result.content[0].text).toBe("exit 0\nhello\n");
    expect(requests - before).toBe(1);
    expect(jobDirs()).toEqual([]);
  }, 20_000);

  it("a busy command that prints nothing is working, not silent", async () => {
    silenceMs = 3_000;
    start();
    exec(3, "echo go; end=$((SECONDS+7)); while [ $SECONDS -lt $end ]; do :; done; echo busy-done");
    const res = await waitFor(3);
    expect(res.result.content[0].text).toContain("busy-done");
  }, 40_000);

  it("stops a command after the silence limit with no output or work, and its processes are gone", async () => {
    silenceMs = 4_000;
    start();
    const pidFile = join(home, "silent.pid");
    exec(4, `echo started; sleep 120 & echo $! > ${pidFile}; wait`);
    const sleeper = await untilFile(pidFile);
    const res = await waitFor(4, 40_000);
    const text = res.result.content[0].text as string;
    expect(res.result.isError).toBe(true);
    expect(text).toContain("started");
    expect(text).toMatch(/no output and no work for \d+ seconds/);
    expect(await untilDead(sleeper)).toBe(true);
    expect(jobDirs()).toEqual([]);
    rmSync(pidFile, { force: true });
  }, 60_000);

  it("Stop (MCP cancel) ends the command at once and sends no result", async () => {
    silenceMs = 600_000;
    start();
    const pidFile = join(home, "stop.pid");
    exec(5, `sleep 120 & echo $! > ${pidFile}; wait`);
    const sleeper = await untilFile(pidFile);
    rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "stop" } });
    expect(await untilDead(sleeper)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(results.has(5)).toBe(false);
    rmSync(pidFile, { force: true });
  }, 40_000);

  it("the engine closing the tool (stdin end or SIGTERM) ends its command", async () => {
    for (const how of ["stdin", "sigterm"] as const) {
      silenceMs = 600_000;
      const child = start();
      const pidFile = join(home, `close-${how}.pid`);
      exec(6, `sleep 120 & echo $! > ${pidFile}; wait`);
      const sleeper = await untilFile(pidFile);
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      if (how === "stdin") child.stdin!.end();
      else child.kill("SIGTERM");
      await exited;
      expect(await untilDead(sleeper), how).toBe(true);
      rmSync(pidFile, { force: true });
    }
  }, 60_000);

  it("a chatty command keeps only a bounded tail on the computer's disk", async () => {
    start({ MURAGE_EXEC_OUTPUT_CAP: "65536" });
    exec(8, "for i in 1 2 3 4 5; do head -c 400000 /dev/zero | tr '\\0' a; echo; sleep 1; done; echo END");
    const res = await waitFor(8);
    const text = res.result.content[0].text as string;
    expect(text).toContain("earlier output was dropped");
    expect(text.trimEnd().endsWith("END")).toBe(true);
  }, 40_000);

  it("a command whose proxy was killed outright stops on its own once nobody checks on it", async () => {
    silenceMs = 600_000;
    const child = start({ MURAGE_EXEC_LEASE_SEC: "3" });
    const pidFile = join(home, "orphan.pid");
    exec(7, `sleep 120 & echo $! > ${pidFile}; wait`);
    const sleeper = await untilFile(pidFile);
    child.kill("SIGKILL");
    expect(await untilDead(sleeper, 20_000)).toBe(true);
    rmSync(pidFile, { force: true });
  }, 40_000);
});
