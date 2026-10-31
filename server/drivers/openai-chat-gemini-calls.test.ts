// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 0cd63a7db: Gemini's OpenAI-compatible endpoint streams each tool call whole in one chunk,
// with an id and no index. Those calls run; a streamed part with neither an index nor an id is still refused.
import { expect, it } from "vitest";
import { ChatToolCalls } from "./openai-chat-protocol.ts";

const whole = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

it("takes whole calls streamed with an id and no index, in order", () => {
  const calls = new ChatToolCalls();
  calls.add([whole("call_a", "read_file", '{"path":"a.md"}')], true);
  calls.add([whole("call_b", "list_dir", '{"path":"."}')], true);
  expect(calls.finish("tool_calls", false).map((call) => [call.id, call.function.name, call.function.arguments])).toEqual([
    ["call_a", "read_file", '{"path":"a.md"}'],
    ["call_b", "list_dir", '{"path":"."}'],
  ]);
});

it("still refuses a streamed part with neither an index nor an id", () => {
  const calls = new ChatToolCalls();
  expect(() => calls.add([{ type: "function", function: { name: "read_file", arguments: "{}" } }], true)).toThrow(/invalid tool-call index/);
});

it("keeps indexed streaming as before", () => {
  const calls = new ChatToolCalls();
  calls.add([{ index: 0, id: "call_x", type: "function", function: { name: "echo", arguments: '{"t":' } }], true);
  calls.add([{ index: 0, function: { arguments: '"hi"}' } }], true);
  expect(calls.finish("tool_calls", false)).toMatchObject([{ id: "call_x", function: { name: "echo", arguments: '{"t":"hi"}' } }]);
});
