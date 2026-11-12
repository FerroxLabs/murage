import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readMcpCatalog, registerCloudMcpCatalog, publishCloudMcpCatalog, publicationFailureFrame } from "../mcp-listed.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// The real stdio proxy, run as a process against a stand-in for the harness relay.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "remote-mcp-proxy.ts");
let server: Server | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
/** C11 v3.1 P-1: how many of the next catalog publications the stand-in refuses. */
let refuseCatalogPosts = 0;

afterEach(async () => {
  refuseCatalogPosts = 0;
  child?.kill();
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

type Posted = { url: string; headers: IncomingHttpHeaders; body: Record<string, any> };
type Answer = { status?: number; contentType?: string; body?: string; headers?: Record<string, string>; custom?: (res: ServerResponse) => void };

async function start(answer: (posted: Posted) => Answer, argvName = "comfy", marker?: string, publication?: { path: string; threadId: string }) {
  const posted: Posted[] = [];
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry: Posted = { url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
    posted.push(entry);
    const reply = publication && entry.url.startsWith("/api/internal/mcp-catalog/") && refuseCatalogPosts > 0 && refuseCatalogPosts--
      ? { status: 403, body: "{}" }
      : publication && entry.url.startsWith("/api/internal/mcp-catalog/")
      ? { status: entry.headers.authorization === "Bearer turn-token-0123" && publishCloudMcpCatalog(entry.url.split("/").at(-1)!, publication.threadId, entry.body) ? 200 : 403, body: "{}" }
      : answer(entry);
    if (reply.custom) return reply.custom(res);
    res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json", ...(reply.headers ?? {}) });
    res.end(reply.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", argvName], {
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "", ...(marker ? { MURAGE_MCP_LISTED_FILE: marker } : {}), ...(publication ? { MURAGE_MCP_LISTED_URL: registerCloudMcpCatalog(publication.path, publication.threadId, `http://127.0.0.1:${port}`) } : {}), MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_MCP_TOKEN: "turn-token-0123" },
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

// MCP-ELICITATION-109: a server's elicitation reaches the engine (and so the
// owner's card) while its call is still open, and the engine's answer goes back
// to the server under the server's own id. Sampling stays refused.
describe("the stdio proxy forwards an elicitation", () => {
  type Held = { posted: Posted[]; next: () => Promise<Record<string, any>>; write: (message: object) => boolean; answered: Promise<Posted> };
  async function startStreaming(options: { serverCancels?: boolean } = {}): Promise<Held> {
    const posted: Posted[] = [];
    let release: (posted: Posted) => void = () => {};
    const answered = new Promise<Posted>((resolve) => { release = resolve; });
    let openCall: ((answer: Posted) => void) | null = null;
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const entry: Posted = { url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      posted.push(entry);
      const body = entry.body;
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-e" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } }));
      }
      if (body.method === "tools/call") {
        // the call's answer stays open until the client answers the server's question
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-42", method: "elicitation/create", params: { message: "Costs USD 0.048. Run it?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } }, _meta: { codex_approval_kind: "mcp_tool_call" } } })}\n\n`);
        if (options.serverCancels) {
          // the server gives up on its own question (its request timeout) and ends the call
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "srv-42", reason: "timed out" } })}\n\n`);
          setTimeout(() => res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "no answer" }], isError: true } })}\n\n`), 100);
          return;
        }
        openCall = (answer) => {
          const confirmed = answer.body.result?.action === "accept";
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: confirmed ? "created" : "declined" }] } })}\n\n`);
        };
        return;
      }
      if (body.method === undefined && body.id === "srv-42") {
        res.writeHead(202);
        res.end();
        release(entry);
        openCall?.(entry);
        return;
      }
      res.writeHead(202);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", "spicy"], {
      windowsHide: true,
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
    return { posted, next, write, answered };
  }

  it("an engine that announced elicitation gets the server's question mid-call, and its accept reaches the server", async () => {
    const { posted, next, write, answered } = await startStreaming();
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {}, sampling: {} }, clientInfo: { name: "claude", version: "1" } } });
    await next();
    expect(posted[0]!.body.params.capabilities).toEqual({ elicitation: {} });
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create", arguments: {} } });
    const question = await next();
    expect(question).toMatchObject({ jsonrpc: "2.0", method: "elicitation/create", id: expect.stringMatching(/^murage-elicit-/), params: { message: "Costs USD 0.048. Run it?" } });
    // the server's _meta never reaches the engine (Codex reads codex_approval_kind as its own)
    expect(question.params._meta).toBeUndefined();
    write({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
    const reply = await answered;
    expect(reply.body).toEqual({ jsonrpc: "2.0", id: "srv-42", result: { action: "accept", content: { confirm: true } } });
    expect(reply.headers["mcp-session-id"]).toBe("sess-e");
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "created" }] } });
    // sampling is still refused, on the server's own id
    const refused = posted.find((entry) => entry.body.id === 1 && entry.body.method === undefined);
    expect(refused?.body).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
  });

  it("an engine that announced no elicitation never sees one: the server is refused", async () => {
    const { posted, next, write } = await startStreaming();
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    await next();
    expect(posted[0]!.body.params.capabilities).toEqual({});
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create", arguments: {} } });
    // the refusal releases the server's call with its "declined" answer
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "declined" }] } });
    expect(posted.find((entry) => entry.body.id === "srv-42")?.body).toEqual({ jsonrpc: "2.0", id: "srv-42", error: { code: -32601, message: "Method not found" } });
  });

  it("a server cancelling its question reaches the engine under the id the engine knows", async () => {
    const { next, write } = await startStreaming({ serverCancels: true });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude", version: "1" } } });
    await next();
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create", arguments: {} } });
    const question = await next();
    expect(await next()).toEqual({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: question.id, reason: "timed out" } });
    expect(await next()).toMatchObject({ id: 2, result: { isError: true } });
  });
});

