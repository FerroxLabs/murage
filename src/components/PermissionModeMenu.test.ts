// The composer's approval-level menu: what each level says it does, and that
// Full access is only offered where the server would accept it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PermissionModeMenu } from "./PermissionModeMenu";

const render = (desktop: boolean | undefined, engineCannotAsk?: string, engineOwnApprovals?: string) =>
  renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "auto", desktop, onPick: () => {}, engineCannotAsk, engineOwnApprovals }));
const item = (markup: string, label: string) => {
  const at = markup.indexOf(label);
  expect(at, `no "${label}" item`).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf("</button>", at));
};

describe("composer approval-level menu", () => {
  it("says what Full access still stops before", () => {
    const full = item(render(true), "Full access");
    expect(full).toContain("stops before deleting outside its folder, paying, messaging someone new, or reading your keys");
  });

  it("offers No limits with its plain description, on the desktop only", () => {
    expect(item(render(true), "No limits")).toContain("Does anything without asking, except reading your keys and passwords.");
    const remote = item(render(false), "No limits");
    expect(remote).toContain(' disabled=""');
    expect(remote).toContain("No limits can only be turned on in the Murage desktop app.");
  });

  it("does not offer Full access away from the desktop app, and says why", () => {
    const remote = item(render(false), "Full access");
    expect(remote).toContain(' disabled=""');
    expect(remote).toContain("Full access can only be turned on in the Murage desktop app.");
    expect(item(render(false), "Auto mode")).not.toContain(' disabled=""');
    for (const desktop of [true, undefined]) expect(item(render(desktop), "Full access")).not.toContain(' disabled=""');
  });

  // Antigravity's print mode cannot ask, so at every level Murage runs it
  // with file edits only: no shell, teammates, memory or connected apps. The
  // menu has to say so on every level, Ask and Auto included.
  it("says when this bot's engine cannot ask, on every level", () => {
    const markup = render(true, "Antigravity");
    for (const label of ["Ask for approval", "Auto mode", "Full access", "No limits"])
      expect(item(markup, label)).toContain("Antigravity can&#x27;t stop to ask, so it works without commands, teammates, memory or connected apps.");
    expect(render(true)).not.toContain("stop to ask");
  });

  // 0.1.60 Mac pass: No limits chosen on the chip in Ember's chat left the
  // routine at "Same as Ember (Ask)", and nothing on the menu said so.
  it("says which level it changes: this conversation's, or the routine's", () => {
    const menu = (scope: { routine?: string } = {}) =>
      renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "ask", desktop: true, onPick: () => {}, scope }));
    expect(menu()).toContain("Changes this conversation only. Routines use the level in Bot settings, Permissions, unless a routine has its own.");
    expect(menu({ routine: "Log tick" })).toContain("Changes the level of the routine Log tick. Every run of it works here.");
    expect(menu({ routine: "Log tick" })).toContain("How should runs of Log tick be approved?");
  });
});

describe("an engine that runs on its own tools and approvals", () => {
  it("says so once, as what it is, and leaves the Antigravity note alone", () => {
    const markup = render(true, undefined, "OpenClaw");
    expect(markup).toContain("OpenClaw runs on its own tools and approvals, so these levels do not change what it does.");
    expect(markup).not.toContain("cannot ask first");
    expect(markup).not.toMatch(/\u2014|\bunsafe\b/);
    expect(render(true)).not.toContain("its own tools and approvals");
  });
});
