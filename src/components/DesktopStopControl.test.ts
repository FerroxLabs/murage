// The control has to be present at exactly one moment — while a bot is
// driving this screen — and absent the rest of the time.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesktopStopControl } from "./DesktopStopControl";

const render = (over: Partial<Parameters<typeof DesktopStopControl>[0]> = {}) =>
  renderToStaticMarkup(createElement(DesktopStopControl, {
    botName: "Fig",
    usingThisScreen: true,
    held: false,
    takeScreen: async () => true,
    stopTurn: async () => {},
    confirmIdle: async () => true,
    ...over,
  }));

describe("DesktopStopControl", () => {
  it("offers a named stop while the bot is on this screen", () => {
    const markup = render();
    expect(markup).toContain("Stop using this computer");
    expect(markup).toContain("Fig is using this computer");
    expect(markup).toContain('aria-label="Stop Fig using this computer"');
  });

  it("warns up front that an action already underway can still finish", () => {
    expect(render()).toContain("already underway can still finish");
  });

  it("renders nothing when no turn is on this screen", () => {
    expect(render({ usingThisScreen: false })).toBe("");
  });

  it("claims no outcome before it has been pressed", () => {
    const markup = render();
    expect(markup).not.toContain("Nothing was stopped");
    expect(markup).not.toContain("stopped, and you have this screen");
  });
});
