import { beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { createSseParser } from "../model-gateway-translate.ts";
const budgetModule = await import(new URL("./release-budget.ts", import.meta.url).href).catch(() => null);
const readerModule = await import(new URL("./upstream-reader.ts", import.meta.url).href).catch(() => null);
beforeEach(() => expect(readerModule, "T-UPSTREAM-BUDGET requires accounting before decode, including non-emitting streams").not.toBeNull());
const budgetUrl = new URL("./release-budget.ts", import.meta.url), readerUrl = new URL("./upstream-reader.ts", import.meta.url);
const budgetApi = existsSync(budgetUrl) ? await import(budgetUrl.href) as typeof import("./release-budget.ts") : undefined;
const readerApi = existsSync(readerUrl) ? await import(readerUrl.href) as typeof import("./upstream-reader.ts") : undefined;
const RELEASE_LIMITS = budgetModule?.RELEASE_LIMITS ?? { work: 16777216, statements: 65536 };
const { UPSTREAM_COLLECTION_MAX, UPSTREAM_EVENT_MAX } = budgetModule ?? {} as typeof import("./release-budget.ts");
beforeEach(() => {
  expect(UPSTREAM_COLLECTION_MAX).toBe(8 * 1024 * 1024);
  expect(UPSTREAM_EVENT_MAX).toBe(1024 * 1024);
});
const readConsumingUpstream: typeof import("./upstream-reader.ts").readConsumingUpstream = (...args) => {
  expect(readerApi?.readConsumingUpstream, "§12.4 raw upstream accounting must precede decode and collection").toBeTypeOf("function");
  return readerApi!.readConsumingUpstream(...args);
};

function setup(mode: "sse" | "collection", collect = false) {
  expect(budgetApi?.ReleaseBudget, "upstream reads must share generation counters with releases").toBeTypeOf("function");
  expect(readerApi?.UpstreamAccounting, "upstream staging must be bounded independently of downstream frames").toBeTypeOf("function");
  const stop = vi.fn(); let sealed = false;
  const refuse = () : never => { if (!sealed) { sealed = true; stop(); } throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }); };
  const budget = new budgetApi!.ReleaseBudget(refuse);
  return { budget, stop, accounting: new readerApi!.UpstreamAccounting([budget], mode, refuse, collect) };
}
// red-at-4df086541: upstream bytes consume budget even without downstream events.
// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the stream was stopped by crossing the
// 64 MiB byte budget; now the budget is sealed first by a work crossing with no accepted release, and the sealed budget stops it.
it("T-UPSTREAM-BUDGET stops an endless stream on a sealed budget before decoding its next bytes", async () => {
  const f = setup("sse"), decode = vi.fn(), cancel = vi.fn();
  expect(() => f.budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([65])); }, cancel }));
  await expect(readConsumingUpstream(response, f.accounting, decode)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(decode).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: exhaustion is shared across reads; starting another stream
// or ending an event must not reset byte/work charges.
// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the second reader was refused at the
// 64 MiB byte budget; now the shared byte count is asserted directly and the shared refusal is reached by sealing the generation.
it("T-UPSTREAM-BUDGET separate readers debit the same generation", () => {
  const f = setup("collection");
  f.budget.charge({ bytes: 64 * 1024 * 1024 - 2 });
  f.accounting.accept(new Uint8Array(1)); f.accounting.end();
  const next = new readerApi!.UpstreamAccounting([f.budget], "collection", () => { throw new Error("MEMORY_CONTEXT_REVOKED"); });
  next.accept(new Uint8Array(1));
  expect(f.budget.counts.bytes).toBe(64 * 1024 * 1024);
  expect(() => next.accept(new Uint8Array(1))).not.toThrow();
  expect(f.budget.counts.bytes).toBe(64 * 1024 * 1024 + 1);
  expect(() => f.budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => next.accept(new Uint8Array(1))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.stop).toHaveBeenCalledOnce();
});
// red-at-4df086541: staging limits apply before accumulation, including streams collected into JSON.
// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, one SSE event over 1 MiB or a
// (collected) body over 8 MiB refused the turn; now the same input is counted and not refused.
it.each(["sse", "collection", "collected-sse"] as const)("counts former oversized %s staging without refusing it", mode => {
  const f = setup(mode === "collection" ? "collection" : "sse", mode === "collected-sse");
  let total = 0;
  if (mode === "collected-sse") {
    const event = Buffer.from("data: {}\n\n");
    expect(() => { for (let n = 0; n <= UPSTREAM_COLLECTION_MAX; n += event.length) { f.accounting.accept(event); total += event.length; } }).not.toThrow();
  } else {
    const max = mode === "sse" ? UPSTREAM_EVENT_MAX : UPSTREAM_COLLECTION_MAX;
    expect(() => f.accounting.accept(new Uint8Array(max + 1))).not.toThrow();
    total = max + 1;
  }
  expect(f.budget.counts.bytes).toBe(total);
  expect(() => f.accounting.end()).not.toThrow();
  expect(f.budget.refused).toBe(false); expect(f.stop).not.toHaveBeenCalled();
});
// control: CRLF split across network reads counts each complete event once.
it("accounts for split delimiters before passing a valid event to the decoder", async () => {
  const f = setup("sse"), events = vi.fn(), parser = createSseParser(events), decoder = new TextDecoder();
  const chunks = ["data: {}\r", "\n\r", "\n"];
  const response = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } }));
  await readConsumingUpstream(response, f.accounting, chunk => parser.push(decoder.decode(chunk, { stream: true })));
  // "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, work was 4 + one unit per raw byte
  // (per-chunk, per-byte and per-event work); now transport work is not counted and only end() charges one unit in sse mode.
  expect(events).toHaveBeenCalledTimes(1); expect(f.budget.counts.work).toBe(1); expect(f.stop).not.toHaveBeenCalled();
});
// red-at-4df086541: callback failure was swallowed by the parser and stream reader.
it("propagates terminal release failure through SSE parsing and cancels upstream", async () => {
  const f = setup("sse"), cancel = vi.fn();
  const parser = createSseParser(() => { throw new Error("MEMORY_CONTEXT_REVOKED"); });
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from("data: {}\n\n")); }, cancel }));
  await expect(readConsumingUpstream(response, f.accounting, chunk => parser.push(new TextDecoder().decode(chunk)))).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(cancel).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: comments and incomplete events could consume unlimited work without output.
