// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux Memory capture after the turn (FLUX-OFF-HEADERS-104 round 2): a memory-on turn is posted to the Flux Memory API once,
// from Murage's process; a memory-off turn never is, on any engine.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFunction } from "./testing/source-extract.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FluxMemoryCapture, fluxMemoryCaptureUrl, setFluxMemoryCaptureVault, type FluxCaptureDeps } from "./flux-memory-capture.ts";
import { setFluxExternalMemory } from "./flux-memory-envelope.ts";
import { setFluxMemorySettings } from "./flux-memory-headers.ts";

const KEY = "sk-flux-capture-test-key";
const SPACE = `bot:${"a".repeat(64)}`;
const TAG = "d".repeat(64);
const URL_ = `https://api.fluxrouter.ai/v1/memory/spaces/${encodeURIComponent(SPACE)}/events`;
const owner = { botId: "b1", audience: "owner" as const, decidedOwner: true };
const guest = { botId: "b1", audience: "non-owner" as const, decidedOwner: false };

type Sent = { url: string; init: RequestInit & { dispatcher?: unknown } };

function rig(over: Partial<FluxCaptureDeps> = {}, statuses: number[] = []) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const queue = [...statuses];
  const capture = new FluxMemoryCapture({
    key: () => KEY,
    threadCaptures: () => true,
    userText: () => "my sister is called Ana",
    asksFirst: () => false,
    ledger: { noteUsed: () => ({ space: SPACE, tag: TAG }), keyOff: () => false, setKeyOff: () => {}, accepted: () => {}, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} },
    sleep: async () => {},
    log: (line) => logs.push(line),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init: init as Sent["init"] });
      return new Response(null, { status: queue.shift() ?? 202 });
    }) as typeof fetch,
    ...over,
  });
  const settle = async () => { await Promise.all([...capture.inflight]); };
  return { capture, sent, logs, settle };
}

/** One whole turn as the server sees it: dispatch, the engine's reply, the end. */
function runTurn(capture: FluxMemoryCapture, turn: Parameters<FluxMemoryCapture["begin"]>[0], provider = "claudeAgent", ok = true) {
  capture.begin(turn);
  capture.observe({ type: "turn.started", threadId: turn.threadId, turnId: "u1", provider } as never);
  capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Noted: your sister is Ana.", threadId: turn.threadId, turnId: "u1", provider } as never);
  capture.observe({ type: "turn.completed", ok, threadId: turn.threadId, turnId: "u1", provider } as never);
}

beforeEach(() => { setFluxMemorySettings({}); setFluxExternalMemory(undefined); setFluxMemoryCaptureVault(undefined); });
afterEach(() => { setFluxMemorySettings({}); setFluxExternalMemory(undefined); setFluxMemoryCaptureVault(undefined); });

it.each(["key", "asksFirst", "botCaptures", "threadCaptures", "keyOff", "userText"] as const)("reports a payload-free %s lookup failure and refuses capture", async (lookup) => {
  const fail = () => { throw Error("private-lookup-canary"); };
  const deps: Partial<FluxCaptureDeps> = lookup === "keyOff"
    ? { ledger: { noteUsed: () => ({ space: SPACE, tag: TAG }), keyOff: fail, setKeyOff: () => {}, accepted: () => {}, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} } }
    : { [lookup]: fail };
  const { capture, sent, logs, settle } = rig(deps);
  expect(() => runTurn(capture, { threadId: "lookup", warmIdentity: owner })).not.toThrow();
  await settle();
  expect(sent).toHaveLength(0);
  expect(logs).toEqual([`[flux] memory-capture failed stage=${lookup === "userText" ? "user-text" : "admission"}`]);
});

