// A brand-new owner chat right after an app restart showed «redacted» on its
// first reply with no engine switch. The two event sequences below follow the
// structure of two such real threads, event for event: turn.started, Murage's
// own startup tool, the engine's session.started, then the command list the
// engine reports once per fresh session (here 61 commands, as recorded), the
// reply, and for the first thread a run of approved engine tools (the real
// thread's second mask fell on its sixth tool).
//
// Each case builds a fresh EventBus (a restarted process) and drives it through
// the bus's own adapter listener with the turn's host source, so the real
// collector and the real turn text policy decide what the owner sees.
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AudienceEmission, ProviderInstance, RuntimeEvent, RuntimeEventListener, SourceContext } from "../contracts.ts";
import { EventBus } from "./bus.ts";

const COMMANDS = Array.from({ length: 61 }, (_, i) => ({ name: `skill-${String(i + 1).padStart(2, "0")}` }));
const REASONING = ["Checking what the owner ", "asked for and ", "how to answer ", "it briefly."];
const REPLY = Array.from({ length: 46 }, (_, i) => (i % 9 === 8 ? `line ${i}.\n` : `word${i} `));

function harness() {
  const writes: string[] = [];
  const append = ((_path: unknown, data: unknown) => { writes.push(String(data)); }) as unknown as typeof appendFileSync;
  const bus = new EventBus(append);
  let listener: RuntimeEventListener | undefined;
  const instance = {
    instanceId: "claude", driverKind: "claudeAgent", displayName: undefined, enabled: true,
    models: { default: "model-a", options: [{ id: "model-a", label: "Model A" }] },
    snapshot: async () => ({ state: "available", version: "0" }),
    adapter: {
      provider: "claudeAgent", capabilities: { sessionModelSwitch: "unsupported" },
      sendTurn: async () => ({ turnId: "t" }), interruptTurn: async () => {}, respondToRequest: async () => "unavailable" as const,
      hasSession: () => false, stopAll: async () => {},
      onEvent: (l: RuntimeEventListener) => { listener = l; return () => { listener = undefined; }; },
    },
    dispose: async () => {},
  } as unknown as ProviderInstance;
  bus.attach([instance]);
  const audience: AudienceEmission[] = [];
  bus.subscribeAudience(emission => audience.push(emission), { durable: false });
  const delivered: RuntimeEvent[] = [];
  bus.subscribe(event => delivered.push(event), { durable: false });
  // The bus stamps a copy of each event: look its verdicts up on the delivered copy.
  const stamped = (eventId: string) => { const e = delivered.find(d => d.eventId === eventId); if (!e) throw new Error(`not delivered: ${eventId}`); return e; };
  return { bus, writes, audience, delivered, stamped, emit: (event: RuntimeEvent, source: SourceContext) => (listener as unknown as (e: RuntimeEvent, s: SourceContext) => void)(event, source) };
}

type Step = Record<string, unknown> & { type: string };
let n = 0;
function turn(threadId: string, turnId: string, opts: { sessions: number; tools: number }): Step[] {
  const ev = (over: Step): Step => ({ eventId: `ev-${++n}`, provider: "claudeAgent", threadId, turnId, createdAt: new Date().toISOString(), ...over });
  const steps: Step[] = [
    ev({ type: "turn.started" }),
    ev({ type: "item.started", itemId: `${turnId}-murage`, itemType: "tool", origin: "murage", title: "murage" }),
    ev({ type: "item.completed", itemId: `${turnId}-murage`, itemType: "tool", ok: true }),
    ev({ type: "session.started", model: "model-a", sessionContract: 2 }),
    // The fresh session's command report: arrives inside the owner's turn.
    ev({ type: "engine.commands", commands: COMMANDS }),
    ...REASONING.map(delta => ev({ type: "content.delta", streamKind: "reasoning_text", delta })),
    ...REPLY.map(delta => ev({ type: "content.delta", streamKind: "assistant_text", delta })),
    ev({ type: "item.completed", itemType: "assistant_text", text: REPLY.join("") }),
  ];
  for (let s = 1; s < opts.sessions; s++) steps.push(ev({ type: "session.started", sessionContract: 2 }), ev({ type: "engine.commands", commands: COMMANDS }));
  for (let i = 1; i <= opts.tools; i++) {
    const itemId = `${turnId}-tool-${i}`;
    steps.push(
      // As the engine driver emits them: the tool's input on start, its content blocks as the result.
      ev({ type: "item.started", itemId, itemType: "tool", origin: "engine", title: "Bash", input: { command: `ls step-${i}`, description: "List the files" } }),
      ev({ type: "request.opened", requestType: "permission", summary: "permission", tool: "Bash" }),
      ev({ type: "request.resolved", behavior: "allow", source: "user" }),
      ev({ type: "item.completed", itemId, itemType: "tool", ok: true, result: [{ type: "text", text: `file-${i}.txt` }] }),
    );
  }
  steps.push(ev({ type: "turn.completed", ok: true, usage: { input: 1, output: 1, cachedInput: 0 } }));
  return steps;
}