describe("the stdio proxy keeps each call's elicitations apart", () => {
  it("a cancel on one call never closes another call's question with the same server id", async () => {
    const posted: Posted[] = [];
    const calls = new Map<string, (answer: Posted) => void>();
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const entry: Posted = { url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      posted.push(entry);
      const body = entry.body;
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-p" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } }));
      }
      if (body.method === "tools/call") {
        const who = String(body.params.arguments.who);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // both calls number their question 1, as a server numbering per response does
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "elicitation/create", params: { message: `ask ${who}`, requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } } } })}\n\n`);
        if (who === "b") {
          setTimeout(() => {
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "b gave up" } })}\n\n`);
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "b ended" }] } })}\n\n`);
          }, 300);
        } else {
          calls.set(who, (answer) => res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `a got ${answer.body.result?.action}` }] } })}\n\n`));
        }
        return;
      }
      res.writeHead(202);
      res.end();
      if (body.method === undefined && body.id === 1) calls.get("a")?.(entry);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, "--server", "par"], {
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "", MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_MCP_TOKEN: "turn-token-0123" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames: Array<Record<string, any>> = [];
    const waiters: Array<() => void> = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => { frames.push(JSON.parse(line)); for (const wake of waiters.splice(0)) wake(); });
    const seen = async (match: (frame: Record<string, any>) => boolean) => {
      for (;;) {
        const found = frames.find(match);
        if (found) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    };
    const write = (message: object) => child!.stdin.write(`${JSON.stringify(message)}\n`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude", version: "1" } } });
    await seen((frame) => frame.id === 1);
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", arguments: { who: "a" } } });
    const askA = await seen((frame) => frame.method === "elicitation/create" && frame.params.message === "ask a");
    write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x", arguments: { who: "b" } } });
    const askB = await seen((frame) => frame.method === "elicitation/create" && frame.params.message === "ask b");
    // b's cancel closes b's question only
    expect(await seen((frame) => frame.method === "notifications/cancelled")).toMatchObject({ params: { requestId: askB.id } });
    await seen((frame) => frame.id === 3);
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toHaveLength(1);
    // a's question is still open: its accept reaches the server and ends a's call
    write({ jsonrpc: "2.0", id: askA.id, result: { action: "accept", content: { ok: true } } });
    expect(await seen((frame) => frame.id === 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "a got accept" }] } });
    expect(posted.find((entry) => entry.body.method === undefined && entry.body.id === 1)?.headers["mcp-session-id"]).toBe("sess-p");
  });
});

