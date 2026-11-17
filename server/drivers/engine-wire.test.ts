import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";

const engine = await import("./engine-input.ts").catch(() => null);
const wire = await import("./engine-wire.ts").catch(() => null);
const fixtures = await import("../testing/consuming-fixture.ts").catch(() => null);
const budgets = await import("../memory/release-budget.ts").catch(() => null);
const shapes = [
  ["claude", { type: "user", message: { role: "user", content: [{ type: "text", text: 'é\n"' }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } }],
  ["codex", { jsonrpc: "2.0", id: 123, method: "turn/start", params: { threadId: "thread", input: [{ type: "text", text: 'é\n"' }, { type: "image", url: "data:image/png;base64,AAAA" }] } }],
  ["pi", { type: "prompt", message: 'system\n\né\n"' }],
  ["acp", { jsonrpc: "2.0", id: 123, method: "session/prompt", params: { sessionId: "session", prompt: [{ type: "text", text: 'é\n"' }], _meta: { verbatim: true } } }],
  ["antigravity", { event: "user", message: { content: 'system\n\né\n"' } }],
  ["boxagent", { provider: "test", model: "test-model", prompt: 'cloud computer\né\n"' }],
] as const;

async function serializer(name: typeof shapes[number][0]): Promise<(frame: Record<string, unknown>, before?: () => void) => string> {
  switch (name) {
    case "claude": return (await import("./claude.ts")).serializeClaudeInput;
    case "codex": return (await import("./codex.ts")).serializeCodexInput;
    case "pi": return (await import("./pi.ts")).serializePiInput;
    case "antigravity": return (await import("./antigravity.ts")).serializeAntigravityInput;
    case "boxagent": return (await import("./boxagent.ts")).serializeBoxAgentInput;
    case "acp": {
      const { writeAcpResponse } = await import("./acp/approval-delivery.ts");
      return (frame, before) => {
        let output = "", failure: Error | null | undefined;
        const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
        writeAcpResponse(stream, frame, error => { failure = error; }, undefined, undefined, before);
        stream.destroy();
        if (failure) throw failure;
        return output;
      };
    }
  }
}

async function fixture() {
  // Baseline fails here on an assertion, before resolving newer fixtures.
  expect(engine?.accountEngineWire, "final serializers must charge the captured generation, not prompt text").toBeTypeOf("function");
  expect(wire?.engineJsonLine).toBeTypeOf("function");
  expect(fixtures?.consumingFixture).toBeTypeOf("function");
  const f = fixtures!.consumingFixture({ audience: null }, { empty: true });
  const { buildPrompt, promptPart, noneRef } = await import("../memory/prompt-parts.ts");
  // Fixture-owned input needs explicit provenance before final-wire accounting.
  const prompt = buildPrompt(f.turn, [promptPart('é\n"', [noneRef("owner-turn")])]);
  const submitted = vi.fn();
  const input = engine!.fencedTurnInput({ threadId: "T", prompt, beforeSubmit: submitted }, { reader: { audience: null }, db: f.f.db, retained: f.turn });
  return { ...f, input, submitted, prompt };
}

// red-at-4df086541: downstream envelopes, escaping, images and added context
// could cross the budget after the prompt-only callback had already passed.
it.each(shapes)("T-ENGINE-FINAL-WIRE %s expansion refuses before release", async (name, frame) => {
  const f = await fixture();
  try {
    const serialize = await serializer(name);
    f.input.beforeSubmit!();
    expect(f.submitted).toHaveBeenCalledTimes(1);
    f.budget.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - f.budget.counts.bytes - Buffer.byteLength(f.prompt.text) });
    const statements = f.budget.counts.statements;
    const write = vi.fn();
    expect(() => write(serialize(frame, f.input.beforeSubmit))).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
    expect(f.budget.counts.statements).toBe(statements);
    expect(() => f.budget.charge({ bytes: 0 })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(f.submitted).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

// control: exact serialized UTF-8 cost includes escaping and the JSONL newline;
// the private hook does not repeat submission bookkeeping or charge prompt text.
it.each(shapes)("T-ENGINE-FINAL-WIRE %s exact cap", async (name, frame) => {
  const f = await fixture();
  try {
    const serialize = await serializer(name);
    f.input.beforeSubmit!();
    const expected = JSON.stringify(frame) + (name === "boxagent" ? "" : "\n");
    f.budget.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - f.budget.counts.bytes - Buffer.byteLength(expected) });
    const before = f.budget.counts;
    const actual = serialize(frame, f.input.beforeSubmit);
    expect(actual).toBe(expected);
    // ACP's helper is itself the concrete Writable operation. Other helpers
    // only serialize; their final destination must enter the writer owner.
    if (name !== "acp") {
      expect(f.budget.counts.bytes).toBe(before.bytes);
      wire!.emitEngineWire(f.input.beforeSubmit, actual, () => { expect(f.f.db.isTransaction).toBe(true); });
    }
    expect(f.budget.counts.bytes).toBe(budgets!.RELEASE_LIMITS.bytes);
    expect(f.budget.counts.attempts - before.attempts).toBe(1);
    expect(f.submitted).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

// red-at-4df086541: the concrete ACP writer serialized after the turn fence,
// allowing an expanded prompt/interjection to write beyond the shared cap.
it.each(["session/prompt", "_fuigo/interject"])("T-ENGINE-FINAL-WIRE ACP %s final writer", async method => {
  const f = await fixture();
  try {
    const { writeAcpResponse } = await import("./acp/approval-delivery.ts");
    const write = vi.fn(), done = vi.fn();
    const stream = new Writable({ write(chunk, _encoding, cb) { write(chunk); cb(); } });
    f.budget.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - f.budget.counts.bytes - Buffer.byteLength(f.prompt.text) });
    writeAcpResponse(stream, { jsonrpc: "2.0", id: 1, method, params: { text: f.prompt.text } }, done, undefined, null, f.input.beforeSubmit);
    expect(write).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: "MEMORY_CONTEXT_REVOKED" }), false);
    stream.destroy();
  } finally { f.close(); }
});

// red-at-4df086541: delayed steers must retain their original callback owner;
// the final serialization may expand after the caller's prompt check.
it("T-ENGINE-FINAL-WIRE delayed steer retains its owner and pays each write", async () => {
  const f = await fixture(), newer = new budgets!.ReleaseBudget(vi.fn());
  try {
    let before: (() => void) | undefined;
    await engine!.steerBuilt({ steer: async (_thread, _text, callback) => { before = callback; return true; } }, "T", f.prompt,
      { reader: { audience: null }, db: f.f.db, retained: f.turn });
    const frame = { type: "user", message: { role: "user", content: f.prompt.text } };
    const bytes = Buffer.byteLength(JSON.stringify(frame) + "\n");
    f.budget.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - f.budget.counts.bytes - bytes });
    const { withUpstreamOwner } = await import("../memory/upstream-reader.ts");
    await Promise.resolve();
    expect(withUpstreamOwner({ budgets: [newer], refuse: (): never => { throw new Error("wrong owner"); } }, () => {
      const serialized = wire!.engineJsonLine(frame, before);
      return wire!.emitEngineWire(before, serialized, () => serialized);
    })).toBe(JSON.stringify(frame) + "\n");
    expect(f.budget.counts.bytes).toBe(budgets!.RELEASE_LIMITS.bytes);
    expect(newer.counts.bytes).toBe(0);
    expect(() => wire!.engineJsonLine(frame, before)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(newer.counts.bytes).toBe(0);
  } finally { f.close(); }
});
