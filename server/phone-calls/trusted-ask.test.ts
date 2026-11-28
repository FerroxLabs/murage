// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it } from "vitest";
import { acpPhoneAskLine, phoneAskLine, setPhoneAskPreview } from "../drivers/phone-tool-schemas.ts";
import { forgetAllPhoneTurns, forgetPhoneIntent, phoneAskContext, recordPhoneTurn } from "./phone-turns.ts";

afterEach(() => {
  forgetAllPhoneTurns();
  setPhoneAskPreview(null);
});

it("binds concurrent Ask previews to the recorded owner message and ignores forged tool input", async () => {
  const first = { botId: "bot-a", threadId: "thread-a", dispatchGeneration: "generation-a" };
  const second = { botId: "bot-b", threadId: "thread-b", dispatchGeneration: "generation-b" };
  recordPhoneTurn(first.dispatchGeneration, { ...first, intent: "message-a" });
  recordPhoneTurn(second.dispatchGeneration, { ...second, intent: "message-b" });
  const contexts: unknown[] = [];
  setPhoneAskPreview((args, turn) => {
    contexts.push(phoneAskContext(turn));
    return { to: String(args.to), goal: "Ask about opening hours", details: "", limits: "", language: "en", settings_revision: 1 };
  });
  const input = { to: "+12025550100", botId: second.botId, intent: "message-b", generation: second.dispatchGeneration };
  const call = { title: "phone_call_place", rawInput: input };
  const lines = await Promise.all([
    Promise.resolve().then(() => acpPhoneAskLine(call, first)),
    Promise.resolve().then(() => phoneAskLine("mcp__agents__phone_call_place", input, second)),
  ]);
  expect(lines.every(line => line?.startsWith("Call +12025550100"))).toBe(true);
  phoneAskLine("phone_call_place", input, { ...first, dispatchGeneration: second.dispatchGeneration });
  phoneAskLine("phone_call_place", input);
  forgetPhoneIntent("message-a");
  acpPhoneAskLine(call, first);
  acpPhoneAskLine(call, second);
  expect(contexts).toEqual([
    { botId: "bot-a", intent: "message-a" },
    { botId: "bot-b", intent: "message-b" },
    undefined,
    undefined,
    undefined,
    { botId: "bot-b", intent: "message-b" },
  ]);
});

it("P16c keeps the owner message identity across generations and revokes the retry on Delete", () => {
  const message = "fixture-message";
  const record = { botId: "fixture-bot", threadId: "fixture-thread", intent: message };
  const first = { ...record, dispatchGeneration: "fixture-first" };
  const retry = { ...record, dispatchGeneration: "fixture-retry" };
  recordPhoneTurn(first.dispatchGeneration, record);
  expect(phoneAskContext(first)).toEqual({ botId: record.botId, intent: message });
  recordPhoneTurn(retry.dispatchGeneration, record);
  expect(phoneAskContext(first)).toBeUndefined();
  expect(phoneAskContext(retry)).toEqual({ botId: record.botId, intent: message });
  forgetPhoneIntent(message);
  expect(phoneAskContext(retry)).toBeUndefined();
});
