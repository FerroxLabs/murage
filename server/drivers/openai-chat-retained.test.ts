import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { expect, it, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { recordEvents } from "../testing/events.ts";
import { fencedTurnInput } from "./engine-input.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "../memory/lineage-write.ts";
import * as lineage from "../memory/lineage-write.ts";
import * as fences from "../memory/send-fence.ts";
import { buildPrompt, noneRef, promptPart, ownReplayRefs, turnToolText } from "../memory/prompt-parts.ts";
import type { ChatMcpSession } from "./chat-mcp-client.ts";
import { CONTENT, MEMBER, WritetimeFixture } from "../memory/testing/writetime-fixture.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { TurnLineage } from "../memory/lineage-types.ts";
const available = existsSync(new URL("../consuming-turn-response.ts", import.meta.url));
const fixtures = available ? await import("../testing/consuming-fixture.ts") : undefined;

// red-at-4df086541: a provider fetch already in flight was independent of
// the retained refusal lifecycle. Stop the actual runtime lease, observe its
// request signal, and ensure a newer turn's binding is never used as authority.
it.each(["refusal", "replacement", "transport-loss", "stream-error", "stream-eof"])("T-EXTERNAL-STOP pending provider fetch/%s", async failure => {
  expect(fences.assertRetainedFence, "pending provider work must belong to the consuming lease").toBeTypeOf("function");
  const { createLedgerLease } = await import("../ledger-refusal.ts");
  const { releaseNativeAnswer } = await import("./engine-input.ts");
  let lease: ReturnType<typeof createLedgerLease>;
  const f = fixtures!.consumingFixture(undefined, { onRefused: verdict => lease.onLedgerRefused(verdict) });
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "pending-provider", displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: "pending-provider", apiKey: "fixture", apiUrl: "https://chat.invalid/v1", tools: false,
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  let entered!: () => void, signal: AbortSignal | undefined, lose!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const fetching = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    signal = init.signal as AbortSignal;
    lose = () => reject(Object.assign(new Error("fixture transport loss"), { code: "ECONNRESET" }));
    signal.addEventListener("abort", () => reject(new DOMException("Fixture stop", "AbortError")), { once: true });
    if (failure.startsWith("stream-")) resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      if (failure === "stream-eof") controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'));
      lose = () => { if (failure === "stream-eof") controller.close(); else controller.error(new Error("fixture stream loss")); };
    } }), { headers: { "content-type": "text/event-stream" } }));
    entered();
  }));
  vi.stubGlobal("fetch", fetching);
  const settle = vi.fn(), present = vi.fn(), interrupted: string[] = [];
  lease = createLedgerLease(f.binding.identity, { seal: vi.fn(), settle, present, quarantine: vi.fn(), interrupt: async id => {
    interrupted.push(id); const stopped = await runtime.adapter.interruptTurn("T", id);
    return Boolean(stopped && stopped.closeConfirmed === true);
  } });
  const pendingEvents = recordEvents(runtime.adapter);
  try {
    const accepted = await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "fixture", releaseBinding: f.binding });
    lease.attach(accepted.turnId);
    await Promise.race([pending, pendingEvents.until(e => e.type === "turn.completed", 3000).then(done => {
      throw new Error(`provider completed before fetch: ${JSON.stringify(done)}; ${JSON.stringify(pendingEvents.events.filter(e => e.type === "runtime.error"))}`);
    })]);
    if (failure === "stream-eof") {
      // 7C P2 (7C-TRIAGE-RULING.md section 3; MurageMain ruling 3, 2026-11-08): only the fence or the release-budget seal refuses.
      // A stream that ends early keeps the driver's native ending: incomplete, with the partial reply kept, and no ledger refusal.
      const events = recordEvents(runtime.adapter);
      lose();
      const done = await events.until((e) => e.type === "turn.completed" && e.threadId === "T");
      expect(done).toMatchObject({ ok: false, stopReason: "incomplete" });
      expect(events.events.flatMap((e) => e.type === "item.completed" && e.itemType === "assistant_text" ? [e.text] : [])).toEqual(["partial answer"]);
      expect(events.events.flatMap((e) => e.type === "runtime.error" ? [e.message] : [])).toEqual(["The model server stopped before it finished this answer."]);
      expect(f.refusals).toBe(0); expect(interrupted).toEqual([]);
      events.stop(); lease.completed(); return;
    }
    if (failure === "transport-loss") {
      // 7C P2 (7C-TRIAGE-RULING.md section 3; MurageMain ruling 1, 2026-11-08): the fetch rejects before any stream exists, so no partial
      // reply is possible. A provider transport failure is not a ledger lookup: the driver's native ending is stopReason "error", no refusal.
      const events = recordEvents(runtime.adapter);
      lose();
      const done = await events.until((e) => e.type === "turn.completed" && e.threadId === "T");
      expect(done).toMatchObject({ ok: false, stopReason: "error" });
      expect(events.events.flatMap((e) => e.type === "item.completed" && e.itemType === "assistant_text" ? [e.text] : [])).toEqual([]);
      expect(events.events.flatMap((e) => e.type === "runtime.error" ? [e.message] : [])).toEqual(["Could not reach chat.invalid: nothing answered there. Check that the server is running and that its address is right."]);
      expect(f.refusals).toBe(0); expect(interrupted).toEqual([]);
      events.stop(); lease.completed(); return;
    }
    if (failure === "stream-error") {
      lose();
      const done = await pendingEvents.until(e => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "incomplete" });
      expect(f.refusals).toBe(0); expect(interrupted).toEqual([]);
      lease.completed(); return;
    }
    if (failure === "refusal") f.flip(); else f.replace();
    const write = vi.fn();
    expect(() => releaseNativeAnswer(f.binding, "openai:decision", "allow", write)).toThrow("MEMORY_CONTEXT_REVOKED");
    await Promise.resolve(); await Promise.resolve();
    expect(signal?.aborted).toBe(true); expect(interrupted).toEqual([accepted.turnId]);
    expect(fetching).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1); expect(present).toHaveBeenCalledTimes(1);
    lease.completed(); expect(settle).toHaveBeenCalledTimes(1);
  } finally { pendingEvents.stop(); await runtime.dispose(); vi.unstubAllGlobals(); f.close(); }
});
const toolFixture = vi.hoisted(() => ({ call: undefined as undefined | (() => Promise<{ isError: boolean; text: string; droppedImages: number }>), session: undefined as ChatMcpSession | undefined }));
vi.mock("./chat-mcp-client.ts", async original => {
  const actual = await original<typeof import("./chat-mcp-client.ts")>();
  return { ...actual, openChatMcpServers: (...args: Parameters<typeof actual.openChatMcpServers>) => toolFixture.call
    ? Promise.resolve({ failed: [], sessions: [{ server: "memory", tools: [{ name: "read_messages", inputSchema: { type: "object" } }],
      callTool: () => toolFixture.call!(), retire: () => {}, close: () => {} }] })
    : toolFixture.session ? Promise.resolve({ sessions: [toolFixture.session], failed: [] }) : actual.openChatMcpServers(...args) };
});

