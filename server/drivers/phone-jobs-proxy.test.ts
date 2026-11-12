import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMcpCatalog } from "../mcp-listed.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone-jobs MCP proxy lists exactly the tools its launch names and forwards a call to the harness with the device token.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import { phoneToolDefinitions, toolsFromEnv } from "./phone-jobs-proxy.ts";

const PROXY = fileURLToPath(new URL("./phone-jobs-proxy.ts", import.meta.url));
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve)); });

async function route(status: number, reply: unknown, seen: Array<{ auth: string | undefined; path: string | undefined; body: any }> = []): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { seen.push({ auth: req.headers.authorization, path: req.url, body: raw ? JSON.parse(raw) : null }); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function exchange(base: string, tools: string | undefined, requests: unknown[], marker?: string): Promise<any[]> {
  const child = spawn(process.execPath, [PROXY], {
    windowsHide: true,
    env: { PATH: process.env.PATH, ...(marker ? { MURAGE_MCP_LISTED_FILE: marker } : {}), MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "device-token", ...(tools === undefined ? {} : { MURAGE_PHONE_TOOLS: tools }) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const lines = () => output.trim().split("\n").filter(Boolean);
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  // like an engine, keep the pipe open until every request is answered: closing it withdraws what is in flight
  for (let waited = 0; lines().length < requests.length && waited < 10000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  return lines().map((line) => JSON.parse(line));
}

describe("phone-jobs proxy", () => {
  it("lists exactly the tools in MURAGE_PHONE_TOOLS and nothing else", async () => {
    const base = await route(200, {});
    const [listing] = await exchange(base, "phone_calendar_read,phone_location_get", [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(listing.result.tools.map((t: any) => t.name)).toEqual(["phone_calendar_read", "phone_location_get"]);
    for (const tool of listing.result.tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
    const [none] = await exchange(base, "", [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    expect(none.result.tools).toEqual([]);
    const [unknown] = await exchange(base, "phone_calendar_read,tap,read_screen,phone_made_up", [{ jsonrpc: "2.0", id: 3, method: "tools/list" }]);
    expect(unknown.result.tools.map((t: any) => t.name)).toEqual(["phone_calendar_read"]);
  });

  it("forwards a listed call with the device token and returns the harness text", async () => {
    const seen: Array<{ auth: string | undefined; path: string | undefined; body: any }> = [];
    const base = await route(200, { ok: true, text: "{\"phone\":\"P\",\"result\":{}}" }, seen);
    const args = { start: "2026-10-01T09:00:00Z", end: "2026-10-02T09:00:00Z" };
    const [call] = await exchange(base, "phone_calendar_read", [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "phone_calendar_read", arguments: args } }]);
    expect(seen).toEqual([{ auth: "Bearer device-token", path: "/api/internal/device/call", body: { tool: "phone_calendar_read", args } }]);
    expect(call.result).toEqual({ content: [{ type: "text", text: "{\"phone\":\"P\",\"result\":{}}" }] });
  });

  it("never forwards a tool outside the launch list, and marks a harness refusal as an error", async () => {
    const seen: Array<{ auth: string | undefined; path: string | undefined; body: any }> = [];
    const base = await route(200, { ok: false, code: "refused", text: "That phone tool is not available in this conversation." }, seen);
    const [outside, refused] = await exchange(base, "phone_calendar_read", [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "phone_call_dial", arguments: { number: "5551234" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "phone_calendar_read", arguments: {} } },
    ]);
    expect(outside.result.isError).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].body.tool).toBe("phone_calendar_read");
    expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: "That phone tool is not available in this conversation." }] });
  });

  it("answers a harness failure with a plain error and no detail", async () => {
    const base = await route(401, { error: "secret detail" });
    const [call] = await exchange(base, "phone_calendar_read", [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "phone_calendar_read", arguments: {} } }]);
    expect(call.result.isError).toBe(true);
    expect(JSON.stringify(call)).not.toContain("secret detail");
  });

  it("builds a definition for every known tool", () => {
    expect(phoneToolDefinitions(PHONE_TOOL_NAMES).map((t) => t.name)).toEqual([...PHONE_TOOL_NAMES]);
    expect(toolsFromEnv("phone_call_dial, phone_calendar_read,phone_call_dial")).toEqual(["phone_calendar_read", "phone_call_dial"]);
    expect(toolsFromEnv(undefined)).toEqual([]);
  });
});

it("c11-marker-writers phoneJobs publishes its served list but never a tool call", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-phone-")), "generation.phone");
  const base = await route(200, { ok: true, text: "fixture" });
  await exchange(base, "phone_calendar_read", [{ id: 1, method: "tools/call", params: { name: "phone_calendar_read" } }], marker);
  expect(readMcpCatalog(marker)).toBeUndefined();
  const answers = await exchange(base, "phone_calendar_read", [{ id: 1, method: "initialize" }, { id: 2, method: "tools/list" }], marker);
  expect(readMcpCatalog(marker)).toMatchObject({ complete: true, resources: false, tools: answers[1].result.tools.map((tool: any) => tool.name) });
});

it("c11-cancel phoneJobs: a cancelled tools/list gets no answer and its chain leaves the active set, so the next list certifies", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "c11-phone-cancel-")), "generation.phone");
  const base = await route(200, { ok: true, text: "fixture" });
  const child = spawn(process.execPath, [PROXY], {
    env: { PATH: process.env.PATH, MURAGE_MCP_LISTED_FILE: marker, MURAGE_CONTROL_URL: base, MURAGE_CONTROL_TOKEN: "device-token", MURAGE_PHONE_TOOLS: "phone_calendar_read" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
  const lines = () => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // the request and its withdrawal arrive together, before the proxy has started on it
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  for (let waited = 0; lines().length < 1 && waited < 10000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.stdin.end(); await new Promise((resolve) => child.once("close", resolve));
  expect(lines().map((frame) => frame.id)).toEqual([2]);
  expect(readMcpCatalog(marker)).toMatchObject({ complete: true, tools: ["phone_calendar_read"] });
});
