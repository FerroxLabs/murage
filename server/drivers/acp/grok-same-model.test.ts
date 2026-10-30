// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot afbc78c5c: Grok is not asked to switch to the model it already runs. A repeat
// session/set_model makes grok rebuild its harness, which can drop the MCP catalog it just confirmed.
import { expect, it } from "vitest";
import type { AcpConfig } from "./core.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { configureGrokSession } from "./grok.ts";

const calls: Array<{ method: string; params: unknown }> = [];
const ctx = (model: string | undefined, currentModelId?: string, refuse = false) => ({
  request: async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (refuse) throw new Error("unknown model");
    return {};
  },
  sessionId: "s-1",
  config: {} as AcpConfig,
  turn: { threadId: "t", text: "hi", ...(model ? { model } : {}) } as SendTurnInput,
  sessionModels: [],
  ...(currentModelId ? { currentModelId } : {}),
});

it("sends no set_model when the session already runs the picked model", async () => {
  calls.length = 0;
  await configureGrokSession(ctx("grok-4.7", "grok-4.7"));
  expect(calls).toEqual([]);
});

it("still switches when the session runs another model or reports none, and fails loudly on a refusal", async () => {
  calls.length = 0;
  await configureGrokSession(ctx("grok-4.7", "grok-code-fast"));
  await configureGrokSession(ctx("grok-4.7"));
  expect(calls).toEqual([
    { method: "session/set_model", params: { sessionId: "s-1", modelId: "grok-4.7" } },
    { method: "session/set_model", params: { sessionId: "s-1", modelId: "grok-4.7" } },
  ]);
  await expect(configureGrokSession(ctx("grok-4.7", "grok-code-fast", true))).rejects.toThrow(/Grok rejected model "grok-4\.7"/);
});

it("sends nothing when no model was picked", async () => {
  calls.length = 0;
  await configureGrokSession(ctx(undefined, "grok-4.7"));
  expect(calls).toEqual([]);
});