// red-at-4df086541: T-D1a/c's second provider fetch omitted the tool result's
// newly retained parents. control: T-D1d preserves owner audience-only delivery.
it.each(["T-D1a", "T-D1c", "T-D1d"])("%s checks tool-result X at the actual next fetch", async label => {
  const { WritetimeFixture, MEMBER } = await import("../memory/testing/writetime-fixture.ts");
  const { openTurnLineage, closeTurnLineage } = await import("../memory/lineage-write.ts");
  const reader = label === "T-D1a" ? MEMBER : { audience: null };
  const legacy = available ? undefined : new WritetimeFixture().reply("T", "X", 1);
  const legacyTurn = legacy ? openTurnLineage(legacy.db, { threadId: "T", turnId: label }) : undefined;
  const f = fixtures ? fixtures.consumingFixture(reader, { empty: true }) : {
    f: legacy!, turn: legacyTurn!, binding: undefined as never, refusals: 0,
    flip() { legacy!.db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)"); legacy!.denyLine("T", 1, 7); },
    close() { closeTurnLineage(legacyTurn!); legacy!.close(); },
  };
  const { turnToolText, buildPrompt, promptPart, noneRef } = await import("../memory/prompt-parts.ts");
  const initial = buildPrompt(f.turn, [promptPart("question", [noneRef("owner-turn")])]);
  const response = available ? await import("../consuming-turn-response.ts") : undefined;
  let admission: import("./mcp-mounts.ts").McpMountAdmission | undefined;
  if (available) {
    const { createMcpMountAdmission } = await import("./mcp-mounts.ts");
    const { createProxyReleaseAuthority } = await import("../consuming-turn-ingress.ts");
    const { InternalCapabilities } = await import("../internal-capabilities.ts");
    const caps = new InternalCapabilities(); caps.begin("B", "T", f.binding.identity.dispatchGeneration);
    admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  }
  let flipped = false;
  toolFixture.call = async () => {
    const result = turnToolText((available ? f.turn : "T") as never, "retained tool X", [{ kind: "line", threadId: "T", messageId: "X" }]);
    if (response) response.emitConsumingTurnResponse(f.binding, response.registerConsumingDescriptor("native:openai:tool-append", "native"), {
      bytes: 15, refs: result.lineageOf, write: () => {},
    });
    return { isError: false, text: "retained tool X", droppedImages: 0 };
  };
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: label, displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: label, apiKey: "fixture", apiUrl: "https://chat.invalid/v1",
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => {
      if (!flipped && messages.some(message => message.role === "tool")) {
        flipped = true;
        if (label === "T-D1c") { f.f.denyLine("T", 1, 8); f.f.db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'"); }
        else f.flip();
      }
      return { model, messages, stream };
    },
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    bodies.push(String(init.body));
    const tool = JSON.parse(String(init.body)).tools?.[0]?.function?.name;
    return new Response(JSON.stringify({ choices: [{ finish_reason: bodies.length === 1 ? "tool_calls" : "stop", message: bodies.length === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: tool, arguments: "{}" } }] }
      : { role: "assistant", content: "done" } }] }), { headers: { "content-type": "application/json" } });
  }));
  const events = recordEvents(runtime.adapter);
  const unsubscribe = runtime.adapter.onEvent(event => {
    if (event.type === "request.opened") void runtime.adapter.respondToRequest("T", event.requestId!, { behavior: "allow" });
  });
  try {
    await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "question", releaseBinding: f.binding, mountAdmission: admission,
      integrations: { memory: { command: process.execPath, args: ["fixture"], env: {} } }, beforeSubmit: () => {
        fences.assertSendFence(initial, reader, f.f.db);
        fences.assertRetainedFence?.(f.turn, f.f.db);
      } });
    await events.until(event => event.type === "turn.completed");
    expect(flipped).toBe(true);
    expect(bodies).toHaveLength(label === "T-D1d" ? 2 : 1);
    if (label === "T-D1d") { expect(bodies[1]).toContain("retained tool X"); expect(f.refusals).toBe(0); }
    else expect(f.refusals).toBe(1);
  } finally { unsubscribe(); events.stop(); await runtime.dispose(); admission?.dispose(); toolFixture.call = undefined; vi.unstubAllGlobals(); f.close(); }
});

