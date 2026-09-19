// The calendar's bot list said "BotAgent" under every bot that had no title —
// a placeholder, not a fact about the bot.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null }));
const { CalendarSidebar } = await import("./CalendarSidebar");

const bot = (over: Partial<Bot>): Bot => ({ id: over.name, name: "Pearl", title: "", description: "", ...over } as Bot);
const render = (bots: Bot[]) => renderToStaticMarkup(createElement(CalendarSidebar, { bots, anchor: Date.parse("2026-09-19T12:00:00Z"), onSelectDate: () => {}, onCreate: () => {} }));

it("shows a bot's own role, or its description, and never a made-up one", () => {
  const html = render([
    bot({ name: "Pearl", title: "Operations lead" }),
    bot({ name: "Ember", description: "Keeps the week moving." }),
    bot({ name: "Moss" }),
  ]);
  expect(html).not.toContain("BotAgent");
  expect(html).toContain("Operations lead");
  expect(html).toContain("Keeps the week moving.");
  // a bot with neither has only its name: no empty second line
  expect(html).toMatch(/>Moss<\/div><\/div>/);
});
