// SPDX-License-Identifier: AGPL-3.0-or-later
// Collector producer owner: r2-owner-limit-projection; project consumer owner: r2-owner-limit-projects.
import { expect, it } from "vitest";
import { RuntimeAudienceCollector } from "./harness/audience-collector.ts";
import type { AudienceEmission, RuntimeEvent } from "./contracts.ts";

type SeenEvent = AudienceEmission["event"];

function stream() {
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach("fixture");
  const source = collector.source(collector.admitNewTurn({ attachment, instanceId: "fixture", threadId: "room" }));
  const seen: SeenEvent[] = [];
  const publish = (fields: object) => {
    const event = Object.freeze({ provider: "fixture", eventId: "provider-event", threadId: "room", turnId: "turn", createdAt: "fixture-time", ...fields }) as RuntimeEvent;
    const result = collector.intake(event, source);
    expect(result.execution).toBe(event);
    seen.push(...result.audience.map(emission => emission.event));
  };
  return { seen, publish };
}
const deltas = (events: SeenEvent[]) => events.flatMap(event => event.type === "content.delta" && event.streamKind === "assistant_text" ? [event.delta] : []).join("");

it("completion releases the scanner-buffered assistant suffix before the durable item", () => {
  const { seen, publish } = stream();
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "hello from " });
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "fake engine" });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text: "hello from fake engine" });
  expect(deltas(seen)).toBe("hello from fake engine");
  expect(seen.map(event => event.type)).toEqual(["content.delta", "item.completed"]);
  const item = seen.find(event => event.type === "item.completed")!;
  expect(seen[0]).toMatchObject({ itemId: item.itemId, regionId: item.regionId });
  expect(seen[1]).toMatchObject({ text: "hello from fake engine" });
});

it("completion streams only the suffix after an already delivered safe prefix", () => {
  const { seen, publish } = stream();
  const prefix = "Ordinary prose. ".repeat(40) + "\n";
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: prefix });
  expect(deltas(seen)).toBe(prefix);
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "Last words." });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text: prefix + "Last words." });
  expect(deltas(seen)).toBe(prefix + "Last words.");
  expect(seen.at(-1)).toMatchObject({ type: "item.completed", text: prefix + "Last words." });
});

it("buffered assistant items retain their own region and completion order", () => {
  const { seen, publish } = stream();
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "First reply." });
  publish({ type: "content.delta", itemId: "second", streamKind: "assistant_text", delta: "Second reply." });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text: "First reply." });
  publish({ type: "item.completed", itemId: "second", itemType: "assistant_text", text: "Second reply." });
  publish({ type: "turn.completed", ok: true });
  expect(seen.map(event => event.type)).toEqual(["content.delta", "item.completed", "content.delta", "item.completed", "turn.completed"]);
  expect(deltas(seen)).toBe("First reply.Second reply.");
  const items = seen.filter(event => event.type === "item.completed");
  const chunks = seen.filter(event => event.type === "content.delta");
  expect(chunks[0]).toMatchObject({ itemId: items[0].itemId, regionId: items[0].regionId, delta: "First reply." });
  expect(chunks[1]).toMatchObject({ itemId: items[1].itemId, regionId: items[1].regionId, delta: "Second reply." });
  expect(chunks[0].itemId).not.toBe(chunks[1].itemId);
});


it("a completion replacement resets the streamed region instead of appending to it", () => {
  const { seen, publish } = stream();
  const prefix = "Ordinary prose. ".repeat(40) + "\n";
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: prefix });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text: "Revised reply." });
  expect(seen.map(event => event.type)).toEqual(["content.delta", "content.reset", "content.delta", "item.completed"]);
  expect(seen[2]).toMatchObject({ delta: "Revised reply.", speechDisposition: "none", regionId: seen.find(event => event.type === "content.delta")!.regionId });
  expect(seen[3]).toMatchObject({ text: "Revised reply.", speechDisposition: "none" });
});

it("a reset clears the delivered prefix before the next completion", () => {
  const { seen, publish } = stream();
  const prefix = "Ordinary prose. ".repeat(40) + "\n";
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: prefix });
  publish({ type: "content.reset", itemId: "first", streamKind: "assistant_text" });
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "Fresh reply." });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text: "Fresh reply." });
  expect(seen.map(event => event.type)).toEqual(["content.delta", "content.reset", "content.delta", "item.completed"]);
  expect(seen.at(-1)).toMatchObject({ text: "Fresh reply." });
  expect(seen.at(-2)).toMatchObject({ delta: "Fresh reply." });
});


it("an unchanged completion retains the full delivered snapshot without repeating deltas", () => {
  const { seen, publish } = stream();
  const text = "Ordinary prose. ".repeat(40) + "\n";
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: text });
  publish({ type: "item.completed", itemId: "first", itemType: "assistant_text", text });
  expect(deltas(seen)).toBe(text);
  expect(seen.map(event => event.type)).toEqual(["content.delta", "item.completed"]);
  expect(seen[1]).toMatchObject({ text, regionId: seen.find(event => event.type === "content.delta")!.regionId, speechDisposition: "append" });
});

it("terminal-flushed items keep their original identities instead of the terminal carrier", () => {
  const { seen, publish } = stream();
  publish({ type: "content.delta", itemId: "first", streamKind: "assistant_text", delta: "First reply." });
  publish({ type: "content.delta", itemId: "second", streamKind: "assistant_text", delta: "Second reply." });
  publish({ type: "turn.completed", ok: true });
  const chunks = seen.filter(event => event.type === "content.delta");
  expect(chunks.map(event => event.delta)).toEqual(["First reply.", "Second reply."]);
  expect(chunks[0].itemId).toMatch(/^1-/);
  expect(chunks[1].itemId).toMatch(/^1-/);
  expect(chunks[0].itemId).not.toBe(chunks[1].itemId);
  expect(chunks[0].regionId).not.toBe(chunks[1].regionId);
  expect(seen.at(-1)).toMatchObject({ type: "turn.completed" });
});
