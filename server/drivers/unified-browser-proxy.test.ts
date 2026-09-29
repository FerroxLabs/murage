// The browser proxy is the only thing between Murage's browser refusal and the
// engine. It must hand Murage's own reason on (a protected page, the owner
// holding control) and still never forward an arbitrary server error, which
// could carry text from a page.
import { spawn } from "node:child_process";
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
async function exchange(base: string, requests: unknown[], extraEnv: Record<string, string> = {}): Promise<any[]> {
  const child = spawn(process.execPath, [PROXY], {
    env: { PATH: process.env.PATH, MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "bot", MURAGE_THREAD_ID: "thread", ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const PROTECTED = "Murage's browser is protecting this page because the owner typed or clicked in it.";

it("passes Murage's own refusal to the bot word for word", async () => {
  const base = await route(409, { error: PROTECTED, code: "browser_protected_owner_input" });
  const [call] = await exchange(base, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_snapshot" } }]);
  expect(call.result).toEqual({ isError: true, content: [{ type: "text", text: PROTECTED }] });
});

it("names the browser's own tools in its refusal the way Fuigo and Grok call them", async () => {
  const reason = "You can leave it by calling agent_browser_open with a different address.";
  const base = await route(409, { error: reason, code: "browser_protected_sensitive_page" });
  const call = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agent_browser_snapshot" } };
  expect((await exchange(base, [call]))[0].result.content[0].text).toBe(reason);
  expect((await exchange(base, [call], { MURAGE_TOOL_CALL_STYLE: "use-tool", MURAGE_MCP_SERVER_NAME: "browser" }))[0].result.content[0].text)
    .toBe('You can leave it by calling use_tool with tool_name "browser__agent_browser_open" with a different address.');
});

it("answers a failed tool listing with an error that says why, not a result with no tools in it", async () => {
  const base = await route(409, { error: "This turn can no longer use the browser.", code: "browser_not_authorized" });
  const [listing] = await exchange(base, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  expect(listing.result).toBeUndefined();
  expect(listing.error).toMatchObject({ message: "This turn can no longer use the browser." });
});

it("never forwards a server error Murage did not write for the bot", async () => {
  const base = await route(500, { error: "strict mode violation: <input value=\"page secret\">" });
  const [call] = await exchange(base, [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_browser_snapshot" } }]);
  expect(JSON.stringify(call)).not.toContain("page secret");
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0].text).toContain("Browser unavailable");
});
