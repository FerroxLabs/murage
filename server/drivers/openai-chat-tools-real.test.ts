// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// OPENAI-TOOLS-109 section 11, real-turn proof. Opt-in: skipped unless MURAGE_REAL_CHAT_TOOLS_URL (an OpenAI-compatible /v1 that
// serves a tools-capable model, keyless, such as Ollama, or with MURAGE_REAL_CHAT_TOOLS_KEY) and MURAGE_REAL_CHAT_TOOLS_MODEL are set. Never the Flux
// test key. A real model calls a real stdio MCP tool through the openai-compat driver. Ask is the card left to the person: the
// test denies it, and the tool never runs. Full is the harness's own allow: the tool runs and its result reaches the reply.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const URL_ = process.env.MURAGE_REAL_CHAT_TOOLS_URL;
const MODEL = process.env.MURAGE_REAL_CHAT_TOOLS_MODEL;

const SERVER = String.raw`
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "real", version: "1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "lookup_code", description: "Returns the secret code word for a given name. Always call this to answer questions about code words.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }] } });
    else if (m.method === "tools/call") { appendFileSync(log, JSON.stringify(m.params) + "\n"); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "The code word for " + (m.params.arguments?.name ?? "?") + " is PELICAN-42." }] } }); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let dir: string;
let script: string;
const instances: ProviderInstance[] = [];

const turn = async (decide: "deny" | "allow") => {
  const instance = await OpenAICompatDriver.create({
    instanceId: `real-tools-${decide}`, displayName: "Real tools", environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: URL_, key: process.env.MURAGE_REAL_CHAT_TOOLS_KEY || "keyless-local", model: MODEL }),
  });
  instances.push(instance);
  const log = join(dir, `${decide}.ndjson`);
  const opened: Array<{ ranBefore: number; summary: unknown }> = [];
  const ran = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  instance.adapter.onEvent((event: RuntimeEvent) => {
    if (event.type !== "request.opened") return;
    const request = event as unknown as { threadId: string; requestId: string; summary?: unknown };
    opened.push({ ranBefore: ran(), summary: request.summary });
    setImmediate(() => void instance.adapter.respondToRequest(request.threadId, request.requestId,
      decide === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The owner declined." } as never));
  });
  const recorder = recordEvents(instance.adapter);
  const threadId = `real-tools-${decide}-${Date.now()}`;
  const { turnId } = await instance.adapter.sendTurn({
    threadId, model: MODEL,
    text: "What is the code word for Alice? Use the real_lookup_code tool to find out, then answer in one short sentence.",
    integrations: { custom: { real: { command: process.execPath, args: [script], env: { FAKE_LOG: log } } } },
  } as never);
  const completed = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 240_000) as unknown as { ok: boolean };
  const events = recorder.events as unknown as Array<{ type: string; itemType?: string; text?: string }>;
  recorder.stop();
  const reply = events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text").map((event) => event.text).join("\n");
  return { opened, ran: ran(), completed, reply };
};

describe.skipIf(!URL_ || !MODEL)("real model, real MCP tool (opt-in)", () => {
  beforeAll(() => {
    ensureDirs();
    dir = mkdtempSync(join(tmpdir(), "oai-real-tools-"));
    script = join(dir, "real-mcp-server.mjs");
    writeFileSync(script, SERVER);
  });
  afterAll(async () => {
    for (const instance of instances.splice(0)) await instance.dispose().catch(() => {});
    removeTempDirSync(dir);
  });

  it("Ask: the call raises a card, and a declined card means the tool never runs", async () => {
    const result = await turn("deny");
    console.log(`[real-tools] ask: cards=${result.opened.length} ran=${result.ran} ok=${result.completed.ok} reply=${JSON.stringify(result.reply.slice(0, 200))}`);
    expect(result.opened.length).toBeGreaterThan(0);
    expect(result.opened.every((card) => card.ranBefore === 0)).toBe(true);
    expect(result.ran).toBe(0);
  }, 300_000);

  it("Full: the allowed call runs once the card is answered, and its result reaches the reply", async () => {
    const result = await turn("allow");
    console.log(`[real-tools] full: cards=${result.opened.length} ran=${result.ran} ok=${result.completed.ok} reply=${JSON.stringify(result.reply.slice(0, 200))}`);
    expect(result.opened.length).toBeGreaterThan(0);
    expect(result.opened[0]!.ranBefore).toBe(0);
    expect(result.ran).toBeGreaterThan(0);
    expect(result.completed.ok).toBe(true);
    expect(result.reply).toMatch(/PELICAN-42/i);
  }, 300_000);
});
