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
const { providerDispatcher } = await import("./openai-chat.ts");

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
    const key = Object.getOwnPropertySymbols(providerDispatcher).find((symbol) => symbol.description === "options");
    const options = (providerDispatcher as unknown as Record<symbol, { headersTimeout?: number; bodyTimeout?: number }>)[key!];
    expect(options).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
  });
});
