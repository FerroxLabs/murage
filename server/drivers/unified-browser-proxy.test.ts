// control migration: real bound proxy ingress; existing assertions retained.
// The browser proxy is the only thing between Murage's browser refusal and the
// engine. It must hand Murage's own reason on (a protected page, the owner
// holding control) and still never forward an arbitrary server error, which
// could carry text from a page.
import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
import { spawnBoundProxy, boundProxyState, boundTerminalReason } from "../testing/bound-proxy-fixture.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const PROXY = fileURLToPath(new URL("./unified-browser-proxy.ts", import.meta.url));
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve)); });

/** A stand-in for the server route: answers every RPC with one fixed reply. */
async function route(status: number, body: unknown): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Run the proxy over stdio exactly as an engine does and collect replies. */
async function exchange(base: string, requests: unknown[], terminal = false, reasons: unknown[] = []): Promise<any[]> {
  const child = await spawnBoundProxy("unifiedBrowser", process.execPath, [PROXY], {
    env: { PATH: process.env.PATH, MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "bot", MURAGE_THREAD_ID: "thread" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  let accepted: () => void = () => {};
  const delivered = new Promise<void>(resolve => { accepted = resolve; });
  child.stdout.on("data", (chunk) => { output += chunk; if (output.trim().split("\n").filter(Boolean).length === requests.length) accepted(); });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  // Keep the engine request alive until the proxy seals it. Closing stdin
  // here would test EOF instead of the route failure under examination.
  if (terminal) {
    await new Promise((resolve) => child.once("close", resolve));
    // MAIN RULING INT-CONFLICT-DEFAULT 6a9dfe7db8: require the authenticated terminal refusal as well as zero ordinary output.
    expect(boundProxyState(child)).toEqual({ sealed: true, refusals: 1, terminal: { jsonrpc: "2.0", id: null, error: { code: -32099, message: LEDGER_REFUSAL_LINE, data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } });
    reasons.push(boundTerminalReason(child));
  } else {
    await delivered;
    expect(boundProxyState(child)).toEqual({ sealed: false, refusals: 0 });
    const closed = new Promise(resolve => child.once("close", resolve)); child.kill(); await closed;
  }
  return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const PROTECTED = "Murage's browser is protecting this page because the owner typed or clicked in it.";

// control: a recognized policy refusal is gated application output, not a
// transport-loss fallback (§12.1 H1a-EXEMPT, design line 401).
it("passes Murage's own refusal to the bot word for word", async () => {
  const base = await route(409, { error: PROTECTED, code: "browser_protected_owner_input" });
  const [call] = await exchange(base, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_snapshot" } }]);
  expect(call.result).toEqual({ isError: true, code: "browser_protected_owner_input", content: [{ type: "text", text: PROTECTED }] });
});

it("answers a failed tool listing with an error that says why, not a result with no tools in it", async () => {
  const base = await route(409, { error: "This turn can no longer use the browser.", code: "browser_not_authorized" });
  const [listing] = await exchange(base, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  expect(listing.result).toBeUndefined();
  expect(listing.error).toMatchObject({ message: "This turn can no longer use the browser." });
});

it("never forwards a server error Murage did not write for the bot", async () => {
  const base = await route(500, { error: "strict mode violation: <input value=\"page secret\">" });
  const replies = await exchange(base, [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_browser_snapshot" } }], true);
  expect(JSON.stringify(replies)).not.toContain("page secret");
  expect(replies).toEqual([]);
});

// MACMOUNTS-1020 (Mac 12:33Z: "type=turn-release-terminal keys=type,instanceId,frame", no cause): the terminal names its first refusing check.
it("MACMOUNTS-REASON: a tool listing the server answered with an uncoded 500 seals with reason tools-list:http-500", async () => {
  const base = await route(500, { error: "engine said <secret page text>" });
  const reasons: unknown[] = [];
  const replies = await exchange(base, [{ jsonrpc: "2.0", id: 4, method: "tools/list" }], true, reasons);
  expect(replies).toEqual([]);
  expect(reasons).toEqual(["tools-list:http-500"]);
});

it("MACMOUNTS-REASON: a server that is not listening seals with the connection code, before any server log could exist", async () => {
  const base = await route(200, {});
  await new Promise((resolve) => servers.pop()!.close(resolve));
  const reasons: unknown[] = [];
  await exchange(base, [{ jsonrpc: "2.0", id: 5, method: "tools/list" }], true, reasons);
  expect(reasons).toEqual(["fetch:econnrefused"]);
});
