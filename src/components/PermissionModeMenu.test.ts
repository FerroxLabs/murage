// The composer's approval-level menu: what each level says it does, and that
// Full access is only offered where the server would accept it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PERMISSION_MODES, PermissionModeMenu } from "./PermissionModeMenu";

const render = (desktop: boolean | undefined, engineCannotAsk?: string, engineOwnApprovals?: string) =>
  renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "auto", desktop, onPick: () => {}, engineCannotAsk, engineOwnApprovals }));
const item = (markup: string, label: string) => {
  const at = markup.indexOf(label);
  expect(at, `no "${label}" item`).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf("</button>", at));
};

describe("composer approval-level menu", () => {
  it("H8 No limits explains native request coverage when the engine cannot ask", () => {
    const noLimits = item(render(true, "Antigravity"), "No limits");
    expect(noLimits).not.toContain("works without commands");
    expect(noLimits).toContain("At No limits, Murage adds no permission cards except for a likely wipe or catastrophe in requests it receives.");
    expect(noLimits).toContain("Only a likely wipe or catastrophe asks first.");
    for (const label of [">Ask<", ">Auto<", "Full access"])
      expect(item(render(true, "Antigravity"), label)).toContain("works without commands");
  });
  it("Astra r1 item 8: names the levels exactly Ask, Auto, Full access, No limits", () => {
    expect(PERMISSION_MODES.map((entry) => entry.label)).toEqual(["Ask", "Auto", "Full access", "No limits"]);
    expect(PERMISSION_MODES.map((entry) => entry.chip)).toEqual(["Ask", "Auto", "Full access", "No limits"]);
    const markup = render(true);
    for (const old of ["Ask for approval", "Auto mode"]) expect(markup).not.toContain(old);
    // Fable r1 L4: the detail is read when used, not frozen at module load
    const auto = PERMISSION_MODES.find((entry) => entry.mode === "auto")!;
    expect(Object.getOwnPropertyDescriptor(auto, "detail")?.get).toBeTypeOf("function");
    expect(auto.detail.length).toBeGreaterThan(10);
  });

  it("says what Full access still stops before", () => {
    const full = item(render(true), "Full access");
    // UX-TRUST-MOMENTS-1012 section 8 row 17
    expect(full).toContain("Still asks before paying, emailing someone new, posting in public, deleting outside its folder, or reading your keys and passwords.");
  });

  it("offers No limits with its plain description, on the desktop only", () => {
    expect(item(render(true), "No limits")).toContain("Your bots run commands and tools without asking, even with outside content or commands Murage cannot read. This can change protected files and read or send keys and passwords. Only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on. Murage says what is off and where to turn it on, without a card. Channel messages off stays off. Trigger links from other apps and routines use the bot's level. Other people's chats stay at Ask unless you explicitly set that bot's level. A setting carried over from 1.0.18 does not count.".replace(/'/g, "&#x27;"));
    // 3.4: greyed on the phone, with where it is set
    const remote = item(render(false), "No limits");
    expect(remote).toContain(' aria-disabled="true"');
    expect(remote).toContain("Set this on your computer.");
  });

  it("does not offer Full access away from the desktop app, and says why", () => {
    const remote = item(render(false), "Full access");
    expect(remote).toContain(' aria-disabled="true"');
    expect(remote).toContain("Set this on your computer.");
    expect(render(false)).toContain("Full access and No limits are set on your computer, where you can see what they change.");
    expect(item(render(false), ">Auto<")).not.toContain(' aria-disabled="true"');
    for (const desktop of [true, undefined]) expect(item(render(desktop), "Full access")).not.toContain(' aria-disabled="true"');
  });

  // Lower levels retain the file-edit restriction; No limits runs commands.
  it("says when this bot's engine cannot ask at lower levels", () => {
    const markup = render(true, "Antigravity");
    for (const label of [">Ask<", ">Auto<", "Full access"])
      expect(item(markup, label)).toContain("Antigravity can&#x27;t stop to ask, so it works without commands, teammates, memory or connected apps.");
    expect(render(true)).not.toContain("stop to ask");
  });

  // 0.1.60 Mac pass: No limits chosen on the chip in Ember's chat left the
  // routine at "Same as Ember (Ask)", and nothing on the menu said so.
  it("says which level it changes: this conversation's, or the routine's", () => {
    const menu = (scope: { routine?: string } = {}) =>
      renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "ask", desktop: true, onPick: () => {}, scope }));
    // UX-TRUST-MOMENTS-1012 3.1: routines keep their own level (T10)
    expect(menu()).toContain("Changes this conversation only. Routines keep their own level. Ember&#x27;s default for new conversations is Ask, under Ember › Level.");
    expect(menu({ routine: "Log tick" })).toContain("Changes the level of the routine Log tick. Every run of it works here.");
    expect(menu({ routine: "Log tick" })).toContain("How should runs of Log tick be approved?");
  });
});

describe("an engine that runs on its own tools and approvals", () => {
  it("says so once, as what it is, and leaves the Antigravity note alone", () => {
    const markup = render(true, undefined, "OpenClaw");
    expect(markup).toContain("OpenClaw uses its own tools. At Ask, it only reads and answers. At other levels, your OpenClaw settings still apply. At No limits, Murage asks only about a likely wipe or catastrophe in requests it receives. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.");
    // U45: the old note said the levels change nothing, which is wrong at Ask.
    expect(markup).not.toContain("these levels do not change what it does");
    expect(markup).not.toContain("cannot ask first");
    expect(markup).not.toMatch(/\u2014|\bunsafe\b/);
    expect(render(true)).not.toContain("runs on its own tools");
  });
});
