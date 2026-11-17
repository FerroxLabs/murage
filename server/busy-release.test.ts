import { expect, it, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { fixtureContract } from "./memory/testing/writetime-fixture.ts";
const available = existsSync(new URL("./consuming-turn-response.ts", import.meta.url));
const api = available ? await import("./consuming-turn-response.ts") : undefined;
const fixtures = available ? await import("./testing/consuming-fixture.ts") : undefined;

// red-at-4df086541: an already-open response could append a busy/exception
// body after revocation instead of closing its original bound stream.
it.each(["flip", "replacement", "lookup-busy"])("T-BUSY-RELEASE open stream %s emits no exception bytes", failure => {
  expect(api?.consumingHttpWriter, "open responses must retain the request binding").toBeTypeOf("function");
  const f = fixtures!.consumingFixture(), sink = fixtures!.consumingResponseRecorder();
  try {
    const writer = api!.consumingHttpWriter(sink.raw, f.binding, {
      headers: api!.registerConsumingDescriptor("outer:response:headers", "headers"),
      body: api!.registerConsumingDescriptor("outer:response:body", "body"),
      chunk: api!.registerConsumingDescriptor("outer:response:chunk", "chunk"),
    });
    api!.declareNoStoredResponse(writer, 200);
    writer.write("accepted chunk");
    const before = [...sink.output];
    if (failure === "flip") f.flip();
    if (failure === "replacement") f.replace();
    if (failure === "lookup-busy") f.f.db.close();
    writer.writeHead(503, { "retry-after": "1" });
    expect(() => writer.end("DATABASE_BUSY")).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(sink.output).toEqual(before); expect(sink.destroyed).toBe(true);
    expect(f.refusals).toBe(1); expect(sink.headers.has("retry-after")).toBe(false);
  } finally { f.close(); }
});

// red-at-4df086541: the next tool response could release despite a revoked previous tool result.
it("T-D3 emits only the fixed refusal before headers after a tool-result flip", async () => {
  expect(api?.consumingHttpWriter, "tool HTTP release must recheck previously returned parents").toBeTypeOf("function");
  const f = fixtures!.consumingFixture(undefined, { empty: true });
  const { turnToolText } = await import("./memory/prompt-parts.ts");
  try {
    const result = turnToolText(f.turn, "line X", [{ kind: "line", threadId: "T", messageId: "X" }]);
    api!.emitConsumingTurnResponse(f.binding, api!.registerConsumingDescriptor("native:openai:tool-append", "native"), {
      bytes: 6, refs: result.lineageOf, write: () => {},
    });
    f.flip();
    const sink = fixtures!.fixtureHttp(f.binding);
    api!.stageConsumingResponse(sink.writer, []);
    sink.writer.writeHead(200);
    expect(() => sink.writer.end("next tool result")).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(sink.output.map(row => row.body ?? "").join("")).toBe("I stopped this turn because some of its context is no longer available.");
    expect(sink.output.every(row => row.status === 409)).toBe(true);
    expect(f.refusals).toBe(1);
  } finally { f.close(); }
});

// red-at-4df086541: busy/outer exceptions wrote raw retryable bodies without checking the consuming generation.
it.each(["live", "flip", "replacement", "lookup-busy"])("T-BUSY-RELEASE %s", failure => {
  expect(api?.consumingHttpWriter, "outer busy responses require the captured consuming writer").toBeTypeOf("function");
  const f = fixtures!.consumingFixture(), sink = fixtures!.consumingResponseRecorder();
  try {
    const writer = api!.consumingHttpWriter(sink.raw, f.binding, {
      headers: api!.registerConsumingDescriptor("outer:response:headers", "headers"),
      body: api!.registerConsumingDescriptor("outer:response:body", "body"),
      chunk: api!.registerConsumingDescriptor("outer:response:chunk", "chunk"),
    });
    if (failure === "flip") f.flip();
    if (failure === "replacement") f.replace();
    if (failure === "lookup-busy") f.f.db.close();
    api!.declareNoStoredResponse(writer, 503);
    writer.writeHead(503, { "retry-after": "1" });
    const end = () => writer.end(JSON.stringify({ code: "DATABASE_BUSY", retryable: true }));
    if (failure === "live") end();
    else expect(end).toThrow("MEMORY_CONTEXT_REVOKED");
    const body = sink.output.map(row => row.body ?? "").join("");
    if (failure === "live") { expect(body).toContain("DATABASE_BUSY"); expect(f.refusals).toBe(0); }
    else {
      expect(body).toBe("I stopped this turn because some of its context is no longer available.");
      expect(sink.output.every(row => row.status === 409)).toBe(true); expect(f.refusals).toBe(1);
      expect(sink.headers.has("retry-after")).toBe(false);
    }
  } finally { f.close(); }
});

const held: Array<{ close(): void }> = [];
afterEach(() => held.splice(0).forEach(f => f.close()));

// red-at-4df086541: the outer catch's harmless-looking 503 is still a release
// into a context retaining X. Test request-owned writer after an await.
it.each(["flip", "replacement"])("T-BUSY-RELEASE %s cannot emit retryable content", async change => {
  const api = await fixtureContract<typeof import("./consuming-turn-response.ts")>(new URL("./consuming-turn-response.ts", import.meta.url), "§12.3 requires the outer busy response to retain its request-owned binding");
  const { consumingFixture, fixtureHttp } = await import("./testing/consuming-fixture.ts");
  const f = consumingFixture(); held.push(f);
  const sink = fixtureHttp(f.binding);
  await Promise.resolve(); if (change === "flip") f.flip(); else f.replace();
  api.declareNoStoredResponse(sink.writer, 503);
  try { sink.writer.writeHead(503, { "content-type": "application/json" }); sink.writer.end('{"retry":true}'); } catch { /* terminal refusal is asserted at the destination below */ }
  expect(sink.output.some(row => row.status === 503)).toBe(false);
  expect(sink.output.some(row => row.body?.includes("retry"))).toBe(false);
  expect(f.refusals).toBe(1);
});

// control: a valid ledger may still report the existing retryable busy status.
it("T-BUSY-RELEASE live request keeps the 503 response", async () => {
  const api = await fixtureContract<typeof import("./consuming-turn-response.ts")>(new URL("./consuming-turn-response.ts", import.meta.url), "request-owned busy writer contract");
  const { consumingFixture, fixtureHttp } = await import("./testing/consuming-fixture.ts");
  const f = consumingFixture(); held.push(f); const sink = fixtureHttp(f.binding);
  api.declareNoStoredResponse(sink.writer, 503); sink.writer.writeHead(503); sink.writer.end('{"retry":true}');
  expect(sink.output).toContainEqual({ status: 503, body: '{"retry":true}' }); expect(f.refusals).toBe(0);
});
