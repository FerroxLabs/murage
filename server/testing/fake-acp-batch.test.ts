// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { askerWakePrompt } from "../asker-wake.ts";
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
