// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Test support (1.0.21 cause6 r4, DESIGN-R3 5.6): the rig that replays an interleaving schedule against the
// REAL proxy process. `node remote-mcp-proxy.ts --server s` is spawned as an engine spawns it. This file is
// the three things around it, and each only carries bytes and timing:
//  - the engine: lines on its stdin, and the frames it lets out;
//  - the relay: an HTTP server that holds every POST until the schedule answers it, cuts it, or breaks its body;
//  - the harness side of the release channel: it says yes to every frame, and yes or no to a reserve.
// A seal is never written here. It is read from the one thing the process does when its real seal object
// (proxy-turn-release) seals: the `turn-release-terminal` notice on its supervisor channel, with the reason.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Json, Rig, RigEvents } from "./remote-mcp-proxy.interleave.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "remote-mcp-proxy.ts");
const VERDICT_PATH = "/api/internal/turn-release/v1/verdict";
/** How long nothing must happen around the process before it counts as quiet. */
const QUIET_MS = Number(process.env.REPLAY_QUIET_MS ?? "150");
const WAIT_MS = Number(process.env.REPLAY_WAIT_MS ?? "10000");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Held { res: ServerResponse; state: "held" | "stream" | "done" }

export async function realProxyRig(events: RigEvents): Promise<Rig> {
  let activity = 0;
  let refusals = 0;
  /** The process has made its first request: before that, silence is only a process still starting. */
  let started = false;
  let wrote = false;
  const notices: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "murage-proxy-replay-"));
  const instanceId = "replay-instance";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      activity++;
      started = true;
      const url = req.url ?? "";
      let body: Json = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* not ours to judge */ }
      if (url === VERDICT_PATH) {
        if (body.operation === "upstream") {
          // the turn's answer to a reserve: yes, or (once, when the schedule says so) no
          if (refusals > 0) { refusals--; res.writeHead(409).end(); return; }
          res.end(JSON.stringify({ reserved: true }));
          return;
        }
        // every frame may go to the engine
        res.end(JSON.stringify({ instanceId: body.instanceId, sequence: body.sequence, frame: body.frame, permit: "A".repeat(43) }));
        return;
      }
      if (!url.startsWith("/api/internal/mcp-remote/") || url.endsWith("/wipe-metadata")) { res.end("{}"); return; }
      const held: Held = { res, state: "held" };
      res.on("close", () => {
        activity++;
        if (held.state === "done") return;
        held.state = "done";
        events.cancelled(held);
      });
      events.posted(body, String(req.headers["mcp-session-id"] ?? ""), held);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", "s"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, MURAGE_DATA_DIR: home,
      TMPDIR: home, TMP: home, TEMP: home, NODE_ENV: "test", ELECTRON_RUN_AS_NODE: "1",
      MURAGE_HARNESS_URL: base, MURAGE_MCP_TOKEN: "turn-token-0123",
      MURAGE_RELEASE_INSTANCE: instanceId, MURAGE_RELEASE_TOKEN: "release-token-0123", MURAGE_RELEASE_URL: base,
    },
  });
  let exited = false;
  child.once("exit", () => { activity++; exited = true; });
  child.on("error", () => { activity++; });
  child.stdin!.on("error", () => { activity++; });
  // the frames the process lets out: each is acknowledged, as the supervisor does, and handed to the engine
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    activity++;
    let envelope: Json;
    try { envelope = JSON.parse(line); } catch { return; }
    if (child.connected) child.send({ type: "turn-release-ack", instanceId, sequence: envelope.sequence }, () => undefined);
    const frame = JSON.parse(String(envelope.frame)) as Json;
    if (typeof frame.method === "string") events.sent(frame); else events.answered(frame.id, frame);
  });
  readline.createInterface({ input: child.stderr! }).on("line", (line) => {
    activity++;
    if (line.startsWith("[remote-mcp-proxy] ")) events.logged(line);
  });
  // THE seal: the process's own terminal notice, made by its real seal object, with the reason it sealed for
  child.on("message", (message: unknown) => {
    activity++;
    const notice = message as { type?: unknown; instanceId?: unknown; reason?: unknown } | null;
    if (notice?.type === "turn-release-terminal" && notice.instanceId === instanceId) notices.push(String(notice.reason));
  });

  const at = (handle: unknown) => handle as Held;
  return {
    real: true,
    engine(message: Json) { wrote = true; if (!exited && child.stdin!.writable) child.stdin!.write(`${JSON.stringify(message)}\n`); },
    whole(handle, status, body, headers) {
      at(handle).state = "done";
      at(handle).res.writeHead(status, { "content-type": "application/json", ...headers });
      at(handle).res.end(body ?? "");
    },
    open(handle, status, headers) {
      at(handle).state = "stream";
      at(handle).res.writeHead(status, headers);
      at(handle).res.flushHeaders();
    },
    chunk(handle, text) { at(handle).res.write(text); },
    end(handle) { at(handle).state = "done"; at(handle).res.end(); },
    breakBody(handle) { at(handle).state = "done"; at(handle).res.socket?.destroy(); },
    reject(handle) { at(handle).state = "done"; at(handle).res.socket?.destroy(); },
    refuseReserve(handle) { refusals++; at(handle).res.write(": more\n\n"); },
    // no `deadline`: the process has the real clock (30 s and 10 min), which a schedule cannot move
    seals: () => notices,
    async settle(until) {
      const limit = Date.now() + WAIT_MS;
      while (wrote && !started && !exited && Date.now() < limit + 20_000) await sleep(10);
      for (;;) {
        for (let seen = activity, since = Date.now(); Date.now() - since < QUIET_MS; ) {
          await sleep(10);
          if (activity !== seen) { seen = activity; since = Date.now(); }
        }
        if (!until || until() || Date.now() > limit) return;
      }
    },
    async stop() {
      if (!exited) {
        const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await gone;
      }
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (child.connected) child.disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
