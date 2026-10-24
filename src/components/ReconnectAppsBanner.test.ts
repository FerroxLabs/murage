// The chat says which app needs signing in again. Its Reconnect opens
// Connected apps; the sign-in starts only from the confirmed label form.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReconnectAppsBannerView, reconnectNotice, type ReconnectApp } from "./ReconnectAppsBanner";

const gmail = { slug: "gmail", label: "Gmail", accounts: [{ id: "ca_1", alias: "work" }] };
const cal = { slug: "googlecalendar", label: "Google Calendar", accounts: [{ id: "ca_2" }] };

describe("reconnect line in the chat", () => {
  it("says nothing when no app needs it", () => {
    expect(reconnectNotice([])).toBeNull();
  });
  it("names the app, singular and plural", () => {
    expect(reconnectNotice([gmail])).toBe("Gmail needs reconnecting.");
    expect(reconnectNotice([gmail, cal])).toBe("Gmail and Google Calendar need reconnecting.");
  });
  it("never authorizes from the chat line: Reconnect opens Connected apps (#758)", () => {
    const source = readFileSync(fileURLToPath(new URL("./ReconnectAppsBanner.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\/authorize/);
    expect(source).not.toMatch(/openExternalPage/);
    expect(source).toContain('dispatch({ type: "togglePlugins", open: true, surface: "apps" })');
  });
  it("follows the copy rules", () => {
    const source = readFileSync(fileURLToPath(new URL("./ReconnectAppsBanner.tsx", import.meta.url)), "utf8");
    for (const text of [source, reconnectNotice([gmail, cal])!]) expect(text).not.toMatch(/—|\bsafe(ly|ty)?\b|\bunsafe\b|Composio/i);
  });
});

describe("the reconnect line as rendered", () => {
  const render = (apps: ReconnectApp[], desktop = true) =>
    renderToStaticMarkup(createElement(ReconnectAppsBannerView, { apps, busy: null, onReconnect: () => {}, desktop }));
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];

  it("renders nothing when no app needs reconnecting", () => {
    expect(render([])).toBe("");
  });
  it("shows the notice and one plain Reconnect for one app", () => {
    const html = render([gmail]);
    expect(html).toContain("Gmail needs reconnecting.");
    expect(buttons(html).map((m) => m[1])).toEqual(["Reconnect"]);
    expect(html).toContain('aria-label="Reconnect Gmail"');
  });
  it("shows one named button per app when several need it", () => {
    const html = render([gmail, cal]);
    expect(html).toContain("Gmail and Google Calendar need reconnecting.");
    expect(buttons(html).map((m) => m[1])).toEqual(["Reconnect Gmail", "Reconnect Google Calendar"]);
    expect(html).toContain('aria-label="Reconnect Gmail"');
    expect(html).toContain('aria-label="Reconnect Google Calendar"');
  });
  it("points to the computer instead of a button away from the desktop", () => {
    const html = render([gmail], false);
    expect(buttons(html)).toHaveLength(0);
    expect(html).toContain("Reconnect it on your computer.");
  });
});

describe("Connected apps panel Reconnect", () => {
  const panel = readFileSync(fileURLToPath(new URL("./PluginsPanel.tsx", import.meta.url)), "utf8");
  it("renders the Reconnect button only for an active account whose app needs reconnecting, and names that account", () => {
    expect(panel).toMatch(/const needsReconnect = active && serviceStatus\?\.needsReconnect === true;/);
    const at = panel.indexOf("data-connector-reconnect=");
    expect(at).toBeGreaterThan(0);
    const before = panel.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/\{needsReconnect && \(\s*<button[\s\S]*$/);
    const after = panel.slice(at, at + 900);
    expect(after).toContain("setReconnectTarget({ slug: card.slug, accountId: account.id })");
    expect(after.slice(0, after.indexOf("aria-label="))).not.toMatch(/\bconnect\(/);
  });
});
