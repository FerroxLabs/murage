// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U22 (1.0.4): the permission proxy connects only to Murage's own permission pipe (Windows) or a .sock file (elsewhere). A
// listener at any other path never sees a connection, and every ask is answered with the unavailable note the driver ends the
// turn on.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { BROKER_UNAVAILABLE_NOTE, brokerPathForArgv } from "./permission-pipe.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const proxy = fileURLToPath(new URL("./permission-proxy.ts", import.meta.url));
const WIN = process.platform === "win32";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A listener that records every connection and answers each ask with an allow. */
function listener(path: string): Promise<{ server: Server; connections: () => number }> {
  let count = 0;
  const server = createServer((conn) => {
    count++;
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const ask = JSON.parse(buf.slice(0, nl)) as { id: string };
      conn.write(JSON.stringify({ t: "answer", id: ask.id, behavior: "allow" }) + "\n");
    });
  });
  cleanups.push(() => server.close());
  return new Promise((resolve) => server.listen(path, () => resolve({ server, connections: () => count })));
}

/** One approve call through the proxy started on `brokerArg`; the permission JSON it answers and its stderr. */
async function ask(brokerArg: string): Promise<{ answer: { behavior: string; message?: string }; stderr: string }> {
  const child = spawn(process.execPath, [proxy, brokerArg], { stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => { try { child.kill(); } catch { /* gone */ } });
  let out = "", stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
  const line = new Promise<string>((resolve) => {
    child.stdout.setEncoding("utf8").on("data", (d) => { out += d; const nl = out.indexOf("\n"); if (nl >= 0) resolve(out.slice(0, nl)); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } } }) + "\n");
  const reply = JSON.parse(await line) as { result: { content: Array<{ text: string }> } };
  return { answer: JSON.parse(reply.result.content[0]!.text), stderr };
}

it("connects to a path of Murage's own shape and carries the broker's answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-proxy-path-"));
  cleanups.push(() => removeTempDirSync(dir));
  const path = WIN ? `\\\\.\\pipe\\murage-perm-${process.pid}-okpath1` : join(dir, "perm-ok.sock");
  const broker = await listener(path);
  const { answer } = await ask(brokerPathForArgv(path));
  expect(answer.behavior).toBe("allow");
  expect(broker.connections()).toBe(1);
});

it("refuses a listener at any other path: no connection, every ask denied with the unavailable note, the reason on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-proxy-path-"));
  cleanups.push(() => removeTempDirSync(dir));
  const path = WIN ? `\\\\.\\pipe\\not-murage-${process.pid}-x` : join(dir, "evil");
  const other = await listener(path);
  const { answer, stderr } = await ask(brokerPathForArgv(path));
  expect(answer).toEqual({ behavior: "deny", message: BROKER_UNAVAILABLE_NOTE });
  expect(stderr).toContain("refusing the broker path");
  expect(other.connections()).toBe(0);
});