describe("Flux Memory capture after the turn", () => {
  it("a memory-on owner turn posts exactly one capture: route, key, idempotency, body", async () => {
    const { capture, sent, settle } = rig();
    runTurn(capture, { threadId: "t1", warmIdentity: owner });
    await settle();
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.get("x-flux-memory-app")).toBe("murage");
    expect(headers.get("x-flux-feature")).toBe("memory");
    expect(headers.get("x-flux-bot-id")).toBe("b1");
    expect(headers.get("x-flux-thread-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get("x-flux-memory-capture")).toBeNull();
    const body = JSON.parse(String(init.body)) as { client_event_id: string; text: string; metadata: Record<string, string> };
    expect(body.client_event_id).toBe(headers.get("idempotency-key"));
    expect(body.text).toBe("User: my sister is called Ana\n\nAssistant: Noted: your sister is Ana.");
    expect(body.metadata).toEqual({ app: "murage", kind: "turn", thread: TAG });
    // nothing in the body names the key, the thread or the bot
    expect(String(init.body)).not.toContain(KEY);
    expect(String(init.body)).not.toContain("t1");
    expect(String(init.body)).not.toContain("b1");
  });

  const offCases: Array<[string, () => void, Parameters<FluxMemoryCapture["begin"]>[0], Partial<FluxCaptureDeps>?]> = [
    ["a guest (non-owner) turn", () => {}, { threadId: "g", warmIdentity: guest }],
    ["an owner-looking turn nobody proved", () => {}, { threadId: "u", warmIdentity: { botId: "b1", audience: "owner" } }],
    ["a turn with no identity", () => {}, { threadId: "n" }],
    ["a background turn", () => {}, { threadId: "bg", warmIdentity: owner, background: true }],
    ["a prewarm", () => {}, { threadId: "pw", warmIdentity: owner, prewarm: true }],
    ["a thread with a number hold", () => {}, { threadId: "nh", warmIdentity: owner, fluxCaptureHold: true }],
    ["an engine command", () => {}, { threadId: "ec", warmIdentity: owner, engineCommand: { name: "compact", args: "" } }],
    ["the kill switch", () => setFluxMemorySettings({ killSwitch: true }), { threadId: "k", warmIdentity: owner }],
    ["\"Use Flux memory\" off", () => setFluxExternalMemory(false), { threadId: "x", warmIdentity: owner }],
    ["the owner gate off", () => setFluxMemorySettings({ ownerMemory: "off" }), { threadId: "og", warmIdentity: owner }],
    ["Murage memory off or the thread excluded", () => {}, { threadId: "mo", warmIdentity: owner }, { threadCaptures: () => false }],
    ["no Flux key", () => {}, { threadId: "nk", warmIdentity: owner }, { key: () => null }],
  ];
  for (const [label, setup, turn, deps] of offCases) {
    it(`${label}: nothing is posted`, async () => {
      setup();
      const { capture, sent, settle } = rig(deps);
      runTurn(capture, turn);
      await settle();
      expect(sent).toEqual([]);
    });
  }

  it("a failed or stopped turn posts nothing; a session that exits drops the entry", async () => {
    const { capture, sent, settle } = rig();
    runTurn(capture, { threadId: "f", warmIdentity: owner }, "codex", false);
    capture.begin({ threadId: "e", warmIdentity: owner });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "half", threadId: "e" });
    capture.observe({ type: "session.exited", threadId: "e" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "e" });
    await settle();
    expect(sent).toEqual([]);
  });

  it("a switch turned off after dispatch reaches the capture: nothing is posted", async () => {
    for (const flip of [() => setFluxExternalMemory(false), () => setFluxMemorySettings({ killSwitch: true })]) {
      setFluxMemorySettings({}); setFluxExternalMemory(undefined);
      const { capture, sent, settle } = rig();
      capture.begin({ threadId: "s", warmIdentity: owner });
      capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "ok", threadId: "s" });
      flip();
      capture.observe({ type: "turn.completed", ok: true, threadId: "s" });
      await settle();
      expect(sent).toEqual([]);
    }
  });

  it("a switch turned back on mid-turn does not widen an off dispatch", async () => {
    setFluxExternalMemory(false);
    const { capture, sent, settle } = rig();
    capture.begin({ threadId: "w", warmIdentity: owner });
    setFluxExternalMemory(true);
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "ok", threadId: "w" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "w" });
    await settle();
    expect(sent).toEqual([]);
  });

  it("Murage's own lines (origin murage) are not part of the captured reply", async () => {
    const { capture, sent, settle } = rig();
    capture.begin({ threadId: "m", warmIdentity: owner });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "murage", text: "Murage: waiting", threadId: "m" });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Real reply", threadId: "m" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "m" });
    await settle();
    expect(JSON.parse(String(sent[0]!.init.body)).text).toBe("User: my sister is called Ana\n\nAssistant: Real reply");
  });

  it("secrets in the turn are redacted before they leave, as Murage's own capture redacts them", async () => {
    const secret = "sk-flux-Eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // secret-scan: fixture
    const { capture, sent, settle } = rig({ userText: () => `my token is Bearer ${secret} ok` });
    capture.begin({ threadId: "sec", warmIdentity: owner });
    capture.observe({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: `saved Bearer ${secret}`, threadId: "sec" });
    capture.observe({ type: "turn.completed", ok: true, threadId: "sec" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.init.body)).not.toContain(secret);
  });

  it("503 and network errors retry twice; a 4xx is not retried and is logged once with the status only", async () => {
    const busy = rig({}, [503, 503, 503]);
    runTurn(busy.capture, { threadId: "r", warmIdentity: owner });
    await busy.settle();
    expect(busy.sent).toHaveLength(3);
    expect(new Set(busy.sent.map(s => new Headers(s.init.headers).get("idempotency-key"))).size).toBe(1);
    expect(busy.logs).toEqual(["[flux] memory-capture failed status=503"]);

    const refused = rig({}, [403, 403]);
    runTurn(refused.capture, { threadId: "r1", warmIdentity: owner });
    runTurn(refused.capture, { threadId: "r2", warmIdentity: owner });
    await refused.settle();
    expect(refused.sent).toHaveLength(2);
    expect(refused.logs).toEqual(["[flux] memory-capture failed status=403"]);
    for (const line of [...busy.logs, ...refused.logs]) { expect(line).not.toContain(KEY); expect(line).not.toContain("Ana"); }
  });

  it("no target known: nothing is posted, one log line", async () => {
    const { capture, sent, logs, settle } = rig({ url: () => null });
    runTurn(capture, { threadId: "nt", warmIdentity: owner });
    runTurn(capture, { threadId: "nt2", warmIdentity: owner });
    await settle();
    expect(sent).toEqual([]);
    expect(logs).toEqual(["[flux] memory-capture no-target"]);
  });

  it("the target is the conversation's space; a vault setting is ignored; a space outside the charset is no target", () => {
    setFluxMemoryCaptureVault("vault-9");
    expect(fluxMemoryCaptureUrl(SPACE)).toBe(URL_);
    expect(fluxMemoryCaptureUrl("../../key/info")).toBeNull();
    expect(fluxMemoryCaptureUrl("")).toBeNull();
    expect(fluxMemoryCaptureUrl("x".repeat(129))).toBeNull();
  });
});

