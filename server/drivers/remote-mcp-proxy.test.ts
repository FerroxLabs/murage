// SPDX-License-Identifier: AGPL-3.0-or-later
// The real stdio proxy, run as a process against a stand-in for the harness relay.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "remote-mcp-proxy.ts");
let server: Server | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  child?.kill();
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

type Posted = { url: string; headers: IncomingHttpHeaders; body: Record<string, any> };
type Answer = { status?: number; contentType?: string; body?: string; headers?: Record<string, string> };

async function start(answer: (posted: Posted) => Answer, argvName = "comfy") {
  const posted: Posted[] = [];
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry: Posted = { url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
    posted.push(entry);
    const reply = answer(entry);
    res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json", ...(reply.headers ?? {}) });
    res.end(reply.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", argvName], {
    env: { PATH: process.env.PATH ?? "", MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_MCP_TOKEN: "turn-token-0123" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const queue: Array<Record<string, any>> = [];
  const waiters: Array<(value: Record<string, any>) => void> = [];
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else queue.push(frame);
  });
  const next = () => new Promise<Record<string, any>>((resolve) => { const queued = queue.shift(); if (queued) resolve(queued); else waiters.push(resolve); });
  const write = (message: object) => child!.stdin.write(`${JSON.stringify(message)}\n`);
  return { posted, next, write };
}

describe("the stdio proxy for one link server", () => {
  it("relays to the named route with the turn token, rewrites initialize capabilities, and carries the session id", async () => {
    const { posted, next, write } = await start((entry) => {
      if (entry.body.method === "initialize") {
        return { headers: { "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } }) };
      }
      if (entry.body.method === "tools/list") return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { tools: [{ name: "echo" }] } }) };
      return { status: 202 };
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { sampling: {}, roots: {} }, clientInfo: { name: "c", version: "1" } } });
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "s" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }] } });
    expect(posted[0]!.url).toBe("/api/internal/mcp-remote/comfy");
    expect(posted[0]!.headers.authorization).toBe("Bearer turn-token-0123");
    expect(posted[0]!.body.params.capabilities).toEqual({});
    expect(posted[0]!.headers["mcp-session-id"]).toBeUndefined();
    const listPost = posted.find((entry) => entry.body.method === "tools/list")!;
    expect(listPost.headers["mcp-session-id"]).toBe("sess-1");
    expect(listPost.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("reopens a session the harness forgot (a reused turn's new generation) and retries the call once", async () => {
    let live = "sess-1";
    let opened = 0;
    const { posted, next, write } = await start((entry) => {
      if (entry.body.method === "initialize") {
        opened += 1;
        live = `sess-${opened}`;
        return { headers: { "mcp-session-id": live }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) };
      }
      if (entry.body.method === "tools/call") {
        if (entry.headers["mcp-session-id"] !== live) return { status: 502, body: JSON.stringify({ code: "session-gone", error: "no such session" }) };
        return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { content: [{ type: "text", text: `ok ${live}` }] } }) };
      }
      return { status: 202 };
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    await next();
    live = "sess-gone"; // the harness revoked generation 1 and dropped its session
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo" } });
    expect(await next()).toMatchObject({ id: 2, result: { content: [{ text: "ok sess-2" }] } });
    expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(2);
    expect(posted.filter((entry) => entry.body.method === "tools/call")).toHaveLength(2);
    expect(posted.some((entry) => entry.body.method === "notifications/initialized")).toBe(true);
  });

  for (const [label, status, code] of [["wrong-address 502", 502, "wrong-address"], ["a bare 404", 404, "wrong-address"], ["wrong-address 404", 404, "wrong-address"]] as const) {
    it(`does not retry ${label}: the call may already have run`, async () => {
      const { posted, next, write } = await start((entry) => {
        if (entry.body.method === "initialize") return { headers: { "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: {} }) };
        if (entry.body.method === "tools/call") return { status, body: label === "a bare 404" ? "" : JSON.stringify({ code }) };
        return { status: 202 };
      });
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
      await next();
      write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
      expect(await next()).toMatchObject({ id: 2, result: { isError: true } });
      expect(posted.filter((entry) => entry.body.method === "tools/call")).toHaveLength(1);
      expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(1);
    });
  }

  it("retries a lost session only once", async () => {
    const { posted, next, write } = await start((entry) => {
      if (entry.body.method === "initialize") return { headers: { "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: {} }) };
      if (entry.body.method === "tools/call") return { status: 502, body: JSON.stringify({ code: "session-gone" }) };
      return { status: 202 };
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await next();
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    expect(await next()).toMatchObject({ id: 2, result: { isError: true } });
    expect(posted.filter((entry) => entry.body.method === "tools/call")).toHaveLength(2);
  });

  it("forwards notifications in an SSE answer and answers a server request on the server's behalf", async () => {
    const { posted, next, write } = await start((entry) => {
      if (entry.body.method === "tools/call") {
        return {
          contentType: "text/event-stream",
          body: [
            'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}', "",
            'data: {"jsonrpc":"2.0","id":99,"method":"sampling/createMessage","params":{}}', "",
            'data: {"jsonrpc":"2.0","id":100,"method":"ping"}', "",
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { content: [{ type: "text", text: "done" }] } })}`, "", "",
          ].join("\n"),
        };
      }
      return { status: 202 };
    });
    write({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: {} } });
    expect(await next()).toEqual({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } });
    expect(await next()).toMatchObject({ id: 5, result: { content: [{ text: "done" }] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const replies = posted.filter((entry) => entry.body.method === undefined);
    expect(replies.map((entry) => entry.body)).toEqual([
      { jsonrpc: "2.0", id: 99, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 100, result: {} },
    ]);
  });

  it("answers every id: a relay failure becomes the relay's sentence, never silence", async () => {
    const { next, write } = await start((entry) => {
      if (entry.body.method === "tools/call") return { status: 401, body: JSON.stringify({ code: "sign-in-ended", error: "Your sign-in to cloud.comfy.org has ended. Sign in again." }) };
      if (entry.body.method === "tools/list") return { status: 502, body: "<html>upstream secret page</html>" };
      if (entry.body.method === "ping") return { body: "   " };
      return { body: "not json at all" };
    });
    write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Your sign-in to cloud.comfy.org has ended. Sign in again." }], isError: true } });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await next();
    expect(listed).toMatchObject({ id: 2, error: { code: -32000 } });
    expect(JSON.stringify(listed)).not.toContain("upstream secret page");
    write({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(await next()).toMatchObject({ id: 3, error: { code: -32000 } });
    write({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect(await next()).toMatchObject({ id: 4, error: { code: -32000 } });
    write({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
    expect(await next()).toMatchObject({ id: 5, result: { isError: true } });
  });

  it("an answer for a different id is not handed back as this one", async () => {
    const { next, write } = await start((entry) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 9999, result: { wrong: true } }) + (entry.body.id ? "" : "") }));
    write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const frame = await next();
    expect(frame).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.stringify(frame)).not.toContain("wrong");
  });

  it("ignores a reply frame from the engine and exits when stdin closes", async () => {
    const { next, write } = await start(() => ({ status: 202 }));
    write({ jsonrpc: "2.0", id: 50, result: {} });
    write({ jsonrpc: "2.0", id: 51, method: "tools/list" });
    expect(await next()).toMatchObject({ id: 51 });
    const closed = once(child!, "close");
    child!.stdin.end();
    await closed;
  });

  it("the server name is read from argv, and the token never appears on stdout", async () => {
    const { posted, next, write } = await start(() => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) }), "github-mcp");
    write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const frame = await next();
    expect(posted[0]!.url).toBe("/api/internal/mcp-remote/github-mcp");
    expect(JSON.stringify(frame)).not.toContain("turn-token-0123");
  });
});
