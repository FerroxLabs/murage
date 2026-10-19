// B3 WP5: the sign-in view's markup. The terminal itself mounts in an effect (not run here); the page around it is.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EngineLoginTerminal, engineNeedsCode } from "./EngineLoginTerminal";
import type { EngineLoginBridge } from "@/lib/engine-login-terminal";

const bridge = { start: async () => ({ ok: false, code: "x", message: "x" }), input: async () => ({ ok: true }), stop: async () => ({ ok: true }), openLink: async () => ({ ok: true }), onData: () => () => {}, onClosed: () => () => {} } as unknown as EngineLoginBridge;
const html = (engine: "codex" | "claudeAgent", action: "login" | "logout" = "login") => renderToStaticMarkup(createElement(EngineLoginTerminal, { homeId: "h-1", engine, action, bridge }));

describe("EngineLoginTerminal markup", () => {
  it("Claude sign-in has a masked code box; the box is a password input that never autofills", () => {
    const out = html("claudeAgent");
    expect(out).toMatch(/<input[^>]*type="password"/);
    expect(out).toMatch(/autocomplete="off"/i);
    expect(out).not.toMatch(/type="text"/);
    expect(out).toContain("Send code");
  });
  it("Codex sign-in and any sign-out have no code box (nothing is typed)", () => {
    for (const out of [html("codex"), html("codex", "logout"), html("claudeAgent", "logout")]) expect(out).not.toMatch(/<input/);
    expect(engineNeedsCode("codex", "login")).toBe(false);
    expect(engineNeedsCode("claudeAgent", "logout")).toBe(false);
    expect(engineNeedsCode("claudeAgent", "login")).toBe(true);
  });
  it("without the desktop bridge it says so instead of drawing a dead terminal", () => {
    expect(renderToStaticMarkup(createElement(EngineLoginTerminal, { homeId: "h-1", engine: "codex", bridge: null }))).toMatch(/available on this device/);
  });
});
