// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

// The scripted engine gives up on a tool call after FAKE_ACP_MCP_TIMEOUT_MS, as a real engine's tool timeout does.
// A relay connection stays open after that, so the abandoned call's answer can still arrive: it must start nothing.
it("a tool call the scripted engine gave up on starts no later call when its answer arrives late", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-mcp-timeout-"));
  const log = join(home, "calls.jsonl");
  // named like the relay shim: the engine keeps that connection open after a timeout
  const mcp = join(home, "cli-mount-shim.mjs");
  writeFileSync(log, "");
  writeFileSync(mcp, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    const note = row => appendFileSync(${JSON.stringify(log)}, JSON.stringify(row) + '\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      const answer = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, result}) + '\\n');
      if (msg.method !== 'tools/call') return answer({});
      note({ call: msg.params.name });
      if (msg.params.name !== 'list_bots') return answer({ content: [{type:'text', text:'Delegation queued'}] });
      // answered long after the engine's tool timeout; whatever the engine sends next is recorded before "settled"
      setTimeout(() => {
        answer({ content: [{type:'text', text:'- Late helper (id: helper-late)'}] });
        note({ answeredLate: true });
        setTimeout(() => note({ settled: true }), 1500);
      }, 1200);
    });
  `);
  let child: ChildProcessWithoutNullStreams | undefined;
  const frames: any[] = [];
  let nextId = 0;
  const rpc = async (method: string, params: object) => {
    const id = ++nextId;
    child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect.poll(() => frames.find(frame => frame.id === id), { timeout: 5000 }).toBeTruthy();
    const response = frames.find(frame => frame.id === id);
    expect(response.error).toBeUndefined();
    return response.result;
  };
  const rows = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  try {
    let pending = "";
    child = spawn(process.execPath, [fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), FAKE_ACP_MODE: "chief-delegate", FAKE_ACP_MCP_TIMEOUT_MS: "300" },
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
    await rpc("initialize", { protocolVersion: 1 });
    const { sessionId } = await rpc("session/new", { cwd: home, mcpServers: [{ name: "agents", command: process.execPath, args: [mcp], env: [] }] });
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "ASSIGN_TO_PEER" }] });
    // the turn went on at the timeout, before the tool answered
    expect(frames.some(frame => frame.params?.update?.content?.text === "delegate error: mcp timeout")).toBe(true);
    expect(rows()).toEqual([{ call: "list_bots" }]);
    // the late answer reaches the still-open connection, and no second call follows it
    await expect.poll(() => rows().some(row => row.settled === true), { timeout: 10_000 }).toBe(true);
    expect(rows()).toEqual([{ call: "list_bots" }, { answeredLate: true }, { settled: true }]);
    expect(frames.filter(frame => typeof frame.params?.update?.content?.text === "string").map(frame => frame.params.update.content.text))
      .toEqual(["delegate error: mcp timeout"]);
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 30_000);
