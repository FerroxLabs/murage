import { describe, expect, it } from "vitest";
import { fakeLlamaCompletion, fakeLlamaToolStream } from "./fake-llama-completion";

const model = "qwen3.8-27b";
const toolCall = { id: "c1", type: "function" as const, function: { name: "get_weather", arguments: '{"city":"Paris"}' } };

function expectCompletionEnvelope(value: Record<string, unknown>, object: string) {
  expect(value).toMatchObject({ id: expect.any(String), object, created: 0, model });
  const choice = (value.choices as Array<Record<string, unknown>>)[0];
  expect(choice).toMatchObject({ index: 0 });
  expect(Object.hasOwn(choice, "finish_reason")).toBe(true);
}

describe("fake llama completion envelopes", () => {
  it("gives prose and tool JSON replies the pinned completion envelope", () => {
    const prose = fakeLlamaCompletion({ role: "assistant", content: "pong" }, "stop", model);
    const tool = fakeLlamaCompletion({ role: "assistant", content: null, tool_calls: [toolCall] }, "tool_calls", model, { prompt_tokens: 7_800 });

    expectCompletionEnvelope(prose, "chat.completion");
    expectCompletionEnvelope(tool, "chat.completion");
    expect((tool.choices[0].message.tool_calls ?? [])).toEqual([toolCall]);
    expect(tool.usage).toEqual({ prompt_tokens: 7_800 });
  });

  it("keeps tool-call stream chunks ordered and terminates them", () => {
    const chunks = fakeLlamaToolStream(toolCall, model);

    expect(chunks).toHaveLength(2);
    expectCompletionEnvelope(chunks[0]!, "chat.completion.chunk");
    expectCompletionEnvelope(chunks[1]!, "chat.completion.chunk");
    expect((chunks[0]!.choices[0]!.delta as { tool_calls?: unknown }).tool_calls).toEqual([{ index: 0, ...toolCall }]);
    expect(chunks[1]!.choices[0]).toMatchObject({ delta: {}, finish_reason: "tool_calls" });
  });
});
