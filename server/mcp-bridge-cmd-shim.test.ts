// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2055 (Apache-2.0).
//
// Windows only: an MCP server launched through a .cmd shim (what npm writes
// for a package's bin) could not be started by the bridge's plain spawn.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const windowsOnly = it.skipIf(process.platform !== "win32");

windowsOnly("starts an MCP server that is only reachable as a .cmd shim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-bridge-shim-"));
  try {
    writeFileSync(join(dir, "shim-mcp.js"),
      "let t='';process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:9,result:{echo:t.trim().split('\\n').length}})+'\\n'));");
    writeFileSync(join(dir, "shim-mcp.cmd"),
      '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%dp0%\\node.exe" "%dp0%\\shim-mcp.js" %*\r\n');
    const script = `import {runMcpBridge} from './server/mcp-bridge.ts';
      runMcpBridge({command:'shim-mcp',args:[],label:'fixture'});`;
    const bridge = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, MURAGE_EXTRA_PATH: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    bridge.stdout.on("data", (chunk) => { output += chunk; });
    bridge.stderr.on("data", (chunk) => { errors += chunk; });
    const timer = setTimeout(() => bridge.kill("SIGKILL"), 20_000);
    try {
      const closed = new Promise<number | null>((resolve, reject) => { bridge.on("error", reject); bridge.on("close", resolve); });
      bridge.stdin.end('{"jsonrpc":"2.0","id":9,"method":"initialize"}\n');
      expect(await closed, errors).toBe(0);
      expect(JSON.parse(output.trim().split("\n")[0]!)).toEqual({ jsonrpc: "2.0", id: 9, result: { echo: 1 } });
    } finally {
      clearTimeout(timer);
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
