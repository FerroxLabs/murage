// The Cloud error card's "Sign in again": for every engine a home signs in, on the Cloud window and on an owner's browser, either a
// button that calls the right sign-in entry, one plain line naming a real place, or (no place offers it) just the refresh news.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";

const cloud = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/cloud-workspace", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloud-workspace")>()), isCloudHome: () => cloud.on }));

const { EngineSignInAgainView, signInAgainPlan, signInAgainComputerLine, signInAgainNoRouteLine } = await import("./EngineSignInAgain");
const { runOfferSignIn } = await import("./BotSignInOffer");
const { ProviderErrorCard } = await import("../ProviderErrorCard");

const BANNED = new RegExp(["\\b(?:sa", "fe|sa", "fely|sa", "fety|fr", "ee|will fa", "il)\\b"].join(""), "i");
const NO_ADVICE = /BYOK|API key|Settings|[–—]/;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const g = globalThis as unknown as Record<string, unknown>;
const hadWindow = g.window, hadDocument = g.document;
afterEach(() => { if (hadWindow === undefined) delete g.window; else g.window = hadWindow; if (hadDocument === undefined) delete g.document; else g.document = hadDocument; });

const ENGINES: Array<{ kind: string; label: string; desktop: "button" | "none"; browser: "button" | "computer" | "none" }> = [
  { kind: "claudeAgent", label: "Claude Code", desktop: "button", browser: "button" },
  { kind: "codex", label: "Codex", desktop: "button", browser: "button" },
  { kind: "grokAgent", label: "Grok", desktop: "button", browser: "button" },
  { kind: "kimiAgent", label: "Kimi", desktop: "button", browser: "button" },
  { kind: "opencodeGo", label: "OpenCode", desktop: "button", browser: "computer" },
  { kind: "antigravityAgent", label: "Antigravity", desktop: "none", browser: "none" },
];
const desktopEnv = { homePage: true, bridge: true };
const browserEnv = { homePage: true, bridge: false };
const view = (plan: "button" | "computer" | "none") => renderToStaticMarkup(createElement(EngineSignInAgainView, { plan, busy: false, error: "", onSignIn: () => {} }));
const asHome = (bridge?: unknown) => { g.document = { querySelector: (s: string) => (s.includes("murage-home-id") ? { getAttribute: () => "h1" } : null) }; g.window = bridge === undefined ? { open: () => ({}) } : { muragecloud: bridge, open: () => ({}) }; };
const card = async (kind: string, label: string) => { await setLocale("en"); return text(renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, engineName: label, signInAgain: { bot: { id: "b1", name: "Bea" }, engine: kind }, onOpenProviderSettings: () => {} }))); };

describe("engine x surface matrix", () => {
  for (const e of ENGINES) {
    it(`${e.kind}: Cloud window ${e.desktop}, owner browser ${e.browser}`, () => {
      expect(signInAgainPlan(e.kind, desktopEnv)).toBe(e.desktop);
      expect(signInAgainPlan(e.kind, browserEnv)).toBe(e.browser);
    });
  }
  it("the button renders only for the button plan", () => {
    expect(view("button")).toContain("data-engine-sign-in-again");
    expect(view("computer")).toBe("");
    expect(view("none")).toBe("");
  });
  it("an unknown engine has no place on either surface", () => {
    expect(signInAgainPlan("somethingElse", desktopEnv)).toBe("none");
    expect(signInAgainPlan("somethingElse", browserEnv)).toBe("none");
  });
});

describe("the card line per surface", () => {
  it("Claude Code shows the button and the sign-in line on the Cloud window and on the browser", async () => {
    for (const bridge of [{ requestSignIn: async () => ({ requested: true }) }, undefined]) {
      asHome(bridge);
      const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, engineName: "Claude Code", signInAgain: { bot: { id: "b1", name: "Bea" }, engine: "claudeAgent" }, onOpenProviderSettings: () => {} }));
      expect(html).toContain("data-engine-sign-in-again");
      expect(text(html)).toContain("Your Claude Code sign-in needs a refresh. Sign in again to carry on.");
    }
  });
  it("OpenCode in a browser has no button and names the Murage app on a computer", async () => {
    asHome();
    const line = await card("opencodeGo", "OpenCode");
    expect(line).toBe("Your OpenCode sign-in needs a refresh. Open Murage on your computer to sign in again.");
    expect(line).toBe(signInAgainComputerLine("OpenCode"));
  });
  it("OpenCode in the Cloud window keeps its button", async () => {
    asHome({ requestSignIn: async () => ({ requested: true }) });
    expect(renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, engineName: "OpenCode", signInAgain: { bot: { id: "b1", name: "Bea" }, engine: "opencodeGo" }, onOpenProviderSettings: () => {} }))).toContain("data-engine-sign-in-again");
  });
  it("Antigravity has nowhere to sign in again from Cloud: no button, and no promise to sign in", async () => {
    for (const bridge of [undefined, { requestSignIn: async () => ({ requested: true }) }]) {
      asHome(bridge);
      const html = renderToStaticMarkup(createElement(ProviderErrorCard, { info: { kind: "authentication", httpStatus: 401 }, engineName: "Antigravity", signInAgain: { bot: { id: "b1", name: "Bea" }, engine: "antigravityAgent" }, onOpenProviderSettings: () => {} }));
      expect(html).not.toContain("data-engine-sign-in-again");
      expect(text(html)).toBe(signInAgainNoRouteLine("Antigravity"));
    }
  });
  it("no card line carries a banned word, dash or key advice", async () => {
    for (const e of ENGINES) {
      for (const bridge of [undefined, { requestSignIn: async () => ({ requested: true }) }]) {
        asHome(bridge);
        const line = await card(e.kind, e.label);
        expect(line).not.toMatch(BANNED);
        expect(line).not.toMatch(NO_ADVICE);
      }
    }
  });
});

describe("the click calls the right sign-in entry", () => {
  it("in the Cloud window it asks the local window for this bot and engine", async () => {
    const requestSignIn = vi.fn(async () => ({ requested: true as const }));
    asHome({ requestSignIn });
    const openBrowser = vi.fn();
    const ok = await runOfferSignIn("b1", "claudeAgent", { setBusy: () => {}, setError: () => {}, openBrowser });
    expect(ok).toBe(true);
    expect(requestSignIn).toHaveBeenCalledWith({ bot: "b1", engine: "claudeAgent" });
    expect(openBrowser).not.toHaveBeenCalled();
  });
  it("in an owner's browser it opens the browser sign-in dialog and does not touch a bridge", async () => {
    asHome();
    const openBrowser = vi.fn();
    const ok = await runOfferSignIn("b1", "claudeAgent", { setBusy: () => {}, setError: () => {}, openBrowser });
    expect(ok).toBe(true);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });
});
