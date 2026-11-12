// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { claudeMcpStartupEnv, createPermissionBroker } from "./drivers/claude.ts";
import { consumePermissionResult } from "./testing/claude-permission-consumer.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const proxy = fileURLToPath(new URL("./permission-proxy.ts", import.meta.url));
type Result = { content: Array<{ type: string; text: string }> };
async function roundTrip(input: unknown, source: "user" | "auto", options: { updatedInput?: Record<string, unknown>; deny?: boolean; tool?: string } = {}): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), "murage-result-"));
  const broker = await createPermissionBroker({
    socketPaths: [join(dir, "p.sock")],
    onAsk: (ask) => {
      expect(ask.input).toEqual(input);
      if (source === "user") broker.answer(ask.id, options.deny ? "deny" : "allow", "Owner decision", undefined, options.updatedInput);
      else broker.settle(ask.id, options.deny ? "deny" : "allow", "Automatic decision", "auto", options.updatedInput);
    },
    onResolve: (resolved) => expect(resolved.source).toBe(source),
  });
  const child = spawn(process.execPath, [proxy, broker.socketPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    const response = new Promise<Result>((resolve, reject) => {
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0]!).result);
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("proxy exited before answering")));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: options.tool ?? "Write", input } } }) + "\n");
    return await response;
  } finally {
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
    broker.close();
    removeTempDirSync(dir);
  }
}

for (const kb of [40, 400]) for (const source of ["user", "auto"] as const) {
  it(`preserves a ${kb} KB Write allow from ${source} through Claude's output limit and schema`, async () => {
    const input = { file_path: "/fixture/build.py", content: "x".repeat(kb * 1024 - 5) + "é✓" };
    const result = await roundTrip(input, source);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ behavior: "allow", updatedInput: input });
    // Inject a high token count independently of the body: even a small body
    // must survive an owner's low limit and any tokenizer/content combination.
    for (const mode of ["persist", "truncate"] as const) {
      const decision = consumePermissionResult(result, { MAX_MCP_OUTPUT_TOKENS: "1000", ...claudeMcpStartupEnv() }, kb * 1024, mode);
      expect(decision).toEqual({ behavior: "allow", updatedInput: input });
    }
  }, 20_000);
}

for (const tool of ["Write", "Edit", "MultiEdit", "Bash", "mcp__fixture__change"]) for (const source of ["user", "auto"] as const) {
  it(`keeps the judged ${tool} input and denies intact (${source})`, async () => {
    const input = { file_path: "/fixture/build.py", content: "before", command: "echo before", old_string: "a", new_string: "b", edits: [{ old_string: "a", new_string: "b" }], nested: { payload: "x".repeat(400 * 1024) } };
    const narrowed = { ...input, content: "approved", nested: { payload: "✓".repeat(400 * 1024) } };
    const result = await roundTrip(input, source, { updatedInput: narrowed, tool });
    expect(consumePermissionResult(result, claudeMcpStartupEnv(false), 400_000)).toEqual({ behavior: "allow", updatedInput: narrowed });
    const denied = await roundTrip(input, source, { deny: true, tool });
    expect(consumePermissionResult(denied, claudeMcpStartupEnv(), 10)).toMatchObject({ behavior: "deny" });
  }, 20_000);
}

it("models the old overflow failure and rejects omitted updatedInput", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: { content: "x".repeat(400 * 1024) } }) }] };
  expect(() => consumePermissionResult(result, {}, 100_000)).toThrow("Permission prompt tool returned an invalid result.");
  expect(() => consumePermissionResult(result, {}, 100_000, "truncate")).toThrow();
  expect(() => consumePermissionResult({ content: [{ type: "text", text: '{"behavior":"allow"}' }] }, {}, 10)).toThrow("schema-invalid");
});
