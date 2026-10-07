// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The prompt never waits for the computer. Dispatch awaits a box wake only
// when the agent runs on the box; every other engine wakes the box on its
// first computer tool call, bounded, and errors cleanly if it never comes up.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitBoxWakeAtDispatch, BOX_LAZY_WAKE_BUDGET_MS, turnTrace } from "./computer-wake.ts";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(700, 0x20), Buffer.from([0xff, 0xd9])]);
const PROXY = join(dirname(fileURLToPath(import.meta.url)), "computer-proxy.ts");

describe("dispatch-time computer wake policy", () => {
  const base = { mountsCloudComputer: true, driverKind: "claude", boxState: "archived" };

  it("does not await a wake for a tool-mounting engine, even with an archived box", () => {
    expect(awaitBoxWakeAtDispatch(base)).toBe(false);
    expect(awaitBoxWakeAtDispatch({ ...base, boxState: "stopped" })).toBe(false);
  });
  it("awaits only when the agent itself runs on the box", () => {
    expect(awaitBoxWakeAtDispatch({ ...base, driverKind: "boxAgent" })).toBe(true);
    expect(awaitBoxWakeAtDispatch({ ...base, driverKind: "boxAgent", boxState: "idle" })).toBe(false);
  });
  it("never awaits without a cloud computer or a box", () => {
    expect(awaitBoxWakeAtDispatch({ ...base, mountsCloudComputer: false, driverKind: "boxAgent" })).toBe(false);
    expect(awaitBoxWakeAtDispatch({ ...base, driverKind: "boxAgent", boxState: undefined })).toBe(false);
  });
  it("has a bounded lazy wake budget", () => {
    expect(BOX_LAZY_WAKE_BUDGET_MS).toBeGreaterThan(0);
    expect(BOX_LAZY_WAKE_BUDGET_MS).toBeLessThanOrEqual(120_000);
  });
  it("traces only when MURAGE_TURN_TRACE is set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.MURAGE_TURN_TRACE;
    turnTrace("computer.wake.deferred");
    expect(log).not.toHaveBeenCalled();
    // Same switch as turn-trace.ts: only "1" turns it on.
    for (const off of ["0", "false", ""]) { process.env.MURAGE_TURN_TRACE = off; turnTrace("computer.wake.deferred"); }
    expect(log).not.toHaveBeenCalled();
    process.env.MURAGE_TURN_TRACE = "1";
    turnTrace("computer.wake.deferred", "x");
    expect(log.mock.calls[0][0]).toContain("[turn-trace] computer.wake.deferred x");
    delete process.env.MURAGE_TURN_TRACE;
    log.mockRestore();
  });
});

describe("first computer tool call wakes the box (fake archived box)", () => {
  let box: Server | null = null;
  let proxy: ChildProcess | null = null;
  afterEach(() => {
    proxy?.kill();
    box?.close();
  });

  async function start(wakes: boolean, budgetMs: number) {
    const state = { awake: false, resumes: 0, commands: 0 };
    box = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      req.resume();
      req.on("end", () => {
        const json = { "content-type": "application/json" };
        if (url.pathname.endsWith("/resume")) {
          res.writeHead(200, json);
          state.resumes += 1;
          if (wakes) state.awake = true;
          return res.end("{}");
        }
        if (url.pathname.endsWith("/commands")) {
          if (!state.awake) {
            res.writeHead(409, json);
            return res.end(JSON.stringify({ code: "machine_not_running" }));
          }
          res.writeHead(200, json);
          state.commands += 1;
          return res.end(JSON.stringify({ exitCode: 0, stdout: `GEOM 1920 1080\nHASH w1\nSIZE ${JPEG.length}\nB64 ${JPEG.toString("base64")}\nACT ok\n`, stderr: "" }));
        }
        res.writeHead(200, json);
        return res.end(JSON.stringify({ box: { id: "box-1", state: state.awake ? "idle" : "archived" } }));
      });
    });
    await new Promise<void>((r) => box!.listen(0, "127.0.0.1", r));
    const port = (box.address() as any).port;
    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY], {
      env: {
        ...process.env,
        MURAGEBOX_BOX_API: `http://127.0.0.1:${port}`,
        MURAGEBOX_BOX_ID: "box-1",
        MURAGEBOX_BOX_TOKEN: "t",
        MURAGEBOX_WAKE_BUDGET_MS: String(budgetMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const results = new Map<number, any>();
    let buf = "";
    proxy.stdout!.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {}
      }
    });
    const rpc = (msg: unknown) => proxy!.stdin!.write(JSON.stringify(msg) + "\n");
    const waitFor = async (id: number, ms = 15_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (results.has(id)) return results.get(id);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no response for id ${id}`);
    };
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
    return { state, rpc, waitFor };
  }

  const call = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "click", arguments: { x: 10, y: 10 } },
  });

  it("mounting alone touches nothing; the first tool call resumes the box and succeeds", async () => {
    const { state, rpc, waitFor } = await start(true, 30_000);
    expect(state.resumes).toBe(0);
    expect(state.commands).toBe(0);
    rpc(call(2));
    const result = await waitFor(2);
    expect(JSON.stringify(result.result).slice(0, 300)).not.toMatch(/asleep|"isError":true/);
    expect(state.resumes).toBe(1);
    expect(state.commands).toBeGreaterThan(0);
  }, 30_000);

  it("a box that never wakes errors cleanly within the budget instead of hanging", async () => {
    const { state, rpc, waitFor } = await start(false, 1_500);
    const t0 = Date.now();
    rpc(call(2));
    const result = await waitFor(2);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(JSON.stringify(result.result)).toMatch(/asleep and did not wake in time/);
    expect(state.commands).toBe(0);
  }, 30_000);
});
