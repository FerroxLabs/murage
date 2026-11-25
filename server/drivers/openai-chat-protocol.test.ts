import { describe, expect, it } from "vitest";

import { ChatReasoningDetails, ChatToolCalls } from "./openai-chat-protocol.ts";

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

  it("keeps the 64-character tool-name rule", () => {
    const calls = new ChatToolCalls();
    expect(() => calls.add([{ index: 0, id: "call_large_name", function: { name: "n".repeat(65), arguments: "{}" } }], true)).toThrow(/size limit/);
  });

  // MAIN-RULING cause22-no-transport-caps: the old 256,000-character argument cap is deleted; a large call's arguments are kept whole.
  it("keeps tool-call arguments over the old 256,000-character cap whole", () => {
    const calls = new ChatToolCalls();
    const args = JSON.stringify({ text: "x".repeat(300_000) });
    expect(() => calls.add([{ index: 0, id: "call_large_args", function: { name: "echo", arguments: args } }], true), "no argument size cap").not.toThrow();
    expect(calls.finish("tool_calls", false).map((call) => call.function.arguments)).toEqual([args]);
  });

  // MAIN-RULING cause22-no-transport-caps: the old 256,000-character reasoning-details cap is deleted; the blocks are kept whole.
  it("keeps reasoning details over the old 256,000-character cap whole", () => {
    const details = new ChatReasoningDetails();
    const blocks = [{ type: "reasoning.text", text: "r".repeat(300_000) }, { type: "reasoning.text", text: "s".repeat(10) }];
    let thrown: unknown;
    try { for (const block of blocks) details.add([block]); } catch (error) { thrown = error; }
    expect(thrown, "no reasoning-details size cap").toBeUndefined();
    expect(details.blocks).toEqual(blocks);
  });

  // MAIN-RULING groupB-left (3) and 2026-11-23T02:48:33Z (row 3h restated): an id-only (Gemini-style) call was placed after Math.max(...slots), so a reply
  // already holding 299,999 indexed calls threw a RangeError. Here the id-only call is placed after every indexed call and its continuation (same id,
  // no index) lands on its own slot; the driver row openai-chat-tools.test.ts 3h reads the same reply through sendTurn.
  it("places an id-only call after 299,999 indexed calls, and its continuation on the same slot", () => {
    const calls = new ChatToolCalls();
    const indexed = Array.from({ length: 299_999 }, (_, index) => ({ index, id: `c_${index}`, type: "function", function: { name: "echo", arguments: "{}" } }));
    let thrown: unknown;
    let placed: Array<{ id: string; arguments: string }> = [];
    try {
      calls.add(indexed, true);
      calls.add([{ id: "c_idonly", type: "function", function: { name: "echo", arguments: '{"text":' } }], true);
      calls.add([{ id: "c_idonly", function: { arguments: '"id only"}' } }], true);
      placed = calls.finish("tool_calls", false).map((call) => ({ id: call.id, arguments: call.function.arguments }));
    } catch (error) { thrown = error; }
    expect([String(thrown ?? "no error"), placed.length, placed[0], placed.at(-1)], "all 300,000 calls placed, the id-only one last and whole").toEqual(["no error", 300_000, { id: "c_0", arguments: "{}" }, { id: "c_idonly", arguments: '{"text":"id only"}' }]);
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
  // MAIN-RULING cause22-no-transport-caps: the old bound of 32 calls per reply is deleted; an index is still a non-negative integer.
  it("keeps every call of a reply that carries more than the old 32-call bound", () => {
    const calls = new ChatToolCalls();
    let thrown: unknown;
    try { calls.add(Array.from({ length: 40 }, (_, index) => ({ index, ...completeCall, id: `call_${index}` })), true); } catch (error) { thrown = error; }
    expect(thrown, "no call-count cap").toBeUndefined();
    expect(calls.finish("tool_calls", false).map((call) => call.id)).toEqual(Array.from({ length: 40 }, (_, index) => `call_${index}`));
    expect(() => new ChatToolCalls().add([{ index: -1, ...completeCall }], true)).toThrow(/invalid tool-call index/);
    expect(() => new ChatToolCalls().add([{ index: 1.5, ...completeCall }], true)).toThrow(/invalid tool-call index/);
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
