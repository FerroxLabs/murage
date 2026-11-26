// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prompt cache: the tool list is part of what a provider caches. Two bots of one role, and two threads of one bot, are sent
// the same tools in the same order, byte for byte; only a capability the harness mounted for that turn changes the list.
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_LIBRARY_ENV, IMAGE_LIBRARY_TOOLS } from "../../shared/image-library-audience.ts";
import { spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const open: ChildProcess[] = [];
afterEach(() => { for (const child of open.splice(0)) child.kill(); });

async function toolsListFor(env: Record<string, string>): Promise<string> {
  const child = await spawnBoundProxy("agents", process.execPath, [PROXY], { env: { ...process.env, MURAGE_HARNESS_URL: "http://127.0.0.1:9", MURAGE_COMMS_TOKEN: "neutral-fixture", MURAGE_TURN_DEPTH: "0", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  open.push(child);
  let buf = "";
  const waiters = new Map<number, (line: string) => void>();
  child.stdout!.on("data", chunk => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) waiters.get(JSON.parse(line).id)?.(line); }
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<string>(resolve => { waiters.set(id, resolve); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc(1, "initialize", { protocolVersion: "2024-11-05" });
  const result = JSON.parse(await rpc(2, "tools/list")).result as { tools: unknown[] };
  return JSON.stringify(result.tools);
}

describe("the agents tool list is one list per role", () => {
  for (const role of ["", "lead", "member"]) {
    it(`two bots and two threads of role "${role || "plain"}" get byte-identical tools`, async () => {
      const roleEnv: Record<string, string> = role ? { MURAGE_PROJECT_ROLE: role } : {};
      const a = await toolsListFor({ ...roleEnv, MURAGE_BOT_ID: "bot-aa", MURAGE_THREAD_ID: "thread-1" });
      const b = await toolsListFor({ ...roleEnv, MURAGE_BOT_ID: "bot-bb", MURAGE_THREAD_ID: "thread-2" });
      const c = await toolsListFor({ ...roleEnv, MURAGE_BOT_ID: "bot-aa", MURAGE_THREAD_ID: "thread-3" });
      expect(JSON.parse(a).length).toBeGreaterThan(5);
      expect(b).toBe(a);
      expect(c).toBe(a);
    }, 60_000);
  }
  it("a mounted capability is the only thing that changes the list", async () => {
    const plain = await toolsListFor({ MURAGE_BOT_ID: "bot-aa", MURAGE_THREAD_ID: "t" });
    const withNeeds = await toolsListFor({ MURAGE_BOT_ID: "bot-aa", MURAGE_THREAD_ID: "t", MURAGE_NEEDS_OWNER_NOW: "1" });
    expect(JSON.parse(withNeeds).length).toBe(JSON.parse(plain).length + 1);
    expect(JSON.stringify(JSON.parse(withNeeds).slice(0, JSON.parse(plain).length))).toBe(plain);
  }, 60_000);
});

it("PC-R2-catalog-audience: a non-owner's catalog cannot inherit private library tools or arguments", async () => {
  const owner = JSON.parse(await toolsListFor({ [IMAGE_LIBRARY_ENV]: "1" }));
  const other = JSON.parse(await toolsListFor({ [IMAGE_LIBRARY_ENV]: "0" }));
  expect(JSON.stringify(owner)).not.toBe(JSON.stringify(other));
  for (const name of IMAGE_LIBRARY_TOOLS) {
    expect(owner.some((t: { name: string }) => t.name === name)).toBe(true);
    expect(other.some((t: { name: string }) => t.name === name)).toBe(false);
  }
  const properties = (tools: typeof owner) => tools.find((t: { name: string }) => t.name === "generate_image").inputSchema.properties;
  expect(properties(owner)).toHaveProperty("prompt_blocks"); expect(properties(owner)).toHaveProperty("reference_pack");
  expect(properties(other)).not.toHaveProperty("prompt_blocks"); expect(properties(other)).not.toHaveProperty("reference_pack");
});
it("PC-R2-catalog-role: the proposal catalog is deterministic and retains its restricted surface", async () => {
  const env = { MURAGE_PROJECT_ROLE: "proposal" };
  const a = await toolsListFor({ ...env, MURAGE_BOT_ID: "bot-aa", MURAGE_THREAD_ID: "thread-a" });
  const b = await toolsListFor({ ...env, MURAGE_BOT_ID: "bot-bb", MURAGE_THREAD_ID: "thread-b" });
  expect(b).toBe(a);
  expect(JSON.parse(a).some((t: { name: string }) => t.name === "project_propose")).toBe(true);
  expect(JSON.parse(a).some((t: { name: string }) => t.name === "delegate_bot")).toBe(false);
});
