// SPDX-License-Identifier: AGPL-3.0-or-later
// U37 (audit 05-3): the browser MCP proxy runs requests side by side and passes the client's notifications/cancelled to the
// request it names (its HTTP call is aborted and no reply is written for it, as MCP asks).
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runBrowserExtensionMcp } from "./browser-extension-mcp.ts";

const config = { endpoint: "http://127.0.0.1:12345/api/browser-extension/mcp", clientId: "paired_client", token: "a".repeat(43) };
const call = (id: number | string) => JSON.stringify({ id, method: "tools/call", params: { name: "agent_browser_snapshot", arguments: {} } }) + "\n";
const until = async (check: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await new Promise(resolve => setTimeout(resolve, 5)); } return true; };

function proxy() {
  const input = new PassThrough();
  const replies: Array<{ id: unknown; result?: unknown; error?: unknown }> = [];
  let buffered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { buffered += chunk.toString(); for (let i; (i = buffered.indexOf("\n")) >= 0;) { replies.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1); } callback(); } });
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      releases.push(() => resolve(Response.json({ content: [{ type: "text", text: "observed" }] })));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const done = runBrowserExtensionMcp({ config, input, output, fetch: fetcher as unknown as typeof fetch });
  return { input, replies, signals, releases, done };
}

describe("browser MCP proxy: parallel requests and client cancellation", () => {
  it("a later request is answered while an earlier one is still waiting on the browser", async () => {
    const p = proxy();
    p.input.write(call(1));
    expect(await until(() => p.signals.length === 1)).toBe(true);
    p.input.write(JSON.stringify({ id: 2, method: "ping" }) + "\n");
    p.input.write(call(3));
    expect(await until(() => p.replies.some(reply => reply.id === 2))).toBe(true);
    expect(await until(() => p.signals.length === 2)).toBe(true);
    expect(p.replies.some(reply => reply.id === 1)).toBe(false);
    p.releases[1]!();
    expect(await until(() => p.replies.some(reply => reply.id === 3))).toBe(true);
    p.releases[0]!();
    p.input.end();
    await p.done;
    expect(p.replies.map(reply => reply.id).sort()).toEqual([1, 2, 3]);
  });

  it("notifications/cancelled aborts the named request's HTTP call and no reply is written for it", async () => {
    const p = proxy();
    p.input.write(call("a"));
    p.input.write(call("b"));
    expect(await until(() => p.signals.length === 2)).toBe(true);
    p.input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "a", reason: "user stopped" } }) + "\n");
    expect(await until(() => p.signals[0]!.aborted)).toBe(true);
    expect(p.signals[1]!.aborted).toBe(false);
    p.releases[1]!();
    p.input.end();
    await p.done;
    expect(p.replies.map(reply => reply.id)).toEqual(["b"]);
  });

  it("a cancel naming a different id type or an unknown id changes nothing", async () => {
    const p = proxy();
    p.input.write(call(7));
    expect(await until(() => p.signals.length === 1)).toBe(true);
    p.input.write(JSON.stringify({ method: "notifications/cancelled", params: { requestId: "7" } }) + "\n");
    p.input.write(JSON.stringify({ method: "notifications/cancelled", params: { requestId: 8 } }) + "\n");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(p.signals[0]!.aborted).toBe(false);
    p.releases[0]!();
    p.input.end();
    await p.done;
    expect(p.replies.map(reply => reply.id)).toEqual([7]);
  });
});