// red-at-4df086541: the round after a staged steer did not check newly retained quote parents.
it("T-D1b refuses round two when the spliced steer quote flips", async () => {
  expect(fences.assertRetainedFence, "staged quotes require a live post-splice ledger check").toBeTypeOf("function");
  const f = fixtures!.consumingFixture(undefined, { empty: true });
  const { addTurnParents } = await import("../memory/lineage-write.ts");
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "retained-steer", displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: "retained-steer", apiKey: "fixture", apiUrl: "https://chat.invalid/v1",
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => {
    await responseReady;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "first answer" } }] }),
      { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const events = recordEvents(runtime.adapter);
  try {
    await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "question", draftOnly: true, releaseBinding: f.binding,
      beforeSubmit: () => fences.assertRetainedFence(f.turn, f.f.db) });
    const steer = runtime.adapter.steer!("T", "quoted X", () => {
      addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "X" }]); f.flip();
    });
    release();
    await steer; await events.until(event => event.type === "turn.completed");
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.refusals).toBe(1);
  } finally { release(); events.stop(); await runtime.dispose(); vi.unstubAllGlobals(); f.close(); }
});

// red-at-4df086541: queued steers committed crossing parents and sent the
// provider round; the duplicate row is a control for delivery at the cap.
it.each(["line", "prefix-union", "object", "duplicate"])("T-CAP-CROSSING-WRITE provider queued steers/%s", async growth => {
  expect(fences.prepareRetainedFence, "queued rounds require prospective cap checks").toBeTypeOf("function");
  const f = fixtures!.consumingFixture({ audience: null }, { empty: true });
  const { addTurnParents } = await import("../memory/lineage-write.ts");
  if (growth === "object") {
    for (let i = 0; i <= 512; i++) f.f.receipt(`cap-${i}`, "T", "driver", "session");
    addTurnParents(f.turn, Array.from({ length: 511 }, (_, i) => ({ kind: "receipt" as const, bundleId: `cap-${i}`, lsn: f.turn.turnLsn, scopeIds: [] })));
  } else {
    // Include both proposed additions so only ledger cardinality can refuse them.
    f.f.db.exec("BEGIN");
    for (let i = 0; i <= 4096; i++) f.f.message("T", `cap-${i}`, "user");
    f.f.db.exec("COMMIT");
    addTurnParents(f.turn, [{ kind: "prefix", threadId: "T", content: true, shown: Array.from({ length: 4095 }, (_, i) => `cap-${i}`) }]);
  }
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "cap-round", displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: "cap-round", apiKey: "fixture", apiUrl: "https://chat.invalid/v1",
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => {
    entered(); await ready;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "answer" } }] }),
      { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const events = recordEvents(runtime.adapter), accepted = vi.fn(), rejected = vi.fn();
  const add = (index: number) => addTurnParents(f.turn, [growth === "object"
    ? { kind: "receipt", bundleId: `cap-${index}`, lsn: f.turn.turnLsn, scopeIds: [] }
    : growth === "prefix-union" ? { kind: "prefix", threadId: "T", content: true, shown: [`cap-${index}`] }
    : { kind: "line", threadId: "T", messageId: `cap-${index}`, judge: "content" }]);
  try {
    await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "fixture", draftOnly: true, releaseBinding: f.binding });
    await waiting;
    const first = runtime.adapter.steer!("T", "first", () => { add(growth === "object" ? 511 : 4095); accepted(); });
    const second = runtime.adapter.steer!("T", "second", () => { add(growth === "object" ? 512 : growth === "duplicate" ? 4095 : 4096); rejected(); });
    release();
    await Promise.allSettled([first, second]);
    await events.until(event => event.type === "turn.completed");
    expect(accepted).toHaveBeenCalledTimes(1);
    if (growth === "duplicate") {
      // control: both queued steers fit and reach the next provider round.
      expect(rejected).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2); expect(f.refusals).toBe(0);
    } else {
      expect(rejected).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1); expect(f.refusals).toBe(1);
      expect((f.turn as import("../memory/lineage-write.ts").OpenTurn).over).toBe(true);
      expect(f.turn.parents.some(ref => ref.kind === "receipt" ? ref.bundleId === "cap-512"
        : ref.kind === "line" ? ref.messageId === "cap-4096" : ref.kind === "prefix" && ref.shown?.includes("cap-4096"))).toBe(false);
    }
  } finally { release(); events.stop(); await runtime.dispose(); vi.unstubAllGlobals(); f.close(); }
});