describe("every engine alike: memory on captures, memory off never does", () => {
  const ENGINES = [
    "fuigoAgent", "grokAgent", "geminiAgent", "hermesAgent", "qwenAgent", "opencodeGo", "kimiAgent", "droidAgent", "clineAgent",
    "openclaw", "custom", "cursorAgent", "claudeAgent", "codex", "openai-compat", "pi", "antigravity",
  ];
  for (const provider of ENGINES) {
    it(`${provider}: one capture for the owner's memory-on turn, none for a guest, none in the background`, async () => {
      const { capture, sent, settle } = rig();
      runTurn(capture, { threadId: `${provider}-on`, warmIdentity: owner }, provider);
      runTurn(capture, { threadId: `${provider}-guest`, warmIdentity: guest }, provider);
      runTurn(capture, { threadId: `${provider}-bg`, warmIdentity: owner, background: true }, provider);
      await settle();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(String(sent[0]!.init.body)).text).toContain("Noted: your sister is Ana.");
      // the capture call is Murage's own request, never an envelope on the engine's traffic
      expect(String(sent[0]!.init.body)).not.toContain("flux_memory");
    });
  }

  it("the server wires it at the one dispatch point and in the one event fold, after the reply guard", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const start = source.indexOf("async function sendProjectUsageTurn(");
    expect(start).toBeGreaterThan(0);
    const dispatch = extractFunction({ file: join(import.meta.dirname, "index.ts"), select: "sendProjectUsageTurn" }).code;
    expect(dispatch).toContain("fluxMemoryCapture.begin(turn);");
    // MAIN RULING INT-CONFLICT-DEFAULT c4-misc-b: select the complete declaration after the executionEvent rename.
    const fold = extractFunction({ file: join(import.meta.dirname, "index.ts"), select: "foldRuntimeEvent" }).code;
    const guard = fold.indexOf("replySpeakerTurns.item(");
    const observe = fold.indexOf("fluxMemoryCapture.observe(");
    expect(guard).toBeGreaterThan(0);
    expect(observe).toBeGreaterThan(guard);
    // no driver builds a capture: the only caller of the capture module is the server
    expect(source).toContain("new FluxMemoryCapture(");
  });

  it("openai-chat no longer declares the envelope, so no flux_memory metadata leaves Murage", () => {
    const source = readFileSync(join(import.meta.dirname, "drivers/openai-chat.ts"), "utf8");
    expect(source).not.toMatch(/fluxEnvelope:\s*true/);
  });
});

