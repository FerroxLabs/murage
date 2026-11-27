import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { distinctBotName, sameNameBots } from "./duplicate-bot-names";
import { DuplicateBotNameNotice } from "@/components/DuplicateBotNameNotice";

// 1.0.21 polish (Sean's live 1.0.20 walk): two bots both named "Dax (Closer)" (one under Sales, one pinned, different
// avatars) appeared in every list. Pinned is a flag on one record (src/lib/sidebar-layout.ts drops pinned ids from the
// team lists), so two rows are two real bots. Murage never deletes or merges one by itself: it says so and offers a
// one-click rename to a distinct name.
const bots = [
  { id: "a", name: "Dax (Closer)", section: "Sales" },
  { id: "b", name: " dax (closer) ", pinned: true },
  { id: "c", name: "Sable" },
  { id: "d", name: "Dax (Closer) 2", hidden: true },
  { id: "e", name: "Sable", hidden: true },
];

describe("same-name bots", () => {
  it("finds the other visible bot with the same name, ignoring case and spaces", () => {
    expect(sameNameBots(bots, bots[0]!).map((bot) => bot.id)).toEqual(["b"]);
    expect(sameNameBots(bots, bots[1]!).map((bot) => bot.id)).toEqual(["a"]);
    // a hidden bot with the same name is not a clash anyone sees in a list
    expect(sameNameBots(bots, bots[2]!)).toEqual([]);
  });
  it("suggests the next name no bot holds", () => {
    expect(distinctBotName(bots, "Dax (Closer)")).toBe("Dax (Closer) 3");
    expect(distinctBotName([{ id: "x", name: "Ivy" }], "Ivy")).toBe("Ivy 2");
  });
});

describe("the notice", () => {
  it("shows nothing for a bot with a unique name", () => {
    expect(renderToStaticMarkup(createElement(DuplicateBotNameNotice, { bot: bots[2]!, bots, onRename: vi.fn() }))).toBe("");
  });
  it("says another bot has the name and offers one rename, never a delete", () => {
    const html = renderToStaticMarkup(createElement(DuplicateBotNameNotice, { bot: bots[0]!, bots, onRename: vi.fn() }));
    expect(html).toContain("Another bot is also named Dax (Closer).");
    expect(html).toContain("Rename this one to Dax (Closer) 3");
    expect(html).not.toMatch(/delete|remove|archive/i);
  });
});

describe("wiring", () => {
  it("bot settings shows the notice and renames through the store's updateBot, the sidebar's own rename path", async () => {
    const { readFileSync } = await import("node:fs");
    const pane = readFileSync(new URL("../components/BotSettingsPane.tsx", import.meta.url), "utf8");
    expect(pane).toContain('<DuplicateBotNameNotice bot={bot} bots={state.bots ?? []} onRename={name => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })} />');
  });
});
