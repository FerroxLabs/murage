import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runBrowserExtensionMcp } from "./browser-extension-mcp.ts";
// MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn; RELEASE_LIMITS has no
// byte budget any more. The exact-cap control below keeps its old value as a plain
// large count (counted, not refused); the crossing cases seal the budget instead (inherited failures on e1767b8540, proxyOwnerTurn mock gap).
const OLD_BYTE_BUDGET = 64 * 1024 * 1024;
const released: any[] = [];
let refused = false;
let reserveInput: (bytes: number) => void = () => {};
let wrapResponse: (response: Response) => Response = response => response;
beforeEach(({ task }) => {
  // E exercises the real unbound entry; keep the generation-gate mocks in HEAD tests.
  if (task.name.startsWith("T-PROXY-RELEASE")) return;
  // Assertion precedes module resolution on the baseline, where this shared
  // release module does not exist. The reason is the independent local writer.
  expect(readFileSync(new URL("./browser-extension-mcp.ts", import.meta.url), "utf8"),
    "T-BEM-LOCAL-REPLIES: every local browser reply must use the shared generation gate").toContain("releaseProxyFrame");
  vi.resetModules(); released.length = 0; refused = false;
  reserveInput = () => {}; wrapResponse = response => response;
  vi.doMock("../proxy-turn-release.ts", () => ({
    releaseProxyFrame: async (_role: string, frame: string) => {
      if (refused) throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
      released.push(JSON.parse(frame));
    },
    reserveProxyUpstream: async (_role: string, bytes: number) => reserveInput(bytes), proxyUpstreamResponse: (_role: string, response: Response) => wrapResponse(response),
    proxyTransportLost: () => { refused = true; },
  }));
});
afterEach(() => { vi.doUnmock("../proxy-turn-release.ts"); });
const config = { endpoint: "http://127.0.0.1:1234/api/browser-extension/mcp", clientId: "test", token: "a".repeat(43) };
const rpc = (id: unknown, method: string) => JSON.stringify({ jsonrpc: "2.0", id, method });
const cases = [
  ["initialize", rpc(1, "initialize"), 1], ["success", rpc(1, "ping"), 1],
  ["error", rpc(1, "tools/call"), 1], ["method-not-found", rpc(1, "missing"), 1],
  ["parse", "{", null], ["non-object", "[]", null], ["invalid-ID", rpc({}, "ping"), null],
  ["duplicate-ID", `${rpc(1, "ping")}\n${rpc(1, "ping")}`, 1],
  ["capacity", Array.from({ length: 17 }, (_, n) => rpc(n + 1, "ping")).join("\n"), 17],
] as const;
// red-at-4df086541: these exact runBrowserExtensionMcp branches wrote directly.
it.each(cases)("T-BEM-LOCAL-REPLIES %s reaches the common gate", async (_name, input, id) => {
  const { runBrowserExtensionMcp } = await import("./browser-extension-mcp.ts");
  const raw = vi.fn(), output = new Writable({ write(chunk, _encoding, done) { raw(chunk); done(); } });
  await runBrowserExtensionMcp({ config, input: Readable.from([input + "\n"]), output });
  expect(released.some(frame => frame.id === id)).toBe(true); expect(raw).not.toHaveBeenCalled();
});
// red-at-4df086541: a failed boundary could become an ordinary local error reply.
it.each(cases)("T-BEM-LOCAL-REPLIES revoked %s emits no result or fallback", async (_name, input) => {
  const { runBrowserExtensionMcp } = await import("./browser-extension-mcp.ts");
  refused = true;
  await expect(runBrowserExtensionMcp({ config, input: Readable.from([input + "\n"]) })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(released).toEqual([]);
});

async function upstreamFixture() {
  const budgets = await import("../memory/release-budget.ts").catch(() => null);
  const readers = await import("../memory/upstream-reader.ts").catch(() => null);
  expect(budgets?.ReleaseBudget, "T-UPSTREAM-BUDGET requires server generation reservations").toBeTypeOf("function");
  expect(readers?.accountedResponse, "T-UPSTREAM-BUDGET requires ownership before body decoding").toBeTypeOf("function");
  const stop = vi.fn();
  const refuse = (): never => {
    if (!refused) { refused = true; stop(); }
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  };
  const counter = new budgets!.ReleaseBudget(refuse);
  const owner = { budgets: [counter], refuse };
  reserveInput = bytes => counter.charge({ bytes, work: 1 });
  wrapResponse = response => readers!.withUpstreamOwner(owner, () => readers!.accountedResponse(response));
  return { budgets: budgets!, counter, stop };
}
// red-at-4df086541: the actual browser upstream path could return a local
// error after crossing, and input frames were parsed before server reservation.
it.each(["input", "upstream"] as const)("T-UPSTREAM-BUDGET browser-extension %s crossing cancels with no fallback", async row => {
  const f = await upstreamFixture();
  const { runBrowserExtensionMcp } = await import("./browser-extension-mcp.ts");
  const cancel = vi.fn(), sourceClosed = vi.fn();
  const request = vi.fn(async () => {
    // MAIN-RULING cause22-no-transport-caps: filling the old byte budget no longer refuses; the upstream row seals the budget here (a
    // work-limit crossing with no accepted release) so the upstream body's charge is the refused one, as before.
    try { f.counter.charge({ work: f.budgets.RELEASE_LIMITS.work + 1 }); } catch { /* sealed: the next charge is refused */ }
    return new Response(new ReadableStream({ pull(c) { c.enqueue(Buffer.from('{"tools":[]}')); }, cancel }, { highWaterMark: 0 }));
  });
  // MAIN-RULING cause22-no-transport-caps (Sean 2026-11-22): no transport size or count cap refuses a turn. Before: the input row filled
  // the 64 MiB byte cap so the input frame's reservation crossed it. Now: it seals the budget first (a work-limit crossing, stop once) so
  // the input frame's reservation is the refused charge, still before any parse, fetch or fallback.
  if (row === "input") expect(() => f.counter.charge({ work: f.budgets.RELEASE_LIMITS.work + 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  const input = Readable.from((async function* () {
    try { yield Buffer.from(rpc(1, "tools/list") + "\n"); }
    finally { sourceClosed(); }
  })());
  await expect(runBrowserExtensionMcp({ config, input, fetch: request as typeof fetch })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.stop).toHaveBeenCalledTimes(1); expect(released).toEqual([]);
  expect(sourceClosed).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(row === "input" ? 0 : 1);
  expect(cancel).toHaveBeenCalledTimes(row === "input" ? 0 : 1);
});
// control: byte-split UTF-8 in both input ids and upstream tool metadata is
// preserved by the concrete proxy; input plus response debit exactly the cap.
it("T-UPSTREAM-BUDGET browser-extension input and upstream split UTF-8 exact cap", async () => {
  const f = await upstreamFixture();
  const { runBrowserExtensionMcp } = await import("./browser-extension-mcp.ts");
  const input = Buffer.from(rpc("🙂", "tools/list") + "\n"), body = Buffer.from('{"tools":[],"fixture":"🙂"}');
  f.counter.charge({ bytes: OLD_BYTE_BUDGET - input.length - body.length });
  const request = vi.fn(async () => new Response(new ReadableStream({ start(c) {
    for (const byte of body) c.enqueue(Uint8Array.of(byte)); c.close();
  } })));
  await runBrowserExtensionMcp({ config, input: Readable.from([...input].map(byte => Buffer.from([byte]))), fetch: request as typeof fetch });
  expect(released).toEqual([{ jsonrpc: "2.0", id: "🙂", result: { tools: [] } }]);
  expect(f.counter.counts.bytes).toBe(OLD_BYTE_BUDGET);
  expect(f.stop).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
});

// red-at-4df086541: a crossing input frame left an already dispatched browser
// fetch alive; it could finish after the consuming generation had been refused.
it("T-UPSTREAM-BUDGET browser-extension input crossing cancels in-flight work", async () => {
  const f = await upstreamFixture();
  const { runBrowserExtensionMcp } = await import("./browser-extension-mcp.ts");
  const aborted = vi.fn(), closed = vi.fn();
  let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const request = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted(); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    started();
  }));
  const input = Readable.from((async function* () {
    try {
      yield Buffer.from(rpc(1, "tools/list") + "\n");
      await opening;
      // MAIN-RULING cause22-no-transport-caps: the old byte budget no longer refuses; sealing the budget makes the next input frame's
      // reservation the refused charge, as filling it did before.
      try { f.counter.charge({ work: f.budgets.RELEASE_LIMITS.work + 1 }); } catch { /* sealed */ }
      yield Buffer.from(rpc(2, "ping") + "\n");
    } finally { closed(); }
  })());
  await expect(runBrowserExtensionMcp({ config, input, fetch: request as typeof fetch })).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(aborted).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  expect(released).toEqual([]);
});


const unboundConfig = { endpoint: "http://127.0.0.1:1/api/browser-extension/mcp", clientId: "e-fixture", token: "x".repeat(43) };
const unboundCases = [
  ["method-not-found", '{"jsonrpc":"2.0","id":1,"method":"missing"}'],
  ["parse-error", '{'], ["non-object", '[]'],
  ["invalid-id", '{"jsonrpc":"2.0","id":{},"method":"ping"}'],
  ["initialize", '{"jsonrpc":"2.0","id":1,"method":"initialize"}'],
  ["ping", '{"jsonrpc":"2.0","id":1,"method":"ping"}'],
  ["tools-list", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
  ["validation", '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}'],
] as const;

// red-at-4df086541: actual runBrowserExtensionMcp local final writes lacked a
// generation binding. Exercise the real entry, including independent replies
// at design D:403, rather than calling the shared emitter with a made-up label.
it.each(unboundCases)("T-PROXY-RELEASE browser-extension %s cannot answer without binding", async (_name, request) => {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  try {
    await runBrowserExtensionMcp({ config: unboundConfig, input: Readable.from([request + "\n"]), output: sink,
      fetch: async () => new Response('{"tools":[]}', { status: 200 }) });
  } catch { /* admission/terminal refusal is expected; payload assertion is decisive */ }
  const frames = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(frames.filter(frame => frame.error?.code !== -32099), "missing binding must suppress every ordinary engine frame").toEqual([]);
  for (const frame of frames) expect(frame.error).toEqual({ code: -32099,
    message: "I stopped this turn because some of its context is no longer available.", data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } });
});

// red-at-4df086541: duplicate-id and capacity replies were independent local
// writes too. One input chunk fills the pending map before any fake fetch ends.
it.each(["duplicate-id", "capacity"])("T-PROXY-RELEASE browser-extension %s has no local fallback", async kind => {
  let output = "";
  const replies: Array<() => void> = [];
  const count = kind === "duplicate-id" ? 2 : 17;
  const requests = Array.from({ length: count }, (_, i) => JSON.stringify({ jsonrpc: "2.0", id: kind === "duplicate-id" ? 1 : i, method: "tools/list" })).join("\n") + "\n";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const done = runBrowserExtensionMcp({ config: unboundConfig, input: Readable.from([requests]), output: sink,
    fetch: async () => { await new Promise<void>(resolve => replies.push(resolve)); return new Response('{"tools":[]}'); } }).catch(() => {});
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const reply of replies) reply(); await done;
  const frames = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(frames.filter(frame => frame.error?.code !== -32099)).toEqual([]);
});
