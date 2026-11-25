import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
const sealedProxyRefusal = { jsonrpc: "2.0", id: null, error: {
  code: -32099, message: LEDGER_REFUSAL_LINE,
  data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true },
} };
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readMcpCatalog, registerCloudMcpCatalog, publishCloudMcpCatalog, publicationFailureFrame } from "../mcp-listed.ts";
// control migration: real bound proxy ingress; existing assertions retained.
// SPDX-License-Identifier: AGPL-3.0-or-later
// The real stdio proxy, run as a process against a stand-in for the harness relay.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { boundProxyState, spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
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

async function stop() {
  refuseCatalogPosts = 0;
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close"); child.kill(); await closed;
  }
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}
afterEach(stop);

type Posted = { url: string; headers: IncomingHttpHeaders; body: Record<string, any> };
type Answer = { status?: number; contentType?: string; body?: string; headers?: Record<string, string>; custom?: (res: ServerResponse) => void };

async function start(answer: (posted: Posted) => Answer, argvName = "comfy", marker?: string, publication?: { path: string; threadId: string }, extraEnv: Record<string, string> = {}) {
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
  child = await spawnBoundProxy("remoteMcp", process.execPath, ["--experimental-strip-types", ENTRY, "--server", argvName], {
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "", ...(marker ? { MURAGE_MCP_LISTED_FILE: marker } : {}), ...(publication ? { MURAGE_MCP_LISTED_URL: registerCloudMcpCatalog(publication.path, publication.threadId, `http://127.0.0.1:${port}`) } : {}), MURAGE_HARNESS_URL: `http://127.0.0.1:${port}`, MURAGE_MCP_TOKEN: "turn-token-0123", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const queue: Array<Record<string, any>> = [];
  const accepted: Array<Record<string, any>> = [];
  const waiters: Array<(value: Record<string, any>) => void> = [];
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    accepted.push(frame);
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else queue.push(frame);
  });
  const next = () => new Promise<Record<string, any>>((resolve) => { const queued = queue.shift(); if (queued) resolve(queued); else waiters.push(resolve); });
  const write = (message: object) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return { posted, next, write, accepted };
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
      // cause6-v2: the relay answers every call on a session it does not hold the same way, the proxy's ping included
      if (entry.body.method === "ping" && entry.headers["mcp-session-id"] !== live) return { status: 502, body: JSON.stringify({ code: "session-gone", error: "no such session" }) };
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
      const { posted, next, write, accepted } = await start((entry) => {
        if (entry.body.method === "initialize") return { headers: { "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: {} }) };
        if (entry.body.method === "tools/call") return { status, body: label === "a bare 404" ? "" : JSON.stringify({ code, error: "This link is not an MCP server." }) }; // the relay's real body
        return { status: 202 };
      });
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
      await next();
      accepted.length = 0;
      const terminal = Promise.race([once(child!, "close"), once(child!.stdout, "data")]);
      write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
      // red-at-4df086541: design 399; an unknown transport failure cannot
      // become a tool result. Preserve the exact no-retry assertions below.
      if (status >= 500 || label === "a bare 404") {
        await terminal;
        expect(accepted).toEqual([]);
        // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: also require the authenticated fixed terminal receipt.
        expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
      } else expect(await next()).toMatchObject({ id: 2, result: { isError: true } });
      expect(posted.filter((entry) => entry.body.method === "tools/call")).toHaveLength(1);
      expect(posted.filter((entry) => entry.body.method === "initialize")).toHaveLength(1);
    });
  }

  it("retries a lost session only once", async () => {
    const { posted, next, write, accepted } = await start((entry) => {
      if (entry.body.method === "initialize") return { headers: { "mcp-session-id": "s" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: {} }) };
      // cause6-v2: no session is held, so the proxy's ping gets the same answer as the call
      if (entry.body.method === "tools/call" || entry.body.method === "ping") return { status: 502, body: JSON.stringify({ code: "session-gone", error: "The connection to this server was closed. Try again in a moment." }) }; // the relay's real body
      return { status: 202 };
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await next();
    accepted.length = 0;
    const terminal = Promise.race([once(child!, "close"), once(child!.stdout, "data")]);
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    // red-at-4df086541: exhausted session recovery is terminal (design 399).
    await terminal;
    expect(accepted).toEqual([]);
    // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: also require the authenticated fixed terminal receipt.
    expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
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

  // red-at-4df086541: design line 399 makes relay transport loss terminal;
  // the completed sign-in decision remains an ordinary gated policy refusal.
  it("answers policy refusals and seals every relay transport failure", async () => {
    const { next, write } = await start((entry) => {
      if (entry.body.method === "tools/call") return { status: 401, body: JSON.stringify({ code: "sign-in-ended", error: "Your sign-in to cloud.comfy.org has ended. Sign in again." }) };
      if (entry.body.method === "tools/list") return { status: 502, body: "<html>upstream secret page</html>" };
      if (entry.body.method === "ping") return { body: "   " };
      return { body: "not json at all" };
    });
    write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Your sign-in to cloud.comfy.org has ended. Sign in again." }], isError: true } });
    await stop();
    for (const [id, method, answer] of [
      [2, "tools/list", { status: 502, body: "<html>upstream secret page</html>" }],
      [3, "ping", { body: "   " }],
      [4, "resources/list", { body: "not json at all" }],
      [5, "tools/call", { body: "not json at all" }],
    ] as const) {
      const run = await start(() => answer);
      const closed = once(child!, "close");
      const replied = once(child!.stdout, "data");
      run.write({ jsonrpc: "2.0", id, method, params: {} });
      await Promise.race([closed, replied]);
      expect(run.accepted).toEqual([]);
      expect(JSON.stringify(run.accepted)).not.toContain("upstream secret page");
      // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: also require the authenticated fixed terminal receipt.
      expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
      await stop();
    }
  });

  it("an answer for a different id is not handed back as this one", async () => {
    const { accepted, write } = await start((entry) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 9999, result: { wrong: true } }) + (entry.body.id ? "" : "") }));
    const closed = once(child!, "close");
    const replied = once(child!.stdout, "data");
    write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await Promise.race([closed, replied]);
    // red-at-4df086541; design line 399: wrong-frame failure is terminal.
    expect(accepted).toEqual([]);
    expect(JSON.stringify(accepted)).not.toContain("wrong");
    // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: also require the authenticated fixed terminal receipt.
    expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
  });

  it("refuses an unbound engine reply and exits when stdin closes", async () => {
    const { accepted, posted, write } = await start(() => ({ status: 202 }));
    const closed = once(child!, "close");
    write({ jsonrpc: "2.0", id: 50, result: {} });
    write({ jsonrpc: "2.0", id: 51, method: "tools/list" });
    child!.stdin.end();
    await closed;
    // red-at-4df086541; design lines 393–399 require an already-bound ID.
    expect(accepted).toEqual([]);
    expect(posted).toEqual([]);
    // The parent refuses the unbound response before the child sees a frame.
    expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1 });
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
    child = await spawnBoundProxy("remoteMcp", process.execPath, ["--experimental-strip-types", ENTRY, "--server", "spicy"], {
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
    const write = (message: object) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
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
    child = await spawnBoundProxy("remoteMcp", process.execPath, ["--experimental-strip-types", ENTRY, "--server", "par"], {
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
    const write = (message: object) => child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
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
  const { next, write } = await start(({ body }) => ({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { capabilities: { resources: {}, tools: {} } } : body.params?.cursor ? { tools: [{ name: "last" }] } : { tools: [{ name: "first" }], nextCursor: "page2" } })}\n\n` }), "fixture", marker);
  write({ id: 0, method: "initialize" }); await next();
  write({ id: 1, method: "tools/list" }); await next();
  await expect.poll(() => readMcpCatalog(marker)?.complete).toBe(false);
  write({ id: "1", method: "tools/list", params: { cursor: "page2" } }); await next();
  await expect.poll(() => readMcpCatalog(marker)).toMatchObject({ complete: true, resources: true, tools: ["first", "last"] });
});

it("c11-cloud-remote-catalog: namespace publication reaches only its registered driver path", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-cloud-catalog-")), "generation.remote");
  const { next, write } = await start(({ body }) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { capabilities: { tools: {}, resources: {} } } : { tools: [{ name: "served" }] } }) }), "fixture", "/not-mounted/generation.remote", { path: marker, threadId: "fixture-thread" });
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
    ? { body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: { tools: {} } } }) }
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
const initialized = ({ body }: Posted) => body.method === "initialize" ? { body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: { tools: {} } } }) } : null;

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

// 1.0.21 cause6 (the signed 1.0.21 on an owner's own computer): every turn logged "mount unavailable ... cause=ipc
// reason=transport-lost" and "stderr=proxy.refuse/error/-" for the owner's own server. One call the relay failed, or one
// failed record of the tool hints, sealed the whole server for the turn. The fakes answered every call well, so no canary saw it.
describe("1.0.21 cause6: one failed call never seals the owner's server for the turn", () => {
  const initialized = (entry: Posted): Answer => ({ headers: { "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "s", version: "1" } } }) });
  const listed = (entry: Posted): Answer => ({ body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { tools: [{ name: "echo" }] } }) });
  const hello = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } };

  for (const [label, failure] of [
    ["the server answered an error status (the relay's 502 server-error)", { status: 502, body: JSON.stringify({ code: "server-error", error: "The server at example.test had a problem. Try again in a moment." }) }],
    ["the server gave no usable answer (the relay's 502 wrong-address)", { status: 502, body: JSON.stringify({ code: "wrong-address", error: "This link is not an MCP server." }) }],
  ] as const) {
    it(`a side call that fails because ${label} gets its own error, and the tools still list and run`, async () => {
      const { next, write } = await start((entry) => {
        if (entry.body.method === "initialize") return initialized(entry);
        if (entry.body.method === "prompts/list") return failure;
        if (entry.body.method === "tools/list") return listed(entry);
        if (entry.body.method === "tools/call") return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { content: [{ type: "text", text: "ran" }] } }) };
        return { status: 202 };
      });
      write(hello);
      expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: "s" } } });
      write({ method: "notifications/initialized" });
      // what a real engine sends once the server announces prompts: the fakes never did
      write({ id: 2, method: "prompts/list", params: {} });
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: JSON.parse(failure.body).error } });
      write({ id: 3, method: "tools/list", params: {} });
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "echo" }] } });
      write({ id: 4, method: "tools/call", params: { name: "echo", arguments: {} } });
      expect(await next()).toMatchObject({ id: 4, result: { content: [{ type: "text", text: "ran" }] } });
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });
  }

  it("a tool call the relay failed at 502 still seals (design 399: it may have run, so it is never a tool result)", async () => {
    const { next, write, accepted } = await start((entry) => {
      if (entry.body.method === "initialize") return initialized(entry);
      return { status: 502, body: JSON.stringify({ code: "server-error", error: "The server had a problem." }) };
    });
    write(hello);
    await next();
    accepted.length = 0;
    const terminal = Promise.race([once(child!, "close"), once(child!.stdout, "data")]);
    write({ id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
    await terminal;
    expect(accepted).toEqual([]);
    expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
  });

  it("a failed notification is owed no answer and seals nothing", async () => {
    const { next, write, accepted } = await start((entry) => {
      if (entry.body.method === "initialize") return initialized(entry);
      if (entry.body.method === "notifications/initialized") return { status: 502, body: JSON.stringify({ code: "server-error", error: "The server had a problem." }) };
      return listed(entry);
    });
    write(hello);
    await next();
    write({ method: "notifications/initialized" });
    write({ id: 2, method: "tools/list", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }] } });
    expect(accepted.length).toBe(2);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("a 5xx that is not the relay's own answer still seals, and nothing of it reaches the engine", async () => {
    for (const body of ["<html>upstream secret page</html>", JSON.stringify({ error: "upstream secret page" }), JSON.stringify({ code: "Not A Code", error: "upstream secret page" })]) {
      const run = await start(() => ({ status: 502, body }));
      const closed = once(child!, "close");
      const replied = once(child!.stdout, "data");
      run.write({ id: 7, method: "tools/list", params: {} });
      await Promise.race([closed, replied]);
      expect(run.accepted).toEqual([]);
      expect(boundProxyState(child!)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
      await stop();
    }
  });

  it("tool hints that cannot be recorded fail that tools/list alone, with no tool listed; the next list succeeds", async () => {
    let refuseHints = 2; // both attempts of the first list
    const { posted, next, write } = await start((entry) => {
      if (entry.url.endsWith("/wipe-metadata")) return refuseHints > 0 && refuseHints-- ? { status: 503, body: "{}" } : { body: JSON.stringify({ ok: true }) };
      if (entry.body.method === "initialize") return initialized(entry);
      if (entry.body.method === "tools/list") return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { tools: [{ name: "delete_all_posts" }] } }) };
      return { status: 202 };
    }, "comfy", undefined, undefined, { MURAGE_MCP_WIPE_METADATA: "1" });
    write(hello);
    await next();
    write({ id: 2, method: "tools/list", params: {} });
    const refused = await next();
    expect(refused).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Murage could not record this server's tools. Try again in a moment." } });
    expect(JSON.stringify(refused)).not.toContain("delete_all_posts");
    write({ id: 3, method: "tools/list", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "delete_all_posts" }] } });
    const hints = posted.filter((entry) => entry.url.endsWith("/wipe-metadata"));
    expect(hints.length).toBe(3);
    expect(hints.at(-1)!.body).toEqual({ tools: [{ tool: "delete_all_posts", destructive: true, bulk: true }], replace: true });
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  // ASTRA cause6-mounts-fable abd393df02 High: the reopen sent the handshake notification and the retry sent it again.
  describe("a replacement session gets notifications/initialized exactly once", () => {
    /** A stand-in harness that holds one live session; any other session id is the relay's session-gone. */
    const harness = (lacks: string[] = []) => {
      const state = { live: "", opened: 0, order: [] as string[] };
      const gone: Answer = { status: 502, body: JSON.stringify({ code: "session-gone", error: "The connection to this server was closed. Try again in a moment." }) }; // the relay's real body
      const answer = (entry: Posted): Answer => {
        const method = String(entry.body.method ?? "");
        const session = String(entry.headers["mcp-session-id"] ?? "");
        state.order.push(`${method}@${session}`);
        if (method === "initialize") {
          state.opened += 1;
          state.live = `sess-${state.opened}`;
          return { headers: { "mcp-session-id": state.live }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "s", version: "1" } } }) };
        }
        if (session !== state.live || lacks.includes(method)) return gone;
        if (method.startsWith("notifications/")) return { status: 202 };
        if (method === "tools/list") return listed(entry);
        return { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: {} }) };
      };
      return { state, answer };
    };
    const handshakes = (order: string[], session: string) => order.filter((line) => line === `notifications/initialized@${session}`).length;

    it("when the engine's own notifications/initialized is the call that finds the session gone", async () => {
      const { state, answer } = harness();
      const { next, write } = await start(answer);
      write(hello);
      await next();
      state.live = "revoked"; // the harness dropped generation 1's session before the engine's notification arrived
      write({ method: "notifications/initialized" });
      // alone on the wire: the notification is the only call that can open the replacement session
      for (let waited = 0; handshakes(state.order, "sess-2") === 0 && waited < 400; waited++) await new Promise((resolve) => setTimeout(resolve, 25));
      write({ id: 2, method: "tools/list", params: {} });
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "echo" }] } });
      write({ id: 3, method: "tools/list", params: {} });
      await next();
      expect(state.opened).toBe(2);
      expect(state.order.filter((line) => line.startsWith("notifications/initialized@"))).toEqual(["notifications/initialized@sess-1", "notifications/initialized@sess-2"]);
      expect(handshakes(state.order, "sess-2")).toBe(1);
      // the handshake is complete on the replacement session before any call runs on it
      expect(state.order.indexOf("notifications/initialized@sess-2")).toBeLessThan(state.order.indexOf("tools/list@sess-2"));
      expect(state.order.indexOf("notifications/initialized@sess-2")).toBeGreaterThan(-1);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("when another call finds the session gone: the reopen sends it once and the call is retried once", async () => {
      const { state, answer } = harness();
      const { next, write } = await start(answer);
      write(hello);
      await next();
      write({ method: "notifications/initialized" });
      write({ id: 2, method: "tools/list", params: {} });
      await next();
      state.live = "revoked";
      write({ id: 3, method: "tools/list", params: {} });
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "echo" }] } });
      write({ id: 99, method: "ping" }); // barrier: nothing is still in flight when the counts are read
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
      expect(state.opened).toBe(2);
      expect(handshakes(state.order, "sess-1")).toBe(1);
      expect(handshakes(state.order, "sess-2")).toBe(1);
      expect(state.order.filter((line) => line.startsWith("tools/list@"))).toEqual(["tools/list@sess-1", "tools/list@sess-1", "tools/list@sess-2"]);
    });

    it("when two calls and the notification find it gone together: one replacement session, one handshake on it", async () => {
      const { state, answer } = harness();
      // hold every session-gone answer until all three calls have arrived, so all three learn it together
      // (cause6-v2: not the proxy's own ping, which asks only after they have learned it)
      let held: Array<() => void> = [];
      const { next, write } = await start((entry) => {
        const reply = answer(entry);
        if (reply.status !== 502 || entry.body.method === "ping") return reply;
        return { custom: (res) => {
          held.push(() => { res.writeHead(502, { "content-type": "application/json" }); res.end(reply.body); });
          if (held.length === 3) { const all = held; held = []; for (const release of all) release(); }
        } };
      });
      write(hello);
      await next();
      state.live = "revoked";
      write({ method: "notifications/initialized" });
      write({ id: 2, method: "prompts/list", params: {} });
      write({ id: 3, method: "tools/list", params: {} });
      const answers = [await next(), await next()].sort((a, b) => a.id - b.id);
      expect(answers).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "echo" }] } }]);
      write({ id: 99, method: "ping" }); // barrier: nothing is still in flight when the counts are read
      expect(await next()).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
      expect(state.opened).toBe(2);
      expect(handshakes(state.order, "sess-2")).toBe(1);
      expect(state.order.filter((line) => line.endsWith("@sess-2") && line !== "ping@sess-2").sort()).toEqual(["notifications/initialized@sess-2", "prompts/list@sess-2", "tools/list@sess-2"]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("an engine that initializes again on a session id the server keeps still sends its own handshake", async () => {
      const order: string[] = [];
      const { next, write } = await start((entry) => {
        order.push(`${entry.body.method}@${entry.headers["mcp-session-id"] ?? ""}`);
        if (entry.body.method === "initialize") return initialized(entry); // always sess-1
        if (entry.body.method === "tools/list") return listed(entry);
        return { status: 202 };
      });
      for (const id of [1, 3]) {
        write({ ...hello, id });
        await next();
        write({ method: "notifications/initialized" });
        write({ id: id + 1, method: "tools/list", params: {} });
        await next();
      }
      expect(order.filter((line) => line.startsWith("notifications/"))).toEqual(["notifications/initialized@sess-1", "notifications/initialized@sess-1"]);
    });
  });
});

// ASTRA cause6-mounts-fable e779ade076 BLOCK (3 High): the session is one state machine with a generation fence.
// Every test drives the real spawned proxy; `order` is the exact wire order the stand-in harness saw.
describe("1.0.21 cause6-v2: one session state machine, a stale reply never changes it", () => {
  const hello = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } };
  const relaySays = (code: string, error: string): Answer => ({ status: 502, body: JSON.stringify({ code, error }) }); // the relay's real status and body
  const GONE = "The connection to this server was closed. Try again in a moment.";
  const NO_ANSWER = "The server did not answer in time. Try again in a moment.";
  const gone = relaySays("session-gone", GONE);
  const noAnswer = relaySays("no-answer", NO_ANSWER);
  const result = (entry: Posted, value: object = {}): Answer => ({ body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: value }) });
  const opened = (entry: Posted, session: string): Answer => ({ headers: { "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "s", version: "1" } } }) });
  const tools = { tools: [{ name: "echo" }] };
  const send = (res: ServerResponse, answer: Answer) => { res.writeHead(answer.status ?? 200, { "content-type": answer.contentType ?? "application/json", ...(answer.headers ?? {}) }); res.end(answer.body ?? ""); };
  /** A reply the test holds back until it releases it: the barrier that fixes the wire order. */
  const held = () => {
    let waiting: ServerResponse | null = null;
    let arrived!: () => void;
    const here = new Promise<void>((resolve) => { arrived = resolve; });
    return { here, answer: { custom: (res: ServerResponse) => { waiting = res; arrived(); } } as Answer, release: (answer: Answer) => send(waiting!, answer) };
  };
  /** A stand-in harness: `live` is the one session the server holds; a call on any other is the relay's session-gone.
   * `script` may answer a call first (return null to fall through). */
  const harness = (script: (entry: Posted, method: string, session: string, state: { live: string; opened: number }) => Answer | null = () => null) => {
    const state = { live: "", opened: 0, order: [] as string[] };
    const answer = (entry: Posted): Answer => {
      const method = String(entry.body.method ?? "");
      const session = String(entry.headers["mcp-session-id"] ?? "");
      state.order.push(`${method}@${session}`);
      const scripted = script(entry, method, session, state);
      if (scripted) return scripted;
      if (method === "initialize") {
        state.opened += 1;
        state.live = `sess-${state.opened}`;
        return opened(entry, state.live);
      }
      if (session === "") return relaySays("wrong-address", "Nothing at this address answers as an MCP server. Check that you copied the whole link.");
      if (session !== state.live) return gone;
      if (method.startsWith("notifications/")) return { status: 202 };
      return result(entry, method === "tools/list" ? tools : {});
    };
    return { state, answer };
  };
  type Run = Awaited<ReturnType<typeof start>>;
  /** The engine's first open, its handshake, and one answered call: everything before the scenario is on the wire. */
  const connect = async (run: Run, order: string[]) => {
    run.write(hello);
    expect(await run.next()).toMatchObject({ id: 1, result: { serverInfo: { name: "s" } } });
    run.write({ method: "notifications/initialized" });
    // the engine's other calls do not wait for its handshake: see it arrive before anything else is sent
    while (!order.some((line) => line.startsWith("notifications/initialized@"))) await new Promise((resolve) => setTimeout(resolve, 5));
    await barrier(run, 90);
  };
  /** A call answered after everything before it: nothing is still in flight when the asserts run. */
  const barrier = async (run: Run, id: number) => {
    run.write({ id, method: "ping" });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id, result: {} });
  };
  const count = (order: string[], line: string) => order.filter((entry) => entry === line).length;
  const isReopen = (entry: Posted) => String(entry.body.id).startsWith("reopen-");

  // High 1 (:242): the engine's initialize did not take the reopen lock, so the automatic open's late answer won.
  it("W1 an engine initialize supersedes an automatic reopen in flight: the late session is never used and the engine's handshake goes on its own", async () => {
    const late = held();
    const { state, answer } = harness((entry, method) => {
      if (method === "initialize" && isReopen(entry)) return late.answer;
      if (method === "initialize" && entry.body.id === 10) { state.live = "sess-B"; return opened(entry, "sess-B"); }
      return null;
    });
    const stand = (entry: Posted): Answer => {
      // both B and the late C are sessions the server holds: only the proxy decides which one it uses
      if (String(entry.headers["mcp-session-id"] ?? "") === "sess-C" && entry.body.method !== "initialize") {
        state.order.push(`${entry.body.method}@sess-C`);
        return String(entry.body.method).startsWith("notifications/") ? { status: 202 } : result(entry, entry.body.method === "tools/list" ? tools : {});
      }
      return answer(entry);
    };
    const run = await start(stand);
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "tools/list", params: {} });
    await late.here; // the automatic initialize is on the wire and unanswered
    run.write({ ...hello, id: 10 });
    expect(await run.next()).toMatchObject({ id: 10, result: { serverInfo: { name: "s" } } });
    late.release({ headers: { "mcp-session-id": "sess-C" }, body: JSON.stringify({ jsonrpc: "2.0", id: "reopen-late", result: { protocolVersion: "2025-06-18", capabilities: {} } }) });
    // A proxy that takes the late answer shows it at once (its handshake on sess-C). One that ignores it posts nothing, so there is
    // nothing to wait on: give the late answer time to be read. The asserts below hold at any timing once the fence is in.
    for (let waited = 0; !state.order.some((line) => line.endsWith("@sess-C")) && waited < 20; waited++) await new Promise((resolve) => setTimeout(resolve, 25));
    run.write({ method: "notifications/initialized" });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
    await barrier(run, 99);
    expect(state.order.filter((line) => line.endsWith("@sess-C"))).toEqual([]);
    expect(count(state.order, "notifications/initialized@sess-B")).toBe(1);
    // the call that lost the first session ran on the engine's session, after its handshake
    expect(state.order.indexOf("notifications/initialized@sess-B")).toBeLessThan(state.order.indexOf("tools/list@sess-B"));
    expect(state.order.at(-1)).toBe("ping@sess-B");
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  // High 1 (:258): any response's mcp-session-id header replaced the session id.
  it("W2 a late answer from the old session that names it does not put the proxy back on it", async () => {
    const slow = held();
    const { state, answer } = harness((_entry, method, session) => method === "prompts/list" && session === "sess-1" ? slow.answer : null);
    const run = await start(answer);
    await connect(run, state.order);
    run.write({ id: 2, method: "prompts/list", params: {} });
    await slow.here; // sent on sess-1, unanswered
    state.live = "revoked";
    run.write({ id: 3, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools }); // reopened: sess-2
    slow.release({ headers: { "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: {} }); // the late answer still answers its own id
    run.write({ id: 4, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 4, result: tools });
    await barrier(run, 99);
    expect(state.order.filter((line) => line.startsWith("tools/list@"))).toEqual(["tools/list@sess-1", "tools/list@sess-2", "tools/list@sess-2"]);
    expect(state.opened).toBe(2);
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
  });

  // High 1 (:211): "already replaced" was decided by comparing ids, so a server that reuses its id was reopened twice.
  it("W3 a server that gives every session the same id is reopened once for two calls that lost the same session", async () => {
    const slow = held();
    let lost = false;
    let initializes = 0;
    const order: string[] = [];
    const run = await start((entry) => {
      const method = String(entry.body.method ?? "");
      order.push(`${method}@${entry.headers["mcp-session-id"] ?? ""}`);
      if (method === "initialize") { initializes += 1; lost = false; return opened(entry, "sess-fixed"); }
      if (method === "prompts/list" && !lost && count(order, "prompts/list@sess-fixed") === 1) return slow.answer;
      if (lost) return gone;
      if (method.startsWith("notifications/")) return { status: 202 };
      return result(entry, method === "tools/list" ? tools : {});
    });
    await connect(run, order);
    run.write({ id: 2, method: "prompts/list", params: {} });
    await slow.here; // sent on the first session, unanswered
    lost = true;
    run.write({ id: 3, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools }); // the one reopen is complete
    slow.release(gone); // the second call learns its (first) session was gone only now
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    await barrier(run, 99);
    expect(initializes).toBe(2);
    expect(count(order, "notifications/initialized@sess-fixed")).toBe(2); // the engine's, and one for the one replacement
    expect(count(order, "prompts/list@sess-fixed")).toBe(2); // sent, and sent once more
  });

  // High 2 (:189): the handshake was marked before its POST and the answer ignored.
  for (const [label, refusal, sentence, killsSession] of [
    ["the relay's session-gone", gone, GONE, true],
    ["no answer in time", noAnswer, NO_ANSWER, false],
  ] as const) {
    it(`W4/W5 a replacement whose handshake gets ${label} is never used; the call fails alone and the next call opens a session with one handshake`, async () => {
      const { state, answer } = harness((_entry, method, session, s) => {
        if (method !== "notifications/initialized" || session !== "sess-2") return null;
        if (killsSession) s.live = "revoked";
        return refusal;
      });
      const run = await start(answer);
      await connect(run, state.order);
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: sentence } });
      run.write({ id: 3, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
      await barrier(run, 99);
      // nothing but its own handshake (and the probe that asks whether it is gone) ever went to the session without one
      expect(state.order.filter((line) => line.endsWith("@sess-2") && !line.startsWith("notifications/initialized@") && !line.startsWith("ping@"))).toEqual([]);
      expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
      expect(state.opened).toBe(3);
      expect(count(state.order, "notifications/initialized@sess-3")).toBe(1);
      expect(state.order.indexOf("notifications/initialized@sess-3")).toBeLessThan(state.order.indexOf("tools/list@sess-3"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });
  }

  it("W6 a server that never answers the handshake is not locked out: the second replacement in a row is used, each session got it once", async () => {
    const { state, answer } = harness((_entry, method, session) => method === "notifications/initialized" && session !== "sess-1" ? noAnswer : null);
    const run = await start(answer);
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: NO_ANSWER } });
    run.write({ id: 3, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
    await barrier(run, 99);
    expect(state.opened).toBe(3);
    expect(state.order.filter((line) => line.startsWith("tools/list@"))).toEqual(["tools/list@sess-1", "tools/list@sess-3"]);
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
    expect(count(state.order, "notifications/initialized@sess-3")).toBe(1);
    expect(state.order.indexOf("notifications/initialized@sess-3")).toBeLessThan(state.order.indexOf("tools/list@sess-3"));
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W11 the engine's own handshake that got no answer in time is sent once and the engine's session is still used", async () => {
    const asked = held();
    const { state, answer } = harness((_entry, method) => method === "notifications/initialized" ? asked.answer : null);
    const run = await start(answer);
    run.write(hello);
    await run.next();
    run.write({ method: "notifications/initialized" });
    await asked.here; // the engine's handshake is on the wire
    asked.release(noAnswer);
    run.write({ id: 2, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
    run.write({ method: "notifications/initialized" }); // a repeat from the engine is not sent again
    await barrier(run, 99);
    expect(state.order).toEqual(["initialize@", "notifications/initialized@sess-1", "tools/list@sess-1", "ping@sess-1"]);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  // Found in this lane's own review: a reopen an engine initialize superseded was still the one later calls waited on.
  it("W12 a superseded automatic reopen that never answers does not hold later calls: a session lost after it is reopened afresh", async () => {
    const late = held();
    let reopens = 0;
    const { state, answer } = harness((entry, method) => {
      if (method === "initialize" && isReopen(entry) && reopens++ === 0) return late.answer;
      if (method === "initialize" && entry.body.id === 10) { state.live = "sess-B"; return opened(entry, "sess-B"); }
      return null;
    });
    const run = await start(answer);
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "tools/list", params: {} });
    await late.here; // the first automatic initialize is on the wire and stays unanswered
    run.write({ ...hello, id: 10 });
    expect(await run.next()).toMatchObject({ id: 10, result: { serverInfo: { name: "s" } } });
    run.write({ method: "notifications/initialized" });
    // the call that waited on the first reopen is released onto the engine's session, not held by the unanswered reopen
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
    await barrier(run, 91);
    expect(state.order.indexOf("notifications/initialized@sess-B")).toBeLessThan(state.order.indexOf("tools/list@sess-B"));
    state.live = "revoked"; // the engine's session is lost too, while the first reopen is still unanswered
    run.write({ id: 5, method: "prompts/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    late.release(noAnswer); // the superseded reopen answers at last: stale, it changes nothing
    await barrier(run, 99);
    expect(state.opened).toBe(2); // the engine's first open and the one fresh reopen (sess-B was the engine's own)
    expect(state.order.filter((line) => line.endsWith("@sess-2")).sort()).toEqual(["notifications/initialized@sess-2", "ping@sess-2", "prompts/list@sess-2"]);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W13 a call that arrives while the replacement's handshake is unanswered is not posted before it is answered", async () => {
    const shaking = held();
    const { state, answer } = harness((_entry, method, session) => method === "notifications/initialized" && session === "sess-2" ? shaking.answer : null);
    const run = await start(answer);
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "tools/list", params: {} });
    await shaking.here; // the replacement is open, its handshake is on the wire
    run.write({ id: 3, method: "prompts/list", params: {} });
    // A proxy that does not wait shows it at once (prompts/list on sess-2). One that waits posts nothing: give it time to be wrong.
    for (let waited = 0; !state.order.includes("prompts/list@sess-2") && waited < 20; waited++) await new Promise((resolve) => setTimeout(resolve, 25));
    const before = state.order.filter((line) => line.endsWith("@sess-2"));
    shaking.release({ status: 202 });
    const answers = [await run.next(), await run.next()].sort((a, b) => a.id - b.id);
    expect(answers).toEqual([{ jsonrpc: "2.0", id: 2, result: tools }, { jsonrpc: "2.0", id: 3, result: {} }]);
    await barrier(run, 99);
    expect(before).toEqual(["notifications/initialized@sess-2"]);
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
  });

  // High 3 (:279): a method that lost two sessions in a row was remembered as refused and never reopened again.
  it("W7 a method that lost two sessions in a row is not locked out: its next call opens a session and is answered", async () => {
    const { state, answer } = harness((_entry, method, session, s) => {
      // the second session dies right after its handshake
      if (method === "notifications/initialized" && session === "sess-2") { s.live = "revoked"; return { status: 202 }; }
      return null;
    });
    const run = await start(answer);
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "prompts/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: GONE } });
    expect(state.order.filter((line) => line.startsWith("prompts/list@"))).toEqual(["prompts/list@sess-1", "prompts/list@sess-2"]); // sent once more, never twice
    run.write({ id: 3, method: "prompts/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    await barrier(run, 99);
    expect(state.opened).toBe(3);
    expect(state.order.at(-2)).toBe("prompts/list@sess-3");
    expect(count(state.order, "notifications/initialized@sess-3")).toBe(1);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  // FABLE Medium 3, now without a memory: the probe tells a server that lacks a method from a lost session.
  it("W8 a method the server answers 404 for on a live session gets its own error and costs no session at all", async () => {
    const { state, answer } = harness((_entry, method, session, s) => method === "prompts/list" && session === s.live ? gone : null);
    const run = await start(answer);
    await connect(run, state.order);
    for (const id of [2, 3]) {
      run.write({ id, method: "prompts/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id, error: { code: -32000, message: GONE } });
    }
    run.write({ id: 4, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 4, result: tools });
    expect(state.opened).toBe(1);
    expect(count(state.order, "prompts/list@sess-1")).toBe(2); // never sent twice
    // a session that is really lost later is still reopened, for this method too
    state.live = "revoked";
    run.write({ id: 5, method: "prompts/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32000, message: GONE } }); // sess-2 lacks it as well
    await barrier(run, 99);
    expect(state.opened).toBe(2);
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
    expect(state.order.at(-1)).toBe("ping@sess-2");
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W10 two calls that learn together that the session is gone share one probe and one replacement", async () => {
    const { state, answer } = harness();
    let waiting: Array<() => void> = [];
    const run = await start((entry) => {
      const reply = answer(entry);
      if (reply.status !== 502 || entry.body.method === "ping") return reply;
      // hold both session-gone answers until both calls have arrived
      return { custom: (res) => {
        waiting.push(() => send(res, reply));
        if (waiting.length === 2) { const all = waiting; waiting = []; for (const release of all) release(); }
      } };
    });
    await connect(run, state.order);
    state.live = "revoked";
    run.write({ id: 2, method: "prompts/list", params: {} });
    run.write({ id: 3, method: "tools/list", params: {} });
    const answers = [await run.next(), await run.next()].sort((a, b) => a.id - b.id);
    expect(answers).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 3, result: tools }]);
    await barrier(run, 99);
    expect(state.opened).toBe(2);
    expect(count(state.order, "ping@sess-1")).toBe(2); // the barrier in connect, and ONE probe for both calls
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
    expect(state.order.filter((line) => line.endsWith("@sess-2")).sort()).toEqual(["notifications/initialized@sess-2", "ping@sess-2", "prompts/list@sess-2", "tools/list@sess-2"]);
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });

  it("W9 a reopen that fails once fails that call alone; the next call opens a session again", async () => {
    let failOpens = 0;
    const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) && failOpens > 0 && failOpens-- ? noAnswer : null);
    const run = await start(answer);
    await connect(run, state.order);
    state.live = "revoked";
    failOpens = 1;
    run.write({ id: 2, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: NO_ANSWER } });
    run.write({ id: 3, method: "tools/list", params: {} });
    expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
    await barrier(run, 99);
    expect(state.order.filter((line) => line.endsWith("@") && !line.startsWith("initialize@"))).toEqual([]); // no call ever went out with no session
    expect(state.opened).toBe(2);
    expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
    expect(state.order.indexOf("notifications/initialized@sess-2")).toBeLessThan(state.order.indexOf("tools/list@sess-2"));
    expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
  });
  // 1.0.21 cause6-v2 round 2 (ASTRA fbb454d706): HTTP 200 is not an open session. An initialize answered with a
  // JSON-RPC error (or with no result) used to mark the session open with no id behind it, and every later call
  // went out with no session for the rest of the turn. The ANSWER decides, exactly as a failed status does.
  describe("an initialize answered HTTP 200 with an error opens nothing", () => {
    const REFUSED = "The server had a problem answering. Try again in a moment.";
    const WRONG = "Nothing at this address answers as an MCP server. Check that you copied the whole link.";
    const SECRET = "upstream words the engine must not get from a reopen";
    const rpcError = (entry: Posted) => ({ jsonrpc: "2.0", id: entry.body.id, error: { code: -32603, message: SECRET } });
    /** Calls that went out with no session (an initialize opens one, so it has none). */
    const sessionless = (order: string[]) => order.filter((line) => line.endsWith("@") && !line.startsWith("initialize@"));
    const reopens = (run: Run) => run.posted.filter((entry) => entry.body.method === "initialize" && isReopen(entry)).length;
    const forms: Array<[string, (entry: Posted) => Answer]> = [
      ["a JSON-RPC error", (entry) => ({ body: JSON.stringify(rpcError(entry)) })],
      ["a JSON-RPC error that also names a session", (entry) => ({ headers: { "mcp-session-id": "sess-bad" }, body: JSON.stringify(rpcError(entry)) })],
      ["a JSON-RPC error in an SSE stream", (entry) => ({ contentType: "text/event-stream", headers: { "mcp-session-id": "sess-bad" }, body: sse(rpcError(entry)) })],
      ["a result that is no object", (entry) => ({ headers: { "mcp-session-id": "sess-bad" }, body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, result: null }) })],
    ];

    for (const [label, form] of forms) {
      it(`X1 a reopen answered 200 with ${label} is a failed open: that call fails alone, nothing goes out without a session, the next call opens one`, async () => {
        let refuse = 0;
        const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) && refuse > 0 && refuse-- ? form(entry) : null);
        const run = await start(answer);
        await connect(run, state.order);
        const before = state.order.length;
        state.live = "revoked";
        refuse = 1;
        run.write({ id: 2, method: "tools/list", params: {} });
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: REFUSED } });
        run.write({ id: 3, method: "tools/list", params: {} });
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
        await barrier(run, 99);
        // the whole wire, in order: the lost call, the probe, the refused open, then ONE new open, its handshake, the call
        expect(state.order.slice(before)).toEqual([
          "tools/list@sess-1", "ping@sess-1", "initialize@",
          "initialize@", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2",
        ]);
        expect(sessionless(state.order)).toEqual([]);
        expect(state.order.filter((line) => line.endsWith("@sess-bad"))).toEqual([]);
        expect(reopens(run)).toBe(2);
        expect(JSON.stringify(run.accepted)).not.toContain(SECRET);
        expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      });
    }

    it("X2 a server that keeps refusing the reopen costs one open per call, never a call without a session, and connects as soon as it accepts", async () => {
      let refusing = true;
      const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) && refusing ? forms[0]![1](entry) : null);
      const run = await start(answer);
      await connect(run, state.order);
      const before = state.order.length;
      state.live = "revoked";
      for (const id of [2, 3, 4]) {
        run.write({ id, method: "tools/list", params: {} });
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id, error: { code: -32000, message: REFUSED } });
        expect(reopens(run)).toBe(id - 1); // bounded: one open for one call, no loop
      }
      refusing = false;
      run.write({ id: 5, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 5, result: tools });
      await barrier(run, 99);
      expect(state.order.slice(before)).toEqual([
        "tools/list@sess-1", "ping@sess-1", "initialize@", "initialize@", "initialize@",
        "initialize@", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2",
      ]);
      expect(sessionless(state.order)).toEqual([]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("X3 a tool call that waited on a refused reopen seals, as it does for a reopen refused by status (design 399), and is never sent without a session", async () => {
      let refuse = 0;
      const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) && refuse > 0 && refuse-- ? forms[0]![1](entry) : null);
      const run = await start(answer);
      await connect(run, state.order);
      const before = run.accepted.length;
      state.live = "revoked";
      refuse = 1;
      const terminal = Promise.race([once(child!, "close"), once(child!.stdout, "data")]);
      run.write({ id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
      await terminal;
      expect(run.accepted.slice(before)).toEqual([]);
      expect(sessionless(state.order)).toEqual([]);
      expect(state.order.slice(state.order.lastIndexOf("tools/call@sess-1"))).toEqual(["tools/call@sess-1", "ping@sess-1", "initialize@"]); // sent once, probed, one refused open, nothing after
      expect(reopens(run)).toBe(1);
      expect(boundProxyState(child!)).toMatchObject({ sealed: true, terminal: sealedProxyRefusal });
    });

    for (const [label, body] of [
      ["an empty body", () => "   "],
      ["an answer to another id", () => JSON.stringify({ jsonrpc: "2.0", id: "someone-else", result: { capabilities: {} } })],
    ] as const) {
      it(`X4 a reopen answered 200 with ${label} is a request nobody answered: the mount is sealed, visibly, and no call goes out without a session`, async () => {
        let hollow = 0;
        const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) && hollow > 0 && hollow-- ? { body: body() } : null);
        const run = await start(answer);
        await connect(run, state.order);
        const before = run.accepted.length;
        state.live = "revoked";
        hollow = 1;
        const terminal = Promise.race([once(child!, "close"), once(child!.stdout, "data")]);
        run.write({ id: 2, method: "tools/list", params: {} });
        await terminal;
        expect(run.accepted.slice(before)).toEqual([]);
        expect(sessionless(state.order)).toEqual([]);
        expect(state.order.at(-1)).toBe("initialize@"); // nothing was sent after the hollow open
        expect(boundProxyState(child!)).toMatchObject({ sealed: true, terminal: sealedProxyRefusal });
      });
    }

    for (const [label, form] of forms.slice(1, 3)) {
      it(`X5 the engine's own initialize answered 200 with ${label} opens nothing: no session id is taken from it, no frame is kept, and the engine's next initialize connects`, async () => {
        let refuse = 1;
        const { state, answer } = harness((entry, method) => method === "initialize" && refuse > 0 && refuse-- ? form(entry) : null);
        const run = await start(answer);
        run.write(hello);
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: SECRET } }); // its own answer, told as it is
        // an engine that calls anyway: no session exists, so none is named and none is opened behind its back
        run.write({ id: 2, method: "tools/list", params: {} });
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: WRONG } });
        run.write({ ...hello, id: 3 });
        expect(await run.next()).toMatchObject({ id: 3, result: { serverInfo: { name: "s" } } });
        run.write({ method: "notifications/initialized" });
        while (!state.order.includes("notifications/initialized@sess-1")) await new Promise((resolve) => setTimeout(resolve, 5));
        run.write({ id: 4, method: "tools/list", params: {} });
        expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 4, result: tools });
        await barrier(run, 99);
        expect(state.order).toEqual(["initialize@", "tools/list@", "initialize@", "notifications/initialized@sess-1", "tools/list@sess-1", "ping@sess-1"]);
        expect(reopens(run)).toBe(0);
        expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      });
    }

    it("X6 the engine's initialize answered as an SSE stream opens its session at the answer, and a lost one is still reopened", async () => {
      const { state, answer } = harness((entry, method, _session, s) => {
        if (method !== "initialize" || isReopen(entry)) return null;
        s.opened += 1;
        s.live = `sess-${s.opened}`;
        const { headers, body } = opened(entry, s.live);
        return { contentType: "text/event-stream", headers, body: sse(JSON.parse(body!)) };
      });
      const run = await start(answer);
      await connect(run, state.order);
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
      await barrier(run, 99);
      expect(state.order).toEqual([
        "initialize@", "notifications/initialized@sess-1", "ping@sess-1",
        "tools/list@sess-1", "ping@sess-1", "initialize@", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2",
      ]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("X7 a reopen answered in an SSE stream the server leaves open is used as soon as its answer arrives", async () => {
      const left: ServerResponse[] = [];
      const { state, answer } = harness((entry, method, _session, s) => {
        if (method !== "initialize" || !isReopen(entry)) return null;
        s.opened += 1;
        s.live = `sess-${s.opened}`;
        const { headers, body } = opened(entry, s.live);
        return { custom: (res) => { left.push(res); res.writeHead(200, { "content-type": "text/event-stream", ...headers }); res.write(sse(JSON.parse(body!))); } };
      });
      const run = await start(answer);
      await connect(run, state.order);
      const before = state.order.length;
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
      await barrier(run, 99);
      expect(state.order.slice(before)).toEqual(["tools/list@sess-1", "ping@sess-1", "initialize@", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2"]);
      expect(left.length).toBe(1);
      for (const res of left) res.end();
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("X10 a server that pings on the reopen's stream and waits for the reply before it answers gets its reply, on the new session", async () => {
      const waiting: { res?: ServerResponse; answer?: string; reply?: unknown } = {};
      const { state, answer } = harness((entry, method, _session, s) => {
        if (method === "initialize" && isReopen(entry)) {
          s.opened += 1;
          s.live = `sess-${s.opened}`;
          const { headers, body } = opened(entry, s.live);
          return { custom: (res) => { waiting.res = res; waiting.answer = body!; res.writeHead(200, { "content-type": "text/event-stream", ...headers }); res.write(sse({ jsonrpc: "2.0", id: "srv-1", method: "ping" })); } };
        }
        if (method === "" && entry.body.id === "srv-1" && waiting.res) {
          waiting.reply = entry.body;
          waiting.res.end(sse(JSON.parse(waiting.answer!))); // the server answers the initialize only now
          return { status: 202 };
        }
        return null;
      });
      const run = await start(answer);
      await connect(run, state.order);
      const before = state.order.length;
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
      await barrier(run, 99);
      expect(waiting.reply).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
      expect(state.order.slice(before)).toEqual(["tools/list@sess-1", "ping@sess-1", "initialize@", "@sess-2", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2"]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    // The two other 2xx answers the proxy reads for itself keep the design's rule (T9, T13): the server answered,
    // so the handshake is spent and the session is alive. Neither can leave a session with nothing behind it.
    it("X8 a replacement's handshake answered 200 with a JSON-RPC error is spent, as an error status is: sent once, the session is used", async () => {
      const { state, answer } = harness((_entry, method, session) => method === "notifications/initialized" && session === "sess-2" ? { body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: SECRET } }) } : null);
      const run = await start(answer);
      await connect(run, state.order);
      const before = state.order.length;
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
      await barrier(run, 99);
      expect(state.order.slice(before)).toEqual(["tools/list@sess-1", "ping@sess-1", "initialize@", "notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2"]);
      expect(JSON.stringify(run.accepted)).not.toContain(SECRET);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    it("X9 a probe answered 200 with a JSON-RPC error means the session is alive: the call fails alone and no session is opened", async () => {
      const { state, answer } = harness((entry, method, session, s) => {
        if (session !== s.live) return null;
        if (method === "prompts/list") return gone;
        return method === "ping" && String(entry.body.id).startsWith("murage-probe-") ? { body: JSON.stringify({ jsonrpc: "2.0", id: entry.body.id, error: { code: -32601, message: SECRET } }) } : null;
      });
      const run = await start(answer);
      await connect(run, state.order);
      const before = state.order.length;
      run.write({ id: 2, method: "prompts/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: GONE } });
      run.write({ id: 3, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
      await barrier(run, 99);
      expect(state.order.slice(before)).toEqual(["prompts/list@sess-1", "ping@sess-1", "tools/list@sess-1", "ping@sess-1"]);
      expect(state.opened).toBe(1);
      expect(JSON.stringify(run.accepted)).not.toContain(SECRET);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });
  });

  // ASTRA cause6-v2 1073bd52ac BLOCK, and the whole class behind it (DESIGN-R3): a fault that arrives late for a session
  // that was superseded, replaced or closed never seals the mount and never changes the live session. Real spawned proxy.
  describe("1.0.21 cause6 r3: only the live session can end the mount", () => {
    const REPLACED = "The server's session was replaced during this call. Try again.";
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** An answer whose headers (an SSE stream, 200) are sent and whose body is held open until the test breaks the socket. */
    const stream = (headers: Record<string, string> = {}, first = ": open\n\n") => {
      let waiting: ServerResponse | null = null;
      let arrived!: () => void;
      const here = new Promise<void>((resolve) => { arrived = resolve; });
      const custom = (res: ServerResponse) => { waiting = res; res.writeHead(200, { "content-type": "text/event-stream", ...headers }); res.write(first); arrived(); };
      return { here, answer: { custom } as Answer, destroy: () => waiting!.socket!.destroy() };
    };
    /** The proxy's stderr so far: its one line per stale continuation is the barrier that the late fault was read. */
    const stderrOf = () => { let text = ""; child!.stderr.on("data", (chunk) => { text += String(chunk); }); return () => text; };
    /** Waits until the proxy has acted on the late fault: it logged the stale site, or (without the fence) it sealed. */
    const acted = async (seen: () => boolean) => { for (let waited = 0; waited < 400 && !seen() && !boundProxyState(child!).sealed && child!.exitCode === null; waited++) await sleep(25); };
    const sealedNow = async () => { for (let waited = 0; waited < 400 && !boundProxyState(child!).sealed; waited++) await sleep(25); return boundProxyState(child!); };
    /** S1 is lost and its reopen (generation 2) is answered by `second`; then the engine initializes (sess-3), sends its
     * handshake, and the call that lost S1 is answered on sess-3. The generation-2 open is now superseded and unanswered. */
    const superseded = async (second: Answer, here: Promise<void>) => {
      const { state, answer } = harness((entry, method) => {
        if (method === "initialize" && isReopen(entry)) return second;
        if (method === "initialize" && entry.body.id === 10) { state.live = "sess-3"; return opened(entry, "sess-3"); }
        return null;
      });
      const run = await start(answer);
      const stderr = stderrOf();
      await connect(run, state.order);
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      await here; // the reopen's initialize is on the wire
      run.write({ ...hello, id: 10 });
      expect(await run.next()).toMatchObject({ id: 10, result: { serverInfo: { name: "s" } } });
      run.write({ method: "notifications/initialized" });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools }); // resent on sess-3, after its handshake
      return { run, state, stderr };
    };
    const healthyOnThree = async (run: Run, state: { order: string[] }) => {
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      run.write({ id: 3, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
      await barrier(run, 99);
      expect(state.order.slice(-2)).toEqual(["tools/list@sess-3", "ping@sess-3"]);
      expect(state.order.filter((line) => line.endsWith("@sess-G2"))).toEqual([]); // the superseded open's id is never used
      expect(count(state.order, "notifications/initialized@sess-3")).toBe(1);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    };

    // ASTRA 1597 as written (:408, and the seal inside the body read under it).
    it("Z1 a superseded reopen whose SSE body breaks late does not seal the engine's healthy session", async () => {
      const second = stream({ "mcp-session-id": "sess-G2" });
      const { run, state, stderr } = await superseded(second.answer, second.here);
      second.destroy();
      await acted(() => stderr().includes("stale reopen-read"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(stderr()).toContain("stale reopen-read");
      await healthyOnThree(run, state);
    });

    // :400, the same class.
    it("Z2 a superseded reopen answered late with a gateway's 503 does not seal the engine's healthy session", async () => {
      const second = held();
      const { run, state, stderr } = await superseded(second.answer, second.here);
      second.release({ status: 503, contentType: "text/html", body: "<html>bad gateway</html>" });
      await acted(() => stderr().includes("stale reopen-status"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(stderr()).toContain("stale reopen-status");
      await healthyOnThree(run, state);
    });

    // The transport's other seal (the POST itself is refused, no headers at all), on the same superseded reopen.
    it("Z9 a superseded reopen whose connection is cut before any answer does not seal the engine's healthy session", async () => {
      let cut!: () => void;
      let arrived!: () => void;
      const here = new Promise<void>((resolve) => { arrived = resolve; });
      const { run, state, stderr } = await superseded({ custom: (res: ServerResponse) => { cut = () => res.socket!.destroy(); arrived(); } }, here);
      cut();
      await acted(() => stderr().includes("stale reopen-post"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(stderr()).toContain("stale reopen-post");
      await healthyOnThree(run, state);
    });

    // :344, the same class.
    it("Z3 a replacement's handshake answered late with a gateway's 503, after the engine initialized, does not seal the engine's session", async () => {
      const shake = held();
      const { state, answer } = harness((entry, method, session) => {
        if (method === "notifications/initialized" && session === "sess-2") return shake.answer;
        if (method === "initialize" && entry.body.id === 10) { state.live = "sess-3"; return opened(entry, "sess-3"); }
        return null;
      });
      const run = await start(answer);
      const stderr = stderrOf();
      await connect(run, state.order);
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      await shake.here; // sess-2 is open and its handshake is on the wire, unanswered
      run.write({ ...hello, id: 10 });
      expect(await run.next()).toMatchObject({ id: 10, result: { serverInfo: { name: "s" } } });
      run.write({ method: "notifications/initialized" });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
      shake.release({ status: 503, contentType: "text/html", body: "<html>bad gateway</html>" });
      await acted(() => stderr().includes("stale handshake"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(stderr()).toContain("stale handshake");
      await healthyOnThree(run, state);
      expect(count(state.order, "notifications/initialized@sess-2")).toBe(1);
    });

    /** `first` is in flight on sess-1 as an open SSE stream. Another call then learns sess-1 is gone (the probe agrees), so
     * sess-1 is closed and its reopen is on the wire, held unanswered. */
    const closedUnderACall = async (first: object) => {
      const body = stream();
      const reopen = held();
      const asked: Posted[] = [];
      const { state, answer } = harness((entry, method, session) => {
        if (entry.body.id === 2 && session === "sess-1") return body.answer;
        if (method === "initialize" && isReopen(entry)) { asked.push(entry); return reopen.answer; }
        return null;
      });
      const run = await start(answer);
      await connect(run, state.order);
      run.write({ id: 2, ...first });
      await body.here; // the first call's answer stream is open on sess-1
      state.live = "revoked";
      run.write({ id: 3, method: "tools/list", params: {} });
      await reopen.here; // sess-1 was confirmed gone and closed; the replacement is not open yet
      return { run, state, body, reopen, asked };
    };

    // A call still in flight on a session that was found gone and is being replaced (:610, and the seal under the body
    // read). The replacement's open has begun, so this is the replaced case; Z8 is the closed-and-nothing-opened case.
    it("Z4 a call still streaming on a session another call found gone fails alone when its stream breaks, exactly once", async () => {
      const { run, state, body, reopen, asked } = await closedUnderACall({ method: "resources/list", params: {} });
      body.destroy();
      const first = await Promise.race([run.next(), once(child!, "close").then(() => ({ closed: true }))]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(first).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: REPLACED } });
      state.live = "sess-2";
      reopen.release(opened(asked[0]!, "sess-2"));
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
      await barrier(run, 99);
      expect(run.accepted.filter((frame) => frame.id === 2)).toHaveLength(1);
      expect(state.order.slice(-3)).toEqual(["notifications/initialized@sess-2", "tools/list@sess-2", "ping@sess-2"]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    // Guard (design 399): the same late break on a TOOL call is an unknown outcome and still seals.
    it("Z5 a tool call still streaming on a session another call found gone still seals when its stream breaks", async () => {
      const { run, body } = await closedUnderACall({ method: "tools/call", params: { name: "echo", arguments: {} } });
      body.destroy();
      expect(await sealedNow()).toMatchObject({ sealed: true, terminal: sealedProxyRefusal });
      expect(run.accepted.filter((frame) => frame.id === 2)).toEqual([]);
    });

    // Guard (fail closed): the CURRENT generation's own fault still seals.
    it("Z6 the current reopen's own body breaking still seals the mount", async () => {
      const second = stream({ "mcp-session-id": "sess-G2" });
      const { state, answer } = harness((entry, method) => method === "initialize" && isReopen(entry) ? second.answer : null);
      const run = await start(answer);
      await connect(run, state.order);
      const before = run.accepted.length;
      state.live = "revoked";
      run.write({ id: 2, method: "tools/list", params: {} });
      await second.here;
      second.destroy();
      expect(await sealedNow()).toMatchObject({ sealed: true, terminal: sealedProxyRefusal });
      expect(run.accepted.slice(before)).toEqual([]);
    });

    // A session closed by its own answer, with nothing opened after it (the fence is the close, not only a newer open).
    it("Z8 an engine initialize the server answered with an error, on a stream that then breaks, does not seal: the next initialize connects", async () => {
      const refused = stream({ "mcp-session-id": "sess-refused" }, `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "not now" } })}\n\n`);
      const { state, answer } = harness((entry, method) => method === "initialize" && entry.body.id === 1 ? refused.answer : null);
      const run = await start(answer);
      const stderr = stderrOf();
      run.write(hello);
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "not now" } }); // told as it is; nothing is open
      refused.destroy();
      await acted(() => stderr().includes("stale stream-read"));
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(stderr()).toContain("stale stream-read");
      run.write({ ...hello, id: 3 });
      expect(await run.next()).toMatchObject({ id: 3, result: { serverInfo: { name: "s" } } });
      run.write({ method: "notifications/initialized" });
      while (!state.order.includes("notifications/initialized@sess-1")) await sleep(5);
      run.write({ id: 4, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 4, result: tools });
      await barrier(run, 99);
      expect(state.order.filter((line) => line.endsWith("@sess-refused"))).toEqual([]);
      expect(run.accepted.filter((frame) => frame.id === 1)).toHaveLength(1);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });

    // :482/:610 on the engine's own open.
    it("Z7 an engine initialize that a second one superseded gets its own error when its stream breaks; the second session lives", async () => {
      const first = stream({ "mcp-session-id": "sess-old" });
      const { state, answer } = harness((entry, method) => method === "initialize" && entry.body.id === 1 ? first.answer : null);
      const run = await start(answer);
      run.write(hello);
      await first.here; // the first initialize's answer stream is open
      run.write({ ...hello, id: 10 });
      expect(await run.next()).toMatchObject({ id: 10, result: { serverInfo: { name: "s" } } });
      run.write({ method: "notifications/initialized" });
      while (!state.order.includes("notifications/initialized@sess-1")) await sleep(5);
      first.destroy();
      const late = await Promise.race([run.next(), once(child!, "close").then(() => ({ closed: true }))]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
      expect(late).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: REPLACED } });
      run.write({ id: 3, method: "tools/list", params: {} });
      expect(await run.next()).toEqual({ jsonrpc: "2.0", id: 3, result: tools });
      await barrier(run, 99);
      expect(run.accepted.filter((frame) => frame.id === 1)).toHaveLength(1);
      expect(state.order.filter((line) => line.endsWith("@sess-old"))).toEqual([]);
      expect(state.order.slice(-2)).toEqual(["tools/list@sess-1", "ping@sess-1"]);
      expect(boundProxyState(child!)).toMatchObject({ sealed: false, refusals: 0 });
    });
  });
});
