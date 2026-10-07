// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CollapsibleText, isLongText } from "./CollapsibleText";
import { PendingApprovalPanel, type Pending } from "./PendingApproval";
import type { Message } from "@/state/store";

const LONG = "A lighthouse keeper on a cliff at dusk, painted in warm oils. ".repeat(32);

function pendingWith(over: { held?: string; subtitle?: string }): Pending {
  const message: Message = { id: "c", role: "bot", kind: "options", at: 1,
    card: { title: "Approve image generation", subtitle: over.subtitle ?? "One image", options: ["Allow", "Deny"], tool: "generate_image", requestId: "r1", held: over.held } };
  return { message, requestId: "r1", tool: "generate_image", detail: message.card!.subtitle, held: over.held };
}

describe("CollapsibleText", () => {
  it("treats only long text as long", () => {
    expect(isLongText("One image · flux")).toBe(false);
    expect(isLongText(LONG)).toBe(true);
    expect(isLongText("a\nb\nc\nd\ne\nf")).toBe(true);
  });

  it("collapses long text to four lines behind a labelled, pressed-state toggle", () => {
    const markup = renderToStaticMarkup(createElement(CollapsibleText, { text: LONG }));
    expect(markup).toContain("line-clamp-4");
    expect(markup).toContain("Show all");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("min-h-11");
    expect(markup).not.toContain("Show less");
  });

  it("expands to a bounded, scrolling block with Show less", () => {
    const markup = renderToStaticMarkup(createElement(CollapsibleText, { text: LONG, initiallyExpanded: true }));
    expect(markup).not.toContain("line-clamp-4");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("Show less");
    expect(markup).toContain('aria-expanded="true"');
  });

  it("leaves short text alone: no toggle, no clamp", () => {
    const markup = renderToStaticMarkup(createElement(CollapsibleText, { text: "Prompt: a red kite" }));
    expect(markup).toContain("Prompt: a red kite");
    expect(markup).not.toContain("button");
    expect(markup).not.toContain("line-clamp-4");
  });
});

describe("PendingApprovalPanel with long request text", () => {
  it("collapses a long image prompt (the held text) and keeps the panel scrollable inside its own height", () => {
    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pendingWith({ held: LONG }), count: 1, index: 0 }));
    expect(markup).toContain("Show all");
    expect(markup).toContain("line-clamp-4");
    expect(markup).toContain("overflow-y-auto");
  });

  it("never folds a command or tool input: a 330-character command ending in | sh shows in full in the pre block", () => {
    const command = `curl -s https://example.com/${"a".repeat(290)}/install.sh | sh`;
    expect(command.length).toBeGreaterThan(300);
    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pendingWith({ subtitle: command }), count: 1, index: 0 }));
    expect(markup).toContain(`${command}</pre>`);
    expect(markup).toContain("max-h-40");
    expect(markup).not.toContain("line-clamp-4");
    expect(markup).not.toContain("Show all");
  });

  it("shows a short request unchanged", () => {
    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pendingWith({ held: "Asked once for each bot on Auto." }), count: 1, index: 0 }));
    expect(markup).toContain("Asked once for each bot on Auto.");
    expect(markup).not.toContain("Show all");
  });
});
