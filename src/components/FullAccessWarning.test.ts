// The one-time Full access warning says, in plain words, what the bot will
// stop asking about — and what still asks.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FullAccessWarning } from "./FullAccessWarning";
import { permissionModeOf } from "@/lib/permission-mode";

const render = (onThisComputer: boolean) =>
  renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", onThisComputer, onCancel: () => {}, onConfirm: () => {} }));

describe("FullAccessWarning", () => {
  it("names what Full access stops asking about, and what it still stops before", () => {
    const markup = render(false);
    expect(markup).toContain("will not ask before running commands, editing files or contacting other bots");
    expect(markup).toContain("still asks before deleting anything outside its folder, paying for anything, messaging someone new or posting in public, and reading your keys and passwords");
    expect(markup).toContain("webhooks or routines still ask");
    expect(markup).toContain("image generation still asks");
    expect(markup).toContain("messages from Telegram, Slack or Discord, and setup requests");
    expect(markup).toContain("unless you allow them in Bot Settings");
    expect(markup).not.toContain("your own screen");
  });

  it("covers this computer when the bot drives it", () => {
    expect(render(true)).toContain("your own screen, mouse and keyboard");
  });

  it("has its own wording for No limits", () => {
    const markup = renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", level: "unlimited", onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(markup).toContain("Give @Vega no limits?");
    expect(markup).toContain("will do anything without asking, except reading your keys and passwords");
    expect(markup).toContain("Turn on no limits");
    expect(markup).not.toContain("still asks before deleting anything outside its folder");
    expect(markup).not.toMatch(/\u2014|\bsafe\b/);
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(FullAccessWarning, { open: false, botName: "Vega", onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }))).toBe("");
  });
});

describe("permissionModeOf", () => {
  it("reads Full access only on top of Auto", () => {
    expect(permissionModeOf({ autoApprove: true, fullAccess: true })).toBe("full");
    expect(permissionModeOf({ autoApprove: true, fullAccess: false })).toBe("auto");
    expect(permissionModeOf({ autoApprove: false, fullAccess: true })).toBe("ask");
  });

  it("reads No limits only on top of Full access, so older Full access bots stay guarded", () => {
    expect(permissionModeOf({ autoApprove: true, fullAccess: true, noLimits: true })).toBe("unlimited");
    expect(permissionModeOf({ autoApprove: true, fullAccess: false, noLimits: true })).toBe("auto");
    expect(permissionModeOf({ autoApprove: true, fullAccess: true })).toBe("full");
  });
});
