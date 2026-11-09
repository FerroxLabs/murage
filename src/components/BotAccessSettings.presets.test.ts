// B43: the preset buttons only set one account's checkboxes; the changes switch is never touched.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CONNECTED_APP_TOOLS } from "../../shared/bot-access";
import { GrantPresetButtons } from "./BotAccessSettings";

const catalog = CONNECTED_APP_TOOLS.map((entry) => ({ ...entry }));
const buttons = (toolkit: string, onApply = vi.fn(), busy = false) => {
  const tree = GrantPresetButtons({ toolkit, catalog, busy, onApply }) as any;
  const row = tree.props.children[0];
  return (row.props.children as any[]).map((span) => ({ title: span.props.title, button: span.props.children }));
};

describe("GrantPresetButtons", () => {
  it("names the buttons for the checkboxes they change and shows the changes-switch note", () => {
    const html = renderToStaticMarkup(createElement(GrantPresetButtons, { toolkit: "gmail", catalog, busy: false, onApply: vi.fn() }));
    expect(html).toContain("Select read tools");
    expect(html).toContain("Select all tools");
    expect(html).toContain("Tools that make changes still need the bot&#x27;s changes switch turned on");
  });
  it("hands back explicit slugs only and does nothing else", () => {
    const onApply = vi.fn();
    const [read, all] = buttons("gmail", onApply);
    read.button.props.onClick();
    all.button.props.onClick();
    expect(onApply.mock.calls).toEqual([[["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"]], [["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE", "GMAIL_SEND_EMAIL"]]]);
  });
  it("an empty expansion disables its button with the tooltip", () => {
    const [read, all] = buttons("slack");
    expect(read.button.props.disabled).toBe(true);
    expect(read.title).toBe("No Slack tools of this kind are available yet");
    expect(all.button.props.disabled).toBe(false);
    expect(all.title).toBeUndefined();
  });
  it("reads its words from locale keys that every shipped language has, with no English in the component", () => {
    const source = readFileSync(new URL("./BotAccessSettings.tsx", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("const PRESET_LABEL"), source.indexOf("/** Owner-only controls."));
    for (const english of ["Select read tools", "Select all tools", "tools of this kind are available yet", "still need the bot"]) expect(body).not.toContain(english);
    const keys = ["botAccess.preset.read", "botAccess.preset.all", "botAccess.preset.none", "botAccess.preset.writesNote"];
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), "utf8")) as Record<string, string>;
      for (const key of keys) expect(pack[key], `${code}:${key}`).toBeTruthy();
      expect(pack["botAccess.preset.none"], code).toContain("{app}");
    }
  });
  it("applying a preset changes grants only: the card wires it to setGrants, never setWrites", () => {
    const source = readFileSync(new URL("./BotAccessSettings.tsx", import.meta.url), "utf8");
    const wiring = source.match(/<GrantPresetButtons [^\n]*\/>/)?.[0] ?? "";
    expect(wiring).toContain("onApply={tools=>setGrants(current=>withAccountTools(current,account,tools))}");
    expect(wiring).not.toMatch(/setWrites|allowWrites/);
    const body = source.slice(source.indexOf("export function GrantPresetButtons"), source.indexOf("/** Owner-only controls."));
    expect(body).not.toMatch(/setWrites|allowWrites|setGrants/);
  });
});
