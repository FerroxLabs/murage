// A real Fuigo owner turn (three bots plus a team, the 1.0.20 real-engine leg
// "s4") stored its final reply and every later tool row as «redacted», with
// no secret anywhere in the turn. The fixture is that turn's own ACP update
// stream as the engine wrote it (tool ids renamed, nothing else changed): the
// engine's tool search returns Murage's tool catalog as JSON text with one
// ranking float per hit, and two of its 28 floats (`4.718623638153076`,
// `8.339136123657227`) pass the payment card test. That one field latched the
// whole turn for the owner.
//
// The updates are turned into runtime events the way the ACP driver does
// (drivers/acp/core.ts: tool_call -> item.started {title, input: rawInput};
// a completed tool_call_update -> item.completed {result: rawOutput ?? content};
// message chunks -> content.delta, then the assistant item) and go through the
// real EventBus, collector and turn text policy.
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AudienceEmission, ProviderInstance, RuntimeEvent, RuntimeEventListener, SourceContext } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { EventBus } from "./bus.ts";

type Update = { sessionUpdate: string; toolCallId?: string; title?: string; rawInput?: unknown; status?: string; rawOutput?: unknown; content?: unknown };
const UPDATES = JSON.parse(readFileSync(new URL("./__fixtures__/fuigo-team-turn-search-score.updates.json", import.meta.url), "utf8")) as Update[];

function harness() {
  const bus = new EventBus((() => {}) as unknown as typeof appendFileSync);
  let listener: RuntimeEventListener | undefined;
  const instance = {
    instanceId: "fuigo", driverKind: "fuigoAgent", displayName: undefined, enabled: true,
    models: { default: "model-a", options: [{ id: "model-a", label: "Model A" }] },
    snapshot: async () => ({ state: "available", version: "0" }),
    adapter: {
      provider: "fuigoAgent", capabilities: { sessionModelSwitch: "unsupported" },
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
  return { bus, audience, delivered, emit: (event: RuntimeEvent, source: SourceContext) => (listener as unknown as (e: RuntimeEvent, s: SourceContext) => void)(event, source) };
}

/** One owner turn from ACP updates. `edit` may change a tool result on its way in. */
function ownerTurn(threadId: string, edit: (update: Update, index: number) => Update = u => u) {
  const h = harness();
  const source = h.bus.admitNewTurn("fuigo", threadId);
  const base = { provider: "fuigoAgent", threadId, turnId: "turn-1", createdAt: new Date().toISOString() };
  let n = 0, reply = "";
  const sent: Array<{ eventId: string; label: string }> = [];
  const send = (label: string, event: Record<string, unknown>) => {
    const eventId = `ev-${++n}`;
    sent.push({ eventId, label });
    h.emit({ ...base, eventId, ...event } as unknown as RuntimeEvent, source);
  };
  send("turn.started", { type: "turn.started" });
  UPDATES.map(edit).forEach((u) => {
    if (u.sessionUpdate === "tool_call") send(`start ${u.title}`, { type: "item.started", itemType: "tool", origin: "engine", itemId: u.toolCallId, title: u.title, input: u.rawInput });
    else if (u.sessionUpdate === "tool_call_update") send(`done ${u.toolCallId}`, { type: "item.completed", itemType: "tool", itemId: u.toolCallId, ok: u.status !== "failed", result: u.rawOutput ?? u.content });
    else if (u.sessionUpdate === "agent_message_chunk") {
      const delta = (u.content as { text: string }).text;
      reply += delta;
      send("delta", { type: "content.delta", streamKind: "assistant_text", delta });
    } else if (u.sessionUpdate === "turn_completed") {
      send("reply", { type: "item.completed", itemType: "assistant_text", text: reply });
      send("turn.completed", { type: "turn.completed", ok: true });
    }
  });
  const stamped = (eventId: string) => { const e = h.delivered.find(d => d.eventId === eventId); if (!e) throw new Error(`not delivered: ${eventId}`); return e; };
  return {
    reply,
    masked: sent.filter(s => h.bus.audienceMaskedFor(stamped(s.eventId))).map(s => s.label),
    secret: sent.some(s => h.bus.audienceSecretMaskedFor(stamped(s.eventId))),
    omitted: h.audience.filter(e => e.event.type === "audience.omitted").length,
    shownReplies: h.audience.filter(e => e.event.type === "item.completed" && (e.event as { itemType?: string }).itemType === "assistant_text").map(e => (e.event as { text?: string }).text),
    shownToolTitles: h.audience.filter(e => e.event.type === "item.started").map(e => (e.event as { title?: string }).title),
  };
}

describe("a Fuigo team turn whose tool search returns ranking scores (real leg s4)", () => {
  it("the capture holds the two card-shaped score floats, in tool results", () => {
    const results = JSON.stringify(UPDATES.filter(u => u.sessionUpdate === "tool_call_update").map(u => u.rawOutput ?? u.content));
    expect(results).toContain("4.718623638153076");
    expect(results).toContain("8.339136123657227");
    expect(UPDATES.filter(u => u.sessionUpdate === "tool_call").length).toBe(11);
  });

  it("the owner's turn is never masked: every tool row and the final reply are shown", () => {
    const r = ownerTurn("thread-team-turn");
    expect(r.reply.length).toBeGreaterThan(100);
    expect(r.masked).toEqual([]);
    expect(r.secret).toBe(false);
    expect(r.omitted).toBe(0);
    expect(r.shownReplies).toEqual([r.reply]);
    expect(r.shownToolTitles).toEqual(UPDATES.filter(u => u.sessionUpdate === "tool_call").map(u => u.title));
    expect(JSON.stringify(r.shownToolTitles)).not.toContain("«redacted»");
  });

  it("a decimal number is shown as typed; the same digits written as a card are still masked", () => {
    for (const line of ['"score": 4.718623638153076,', '"score": 8.339136123657227,', "x = 0.4539136123657227"]) {
      expect(redactSecretsInText(line)).toBe(line);
    }
    // 4718623638153076 passes the card test: any real grouping of it stays masked.
    for (const card of ["4718623638153076", "4718 6236 3815 3076", "4718-6236-3815-3076", "4718.6236.3815.3076", "4111 1111 1111 1111", "4718.623638153076"]) {
      const shown = redactSecretsInText(`pay with ${card} today`);
      expect(shown).not.toContain(card);
      expect(shown).toContain("pay with ");
    }
    // A decimal joined to further digit groups is not one literal: masked as before.
    expect(redactSecretsInText("4.718623638153076 1234")).not.toContain("718623638153076");
  });

  it("a real card number in a tool result still latches the turn (the secret latch is unchanged)", () => {
    const firstResult = UPDATES.findIndex(u => u.sessionUpdate === "tool_call_update");
    const r = ownerTurn("thread-team-turn-card", (u, i) => i === firstResult ? { ...u, rawOutput: { type: "text", content: "card on file: 4111 1111 1111 1111" } } : u);
    expect(r.secret).toBe(true);
    expect(r.masked).toContain("reply");
    expect(r.shownReplies).not.toContain(r.reply);
  });
});
