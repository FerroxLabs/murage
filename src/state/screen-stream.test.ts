import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, reducer } from "./store";
import { ScreenStreamNotice } from "../components/ComputerPanel";

// The stateless notice does not need Electron's browser-only context startup.
vi.mock("../components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

describe("oversized live preview notices", () => {
  it("keeps the last good image and shows an actionable notice", () => {
    const pixels = { png: "last-good-image", mime: "image/png" };
    const state = reducer({ ...initialState, screens: { "bot-a": pixels } }, {
      type: "screenUnavailable", botId: "bot-a", message: "Preview too large; open the live desktop or request a screenshot.",
    });
    expect(state.screens["bot-a"]).toEqual(pixels);
    const markup = renderToStaticMarkup(createElement(ScreenStreamNotice, { message: state.screenNotices?.["bot-a"] }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("open the live desktop or request a screenshot");
  });

  it("resumes ordinary previews and clears only that bot's notice", () => {
    const state = reducer({ ...initialState, screenNotices: { "bot-a": "large", "bot-b": "other" } }, {
      type: "screenFrame", botId: "bot-a", png: "new-good-image", mime: "image/jpeg",
    });
    expect(state.screens["bot-a"]).toEqual({ png: "new-good-image", mime: "image/jpeg" });
    expect(state.screenNotices).toEqual({ "bot-b": "other" });
    expect(renderToStaticMarkup(createElement(ScreenStreamNotice, { message: state.screenNotices?.["bot-a"] }))).toBe("");
  });
});
