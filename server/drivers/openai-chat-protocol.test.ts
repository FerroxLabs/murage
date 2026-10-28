import { describe, expect, it } from "vitest";

import { ChatToolCalls } from "./openai-chat-protocol.ts";

const completeCall = {
  id: "call_echo",
  type: "function",
  function: { name: "echo", arguments: "{}" },
};

describe("streamed chat tool calls", () => {
  it("treats explicit null continuation fields as absent", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall, function: { ...completeCall.function, arguments: "" } }], true);
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);
    calls.add([{ index: 0, id: null, function: { name: null, arguments: "{}" } }], true);

    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("still rejects incomplete calls after null-only deltas", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, id: null, type: null, function: { name: null, arguments: null } }], true);

    expect(() => calls.finish("tool_calls", false)).toThrow(/incomplete or duplicate/);
  });

  it.each([
    { index: 0, type: "computer" },
    { index: 0, function: [] },
    { index: 0, function: { name: 1 } },
    { index: 0, function: { arguments: 1 } },
  ])("rejects unsupported or malformed continuation fields", (delta) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([delta], true)).toThrow();
  });

  it.each([
    { id: "call_large_name", name: "n".repeat(65), arguments: "{}" },
    { id: "call_large_args", name: "echo", arguments: "x".repeat(256_001) },
  ])("preserves tool-call size limits", ({ id, name, arguments: args }) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([{ index: 0, id, function: { name, arguments: args } }], true)).toThrow(/size limit/);
  });
});

describe("OPENAI-TOOLS-109 s5.1 deviation: streamed function:null", () => {
  it("omits a streamed function:null like every other streamed null field", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall }], true);
    calls.add([{ index: 0, id: null, type: null, function: null }], true);
    expect(calls.finish("tool_calls", false)).toEqual([completeCall]);
  });

  it("still refuses function:null in a non-streamed reply", () => {
    expect(() => new ChatToolCalls().add([{ ...completeCall, function: null }], false)).toThrow(/invalid tool-call function/);
  });
});

describe("finish refusals", () => {
  it.each([
    ["length", /truncated or malformed/],
    ["content_filter", /truncated or malformed/],
  ])("refuses calls under finish %s", (reason, error) => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall }], true);
    expect(() => calls.finish(reason, false)).toThrow(error);
  });

  it("refuses a malformed frame, legacy function_call, tool_calls without calls, and duplicate ids", () => {
    const one = new ChatToolCalls();
    one.add([{ index: 0, ...completeCall }], true);
    expect(() => one.finish("tool_calls", true)).toThrow(/malformed completion frame/);
    expect(() => new ChatToolCalls().finish("function_call", false)).toThrow(/legacy function_call/);
    expect(() => new ChatToolCalls().finish("tool_calls", false)).toThrow(/without a complete call/);
    const dup = new ChatToolCalls();
    dup.add([{ index: 0, ...completeCall }, { index: 1, ...completeCall }], true);
    expect(() => dup.finish("tool_calls", false)).toThrow(/incomplete or duplicate/);
  });

  it("refuses an id that changes mid-stream and a name outside the allowed alphabet", () => {
    const calls = new ChatToolCalls();
    calls.add([{ index: 0, ...completeCall }], true);
    expect(() => calls.add([{ index: 0, id: "call_other" }], true)).toThrow(/changed or omitted/);
    const bad = new ChatToolCalls();
    bad.add([{ index: 0, ...completeCall, function: { name: "bad name", arguments: "{}" } }], true);
    expect(() => bad.finish("tool_calls", false)).toThrow(/incomplete or duplicate/);
  });
});

describe("tool calls per reply", () => {
  it("accepts 32 calls in one reply and refuses a 33rd", () => {
    const calls = new ChatToolCalls();
    calls.add(Array.from({ length: 32 }, (_, index) => ({ index, ...completeCall, id: `call_${index}` })), true);
    expect(calls.finish("tool_calls", false)).toHaveLength(32);
    expect(() => new ChatToolCalls().add([{ index: 32, ...completeCall }], true)).toThrow(/invalid tool-call index/);
  });
});

describe("complete chat tool calls", () => {
  it.each([
    { ...completeCall, id: null },
    { ...completeCall, type: null },
    { ...completeCall, function: null },
    { ...completeCall, function: { ...completeCall.function, name: null } },
    { ...completeCall, function: { ...completeCall.function, arguments: null } },
  ])("rejects null required fields in non-streaming responses", (call) => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([call], false)).toThrow();
  });
});
