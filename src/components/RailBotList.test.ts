// UX L6B (scale): the rail still works at 18 bots. At most eight rows per
// section, a fold row that says what the hidden bots are doing, needs-you and
// the open chat never hidden, and a search shows every match.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { railFold, railSearchEscape, railRecency, railBotsLimit, RAIL_VISIBLE_BOTS } from "@/lib/rail-fold";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { RailFoldRow, railFoldMeta } from "./RailBotList";
import type { SidebarAttentionBot, SidebarAttentionTask } from "@/lib/sidebar-attention";

// A rail bot as the sidebar hands it over: its chats carry when they were last active.
type RailTask = SidebarAttentionTask & { threadId?: string; lastActivityAt?: number; createdAt?: number };
type B = Omit<SidebarAttentionBot, "tasks"> & { id: string; tasks?: RailTask[] };
const team = (n: number, extra: (i: number) => Partial<B> = () => ({})): B[] =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, ...extra(i + 1) }));
const ids = (bots: B[]) => bots.map((bot) => bot.id);

describe("rail fold", () => {
  it("shows a small team whole, exactly like the mockup", () => {
    const fold = railFold(team(3), { open: false });
    expect(ids(fold.visible)).toEqual(["b1", "b2", "b3"]);
    expect(fold.hidden).toEqual([]);
  });

  it.each([9, 25, 35])("folds %i bots to eight rows in the owner's order", (n) => {
    const fold = railFold(team(n), { open: false });
    expect(RAIL_VISIBLE_BOTS).toBe(8);
    expect(ids(fold.visible)).toEqual(ids(team(8)));
    expect(fold.hidden).toHaveLength(n - 8);
  });

  it("counts what the hidden bots are doing on the fold row", () => {
    const fold = railFold(team(18, (i) => (i === 12 || i === 15 ? { activity: "working" } : i === 17 ? { unread: true } : {})), { open: false });
    expect(fold.hidden).toHaveLength(10);
    expect(fold.attention).toEqual({ unread: 1, waiting: 0, working: 2 });
    expect(railFoldMeta(fold.attention)).toBe("2 working · 1 unread");
  });

  it("never hides a bot that needs you or the open chat", () => {
    const fold = railFold(team(18, (i) => (i === 14 ? { activity: "waiting-on-you" } : {})), { open: false, keep: (bot) => bot.id === "b16" });
    expect(fold.visible).toHaveLength(8);
    expect(ids(fold.visible)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b14", "b16"]);
    expect(ids(fold.hidden)).not.toContain("b14");
    expect(ids(fold.hidden)).not.toContain("b16");
  });

  it("keeps every bot that needs you even past eight", () => {
    const fold = railFold(team(20, (i) => (i > 10 ? { activity: "waiting-on-you" } : {})), { open: false });
    expect(fold.visible).toHaveLength(10);
    expect(fold.visible.every((bot) => bot.activity === "waiting-on-you")).toBe(true);
  });

  it("keeps a bot with a question card in view, weighed the way its row is", () => {
    const weigh = (bot: B) => ({ bot, questions: bot.id === "b12" ? 2 : 0 });
    const fold = railFold(team(18), { open: false, weigh });
    expect(ids(fold.visible)).toContain("b12");
    expect(ids(fold.hidden)).not.toContain("b12");
    expect(fold.visible).toHaveLength(8);
  });

  it("a snoozed bot adds nothing to the fold line", () => {
    const weigh = (bot: B) => ({ bot: bot.id === "b15" ? { ...bot, unread: false } : bot, questions: 0 });
    const fold = railFold(team(18, (i) => (i === 15 ? { unread: true } : {})), { open: false, weigh });
    expect(ids(fold.hidden)).toContain("b15");
    expect(fold.attention.unread).toBe(0);
  });

  it("opens whole when the owner opens it or searches", () => {
    expect(railFold(team(35), { open: true }).visible).toHaveLength(35);
    expect(railFold(team(35), { open: true }).hidden).toEqual([]);
  });
});

describe("rail fold row", () => {
  const render = (props: Partial<Parameters<typeof RailFoldRow>[0]> = {}) =>
    renderToStaticMarkup(createElement(RailFoldRow, { hidden: 10, attention: { unread: 0, waiting: 0, working: 2 }, open: false, iconsOnly: false, onToggle: () => {}, ...props }));

  it("reads like the board when closed: 10 more · 2 working, with the pulse", () => {
    const html = render();
    expect(html).toContain("10 more");
    expect(html).toContain("· 2 working");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show 10 more bots, 2 working"');
    expect(html).toContain("data-working-pulse");
  });

  it("offers Show less when open, with no pulse", () => {
    const html = render({ open: true });
    expect(html).toContain("Show less");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("data-working-pulse");
  });

  it("shows +10 in the icon rail, the full line in the tip", () => {
    const html = render({ iconsOnly: true });
    expect(html).toContain("+10");
    expect(html).toContain('title="Show 10 more bots, 2 working"');
  });
});

describe("rail fold in the real sidebar", () => {
  it("every bot section renders through the fold, a search shows every match, and the fold row follows the bots", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain("railFold(sectionBotItems, { open: Boolean(q) || foldOpen, keep: (bot) => rowSelected(bot.id), weigh:");
    expect(source).not.toContain("{sectionBotItems.map((bot) => (");
    expect(source).toContain("weigh: (bot) => sidebarBotAttention(bot, threadAttention, Date.now())");
    expect(source.indexOf("{fold.visible.map((bot) => (")).toBeLessThan(source.indexOf("<RailFoldRowLazy.Component"));
    // first paint: the row loads on first use, never in the entry chunk
    expect(source).not.toMatch(/import \{[^}]*RailFoldRow[^}]*\} from "\.\/RailBotList"/);
  });
});

