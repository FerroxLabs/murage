import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { waitForExit } from "../server/testing/cleanup.ts";
import { permittedProofPermission } from "./fuigo-proof-proxy.mjs";

let child;
let directory;

it("approves only pinned discovery and exact fixture calls, never shell or arbitrary MCP work", () => {
  const call = (name, rawInput) => ({ _meta: { "fuigo/tool": { version: 1, name } }, rawInput });
  expect(permittedProofPermission(call("search_tool", { variant: "SearchTool", query: "agents list_bots", limit: 12 }), "read", "target")).toBe("search_tool");
  const read = call("use_tool", { variant: "UseTool", tool_name: "agents__list_bots", tool_input: {} });
  expect(permittedProofPermission(read, "read", "target")).toBe("list_bots");
  const ask = call("use_tool", { variant: "UseTool", tool_name: "agents__ask_bot", tool_input: { bot_id: "target", message: "Fixture approval cancellation proof" } });
  expect(permittedProofPermission(ask, "read", "target")).toBeNull();
  expect(permittedProofPermission(ask, "approval", "different-target")).toBeNull();
  expect(permittedProofPermission(ask, "approval", "target")).toBe("ask_bot");
  expect(permittedProofPermission(call("bash", { variant: "Bash", command: "echo unsafe" }), "read", "target")).toBeNull();
  expect(permittedProofPermission(call("use_tool", { variant: "UseTool", tool_name: "agents__create_bot", tool_input: {} }), "approval", "target")).toBeNull();
  expect(permittedProofPermission({ title: "agents__list_bots", rawInput: {} }, "read", "target")).toBeNull();
  expect(permittedProofPermission(read, "unknown", "target")).toBeNull();
});
afterEach(async () => {
  if (child) {
    child.stdin.end();
    await waitForExit(child, 2_000);
    child = undefined;
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function start() {
  directory = mkdtempSync(join(tmpdir(), "murage-proof-proxy-"));
  const realPath = join(directory, "real.mjs");
  const evidencePath = join(directory, "evidence.ndjson");
  const phasePath = join(directory, "phase");
  const callsPath = join(directory, "forwarded.jsonl");
  writeFileSync(realPath, `
    import {createInterface} from 'node:readline';
    import {appendFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.id===undefined) return;
      if(request.method==='tools/call') appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(request.params.name)+'\\n');
      const result=request.method==='tools/list'
        ? {tools:[{name:'list_bots'},{name:'ask_bot'},{name:process.env.FAKE_SECRET}]}
        : {content:[{type:'text',text:'- Synthetic [id: fixture-peer, model: fake] '+process.env.FAKE_SECRET}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });
  `);
  const wrapper = join(directory, "wrapper.mjs");
  writeFileSync(wrapper, `import {runProxy} from ${JSON.stringify(new URL("./fuigo-proof-proxy.mjs", import.meta.url).href)}; await runProxy(${JSON.stringify({ realPath, evidencePath, phasePath })});`);
  child = spawn(process.execPath, [wrapper], {
    env: { PATH: process.env.PATH, FAKE_SECRET: "fake-private-value" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    waiting.get(response.id)?.(response);
    waiting.delete(response.id);
  });
  const request = (id, method, name) => new Promise(resolve => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { name, arguments: { unused: "fake-private-value" } } }) + "\n");
  });
  return { request, phasePath, callsPath, evidencePath };
}

it("tees catalog and real results without recording credentials or arguments", async () => {
  const fixture = start();
  writeFileSync(fixture.phasePath, "read");
  await fixture.request(1, "tools/list");
  const result = await fixture.request(2, "tools/call", "list_bots");
  expect(result.result.content[0].text).toContain("fixture-peer");
  expect((await fixture.request(3, "tools/call", "fake-private-value")).result.isError).toBe(true);
  const evidence = readFileSync(fixture.evidencePath, "utf8");
  expect(evidence).not.toContain("fake-private-value");
  expect(evidence).not.toContain("arguments");
  const events = evidence.split("\n").filter(Boolean).map(JSON.parse);
  expect(events[0]).toMatchObject({ type: "proxy_start", pid: expect.any(Number), childPid: expect.any(Number) });
  expect(events.filter(event => event.type !== "proxy_start")).toEqual([
    { type: "catalog", names: ["list_bots", "ask_bot"], unexpectedCount: 1 },
    { type: "call", name: "list_bots" },
    { type: "result", name: "list_bots", isError: false, peers: [{ id: "fixture-peer" }] },
    { type: "unexpected_call" },
  ]);
  expect(readFileSync(fixture.callsPath, "utf8")).toBe('"list_bots"\n');
});

it("defaults closed and reads the current phase before forwarding calls", async () => {
  const fixture = start();
  expect((await fixture.request(1, "tools/call", "list_bots")).result.isError).toBe(true);
  writeFileSync(fixture.phasePath, "read");
  expect((await fixture.request(2, "tools/call", "ask_bot")).result.isError).toBe(true);
  writeFileSync(fixture.phasePath, "approval");
  expect((await fixture.request(3, "tools/call", "ask_bot")).result.isError).toBeUndefined();
  expect((await fixture.request(4, "tools/call", "create_bot")).result.isError).toBe(true);
  expect(readFileSync(fixture.callsPath, "utf8")).toBe('"ask_bot"\n');
});