// red-at-4df086541: a redirect rechecked only the initial prompt, not dynamic retained parents.
it("T-D1e refuses the actual second fetch after a flip at the first redirect", async () => {
  expect(fences.assertRetainedFence, "every redirect must check the live concrete ledger").toBeTypeOf("function");
  const f = fixtures!.consumingFixture();
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "retained-chat", displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: "retained-chat", apiKey: "fixture", apiUrl: "https://chat.invalid/v1", tools: false,
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  const bodies: string[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body)); f.flip();
    return new Response(null, { status: 307, headers: { location: "https://chat.invalid/second" } });
  });
  vi.stubGlobal("fetch", fetch);
  const events = recordEvents(runtime.adapter);
  try {
    await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "question", releaseBinding: f.binding,
      beforeSubmit: () => fences.assertRetainedFence(f.turn, f.f.db) });
    await events.until(event => event.type === "turn.completed");
    expect(bodies).toHaveLength(1); expect(bodies[0]).toContain("question");
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.refusals).toBe(1);
  } finally { events.stop(); await runtime.dispose(); vi.unstubAllGlobals(); f.close(); }
});


vi.mock("./native.ts", async original => ({ ...await original<typeof import("./native.ts")>(), appendNative: () => {} }));
vi.mock("./mcp-mounts.ts", async original => {
  const actual = await original<typeof import("./mcp-mounts.ts")>();
  return { ...actual, buildMcpServers: (...args: Parameters<typeof actual.buildMcpServers>) => toolFixture.session
    ? { fixture: args[0].mountAdmission?.mount({ command: "fixture", args: [], env: {} })
      ?? { command: "fixture", args: [], env: {} } } : actual.buildMcpServers(...args) };
});
const responseUrl = new URL("../consuming-turn-response.ts", import.meta.url);
const responseApi = existsSync(responseUrl) ? await import(responseUrl.href) as typeof import("../consuming-turn-response.ts") : undefined;
const held: Array<{ f: WritetimeFixture; turn: TurnLineage; instance: ProviderInstance }> = [];
afterEach(async () => { for (const h of held.splice(0)) { await h.instance.dispose(); closeTurnLineage(h.turn); h.f.close(); } toolFixture.session = undefined; vi.unstubAllGlobals(); });
const answer = () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
function setup(owner = false, preparingBody?: () => void) {
  const f = new WritetimeFixture().reply("T", "X", 1);
  const turn = openTurnLineage(f.db, { threadId: "T", turnId: "openai-e" });
  const reader = fences.prepareRetainedFence?.(turn, owner ? CONTENT : MEMBER, vi.fn(), f.db) ?? (owner ? CONTENT : MEMBER);
  const instance = createOpenAIChatRuntime({
    input: { instanceId: "e-chat", displayName: "E chat", environment: {}, enabled: true, config: {} },
    driverKind: "e-chat", apiKey: "fixture-key", apiUrl: "https://chat.invalid/v1",
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => { preparingBody?.(); return { model, messages, stream }; },
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "unavailable", timeoutMs: 10000,
    nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
  });
  held.push({ f, turn, instance });
  let input = fencedTurnInput({ cwd: fixtureBotFolder(), threadId: "T", prompt: buildPrompt(turn, [promptPart("question", [noneRef("owner-turn")])]) }, { reader, retained: turn, db: f.db });
  if (responseApi) { const members = lineage.checkedOpenTurns(turn); input = { ...input, releaseBinding: responseApi.bindConsumingTurn({
    identity: { botId: "B", threadId: "T", dispatchGeneration: turn.turnId, lineageTurnIds: [turn.turnId], adapterLeaseId: turn.turnId },
    turn, db: f.db, isCurrent: () => true,
    onLedgerRefused: verdict => { for (const member of members) lineage.refuseRetainedTurn(member, verdict); },
  }) }; }
  return { f, turn, instance, input };
}