function ownerTurn(h: ReturnType<typeof harness>, threadId: string, turnId: string, opts: { sessions: number; tools: number }) {
  const source = h.bus.admitNewTurn("claude", threadId);
  const from = h.audience.length;
  const steps = turn(threadId, turnId, opts);
  for (const step of steps) h.emit(step as unknown as RuntimeEvent, source);
  const mine = h.audience.slice(from);
  const executions = h.delivered.filter(e => steps.some(s => s.eventId === e.eventId));
  return {
    omitted: mine.filter(e => e.event.type === "audience.omitted").length,
    maskedEvents: executions.filter(e => h.bus.audienceMaskedFor(e)).map(e => e.type),
    streamed: mine.filter(e => e.event.type === "content.delta" && (e.event as { streamKind?: string }).streamKind === "assistant_text")
      .map(e => (e.event as { delta: string }).delta).join(""),
    reply: mine.filter(e => e.event.type === "item.completed" && (e.event as { itemType?: string }).itemType === "assistant_text")
      .map(e => (e.event as { text?: string }).text),
  };
}

describe("fresh owner chat after restart (single engine, owner only)", () => {
  it("thread A: first turn with the session command report and 13 approved tools is never masked", () => {
    const h = harness();
    const r = ownerTurn(h, "thread-fresh-a", "6", { sessions: 1, tools: 13 });
    expect(r.omitted).toBe(0);
    expect(r.maskedEvents).toEqual([]);
    expect(r.streamed).toBe(REPLY.join(""));
    expect(r.reply).toEqual([REPLY.join("")]);
    expect(h.writes.join("")).not.toContain("audience.omitted");
    expect(h.writes.join("")).not.toContain("«redacted»");
  });
  it("thread B: two turns, the second restarting its session twice, are never masked", () => {
    const h = harness();
    for (const [turnId, sessions, tools] of [["2", 1, 0], ["3", 2, 2]] as const) {
      const r = ownerTurn(h, "thread-fresh-b", turnId, { sessions, tools });
      expect(r.omitted).toBe(0);
      expect(r.maskedEvents).toEqual([]);
      expect(r.streamed).toBe(REPLY.join(""));
      expect(r.reply).toEqual([REPLY.join("")]);
    }
    expect(h.writes.join("")).not.toContain("audience.omitted");
  });
  it("a command description that scans as a secret does not latch the owner's reply (the menu scans it on its own)", () => {
    const h = harness();
    const source = h.bus.admitNewTurn("claude", "thread-fresh-d");
    const base = { provider: "claudeAgent", threadId: "thread-fresh-d", turnId: "4", createdAt: new Date().toISOString() };
    const commands = [{ name: "skill-key", description: "**password**: hunter2-value-xyz" }, ...COMMANDS.slice(0, 3)];
    h.emit({ ...base, eventId: "d1", type: "turn.started" } as unknown as RuntimeEvent, source);
    h.emit({ ...base, eventId: "d2", type: "engine.commands", commands } as unknown as RuntimeEvent, source);
    for (const [i, delta] of REPLY.entries()) h.emit({ ...base, eventId: `d3-${i}`, type: "content.delta", streamKind: "assistant_text", delta } as unknown as RuntimeEvent, source);
    h.emit({ ...base, eventId: "d4", type: "item.completed", itemType: "assistant_text", text: REPLY.join("") } as unknown as RuntimeEvent, source);
    expect(h.audience.filter(e => e.event.type === "audience.omitted")).toEqual([]);
    expect(h.bus.audienceMaskedFor(h.stamped("d4"))).toBe(false);
    expect(h.audience.find(e => e.event.type === "item.completed")?.event).toMatchObject({ text: REPLY.join("") });
    // The report itself still displays no command text in the turn.
    const shown = h.bus.audienceFor(h.stamped("d2"));
    expect(shown.map(e => e.event)).toEqual([expect.objectContaining({ type: "engine.commands", commands: [] })]);
    expect(JSON.stringify(shown)).not.toContain("hunter2-value-xyz");
  });
  it("a real secret in the reply still masks that turn (the fix lifts no scan)", () => {
    const h = harness();
    const source = h.bus.admitNewTurn("claude", "thread-fresh-c");
    const base = { provider: "claudeAgent", threadId: "thread-fresh-c", turnId: "9", createdAt: new Date().toISOString() };
    h.emit({ ...base, eventId: "s1", type: "turn.started" } as unknown as RuntimeEvent, source);
    h.emit({ ...base, eventId: "s2", type: "engine.commands", commands: COMMANDS } as unknown as RuntimeEvent, source);
    const secret = "**password**: hunter2-value-xyz\n";
    h.emit({ ...base, eventId: "s3", type: "content.delta", streamKind: "assistant_text", delta: secret } as unknown as RuntimeEvent, source);
    h.emit({ ...base, eventId: "s4", type: "item.completed", itemType: "assistant_text", text: secret } as unknown as RuntimeEvent, source);
    expect(h.bus.audienceMaskedFor(h.stamped("s4"))).toBe(true);
    expect(JSON.stringify(h.audience.map(e => e.event))).not.toContain("hunter2-value-xyz");
  });
});
