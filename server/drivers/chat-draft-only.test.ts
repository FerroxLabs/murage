// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only turn on a connected chat model (DRAFT-ONLY-ALLOWLIST-104 section 2): through the registry's decorator, the
// one HTTP request carries the draft-only note and no tools, functions or tool choice, whatever integrations the caller built.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import { decorateDraftOnlyInstance } from "../harness/draft-only-adapter.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const MOUNTS = {
  composio: { command: "node", args: ["connector"], env: {} },
  agents: { command: "node", args: ["agents"], env: {} },
  custom: { mailer: { command: "node", args: ["mailer"], env: {} } },
} as unknown as SendTurnInput["integrations"];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a draft-only turn on openai-compat", () => {
  it("sends one request with the draft-only note and no tools field", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"Hi Dana, here is the draft."}}]}\ndata: [DONE]\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const live = await OpenAICompatDriver.create({ instanceId: "chat-draft", displayName: "Chat", enabled: true, config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" }, environment: { TEST_KEY: "secret" } });
    const instance = decorateDraftOnlyInstance(live);
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-chat-draft", text: "draft a reply to ticket 812", model: "vendor/model", draftOnly: true, integrations: MOUNTS, system: "You are Sorrel." });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      for (const key of ["tools", "functions", "tool_choice", "function_call"]) expect(body, key).not.toHaveProperty(key);
      const system = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("I write drafts for you to review and send.");
      expect(JSON.stringify(body)).not.toMatch(/mailer/);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
