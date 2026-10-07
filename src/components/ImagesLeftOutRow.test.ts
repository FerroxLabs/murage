// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G11: a picture a text-only model cannot see is left out with a plain note,
// and a raw provider error reads as a sentence naming the bot.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImagesLeftOutRow } from "./ImagesLeftOutRow";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
import { timelineEvents } from "@/lib/taskTimeline";
import { imagesLeftOutActivityName } from "../../shared/images-left-out";

const RAW = "API error (status 400): {\"error\":{\"message\":\"image input is not supported for this model\",\"type\":\"invalid_request_error\"}}";

describe("images left out (G11)", () => {
  it("is one quiet status line naming the bot, never a card or an action", () => {
    const markup = renderToStaticMarkup(createElement(ImagesLeftOutRow, { botName: "Dax", count: 1 }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Dax can&#x27;t see images, so I left the picture out.");
    expect(markup).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(ImagesLeftOutRow, { botName: "Dax", count: 2 }))).toContain("left the pictures out.");
  });

  it("reads as an observed note in the task timeline", () => {
    const [event] = timelineEvents([{ id: "m1", at: 1, kind: "activity", role: "bot", tool: { name: imagesLeftOutActivityName(1), ok: true } }]);
    expect(event).toMatchObject({ label: "This bot can't see images, so I left the picture out.", state: "observed" });
  });

  it("an error card leads with a plain sentence naming the bot, and keeps the raw text in details", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeErrorCard, { message: RAW, botName: "Dax", onOpenProviderSettings: () => {} }));
    const lead = markup.split("<details")[0];
    expect(lead).toContain("Dax&#x27;s model can&#x27;t read images, so it couldn&#x27;t answer.");
    expect(lead).not.toContain("invalid_request_error");
    expect(markup.split("<details")[1]).toContain("invalid_request_error");
  });

  it("an error card without a bot name, or with Murage's own sentence, is unchanged", () => {
    expect(renderToStaticMarkup(createElement(RuntimeErrorCard, { message: RAW, onOpenProviderSettings: () => {} })).split("<details")[0]).toContain("invalid_request_error");
    const own = "Selected provider connection changed before dispatch";
    expect(renderToStaticMarkup(createElement(RuntimeErrorCard, { message: own, botName: "Dax", onOpenProviderSettings: () => {} })).split("<details")[0]).toContain(own);
  });
});

describe("audit round: a typed engine error still reads plainly", () => {
  it("keeps the raw text out of the card's lead when the engine gave a kind", () => {
    const raw = "API error (status 402): Monthly limit $10 reached";
    const markup = renderToStaticMarkup(createElement(RuntimeErrorCard, { message: raw, errorKind: "http", botName: "Dax", onOpenProviderSettings: () => {} }));
    const lead = markup.split("<details")[0];
    expect(lead).not.toContain("$10");
    expect(lead).toContain("Dax&#x27;s model provider turned this request down.");
    expect(markup.split("<details")[1]).toContain("$10");
  });
});