// "MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn": before, the next byte past the 64 MiB byte
// budget refused; now it is counted, and the refusal of the next read is reached by sealing the budget with a work crossing.
it.each([": keepalive\n\n", "data: unfinished", ": unterminated"])("T-UPSTREAM-BUDGET charges non-emitting %s", text => {
  const f = setup("sse"); f.budget.charge({ bytes: 64 * 1024 * 1024 - Buffer.byteLength(text) });
  f.accounting.accept(Buffer.from(text));
  expect(f.budget.counts.bytes).toBe(64 * 1024 * 1024);
  expect(() => f.accounting.accept(Buffer.from("x"))).not.toThrow();
  expect(f.budget.counts.bytes).toBe(64 * 1024 * 1024 + 1);
  expect(() => f.budget.charge({ work: RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => f.accounting.accept(Buffer.from("x"))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.stop).toHaveBeenCalledTimes(1);
});
// control: byte-split UTF-8 survives accounting and streaming decoding.
it("preserves a UTF-8 scalar split across reads", async () => {
  const f = setup("sse"), output: string[] = [], decoder = new TextDecoder();
  const encoded = Buffer.from('data: {"text":"🙂"}\n\n');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }));
  await readConsumingUpstream(response, f.accounting, chunk => { output.push(decoder.decode(chunk, { stream: true })); });
  expect(output.join("") + decoder.decode()).toBe(encoded.toString());
  expect(f.budget.counts.bytes).toBe(encoded.byteLength);
});
// red-at-4df086541: downstream writers could receive arbitrarily large raw chunks.
it("bounds chunks to 64 KiB before downstream expansion", async () => {
  const f = setup("collection"), lengths: number[] = [];
  const response = new Response(new Uint8Array(128 * 1024 + 1));
  await readConsumingUpstream(response, f.accounting, chunk => { lengths.push(chunk.byteLength); });
  expect(lengths).toEqual([65536, 65536, 1]);
});

it("cancels native upstream failure without reclassifying it as a ledger refusal", async () => {
  const f = setup("sse"), native = new Error("fixture native stream failure");
  const response = new Response(new ReadableStream({ start(controller) { controller.error(native); } }));
  await expect(readConsumingUpstream(response, f.accounting, vi.fn())).rejects.toBe(native);
  expect(f.stop).not.toHaveBeenCalled();
});

it("R1 request preparation and actual enqueue charge one release only", async () => {
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const { releaseNativeAnswer } = await import("../drivers/engine-input.ts");
  const f = consumingFixture(), wire = '{"prompt":"é"}';
  try {
    readerApi!.withUpstreamOwner({ budgets: [f.budget], refuse: () => { throw new Error("unexpected refusal"); } }, () => {
      readerApi!.reserveUpstreamRequest(Buffer.byteLength(wire));
      expect(f.budget.counts).toMatchObject({ attempts: 0, bytes: 0 });
      releaseNativeAnswer(f.binding, "openai:fetch", wire, () => {
        expect(f.f.db.isTransaction).toBe(true);
        expect(f.budget.counts).toMatchObject({ attempts: 1, bytes: Buffer.byteLength(wire) });
      });
    });
  } finally { f.close(); }
});

it("P2 accounted response preserves native stream errors without ledger refusal", async () => {
  const f = setup("sse"), native = new Error("native socket loss");
  const response = readerApi!.withUpstreamOwner({ budgets: [f.budget], refuse: f.accounting.refuse }, () =>
    readerApi!.accountedResponse(new Response(new ReadableStream({ start(controller) { controller.error(native); } }),
      { headers: { "content-type": "text/event-stream" } })));
  await expect(response.text()).rejects.toBe(native);
  expect(f.stop).not.toHaveBeenCalled();
});
