// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { askerWakePrompt } from "../asker-wake.ts";
import { continuationResultsPrompt } from "../project-prompt.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";

// Drive the actual scripted engine over ACP, with a recording MCP server.
// Completion of each prompt is the barrier: wakes arrive after the assignment,
// in separate groups, including after a process restart and session/load.
// This tests the fake's behaviour without depending on scheduler timing.
it.each(["resident", "reloaded"])("batch chief consumes result wakes without assigning again (%s)", async lifecycle => {
  const home = mkdtempSync(join(tmpdir(), "murage-batch-script-"));
  const log = join(home, "calls.jsonl");
  const mcp = join(home, "recording-mcp.mjs");
  writeFileSync(log, "");
  writeFileSync(mcp, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      let result = {};
      if (msg.method === 'tools/call') {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg.params) + '\\n');
        const text = msg.params.name === 'list_bots'
          ? Array.from({length:8}, (_, i) => '- Batch helper ' + i + ' (id: helper-' + i + ')').join('\\n')
          : 'Delegation queued';
        result = { content: [{type:'text', text}] };
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, result}) + '\\n');
    });
  `);
  let child: ChildProcessWithoutNullStreams | undefined;
  let frames: any[] = [];
  let nextId = 0;
  const start = () => {
    frames = [];
    let pending = "";
    child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), FAKE_ACP_MODE: "batch-delegate" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        frames.push(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
    });
  };
  const rpc = async (method: string, params: object) => {
    const id = ++nextId;
    child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 5000 }).toBeTruthy();
    const response = frames.find(frame => frame.id === id);
    expect(response.error).toBeUndefined();
    return response.result;
  };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const mcpServers = [{ name: "agents", command: process.execPath, args: [mcp], env: [] }];
  try {
    start();
    await rpc("initialize", { protocolVersion: 1 });
    const { sessionId } = await rpc("session/new", { cwd: home, mcpServers });
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Assign the eight helpers" }] });
    const initialCalls = calls();
    expect(initialCalls.map(call => call.name)).toEqual(["list_bots", ...Array(8).fill("delegate_bot")]);
    expect(initialCalls.slice(1).map(call => call.arguments)).toEqual(Array.from({ length: 8 }, (_, i) => ({ bot_id: `helper-${i}`, message: `batch work ${i}` })));
    if (lifecycle === "reloaded") {
      await waitForExit(child!, { signal: "SIGTERM" });
      start();
      await rpc("initialize", { protocolVersion: 1 });
      await rpc("session/load", { sessionId, cwd: home, mcpServers });
    }
    for (const indices of [[0], [1, 2, 3], [4, 5, 6, 7]]) {
      const wake = askerWakePrompt(indices.map(i => ({ taskId: `task-${i}`, toBotId: `helper-${i}`, toBotName: `Batch helper ${i}`, ok: i !== 7 })));
      // A rebuilt prompt can carry the original assignment in its history.
      const text = `Earlier user message: Assign the eight helpers\n${wake}`;
      const from = frames.length;
      await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      expect(calls()).toEqual(initialCalls);
      expect(frames.slice(from).some(frame => frame.params?.update?.content?.text === "BATCH RESUMED: read the teammates' replies")).toBe(true);
    }
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 30_000);

it.each(["delegate-peer", "ask-peer-resume", "create-peer"])("%s distinguishes replayed handoff words from the actual wake", async mode => {
  const home = mkdtempSync(join(tmpdir(), "murage-wake-script-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    windowsHide: true,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, FAKE_ACP_MODE: mode,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = [];
  let pending = "", nextId = 0;
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      frames.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  const rpc = async (method: string, params: object) => {
    const id = ++nextId, from = frames.length;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 5000 }).toBeTruthy();
    expect(frames.find(frame => frame.id === id).error).toBeUndefined();
    return { result: frames.find(frame => frame.id === id).result,
      text: frames.slice(from).map(frame => frame.params?.update?.content?.text ?? "").join("") };
  };
  try {
    await rpc("initialize", { protocolVersion: 1 });
    const { result: { sessionId } } = await rpc("session/new", { cwd: home, mcpServers: [] });
    const history = "Room history: you handed off an earlier task.\nHelper replied to that earlier task.\nOwner: start a fresh assignment.";
    const fresh = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: history }] });
    expect(fresh.text).not.toContain("LEAD RESUMED");
    const wake = askerWakePrompt([{ taskId: "fixture-task", toBotId: "fixture-helper", toBotName: "Fixture helper", ok: true }]);
    const resumed = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: `${history}\n${wake}` }] });
    expect(resumed.text).toBe("LEAD RESUMED: finished with the teammate's reply");
    if (mode === "delegate-peer") {
      const roomWake = continuationResultsPrompt(true, [{ botName: "Fixture helper", state: "done" }]);
      const freshRoom = `Earlier room result:\n${roomWake}\nOwner: a fresh assignment.\n(Reply to the conversation above as Fixture lead.)`;
      const fresh = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: freshRoom }] });
      expect(fresh.text).not.toContain("LEAD RESUMED");
      const resumed = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: `${freshRoom}\n\n${roomWake}` }] });
      expect(resumed.text).toBe("LEAD RESUMED: finished with the teammate's reply");
    }
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 20_000);

it("C11 session readiness waits for a held catalog before reporting its prompt count", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-catalog-script-"));
  const gate = join(root, "catalog-gate"), log = join(root, "rpc.jsonl");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    windowsHide: true,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      FAKE_ACP_MODE: "c11-budget", FAKE_C11_LOG: log,
      FAKE_C11_SPEC: JSON.stringify({ catalogs: { agents: ["fixture_tool"] }, native: 1, limit: 40, awaitCatalogExit: true, heldMount: "agents", markerGate: gate }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = [];
  let pending = "";
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      frames.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
    }
  });
  const send = (id: number, method: string, params: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  try {
    send(1, "initialize", { protocolVersion: 1 });
    await expect.poll(() => frames.find(frame => frame.id === 1), { timeout: 5000 }).toBeTruthy();
    send(2, "session/new", { cwd: root, mcpServers: [{ name: "agents", command: process.execPath, args: [], env: [{ name: "MURAGE_MCP_LISTED_FILE", value: join(root, "listed") }] }] });
    // The following response is a stdio barrier: session/new was handled first.
    send(3, "fixture/barrier", {});
    await expect.poll(() => frames.find(frame => frame.id === 3), { timeout: 5000 }).toBeTruthy();
    expect(frames.find(frame => frame.id === 2)).toBeUndefined();
    writeFileSync(gate, "release");
    await expect.poll(() => frames.find(frame => frame.id === 2), { timeout: 5000 }).toBeTruthy();
    const sessionId = frames.find(frame => frame.id === 2).result.sessionId;
    send(4, "session/prompt", { sessionId, prompt: [{ type: "text", text: "fixture only" }] });
    await expect.poll(() => frames.find(frame => frame.id === 4), { timeout: 5000 }).toBeTruthy();
    const rows = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.event === "catalog")).toMatchObject([{ names: ["fixture_tool"] }]);
    expect(rows.find(row => row.event === "prompt")).toMatchObject({ count: 2, visible: ["agents_fixture_tool"] });
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(root);
  }
});

it.each([true, false])("named peer asks ignore a distractor before the requested bot (distractor first=%s)", async distractorFirst => {
  const home = mkdtempSync(join(tmpdir(), "murage-named-peer-")), log = join(home, "calls.jsonl"), mcp = join(home, "recording-mcp.mjs");
  const roster = ["- Sam [id: distractor, model: fixture]", "- Iris [id: requested-peer, model: fixture]"];
  if (!distractorFirst) roster.reverse();
  writeFileSync(log, "");
  writeFileSync(mcp, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line); if (msg.id === undefined) return;
      let result = {};
      if (msg.method === 'tools/call') {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg.params) + '\\n');
        result = { content: [{ type:'text', text: msg.params.name === 'list_bots' ? ${JSON.stringify(roster.join("\n"))} : 'requested peer reply' }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result }) + '\\n');
    });
  `);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "ask-peer",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = []; let pending = "", nextId = 0;
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) { const end = pending.indexOf("\n"); if (end < 0) break; frames.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); }
  });
  const rpc = async (method: string, params: object) => {
    const id = ++nextId; child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 5000 }).toBeTruthy();
    const response = frames.find(frame => frame.id === id); expect(response.error).toBeUndefined(); return response.result;
  };
  try {
    await rpc("initialize", { protocolVersion: 1 });
    const { sessionId } = await rpc("session/new", { cwd: home, mcpServers: [{ name: "agents", command: process.execPath, args: [mcp], env: [] }] });
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Ask Iris to reply." }] });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => call.name)).toEqual(["list_bots", "ask_bot"]);
    expect(calls[1].arguments).toEqual({ bot_id: "requested-peer", message: "ping from fake" });
    expect(frames.some(frame => frame.params?.update?.content?.text === "peer says: requested peer reply")).toBe(true);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }
});
