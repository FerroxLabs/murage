// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS B guard change at openai-chat.ts sendTurn: only a turn the server marked draftOnly === true (server/index.ts sets it
// from the bot profile; the registry decorator cuts its folder) skips the bot-folder guard, because that turn has no tools and
// never opens a folder. Every other turn without a real folder is refused before any request is sent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import { decorateDraftOnlyInstance } from "../harness/draft-only-adapter.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function make() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response("data: [DONE]\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const live = await OpenAICompatDriver.create({ instanceId: "chat-guard", displayName: "Chat", enabled: true, config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" }, environment: { TEST_KEY: "secret" } });
  return { live, fetchMock, chatCalls: () => fetchMock.mock.calls.filter(([u]) => !String(u).endsWith("/models")).length };
}

describe("the bot-folder guard in the chat engine", () => {
  it("refuses a NON-draft turn that has no folder, before any request", async () => {
    const { live, chatCalls } = await make();
    try {
      await expect(live.adapter.sendTurn({ threadId: "t-guard-1", text: "hi", model: "vendor/model" } as SendTurnInput)).rejects.toThrow(/folder/i);
      expect(chatCalls()).toBe(0);
    } finally { await live.dispose(); }
  });

  it("gives a request that merely claims draft-only no skip (only server-set true counts)", async () => {
    const { live, chatCalls } = await make();
    const instance = decorateDraftOnlyInstance(live);
    try {
      for (const claim of ["true", 1, "yes", {}]) {
        await expect(instance.adapter.sendTurn({ threadId: "t-guard-2", text: "hi", model: "vendor/model", draftOnly: claim } as unknown as SendTurnInput)).rejects.toThrow(/folder/i);
      }
      expect(chatCalls()).toBe(0);
    } finally { await instance.dispose(); }
  });
});