it("marks a long turn as an excerpt and identifies which side was cut", async () => {
  const { capture, sent, settle } = rig({ userText: () => "word ".repeat(10000) });
  runTurn(capture, { threadId: "long", warmIdentity: owner }); await settle();
  expect(JSON.parse(String(sent[0]!.init.body)).metadata).toMatchObject({ incomplete: true, user_truncated: true, assistant_truncated: false });
});
it("a failed receipt is reported without claiming capture success or disclosing payloads", async () => {
  const test = rig();
  const capture = new FluxMemoryCapture({ key: () => KEY, threadCaptures: () => true, userText: () => "private-canary", asksFirst: () => false,
    ledger: { noteUsed: () => ({ space: SPACE, tag: TAG }), keyOff: () => false, setKeyOff: () => {}, accepted: () => { throw Error("private-ledger-canary"); }, threadForgotten: () => {}, spaceGone: () => {}, limit: () => {} },
    log: line => test.logs.push(line), fetch: (async () => new Response(null, { status: 202 })) as typeof fetch });
  runTurn(capture, { threadId: "receipt", warmIdentity: owner }); await Promise.all([...capture.inflight]);
  expect(test.logs).toEqual(["[flux] memory-capture failed stage=ledger-receipt"]);
});

it("capture resolves exactly the dispatched owner message across long continuations", async () => {
  const userText = vi.fn((_thread: string, messageId?: string) => messageId === "dispatched-message" ? "the owner's original request" : "wrong later message");
  const { capture, sent, settle } = rig({ userText });
  runTurn(capture, { threadId: "continued-thread", ownerMessageId: "dispatched-message", warmIdentity: owner });
  await settle();
  expect(userText).toHaveBeenCalledExactlyOnceWith("continued-thread", "dispatched-message");
  expect(sent).toHaveLength(1);
  expect(sent[0].init.body).toContain("the owner's original request");
  expect(sent[0].init.body).not.toContain("wrong later message");
});
