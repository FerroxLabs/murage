// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 Settings pages 8 to 13 and Apps > Messaging (SETPAGES-B): each page lists every registered card once, with the registry's
// anchor, marks the Simple cards the lock names, and renders a stub (never nothing) where the surface cannot use a card.
// The pages as a person sees them are driven in e2e/settings-pages-b.human.spec.ts.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import "@/lib/settings-copy";
import { SETTINGS_CARDS } from "@/lib/settings-card-registry";
import { pageCardProblems, visibleCards } from "@/lib/settings-page-contract";
import { isAdvancedOnlyCard, isSimpleCard } from "@/lib/settings-simple-cards";
import { aboutCards } from "./AboutPage";
import { backupsCards } from "./BackupsPage";
import { ChannelsPageBody, channelsCards } from "./ChannelsPage";
import { SECTION_ALIASES } from "@/lib/settings-pages";
import { SETTINGS_PAGE_LOADERS } from "../page-registry";
import { companionCards } from "./CompanionPage";
import { computerCards } from "./ComputerPage";
import ConnectionsPage, { ConnectedAppsCard, connectionsCards } from "./ConnectionsPage";
import { BotEmailReadoutView } from "./BotEmailReadout";
import { PluginsPanel } from "../../PluginsPanel";
import type { EmailStatusState } from "@/lib/bot-email";
import { usageCards } from "./UsagePage";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { composio: { configured: true, mode: "managed" }, flux: { configured: true } }, bots: [] }, dispatch: vi.fn() }),
}));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replaceAll("&#x27;", "'");
const ids = (cards: readonly { id: string }[]) => cards.map((card) => card.id);

describe("About and help (page 13)", () => {
  const desktop = aboutCards({ desktop: true, cloud: false });
  it("lists every registered card once with the registry's anchor", () => {
    expect(pageCardProblems("about", desktop, SETTINGS_CARDS)).toEqual([]);
  });
  it("puts Version and updates and What's new in Simple, and the rest behind Set in Advanced", () => {
    const simple = visibleCards(desktop, "simple");
    expect(ids(simple.shown)).toEqual(["about.version", "about.whats-new"]);
    expect(simple.hidden).toBe(5);
    expect(visibleCards(desktop, "advanced").hidden).toBe(0);
  });
  it("keeps the locked seven cards in the locked order, Updates and Previous version inside Version and Announcements inside News", () => {
    expect(ids(desktop)).toEqual(["about.version", "about.whats-new", "about.news", "about.health", "about.diagnostics", "about.setup", "about.shortcuts"]);
  });
  it("on a phone stubs the cards that need the computer instead of dropping them", () => {
    const phone = aboutCards({ desktop: false, cloud: false });
    for (const id of ["about.news", "about.diagnostics", "about.setup"]) {
      const out = html(phone.find((card) => card.id === id)!.render() as never);
      expect(out, id).toContain("data-settings-stub");
    }
  });
});