// red-at-4df086541: T-D1e, the first real fetch introduces retained X, then an
// audience-only flip happens before the redirect's second final fetch.
it("T-D1e refuses a redirect hop with newly revoked retained context", async () => {
  const h = setup(), bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) {
      addTurnParents(h.turn, ownReplayRefs("T", ["X"])); h.f.audienceFlip("T", 1);
      return new Response(null, { status: 307, headers: { location: "https://chat.invalid/v1/redirected" } });
    }
    return answer();
  }));
  const events = recordEvents(h.instance.adapter);
  try {
    await h.instance.adapter.sendTurn(h.input);
    await events.until(event => event.type === "turn.completed");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("question");
  } finally { events.stop(); }
});

// red-at-4df086541: T-D1b, after splice the initial BuiltPrompt alone cannot
// authorize the next round. Flip occurs after the accepted quote addition.
it("T-D1b final fetch checks the live ledger after a queued steer splice", async () => {
  const h = setup(), bodies: string[] = [];
  let steered: Promise<unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) steered = h.instance.adapter.steer!("T", "SECRET", () => {
      addTurnParents(h.turn, ownReplayRefs("T", ["X"])); h.f.audienceFlip("T", 1);
    });
    return answer();
  }));
  const events = recordEvents(h.instance.adapter);
  try {
    await h.instance.adapter.sendTurn(h.input); await events.until(event => event.type === "turn.completed");
    await steered;
    expect(bodies).toHaveLength(1); expect(bodies.join("")).not.toContain("SECRET");
  } finally { events.stop(); }
});

