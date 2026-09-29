// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 turn limits: a working turn stops only on silence (the thread's
// watch, on the owner's setting), the owner's Stop or a budget. The chat
// engines built on the shared OpenAI-style runtime used to pass a fixed
// provider idle cut of their own (180 seconds, 120 for xAI), which stopped a
// quiet turn long before the owner's setting and ignored it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const captured: Array<Record<string, unknown>> = [];
vi.mock("./openai-chat.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openai-chat.ts")>();
  return {
    ...actual,
    createOpenAIChatRuntime: (options: Record<string, unknown>) => {
      captured.push(options);
      return { dispose: async () => {} };
    },
  };
});

const { OpenAICompatDriver } = await import("./openai-compat.ts");
const { MinimaxDriver } = await import("./minimax.ts");
const { GrokDriver } = await import("./grok.ts");
const { providerDispatcher } = await import("../provider-dispatcher.ts");
const { EnvHttpProxyAgent } = await import("undici");

describe("chat engines on the shared runtime", () => {
  const savedHome = process.env.HOME;
  afterEach(() => {
    captured.length = 0;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  });

  it("the OpenAI-compatible engine sets no fixed provider idle cut", async () => {
    await OpenAICompatDriver.create({ instanceId: "compat", displayName: "Compat", environment: {}, enabled: true, config: OpenAICompatDriver.decodeConfig({ key: "sk-or-v1-synthetic", url: "https://openrouter.ai/api/v1" }) });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.timeoutMs).toBeUndefined();
  });

  it("the MiniMax engine sets no fixed provider idle cut", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "murage-idle-cut-"));
    await MinimaxDriver.create({ instanceId: "mm", displayName: "MiniMax", environment: { MINIMAX_API_KEY: "synthetic" }, enabled: true, config: MinimaxDriver.decodeConfig({}) });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.timeoutMs).toBeUndefined();
  });

  it("the xAI engine sets no fixed provider idle cut", async () => {
    await GrokDriver.create({ instanceId: "xai", displayName: "xAI", environment: { XAI_API_KEY: "xai-synthetic" }, enabled: true, config: GrokDriver.decodeConfig({}) });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.timeoutMs).toBeUndefined();
  });

  // Node's fetch would otherwise end a response after 300 s without headers or
  // bytes (undici's own defaults): a fixed silence cut of its own.
  it("provider requests carry no transport clock of their own", () => {
    const saved = process.env.NODE_USE_ENV_PROXY;
    delete process.env.NODE_USE_ENV_PROXY;
    try {
      const dispatcher = providerDispatcher();
      const key = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === "options");
      const options = (dispatcher as unknown as Record<symbol, { headersTimeout?: number; bodyTimeout?: number }>)[key!];
      expect(options).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
      expect(providerDispatcher()).toBe(dispatcher);
    } finally { if (saved === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = saved; }
  });

  // A proxy the owner set for Node (NODE_USE_ENV_PROXY with HTTPS_PROXY) is
  // still used: an explicit dispatcher would otherwise bypass it.
  it("follows the environment's proxy when Node is told to use it", () => {
    const saved = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      expect(providerDispatcher("https://api.fluxrouter.ai/v1/chat/completions")).toBeInstanceOf(EnvHttpProxyAgent);
      // A model server on this computer or the local network stays direct.
      for (const local of ["http://127.0.0.1:1234/v1/chat/completions", "http://localhost:11434/v1", "http://[::1]:8080/v1", "http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://100.101.102.103/v1", "http://box.local/v1"]) {
        expect(providerDispatcher(local), local).not.toBeInstanceOf(EnvHttpProxyAgent);
      }
      expect(providerDispatcher("http://8.8.8.8/v1")).toBeInstanceOf(EnvHttpProxyAgent);
      delete process.env.NODE_USE_ENV_PROXY;
      const savedOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = "--max-old-space-size=4096 --use-env-proxy";
      try { expect(providerDispatcher("https://api.fluxrouter.ai/v1")).toBeInstanceOf(EnvHttpProxyAgent); }
      finally { if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions; }
    } finally { if (saved === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = saved; }
  });
});
