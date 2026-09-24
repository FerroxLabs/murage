// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotShapesView, SHAPE_GROUPS, type ShapeRow, type ShapesView } from "./BotShapesPanel";

const noop = () => {};
const row = (id: string, group: ShapeRow["group"], extra: Partial<ShapeRow> = {}): ShapeRow => ({ id, group, label: id, what: `${id} does a thing.`, text: `${id} text`, switchable: false, locked: false, ...extra });
const view = (rows: ShapeRow[], lastTurn: ShapesView["lastTurn"] = null): ShapesView => ({ botId: "b1", botName: "Moss", team: { section: "Ops", label: "Ops" }, rows, lastTurn });
const render = (v: ShapesView) => renderToStaticMarkup(createElement(BotShapesView, { view: v, busy: null, error: "", onToggle: noop, onEdit: noop }));

describe("What shapes a bot", () => {
  const rows = [
    row("house-rules", "rules", { label: "House rules", switchable: true, on: true, editor: "houseRules" }),
    row("persona", "identity", { label: "Description and personality", editor: "identity" }),
    row("team-brief", "identity", { label: "Team brief", switchable: true, on: false, editor: "teamBrief" }),
    row("credential", "tools", { label: "Asking for keys", locked: true }),
    row("capabilities", "turn", { label: "What it can do right now", locked: true, text: null }),
  ];

  it("groups the rows under plain headings, in order, and says what each does", () => {
    const html = render(view(rows));
    const at = (text: string) => html.indexOf(text);
    expect(SHAPE_GROUPS.map((group) => group.title)).toEqual(["Your rules", "Who it is", "What it can use", "This turn"]);
    expect(at("Your rules")).toBeLessThan(at("Who it is"));
    expect(at("Who it is")).toBeLessThan(at("What it can use"));
    expect(at("What it can use")).toBeLessThan(at("This turn"));
    expect(html).toContain("Everything that goes into Moss&#x27;s instructions. Each group lists its parts in the order Moss reads them.");
    expect(html).toContain("persona does a thing.");
  });

  it("switches only the owner's choices, and marks Murage's own rules with a lock", () => {
    const html = render(view(rows));
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Use House rules"');
    expect(html).toContain('aria-label="Use Team brief"');
    expect(html).toMatch(/aria-label="Use Team brief"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Use Team brief"/);
    expect(html).toContain("Off. Moss doesn&#x27;t read this now.");
    expect(html.match(/Always on/g)).toHaveLength(4); // two locked rows, each a title and a label
    expect(html).toContain("Edit in Settings");
    expect(html).toContain("View<span class=\"sr-only\"> Asking for keys</span>");
  });

  it("offers the last turn word for word, or says there is none yet", () => {
    expect(render(view(rows))).toContain("Show exactly what it read");
    // The text itself opens on demand; the stateful part is covered in the browser spec.
    expect(render(view(rows, { at: 0, where: "chat", text: "SYSTEM" }))).not.toContain("SYSTEM");
  });

  it("keeps its own words plain", () => {
    const source = readFileSync(new URL("./BotShapesPanel.tsx", import.meta.url), "utf8");
    const copy = [...source.matchAll(/"([^"]*[a-z] [^"]*)"|>([^<>{}]*[a-z] [^<>{}]*)</g)].map((m) => m[1] ?? m[2]).join(" ");
    expect(copy).not.toMatch(/[—–]|\bsafe\b|composio|prompt/i);
    expect(source).not.toMatch(/window\.confirm|\bconfirm\(/);
  });

  it("is a section of the bot's window, shown only on the desktop", () => {
    const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('<SettingsSection id="shapes" active={section}>');
    expect(panel).toContain("{desktop === true && <BotShapesPanel");
  });
});