describe("Connected apps (page 8)", () => {
  const cards = connectionsCards({ desktop: true, cloud: false });
  it("lists every registered card once; Simple has the apps and tools cards, Advanced adds bot email, HighLevel and phone calls", () => {
    expect(pageCardProblems("connections", [...cards, ...channelsCards({ desktop: true })], SETTINGS_CARDS)).toEqual([]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["connections.apps", "connections.mcp"]);
    expect(visibleCards(cards, "simple").hidden).toBe(4);
    expect(ids(visibleCards(cards, "advanced").shown)).toEqual(["connections.apps", "connections.bot-email", "connections.mcp", "connections.claude-code", "connections.highlevel", "connections.phone-calls"]);
  });
  it("on a phone keeps every card and its computer-action stub, including app and email readouts", () => {
    for (const card of connectionsCards({ desktop: false, cloud: false })) expect(html(card.render() as never), card.id).toContain("data-settings-stub");
  });
  it("embeds the catalog and tools without a second modal or close button, with real anchor controls", () => {
    const apps = html(cards.find((card) => card.id === "connections.apps")!.render() as never);
    const tools = html(cards.find((card) => card.id === "connections.mcp")!.render() as never);
    expect(apps).toContain('data-plugins-embedded="true"');
    expect(apps).toContain("Marketplace");
    expect(apps).toContain("Connected");
    expect(apps).toContain('data-setting-control="connections-heading"');
    expect(apps).toContain('aria-controls=');
    expect(apps).toContain('tabindex="-1"');
    expect(tools).toContain('data-mcp-embedded="true"');
    expect(tools).toContain('data-setting-control="mcp-servers-heading"');
    for (const out of [apps, tools]) {
      expect(out).not.toContain('role="dialog"');
      expect(out).not.toContain('aria-modal=');
      expect(out).not.toContain("Close connected apps");
      expect(out).not.toContain("plugins-title");
    }
    const modal = html(createElement(PluginsPanel));
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain("Close connected apps");
  });
  it.each(["simple", "advanced"] as const)("composes the same Messaging body in %s with its surface and mode", (mode) => {
    const props = { page: "connections" as const, mode, desktop: false, cloud: false, anchor: "telegram-settings-title" };
    const out = html(createElement(ConnectionsPage, props));
    const body = html(createElement(ChannelsPageBody, props));
    expect(out).toContain("Messaging apps");
    expect(out).toContain(body);
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('aria-controls=');
    expect(out).toContain('hidden=""');
    expect(Object.hasOwn(SETTINGS_PAGE_LOADERS, "channels")).toBe(false);
    for (const card of channelsCards(props).filter((card) => mode === "advanced" || card.simple)) {
      expect(out.split(`id="${card.anchor}"`)).toHaveLength(2);
    }
  });
  it("keeps the app list first: the ready note follows it, and Refresh sits in the tabs row, so Add account is not pushed down", () => {
    const card = html(createElement(ConnectedAppsCard, {}));
    expect(card).toContain("Connected apps service is ready");
    expect(card.indexOf("data-plugins-embedded")).toBeGreaterThan(-1);
    expect(card.indexOf("Connected apps service is ready")).toBeGreaterThan(card.indexOf("data-plugins-embedded"));
    const source = readFileSync(new URL("../../PluginsPanel.tsx", import.meta.url), "utf8");
    const tabsRow = source.indexOf('aria-label="Connected apps view"');
    const refresh = source.indexOf('data-setting-control="connections-heading"');
    expect(tabsRow).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(tabsRow);
  });
  it("opens the legacy Channels route on the visible Messaging tab", () => {
    const target = SECTION_ALIASES.channels;
    const out = html(createElement(ConnectionsPage, { page: target.section, anchor: target.anchor, mode: "simple", desktop: false, cloud: false }));
    expect(out).toMatch(/aria-selected="true"[^>]*>Messaging apps<\/button>/);
    expect(out).toContain('id="telegram-settings-title"');
    expect(out).not.toContain('id="slack-app-setup-heading"');
  });
  it.each([{ desktop: false, cloud: false }, { desktop: true, cloud: true }, { desktop: undefined, cloud: false }])("retains readouts and stubs tools/HighLevel on $desktop/$cloud", (surface) => {
    const remote = connectionsCards(surface);
    expect(html(remote.find((card) => card.id === "connections.apps")!.render() as never)).toContain('data-plugins-embedded="true"');
    expect(html(remote.find((card) => card.id === "connections.bot-email")!.render() as never)).toContain('data-testid="bot-email-readout"');
    for (const id of ["connections.mcp", "connections.highlevel"]) expect(html(remote.find((card) => card.id === id)!.render() as never)).toContain('data-settings-stub="other-surface"');
  });
  it("shows email state, usage, addresses and stale information without account mutation controls or prices", () => {
    const status: EmailStatusState = { kind: "on", view: {
      enabled: true, accountState: "active", termsVersion: null, limits: {}, priceNote: "desktop-only-price",
      removing: [{ botId: "ada", address: "ada@example.test" }], otherSetups: [{ inboxId: "old", address: "old@example.test" }],
      accountSends: { today: 2, perDay: 10 }, staleNote: "last confirmed email status", ownerKeyLine: "sign-in status", reasonLine: "account reason",
    } };
    const out = html(createElement(BotEmailReadoutView, { status, fluxReady: true, chief: "Nova" }));
    for (const text of ["Bot email is on", "ada@example.test", "old@example.test", "2 of 10", "last confirmed email status", "sign-in status", "account reason"]) expect(out).toContain(text);
    expect(out).toContain('data-settings-stub="other-surface"');
    expect(out).not.toContain('role="switch"');
    expect(out).not.toContain("desktop-only-price");
  });
  it.each<EmailStatusState>([
    { kind: "checking", note: "Waiting for confirmation" }, { kind: "flux-refused", line: "Key refused" },
    { kind: "flux-sign-in", line: "Email scope required" }, { kind: "flux-line", line: "Rollout pending" },
  ])("keeps the email gate's readout: $kind", (status) => {
    const out = html(createElement(BotEmailReadoutView, { status, fluxReady: true, chief: "Nova" }));
    expect(out).toContain("line" in status ? status.line : status.kind === "checking" ? status.note! : "");
    expect(out).not.toContain("Bot email is off");
  });
});

describe("Messaging apps (Apps tab)", () => {
  const cards = channelsCards({ desktop: true });
  it("lists the eight registered cards once in app order; Simple has the four apps, Advanced adds the four parts", () => {
    expect(pageCardProblems("connections", [...connectionsCards({ desktop: true, cloud: false }), ...cards], SETTINGS_CARDS)).toEqual([]);
    expect(ids(cards)).toEqual(["channels.telegram", "channels.slack", "channels.slack-setup", "channels.discord", "channels.discord-setup", "channels.whatsapp", "channels.allow-lists", "channels.whatsapp-groups"]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["channels.telegram", "channels.slack", "channels.discord", "channels.whatsapp"]);
    expect(visibleCards(cards, "simple").hidden).toBe(4);
  });
  it("on a phone stubs every card instead of dropping it", () => {
    for (const card of channelsCards({ desktop: false })) expect(html(card.render() as never), card.id).toContain("data-settings-stub");
  });
});

