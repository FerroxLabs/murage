// 1.0.9 phone tools N3-web: the "Phone for your bots" row. Pure show/hide rule, a presentational view, and the one click.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { openPhoneForBotsScreen, PhoneForBotsView, phoneForBotsVisible } from "./PhoneForBotsRow";

describe("when the row shows", () => {
  it("shows only inside the app, with the method listed, and with phones offered", () => {
    expect(phoneForBotsVisible({ method: true, offered: true })).toBe(true);
  });
  it("is hidden in a browser or an older app (method missing)", () => {
    expect(phoneForBotsVisible({ method: false, offered: true })).toBe(false);
  });
  it("is hidden when the host flag is off or not yet known", () => {
    expect(phoneForBotsVisible({ method: true, offered: false })).toBe(false);
    expect(phoneForBotsVisible({ method: true, offered: null })).toBe(false);
  });
  it("renders nothing when hidden and the row with its button when shown", () => {
    expect(renderToStaticMarkup(createElement(PhoneForBotsView, { visible: false, onOpen: () => {} }))).toBe("");
    const html = renderToStaticMarkup(createElement(PhoneForBotsView, { visible: true, onOpen: () => {} }));
    expect(html).toContain("phone-for-bots-row");
    expect(html).toContain(t("settings.bot.phoneForBots.title"));
    expect(html).toContain("<button");
  });
});

describe("the click", () => {
  afterEach(() => { delete (globalThis as { murageNative?: unknown }).murageNative; });
  it("the button's handler is the one passed in", () => {
    const onOpen = vi.fn();
    const tree = PhoneForBotsView({ visible: true, onOpen }) as ReactElement<{ children: ReactElement[] }>;
    const find = (node: unknown): ReactElement<{ onClick?: () => void }> | null => {
      if (!node || typeof node !== "object") return null;
      const el = node as ReactElement<{ onClick?: () => void; children?: unknown }>;
      if (el.type === "button") return el;
      const kids = el.props?.children;
      for (const k of Array.isArray(kids) ? kids : [kids]) { const hit = find(k); if (hit) return hit; }
      return null;
    };
    find(tree)!.props.onClick!();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("calls openPhoneForBots on the bridge with no arguments", async () => {
    const open = vi.fn();
    (globalThis as { murageNative?: unknown }).murageNative = { hello: () => ({ version: 1, methods: ["openPhoneForBots"] }), openPhoneForBots: open };
    await openPhoneForBotsScreen();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual([]);
  });
  it("does not throw when the app cannot open it", async () => {
    await expect(openPhoneForBotsScreen()).resolves.toBeUndefined();
  });
});
