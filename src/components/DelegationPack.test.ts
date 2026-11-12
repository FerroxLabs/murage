// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationPackChip, DelegationPackLine } from "./DelegationPack";

const props = { packId: "pack", sourceBotName: "Sable", targetBotName: "Ember", load: async () => ({ rows: [] }) };

describe("delegation pack component render", () => {
  it("T-PREPARED: offers details only after preparation; kills chip-at-enqueue", () => {
    expect(renderToStaticMarkup(h(DelegationPackChip, { ...props, state: "prepared" }))).toContain("Recent context from your chat with Sable");
    expect(renderToStaticMarkup(h(DelegationPackChip, { ...props, state: "queued" }))).toBe("");
    const prepared = renderToStaticMarkup(h(DelegationPackLine, { ...props, state: "prepared" }));
    expect(prepared).toContain("Recent lines of this chat were prepared for Ember");
    expect(prepared).toContain("See what was prepared");
    const pending = renderToStaticMarkup(h(DelegationPackLine, { ...props, state: "queued" }));
    expect(pending).toContain("Asked Ember. Recent chat context will be included where available.");
    expect(pending).not.toContain("<button");
  });

  it("uses the amended note-only copy; kills receipt wording", () => {
    const html = renderToStaticMarkup(h(DelegationPackLine, { ...props, state: "note-only" }));
    expect(html).toContain("Only Sable&#x27;s note was prepared for Ember.");
    expect(html).not.toMatch(/got |given |received |read |<button/);
    expect(renderToStaticMarkup(h(DelegationPackChip, { ...props, state: "note-only" }))).toBe("");
  });
});
