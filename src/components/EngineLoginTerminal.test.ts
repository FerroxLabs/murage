// B3 WP5: the sign-in view's markup. The terminal itself mounts in an effect (not run here); the page around it is.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EngineLoginTerminal, engineLoginRequest, engineNeedsCode } from "./EngineLoginTerminal";
import { EngineSignInsView, SIGN_INS, type EngineSignInsViewProps, type SignInTarget } from "./cloud/EngineSignIns";
import { engineLoginNeedsBot } from "@/lib/engine-login-terminal";
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
describe("Antigravity in the Connect list and the sign-in terminal (AGY-ON-CLOUD 5)", () => {
  it("the Connect list has Sign in to Antigravity, and it asks which bot", () => {
    expect(SIGN_INS).toContainEqual({ engine: "antigravityAgent", action: "login", label: "Sign in to Antigravity" });
    expect(engineLoginNeedsBot("antigravityAgent", "login", null)).toBe(true);
  });
  it("login shows the masked code field and the start request carries the bot", () => {
    expect(engineNeedsCode("antigravityAgent", "login")).toBe(true);
    expect(engineNeedsCode("antigravityAgent", "logout")).toBe(false);
    expect(engineLoginRequest("h-1", "antigravityAgent", "login", { id: "atlas" })).toMatchObject({ engine: "antigravityAgent", bot: "atlas" });
  });
});
describe("Antigravity sign-in confirmation names the home and the bot (AGY-ON-CLOUD 5, test 7)", () => {
  const atlas = { id: "atlas", name: "Atlas" };
  const base: EngineSignInsViewProps = { homeId: "h2", homeName: "home-7.example", busy: false, signIn: null, botChoices: null, onSignIn: () => {}, onChooseBot: () => {}, onCloseSignIn: () => {} };
  const view = (over: Partial<EngineSignInsViewProps>) => renderToStaticMarkup(createElement(EngineSignInsView, { ...base, ...over }));
  const agy = (extra: Partial<SignInTarget> = {}): SignInTarget => ({ homeId: "h2", engine: "antigravityAgent", action: "login", bot: atlas, ...extra });
  it("before any relay opens, the dialog says which bot and which home, with a Continue button", () => {
    const out = view({ signIn: agy() });
    expect(out).toContain("Sign Atlas in to Antigravity on this Cloud home.");
    expect(out).not.toContain("home-7.example");
    expect(out).toContain("Continue");
    expect(out).not.toContain("Opening the sign-in");
    expect(out).not.toContain("This replaces the current sign-in.");
  });
  it("a bot that already has an Antigravity sign-in is told this replaces it", () => {
    const bots = [{ id: "atlas", name: "Atlas", signIn: { engine: "antigravityAgent", label: "Antigravity", signedIn: true, uses: null as null } }];
    const out = view({ signIn: agy(), bots });
    expect(out).toContain("Sign Atlas in to Antigravity on this Cloud home. This replaces the current sign-in.");
    expect(out).not.toContain("home-7.example");
  });
  it("after Continue the terminal opens, and other engines are not asked", () => {
    expect(view({ signIn: agy({ confirmed: true }) })).toContain("Opening the sign-in");
    const codex = view({ signIn: { homeId: "h2", engine: "codex", action: "login", bot: atlas } });
    expect(codex).not.toContain("Continue");
    expect(codex).toContain("Opening the sign-in");
  });
});
