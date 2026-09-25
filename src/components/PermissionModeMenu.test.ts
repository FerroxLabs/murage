// The composer's approval-level menu: what each level says it does, and that
// Full access is only offered where the server would accept it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PermissionModeMenu } from "./PermissionModeMenu";

const render = (desktop: boolean | undefined, engineCannotAsk?: string) =>
  renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Ember", current: "auto", desktop, onPick: () => {}, engineCannotAsk }));
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

  // Antigravity's print mode cannot ask, so under Full access and No limits
  // Murage runs it with file edits only. The menu has to say so, or the bot
  // just fails the first time it needs a command.
  it("says when this bot's engine cannot ask, on the levels where that costs it commands", () => {
    const markup = render(true, "Antigravity");
    for (const label of ["Full access", "No limits"]) expect(item(markup, label)).toContain("Antigravity cannot ask first, so it edits files here but runs no commands.");
    for (const label of ["Ask for approval", "Auto mode"]) expect(item(markup, label)).not.toContain("cannot ask first");
    expect(render(true)).not.toContain("cannot ask first");
  });
});