describe("Backups (page 11)", () => {
  it("lists both registered cards once; Simple has the backup card only, Advanced adds Storage", () => {
    const cards = backupsCards("simple");
    expect(pageCardProblems("backups", cards, SETTINGS_CARDS)).toEqual([]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["backups.backups"]);
    expect(ids(visibleCards(cards, "advanced").shown)).toEqual(["backups.backups", "backups.storage"]);
  });
});

describe("Usage (page 12)", () => {
  it("lists the six registered cards once; Simple has by bot, the spend notice, by routine and account usage, Advanced adds the learning meters and the monthly limit", () => {
    const cards = usageCards();
    expect(pageCardProblems("usage", cards, SETTINGS_CARDS)).toEqual([]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["usage.by-bot", "usage.spend-limit", "usage.by-routine", "usage.account"]);
    expect(ids(visibleCards(cards, "advanced").shown)).toEqual(["usage.by-bot", "usage.learning", "memory.limit", "usage.spend-limit", "usage.by-routine", "usage.account"]);
  });
  it("filters Simple from the shared order without changing cards or anchors", () => {
    const cards = usageCards();
    expect(cards.map(({ anchor }) => anchor)).toEqual(["usage-heading", "usage-learning-heading", "memory-limit-heading", "spend-limit-heading", "usage-by-routine-heading", "plan-usage-heading"]);
    const simple = visibleCards(cards, "simple");
    expect(simple.shown).toEqual(cards.filter((card) => card.simple));
    for (const card of simple.shown) expect(cards).toContain(card);
    expect(simple.hidden).toBe(2);
    expect(visibleCards(cards, "advanced").hidden).toBe(0);
  });
  it("the monthly learning limit moved here from Memory and kept its id and anchor", () => {
    const entry = SETTINGS_CARDS.find((card) => card.id === "memory.limit");
    expect(entry?.section).toBe("usage");
    expect(entry?.anchor).toBe("memory-limit-heading");
  });
});

describe("Computer and browser (page 9)", () => {
  const cards = computerCards([]);
  it("lists every registered card once, in the locked order, with Browser access in Simple", () => {
    expect(pageCardProblems("computer", cards, SETTINGS_CARDS)).toEqual([]);
    expect(ids(cards)).toEqual(["companion.computer", "companion.browser", "companion.vps", "companion.script-access"]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["companion.browser"]);
    expect(visibleCards(cards, "simple").hidden).toBe(3);
    expect(ids(visibleCards(cards, "advanced").shown)).toEqual(ids(cards));
    expect(visibleCards(cards, "advanced").hidden).toBe(0);
  });
  it("keeps the same Browser access card and anchor in both modes", () => {
    const simple = visibleCards(cards, "simple").shown[0]!;
    expect(simple).toBe(visibleCards(cards, "advanced").shown.find((card) => card.id === "companion.browser"));
    expect(simple.anchor).toBe("browser-settings-heading");
    expect(isAdvancedOnlyCard("computer", simple.id)).toBe(false);
    expect(isAdvancedOnlyCard("computer", "companion.computer")).toBe(true);
  });
});

describe("Phone and other devices (page 10)", () => {
  it("lists the pairing card once in Simple and Advanced with no hidden cards", () => {
    const cards = companionCards(undefined);
    expect(pageCardProblems("companion", cards, SETTINGS_CARDS)).toEqual([]);
    expect(ids(visibleCards(cards, "simple").shown)).toEqual(["companion.pairing"]);
    expect(visibleCards(cards, "simple").hidden).toBe(0);
    expect(visibleCards(cards, "advanced").hidden).toBe(0);
  });
  it("keeps pairing in its canonical home with the same card and anchor in both modes", () => {
    const cards = companionCards(undefined);
    const simple = visibleCards(cards, "simple").shown[0]!;
    expect(simple).toBe(visibleCards(cards, "advanced").shown[0]);
    expect(simple.anchor).toBe("companion-heading");
    expect(isAdvancedOnlyCard("companion", simple.id)).toBe(false);
    expect(computerCards([]).some((card) => card.id === simple.id)).toBe(false);
  });
});

describe("the Simple card list (settings-simple-cards.ts) says what the page files say", () => {
  const pages = {
    connections: [...connectionsCards({ desktop: true, cloud: false }), ...channelsCards({ desktop: true })], backups: backupsCards("simple"),
    usage: usageCards(), about: aboutCards({ desktop: true, cloud: false }), computer: computerCards([]), companion: companionCards(undefined),
  } as const;
  for (const [page, cards] of Object.entries(pages)) {
    it(`${page}: every card's simple flag matches the list, so a link to an Advanced-only card turns Advanced on`, () => {
      for (const card of cards) {
        expect(isSimpleCard(card.id), card.id).toBe(card.simple);
        expect(isAdvancedOnlyCard(page as never, card.id), card.id).toBe(!card.simple);
      }
    });
  }
});
