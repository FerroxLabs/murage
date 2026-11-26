// Settings v10 A9-bots (roster): the rendered Bots list and the Move all review draw every row the plan names.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NoLimitsPlan } from "../../shared/settings-v10/no-limits-plan";
import { BotsRosterBody, type BotsRosterBodyProps } from "./BotsRoster";

const bots = [
  ...Array.from({ length: 34 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, autoApprove: i % 2 === 0, fullAccess: false, noLimits: false, hidden: false })),
  { id: "a1", name: "Old one", autoApprove: false, fullAccess: false, noLimits: false, hidden: true },
  { id: "a2", name: "Old two", autoApprove: false, fullAccess: false, noLimits: false, hidden: true },
];
const plan: NoLimitsPlan = {
  digest: "d",
  bots: bots.map((bot) => ({ id: bot.id, name: bot.name, archived: Boolean(bot.hidden), levelCleared: null })),
  routines: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, name: `Routine ${i}`, botId: `b${i}`, levelCleared: "auto" as const, pendingApprovalWithdrawn: i === 0 })),
  chats: [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, name: `Chat ${i}`, botId: `b${i}`, levelCleared: "full" as const, guest: false })),
    { id: "c3", name: "Shop front", botId: "b4", levelCleared: "ask" as const, guest: true },
  ],
};
const noop = () => {};
const props = (over: Partial<BotsRosterBodyProps> = {}): BotsRosterBodyProps => ({
  bots, selected: new Set(), onToggle: noop, onClear: noop, target: "auto", onTarget: noop, onApply: noop, onArchive: noop, onMoveAll: noop,
  busy: false, results: [], levelReview: null, onConfirmLevel: noop, onCancelLevel: noop, archiveReview: null, onConfirmArchive: noop, onCancelArchive: noop,
  moveAll: null, onConfirmMoveAll: noop, onCancelMoveAll: noop, ...over,
});
const html = (over: Partial<BotsRosterBodyProps> = {}) => renderToStaticMarkup(createElement(BotsRosterBody, props(over)));

describe("Bots list", () => {
  it("draws every bot, active and archived, with no Show all", () => {
    const out = html();
    expect(out.match(/data-bot-row=/g)).toHaveLength(36);
    expect(out).toContain("34 bots. 2 archived.");
    expect(out).not.toContain("Show all");
  });
  it("shows the bulk bar only with a selection", () => {
    expect(html()).not.toContain("Bulk actions");
    const out = html({ selected: new Set(["b0", "b1", "b2"]) });
    expect(out).toContain("3 of 36 selected");
    expect(out).toContain('data-bots-action="archive"');
  });
});

describe("Move all review", () => {
  it("names all six routines and four chats with bot and level, the withdrawn request and the guest chat", () => {
    const out = html({ moveAll: { plan, outcome: null } });
    for (let i = 0; i < 6; i++) expect(out).toContain(`Routine ${i} (Bot ${i}), at Auto`);
    for (let i = 0; i < 3; i++) expect(out).toContain(`Chat ${i} (Bot ${i}), at Full access`);
    expect(out).toContain("Shop front (Bot 4), at Ask, a chat a guest started: it still never runs at No limits");
    expect(out).toContain("that request is withdrawn");
    expect(out).toContain("34 active bots and 2 archived bots");
  });
  it("a changed list shows the new one and offers Try again; Moved offers no second commit", () => {
    expect(html({ moveAll: { plan, outcome: { kind: "changed", plan } } })).toContain("Nothing was moved. Review the new list.");
    expect(html({ moveAll: { plan, outcome: { kind: "pending" } } })).not.toContain('data-move-all="confirm"');
  });
});

describe("Bulk Archive review", () => {
  it("is the list form: one line per ticked bot with what it loses", () => {
    const out = html({ archiveReview: [
      { id: "b1", name: "Atlas", accessRevision: 2, savedChoices: ["googlecalendar"] },
      { id: "b2", name: "Nova", accessRevision: 0, savedChoices: [] },
    ] });
    expect(out).toContain("Archive 2 bots?");
    expect(out).toContain("Atlas: googlecalendar");
  });
});
