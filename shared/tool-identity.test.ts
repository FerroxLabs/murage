import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseToolIdentity, toolIdentity, toolIdentityWire, type EngineFrame, type IdentityCtx } from "./tool-identity.ts";

const ctx: IdentityCtx = {
  mounts: [{ engineName: "s", mountId: "custom:s", provenance: "custom" }],
  hermesVersion: "0.22.2", hermesInstallSha: "d923a5eb487a17c0a68801bba9ef0f56c81040a8",
};
const stamp = (name = "read_file", namespace = "fuigo_build", kind = "read", rawInput: unknown = {}): EngineFrame => ({
  kind, rawInput, _meta: { "fuigo/tool": { version: 1, namespace, name, kind } },
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hook: EngineFrame = { kind: "execute", rawInput: {
  command: "<terminal> (plugin approval rule)",
  description: JSON.stringify({ murage: 1, v: 1, tool: "terminal", input: { command: "printf s0-terminal" }, truncated: false }),
} };

describe("S1 engine-owned tool identity", () => {
  it("I10 only a stamped dispatcher reads argument names", () => {
    const input = { tool_name: "read_file", tool_input: {} };
    expect(toolIdentity("fuigo", stamp("use_tool", "fuigo_build", "other", input), ctx)).toMatchObject({
      proven: true, key: "fuigo/fuigo_build/use_tool", name: "use_tool", dispatch: { target: "read_file", targetInput: {}, proven: true },
    });
    expect(toolIdentity("fuigo", { kind: "read", rawInput: input }, ctx)).toMatchObject({ key: "fuigo/acp-kind/read" });
    expect(toolIdentity("fuigo", { kind: "read", rawInput: input }, ctx).dispatch).toBeUndefined();
    expect(toolIdentity("fuigo", stamp("read_file", "fuigo_build", "read", input), ctx).dispatch).toBeUndefined();
  });
  it("F1 a present malformed stamp never falls back to kind", () => {
    for (const bad of [null, {}, [], "read_file", { version: 2, namespace: "fuigo_build", name: "read_file", kind: "read" }]) {
      expect(toolIdentity("fuigo", { kind: "read", _meta: { "fuigo/tool": bad } }, ctx)).toMatchObject({ proven: false, key: "" });
    }
    expect(toolIdentity("fuigo", { ...stamp(), kind: "execute" }, ctx).proven).toBe(false);
    expect(toolIdentity("fuigo", stamp("read_file "), ctx).proven).toBe(false);
    expect(toolIdentity("fuigo", stamp("read_file", "unrecognized"), ctx).proven).toBe(false);
    expect(toolIdentity("fuigo", stamp("write", "opencode", "edit"), ctx).proven).toBe(true);
    expect(toolIdentity("fuigo", stamp("apply_patch", "codex", "edit"), ctx).proven).toBe(true);
  });
  it("F2 dispatch resolves wrappers and MCP mounts, rejecting ambiguity and excess depth", () => {
    const wrap = (input: unknown) => ({ tool_name: "use_tool", tool_input: input });
    const input = { tool_name: "mcp__s__t", tool_input: { x: 1 } };
    expect(toolIdentity("fuigo", stamp("use_tool", "fuigo_build", "other", wrap(input)), ctx).dispatch).toEqual({ target: "mcp__s__t", targetInput: { x: 1 }, proven: true });
    for (const bad of [wrap(wrap(wrap(input))), { ...input, extra: 1 }, { ...input, toolName: "read_file" }, { tool_name: "tool", tool_input: {} }]) {
      expect(toolIdentity("fuigo", stamp("use_tool", "fuigo_build", "other", bad), ctx).proven).toBe(false);
    }
    expect(toolIdentity("fuigo", stamp("s__t", "mcp", "other"), ctx).key).toBe("fuigo/mcp/s__t");
    expect(toolIdentity("fuigo", stamp("s__t", "mcp", "other"), { mounts: [] }).proven).toBe(false);
    expect(toolIdentity("fuigo", stamp("s__t", "mcp", "other"), { mounts: [...ctx.mounts!, ...ctx.mounts!] }).proven).toBe(false);
  });
  it("A1 unstamped ACP proves only identifying protocol kinds", () => {
    for (const engine of ["fuigo", "cline", "copilot", "cursor", "droid", "gemini", "grok", "custom"]) {
      expect(toolIdentity(engine, { title: "read_file", kind: "execute", rawInput: { tool_name: "read_file" } }, ctx).key).toBe(`${engine}/acp-kind/execute`);
      expect(toolIdentity(engine, { title: "read_file", kind: "other" }, ctx).proven).toBe(false);
    }
  });
  it("CL1 Claude prompt and tool_use agree, with mount-bound MCP names", () => {
    const ask = toolIdentity("claude", { tool_name: "Bash", input: { tool_name: "Read" } }, ctx);
    expect(ask.key).toBe("claude/claude/Bash");
    expect(toolIdentity("claude", { type: "tool_use", name: "Bash", input: {} }, ctx).key).toBe(ask.key);
    expect(toolIdentity("claude", { tool_name: "mcp__s__t" }, ctx).key).toBe("claude/mcp:s/t");
    expect(toolIdentity("claude", { tool_name: "mcp__missing__t" }, ctx).proven).toBe(false);
    expect(toolIdentity("claude", { rawInput: { tool_name: "Read" }, kind: "read" }, ctx).proven).toBe(false);
  });
  it("CX1 Codex items read item.type, server and tool; only S0b pinned hooks are proven", () => {
    for (const [type, name] of [["commandExecution", "shell"], ["fileChange", "edit"], ["webSearch", "web_search"]]) {
      expect(toolIdentity("codex", { type, command: "read_file" }, ctx).key).toBe(`codex/codex/${name}`);
    }
    expect(toolIdentity("codex", { type: "mcpToolCall", server: "s", tool: "t" }, ctx).key).toBe("codex/mcp:s/t");
    for (const frame of [{ type: "unknown" }, { tool_name: "invented" }, { tool_name: "exec_command" }, { type: "mcpToolCall", server: "missing", tool: "t" }]) {
      expect(toolIdentity("codex", frame, ctx).proven).toBe(false);
    }
  });
  it("Codex apply_patch pairing requires the same present call id", () => {
    const codexHook = {tool_name:"Bash",tool_input:{command:"apply_patch <<EOF"},tool_use_id:"call-1"};
    expect(toolIdentity("codex",{type:"fileChange",id:"call-1"},{...ctx,codexHook}).key).toBe("codex/codex/shell");
    expect(toolIdentity("codex",{type:"fileChange",id:"call-2"},{...ctx,codexHook}).key).toBe("codex/codex/edit");
    expect(toolIdentity("codex",{type:"fileChange"},{...ctx,codexHook:{...codexHook,tool_use_id:undefined}}).key).toBe("codex/codex/edit");
  });
  it("R1 rejects a forged Hermes read identity", () => {
    const wire = { ...toolIdentityWire(toolIdentity("hermes", hook, ctx)), name: "read_file", key: "hermes/hermes/read_file", proven: true };
    expect(parseToolIdentity(wire, hook, "hermes", ctx)).toMatchObject({ proven: false, key: "", why: "identity did not re-derive" });
  });
  it("R2 rejects fabricated or dropped dispatch and altered target input", () => {
    const frame = stamp();
    expect(parseToolIdentity({ ...toolIdentityWire(toolIdentity("fuigo", frame, ctx)), dispatch: { target: "mcp__s__t", targetInput: {}, proven: true } }, frame, "fuigo", ctx).proven).toBe(false);
    const wrapped = stamp("use_tool", "fuigo_build", "other", { tool_name: "mcp__s__t", tool_input: { p: "café" } });
    const wire = toolIdentityWire(toolIdentity("fuigo", wrapped, ctx));
    expect(parseToolIdentity(clone(wire), wrapped, "fuigo", ctx).dispatch).toEqual(wire.dispatch);
    expect(parseToolIdentity({ ...wire, dispatch: undefined }, wrapped, "fuigo", ctx).proven).toBe(false);
    expect(parseToolIdentity({ ...wire, dispatch: { ...wire.dispatch!, targetInput: { p: "cafe\u0301" } } }, wrapped, "fuigo", ctx).proven).toBe(false);
  });
  it("R3 re-derives a stored card after reload, including its dispatch input", () => {
    const identityFrame = stamp();
    const stored = clone({ identityFrame, toolIdentity: toolIdentityWire(toolIdentity("fuigo", identityFrame, ctx)) });
    stored.identityFrame = stamp("terminal", "fuigo_build", "execute");
    expect(parseToolIdentity(stored.toolIdentity, stored.identityFrame, "fuigo", ctx).proven).toBe(false);
  });
  it("R4 re-derives the real S0 terminal hook ask", () => {
    const frames = readFileSync(new URL("../server/testing/fixtures/hermes-0.22.2-tool-identity/frames.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const captured = frames.filter((f) => f.scenario === "terminal" && f.direction === "stdout").map((f) => JSON.parse(f.line)).find((f) => f.method === "session/request_permission").params.toolCall;
    const id = toolIdentity("hermes", captured, ctx);
    expect(id).toMatchObject({ proven: true, provenance: "hermes-hook", key: "hermes/hermes/terminal" });
    expect(parseToolIdentity(clone(toolIdentityWire(id)), captured, "hermes", ctx)).toEqual(id);
  });
  it("r1.2 removes the wire binding field", () => {
    const wire = toolIdentityWire(toolIdentity("hermes", hook, ctx));
    expect(wire).not.toHaveProperty("binding");
    expect(parseToolIdentity({ ...wire, binding: { executionToolCallId: "forged" } }, hook, "hermes", ctx).proven).toBe(false);
  });
  it("R5 rejects unknown wire fields, invalid values, engines and versions", () => {
    const frame = stamp(); const wire = toolIdentityWire(toolIdentity("fuigo", frame, ctx));
    for (const bad of [null, { ...wire, v: 2 }, { ...wire, engine: "claude" }, { ...wire, extra: 1 }, { ...wire, dispatch: NaN }]) {
      expect(parseToolIdentity(bad, frame, "fuigo", ctx).proven).toBe(false);
    }
    expect(toolIdentity("hermes", hook, { ...ctx, hermesVersion: "0.22.3" }).proven).toBe(false);
    expect(toolIdentity("hermes", hook, { ...ctx, hermesInstallSha: undefined }).proven).toBe(false);
  });
  it("R6 freezes the complete identity without freezing caller-owned arguments", () => {
    const input = { tool_name: "read_file", tool_input: { nested: [1] } };
    const id = toolIdentity("fuigo", stamp("use_tool", "fuigo_build", "other", input), ctx);
    expect(Object.isFrozen(id)).toBe(true);
    expect(Object.isFrozen(id.dispatch)).toBe(true);
    input.tool_input.nested.push(2);
    expect(id.dispatch?.targetInput).toEqual({ nested: [1] });
    expect(Object.isFrozen((id.dispatch?.targetInput as { nested: number[] }).nested)).toBe(true);
  });
});
