import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as EngineNotes from "./EngineNotes";
import { HeldQueueRow } from "./EngineNotes";
import { ClaimRow } from "./InspectorPanel";
import { groupTranscript } from "../lib/activity-runs";
import { engineDividers } from "../../shared/chat-engine-notes";
import type { Message } from "../state/store";

it("F11 opens an inspectable queue with links to original rows", () => {
  const html = renderToStaticMarkup(createElement(HeldQueueRow, { text: "Waiting for a tool-capable engine: 1 item(s). Open now", count: 1, items: [{ id: "request", text: "Continue original routine", rowId: "card" }], onJump: () => {} }));
  expect(html).toContain("<details"); expect(html).toContain("Continue original routine"); expect(html).toContain("Open original");
});
it("the chat renders no claim notice: the component and the call site are gone", () => {
  expect(EngineNotes).not.toHaveProperty("ReplyActionNote");
  const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  expect(chat).not.toMatch(/ReplyActionNote|FLAGGED_REPLY_LINE|data-claim-state/);
});
it("the sidebar row carries the sentence, the explanation and a jump to the chat", () => {
  let jumped = 0;
  const element = ClaimRow({ row: { key: "claim:a", kind: "claim", at: "2026-10-09T10:00:00.000Z", sentence: "I ran the report", messageId: "m1" }, onJump: () => { jumped++; } });
  const html = renderToStaticMarkup(element);
  expect(html).toContain("No matching action found for: &quot;I ran the report&quot;");
  expect(html).toContain("Murage found no record of this action in this reply. It may have been done by another bot or in an earlier reply. Check before relying on it.");
  expect(html).not.toMatch(/Nothing was done/);
  element.props.onClick(); expect(jumped).toBe(1);
});
it("F15 keeps folded runs on engine boundaries and exposes the narration seam", () => {
  const row = (id: string, engine: string, extra = {}): Message => ({ id, at: 1, role: "bot", kind: "activity", engine: { instanceId: engine, driverKind: "fake", model: "one", capabilityHash: "hash" }, tool: { name: "read_file", ok: true }, ...extra });
  const messages = [row("a1", "a"), row("a2", "a"), row("b1", "b"), row("b2", "b"), row("c1", "c", { kind: "text", text: "Working", turnId: "c" }), row("c2", "c", { kind: "text", text: "Done", turnId: "c", turnTerminal: true })];
  const items = groupTranscript(messages), dividers = engineDividers(messages, engine => engine.instanceId);
  expect(items.filter(item => item.kind === "run")).toHaveLength(2);
  const seamIds = items.flatMap(item => item.kind === "helpers" ? [] : item.kind === "message" ? [item.message.id] : item.messages.map(row => row.id)).filter(id => dividers.has(id));
  expect(seamIds).toEqual(["b1", "c1"]);
});

it("N7 recovery and retry actions are visible beside the saved instruction", () => {
  const html = renderToStaticMarkup(createElement(HeldQueueRow, { text: "Waiting for a tool-capable engine: 2 item(s). Open now", count: 2,
    items: [{ id: "legacy", text: "Saved instruction", state: "recovery" }, { id: "retry", text: "Try again", botId: "bot", state: "retry" }],
    bots: [{ id: "bot", name: "Bot" }], onJump: () => {}, onRetry: async () => {} }));
  expect(html).toContain("Authorize continuation"); expect(html).toContain("Retry continuation"); expect(html).toContain("Choose a bot");
});
