// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { RoomCommChip, RoomSpeakerLabel } from "./RoomSpeakerLabel";
import { TurnPresence } from "./TurnPresence";

const dax = { id: "dax", name: "Dax", color: "blue" as const };
const sean: Message = { id: "u1", role: "user", kind: "text", text: "Can you draft the launch copy for Friday?", at: 1 };

describe("RoomSpeakerLabel", () => {
  it("names the speaker", () => {
    const html = renderToStaticMarkup(createElement(RoomSpeakerLabel, { name: "Dax", color: "blue" }));
    expect(html).toContain(">Dax<");
    expect(html).not.toContain("replying to");
  });

  it("says what the turn answers, as a button that jumps to it", () => {
    const html = renderToStaticMarkup(createElement(RoomSpeakerLabel, { name: "Dax", color: "blue", replyTo: sean, onJump: () => {} }));
    expect(html).toContain("replying to you");
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('aria-label="Dax is replying to you: Can you draft the launch copy for Friday?. Show that message"');
  });

  it("the jump button is a 24px touch target (audit)", () => {
    const html = renderToStaticMarkup(createElement(RoomSpeakerLabel, { name: "Dax", color: "blue", replyTo: sean, onJump: () => {} }));
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-6\b/);
  });

  it("names a bot it answers", () => {
    const finch: Message = { id: "f1", role: "bot", kind: "text", text: "@Dax over to you", at: 2, from: { botId: "finch", name: "Finch", color: "orange" } };
    const html = renderToStaticMarkup(createElement(RoomSpeakerLabel, { name: "Dax", color: "blue", replyTo: finch, onJump: () => {} }));
    expect(html).toContain("replying to Finch");
  });
});

describe("RoomCommChip", () => {
  const comm = { groupId: "pair", withBotId: "dax", withName: "Dax", withColor: "blue" as const };

  it("is a link to the pair room", () => {
    const html = renderToStaticMarkup(createElement(RoomCommChip, { label: "Messaged @Dax", comm, bots: [dax], onOpen: () => {} }));
    expect(html).toMatch(/^<div[^>]*><button[^>]*type="button"/);
    expect(html).toContain('title="Open the conversation with Dax"');
    expect(html).toContain("Messaged @Dax");
  });
});

describe("TurnPresence speaker", () => {
  it("names who is thinking", () => {
    const html = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, name: "Dax" }));
    expect(html).toContain('data-testid="turn-speaker"');
    expect(html).toContain(">Dax<");
    expect(html).toContain("Thinking");
  });

  it("names who is answering above the answer", () => {
    const html = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, answering: true, name: "Dax" }, "the answer"));
    expect(html.indexOf(">Dax<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Dax<")).toBeLessThan(html.indexOf("the answer"));
  });

  it("stays unnamed where no name is given (a direct chat)", () => {
    const html = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true }));
    expect(html).not.toContain("turn-speaker");
  });
});

// The components hold no hooks, so calling them gives the element tree; the
// button's own onClick is what a click or Enter/Space on it runs.
function findButton(node: ReactNode): ReactElement<{ onClick?: () => void; type?: string }> | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void; type?: string }>;
  if (element.type === "button") return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findButton(child as ReactNode);
    if (hit) return hit;
  }
  return undefined;
}

describe("navigation wiring (audit)", () => {
  it("the replying-to button runs the jump", () => {
    const onJump = vi.fn();
    const button = findButton(RoomSpeakerLabel({ name: "Dax", color: "blue", replyTo: sean, onJump }));
    expect(button?.props.type).toBe("button");
    button?.props.onClick?.();
    expect(onJump).toHaveBeenCalledOnce();
  });

  it("the pair-room chip opens the pair room", () => {
    const onOpen = vi.fn();
    const comm = { groupId: "pair", withBotId: "dax", withName: "Dax", withColor: "blue" as const };
    findButton(RoomCommChip({ label: "Messaged @Dax", comm, bots: [dax], onOpen }))?.props.onClick?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