// UX L6B r2 Mediums: opening the fold puts focus in the search box, and Esc
// there folds it again (a typed search clears first).
describe("rail fold by keyboard", () => {
  it("Esc clears a search first, then closes the most recent fold, then does nothing", () => {
    expect(railSearchEscape("nova", ["team"])).toEqual({ query: "", folds: ["team"] });
    expect(railSearchEscape("", ["team", "ops"])).toEqual({ query: "", folds: ["team"] });
    expect(railSearchEscape("", [])).toBeNull();
  });

  it("a click on the fold row calls its toggle (driven through the element tree)", () => {
    let toggled = 0;
    const row = RailFoldRow({ hidden: 4, attention: { unread: 0, waiting: 0, working: 0 }, open: false, iconsOnly: false, onToggle: () => { toggled += 1; } });
    (row.props as { onClick: () => void }).onClick();
    expect(toggled).toBe(1);
    expect((row.props as Record<string, unknown>)["aria-expanded"]).toBe(false);
  });

  it("the sidebar focuses the search box on open and routes Esc through railSearchEscape", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain('if (opening && density !== "icons") railSearchRef.current?.focus();');
    expect(source).toMatch(/e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
    expect(source).toContain("ref={railSearchRef}");
    expect(source).toContain("railSearchEscape(query, openRailFolds)");
  });
});

// UX L6B p2 item 3 (spec 2.1 items 2 to 4): pins come first in the owner's
// order, the free slots go to the most recently active bots, eight in all,
// and a folded section's header says how many bots it holds ("Bots · 18").
describe("rail pins and the team count", () => {
  it("fills free slots with the most recently active bots, drawn in the owner's order", () => {
    const bots = team(12, (i) => ({ tasks: [{ threadId: `t${i}`, lastActivityAt: i === 11 || i === 12 ? 1_000 + i : i }] }));
    const fold = railFold(bots, { open: false, rank: railRecency });
    expect(ids(fold.visible)).toEqual(["b5", "b6", "b7", "b8", "b9", "b10", "b11", "b12"]);
    expect(ids(fold.hidden)).toEqual(["b1", "b2", "b3", "b4"]);
    // each bot is ranked once per fold, never once per sort comparison
    let ranked = 0;
    railFold(team(40), { open: false, rank: (bot) => (ranked++, railRecency(bot)) });
    expect(ranked).toBe(40);
    // no rank (the Pinned section): the owner's order, as before
    expect(ids(railFold(bots, { open: false }).visible)).toEqual(ids(team(8)));
  });

  it("the Bots section gets what the pins leave of eight", () => {
    expect(railBotsLimit(0)).toBe(8);
    expect(railBotsLimit(3)).toBe(5);
    expect(railBotsLimit(11)).toBe(0);
    const fold = railFold(team(6), { open: false, limit: railBotsLimit(3), rank: railRecency });
    expect(fold.visible).toHaveLength(5);
    expect(fold.hidden).toHaveLength(1);
    // a bot that needs you keeps its row even with no slot left
    const full = railFold(team(4, (i) => ({ activity: i === 2 ? "waiting-on-you" : "idle" })), { open: false, limit: 0, rank: railRecency });
    expect(ids(full.visible)).toEqual(["b2"]);
  });

  it("a bot's recency is its newest chat", () => {
    expect(railRecency({ tasks: [{ lastActivityAt: 5 }, { createdAt: 9 }, {}] })).toBe(9);
    expect(railRecency({})).toBe(0);
  });

  it("a folded section's header carries its count", () => {
    const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(sidebar).toContain('if (id === BOTS_SECTION_ID) return "Your team";');
    const html = renderToStaticMarkup(createElement(SidebarSectionHeader, { name: "Your team", collapsed: false, count: 18, onToggle: () => {}, reorderable: false, dragging: false }));
    expect(html).toContain("Your team · 18");
    expect(renderToStaticMarkup(createElement(SidebarSectionHeader, { name: "Your team", collapsed: false, onToggle: () => {}, reorderable: false, dragging: false }))).not.toContain("·");
  });

  it("the sidebar ranks unpinned sections, budgets the pins and passes the count", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(source).toContain("railBotsLimit(sectionCollapsed(PINNED_SECTION_ID) ? 0 : pinnedBots.length)");
    expect(source).toContain("rank: pins ? undefined : railRecency");
    expect(source).toContain("count={(collapsed || fold.hidden.length > 0) && sectionBotItems.length");
  });
});