// control: T-D1d, actual owner runtime still delivers the accepted quote after
// an audience-only flip; owner preservation must not be mistaken for red proof.
it("T-D1d owner audience flip delivers a subsequent request", async () => {
  const h = setup(true), bodies: string[] = []; let steered: Promise<unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) steered = h.instance.adapter.steer!("T", "SECRET", () => {
      addTurnParents(h.turn, ownReplayRefs("T", ["X"], "content")); h.f.audienceFlip("T", 1);
    });
    return answer();
  }));
  const events = recordEvents(h.instance.adapter);
  try {
    await h.instance.adapter.sendTurn(h.input); await events.until(event => event.type === "turn.completed"); await steered;
    expect(bodies).toHaveLength(2); expect(bodies[1]).toContain("SECRET");
  } finally { events.stop(); }
});

// red-at-4df086541: T-D1a/T-D1c. The actual tool round accepts turnToolText
// before a revoke lands during construction of the next request. Checking only
// the original prompt (or checking before requestBody) releases the second body.
it.each(["audience", "content"] as const)("T-D1 tool result %s revoke blocks the actual second fetch", async kind => {
  let bodyCount = 0, accepted = 0;
  const h = setup(kind === "content", () => {
    if (++bodyCount !== 2) return;
    if (kind === "audience") h.f.audienceFlip("T", 1);
    else h.f.denyLine("T", 1).meta("deny_generation", h.f.generation() + 1);
  });
  // piMountRecords validates the mount before opening the permission request.
  // Mock the child session, but keep its real generation-bound admission.
  if (responseApi) {
    const { createMcpMountAdmission } = await import("./mcp-mounts.ts");
    const { createProxyReleaseAuthority } = await import("../consuming-turn-ingress.ts");
    const { InternalCapabilities } = await import("../internal-capabilities.ts");
    const caps = new InternalCapabilities();
    caps.begin("B", "T", h.input.releaseBinding!.identity.dispatchGeneration);
    h.input = { ...h.input, mountAdmission: createMcpMountAdmission(h.input.releaseBinding!, createProxyReleaseAuthority(caps), "http://127.0.0.1:1") };
  }
  toolFixture.session = {
    server: "fixture", tools: [{ name: "read_messages", inputSchema: { type: "object", properties: {} } }],
    callTool: async () => {
      const shown = turnToolText(h.turn, "SECRET", ownReplayRefs("T", ["X"]));
      // Production ToolText is staged; baseline turnToolText commits itself.
      const accept = () => { accepted++; };
      if (responseApi) responseApi.emitConsumingTurnResponse(h.input.releaseBinding!,
        responseApi.registerConsumingDescriptor("native:openai:tool-append", "native"),
        { bytes: Buffer.byteLength(shown.text), refs: shown.lineageOf, write: accept });
      else accept();
      return { text: shown.text, isError: false, droppedImages: 0 };
    },
    retire: () => {}, close: () => {}, closed: Promise.resolve(),
  } as unknown as ChatMcpSession;
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = String(init.body); bodies.push(body);
    if (bodies.length > 1) return answer();
    const name = JSON.parse(body).tools[0].function.name;
    const event = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-e", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  const events = recordEvents(h.instance.adapter);
  const unsubscribe = h.instance.adapter.onEvent(event => {
    if (event.type === "request.opened") void h.instance.adapter.respondToRequest("T", event.requestId!, { behavior: "allow" });
  });
  try {
    await h.instance.adapter.sendTurn(h.input);
    await events.until(event => event.type === "turn.completed");
    expect(accepted, "the actual read_messages result must be accepted in round one").toBe(1);
    expect(bodyCount, "the refused body must have reached request construction").toBe(2);
    expect(bodies).toHaveLength(1);
    expect(bodies.join("")).not.toContain("SECRET");
  } finally { unsubscribe(); events.stop(); h.input.mountAdmission?.dispose(); }
});