it("c11-cloud-remote-catalog observes streamed pagination and resource capability", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-remote-")), "generation.remote");
  const { next, write } = await start(({ body }) => ({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ id: body.id, result: body.method === "initialize" ? { capabilities: { resources: {}, tools: {} } } : body.params?.cursor ? { tools: [{ name: "last" }] } : { tools: [{ name: "first" }], nextCursor: "page2" } })}\n\n` }), "fixture", marker);
  write({ id: 0, method: "initialize" }); await next();
  write({ id: 1, method: "tools/list" }); await next();
  await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(false);
  write({ id: "1", method: "tools/list", params: { cursor: "page2" } }); await next();
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, resources: true, tools: ["first", "last"] });
});

it("c11-cloud-remote-catalog: namespace publication reaches only its registered driver path", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-cloud-catalog-")), "generation.remote");
  const { next, write } = await start(({ body }) => ({ body: JSON.stringify({ id: body.id, result: body.method === "initialize" ? { capabilities: { tools: {}, resources: {} } } : { tools: [{ name: "served" }] } }) }), "fixture", "/not-mounted/generation.remote", { path: marker, threadId: "fixture-thread" });
  write({ id: 0, method: "initialize" }); await next();
  write({ id: 1, method: "tools/list" }); await next();
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, resources: true, tools: ["served"] });
  const url = registerCloudMcpCatalog(marker, "owner-thread", "http://127.0.0.1");
  expect(publishCloudMcpCatalog(url.split("/").at(-1)!, "other-thread", readMcpCatalog(marker))).toBe(false);
});

it("P-1 a refused catalog publication on a streamed list replaces only that response: the frames around it are forwarded, one answer per id, and the proxy lives on", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-remote-p1-")), "generation.remote");
  const note = (n: number) => ({ jsonrpc: "2.0", method: "notifications/message", params: { n } });
  const { next, write } = await start(({ body }) => body.method === "initialize"
    ? { body: JSON.stringify({ id: body.id, result: { capabilities: { tools: {} } } }) }
    : { contentType: "text/event-stream", body: [note(1), { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } }, note(2)].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") },
  "fixture", marker, { path: marker, threadId: "owner-thread" });
  write({ id: 0, method: "initialize" }); await next();
  refuseCatalogPosts = 1; // the next catalog POST (list 1's request publication) is refused
  write({ id: 1, method: "tools/list" });
  const first = [await next(), await next(), await next()];
  expect(first.filter((frame) => frame.id === 1)).toHaveLength(1);
  expect(first.find((frame) => frame.id === 1)).toEqual(publicationFailureFrame(1));
  expect(first.filter((frame) => frame.method === "notifications/message").map((frame) => frame.params.n).sort()).toEqual([1, 2]);
  // the proxy did not exit: the next list is answered, and the catalog certifies
  write({ id: 2, method: "tools/list" });
  const second = [await next(), await next(), await next()];
  expect(second.filter((frame) => frame.id === 2)).toHaveLength(1);
  expect(second.find((frame) => frame.id === 2)!.result.tools).toEqual([{ name: "t" }]);
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, tools: ["t"] });
  expect(child!.exitCode).toBeNull();
});

const sse = (frame: object) => `data: ${JSON.stringify(frame)}\n\n`;
const publicationRig = (answer: (posted: Posted) => Answer) => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-remote-p1x-")), "generation.remote");
  return { marker, started: () => start(answer, "fixture", marker, { path: marker, threadId: "owner-thread" }) };
};
const initialized = ({ body }: Posted) => body.method === "initialize" ? { body: JSON.stringify({ id: body.id, result: { capabilities: { tools: {} } } }) } : null;

it("P-1a a JSON answer whose publication is refused gets exactly the publication envelope, and the next list certifies", async () => {
  const { marker, started } = publicationRig((posted) => initialized(posted) ?? { body: JSON.stringify({ jsonrpc: "2.0", id: posted.body.id, result: { tools: [{ name: "t" }] } }) });
  const { next, write } = await started();
  write({ id: 0, method: "initialize" }); await next();
  refuseCatalogPosts = 1;
  write({ id: 1, method: "tools/list" });
  expect(await next()).toEqual(publicationFailureFrame(1));
  write({ id: 2, method: "tools/list" });
  expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t" }] } });
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, tools: ["t"] });
  expect(child!.exitCode).toBeNull();
}, 20_000);

// the answer is the LAST event and has no trailing blank line: only the end-of-stream flush emits it
const unterminated = ({ body }: Posted) => ({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "flushed" }] } })}` });
it("P-1b (ok) the SSE decoder's end-of-stream flush delivers an unterminated final answer", async () => {
  const { marker, started } = publicationRig((posted) => initialized(posted) ?? unterminated(posted));
  const { next, write } = await started();
  write({ id: 0, method: "initialize" }); await next();
  write({ id: 1, method: "tools/list" });
  expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "flushed" }] } });
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, tools: ["flushed"] });
}, 20_000);
it("P-1b (fail) the same unterminated stream with the publication refused gives exactly the publication envelope", async () => {
  const { started } = publicationRig((posted) => initialized(posted) ?? unterminated(posted));
  const { next, write } = await started();
  write({ id: 0, method: "initialize" }); await next();
  refuseCatalogPosts = 1;
  write({ id: 1, method: "tools/list" });
  expect(await next()).toEqual(publicationFailureFrame(1));
  expect(child!.exitCode).toBeNull();
}, 20_000);

it("P-1c an elicitation during a refused publication reaches the engine, its reply reaches the server, and id 1 gets exactly the publication envelope", async () => {
  let release!: () => void;
  const replied = new Promise<void>((resolve) => { release = resolve; });
  const { started } = publicationRig((posted) => {
    const { body } = posted;
    if (body.method === "tools/list") {
      return { custom: (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse({ jsonrpc: "2.0", id: "srv-1", method: "elicitation/create", params: { message: "Run it?", requestedSchema: { type: "object", properties: {} } } }));
        void replied.then(() => res.end(sse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } })));
      } };
    }
    if (body.method === undefined && body.id === "srv-1") { release(); return { status: 202 }; }
    return initialized(posted) ?? { status: 202 };
  });
  const { posted, next, write } = await started();
  write({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } } }); await next();
  refuseCatalogPosts = 1;
  write({ id: 1, method: "tools/list" });
  const ask = await next();
  expect(ask).toMatchObject({ method: "elicitation/create", params: { message: "Run it?" } });
  write({ jsonrpc: "2.0", id: ask.id, result: { action: "accept" } });
  expect(await next()).toEqual(publicationFailureFrame(1));
  await replied;
  expect(posted.find((entry) => entry.body.method === undefined && entry.body.id === "srv-1")?.body).toMatchObject({ result: { action: "accept" } });
  expect(child!.exitCode).toBeNull();
}, 20_000);
