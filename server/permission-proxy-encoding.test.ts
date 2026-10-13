// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2387 (Apache-2.0).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const proxy = fileURLToPath(new URL("./permission-proxy.ts", import.meta.url));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The broker socket is a unix socket path; Windows uses a different transport.
it.skipIf(process.platform === "win32")("keeps non-ASCII text intact when a read ends inside a character, in both directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-proxy-enc-"));
  const sock = join(dir, "p.sock");
  const content = "é".repeat(50_000) + "日本語";
  const reply = "ü".repeat(2_000) + "✓";
  let asked: any;
  const brokerSeen = new Promise<Socket>((resolve) => {
    const server = createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        if (!buf.includes("\n") || asked) return;
        asked = JSON.parse(buf.split("\n")[0]!);
        resolve(conn);
      });
    });
    server.listen(sock);
  });
  await wait(100);
  const child = spawn(process.execPath, [proxy, sock], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const request = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { content } } },
    }) + "\n");
    const cut = request.indexOf(Buffer.from("é")) + 1;
    child.stdin.write(request.subarray(0, cut));
    await wait(50);
    child.stdin.write(request.subarray(cut));
    const conn = await brokerSeen;
    expect(asked.input.content).toBe(content);

    let out = "";
    child.stdout.setEncoding("utf8");
    const answered = new Promise<any>((resolve) => child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]!));
    }));
    const line = Buffer.from(JSON.stringify({ t: "answer", id: asked.id, behavior: "deny", message: reply }) + "\n");
    const cut2 = line.indexOf(Buffer.from("ü")) + 1;
    conn.write(line.subarray(0, cut2));
    await wait(50);
    conn.write(line.subarray(cut2));
    const response = await answered;
    expect(JSON.parse(response.result.content[0].text).message).toBe(reply);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
